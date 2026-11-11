//! Native ownership for Bridge's leased Position/Pick and Motor tasks. Request admission,
//! the writer's final permission check, and page migration share one lock.
//! Direct trajectory/gravity and SSH task lifetimes are not yet managed here.
use super::{command_queue::SendPermit, windows::WindowToken};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub epoch: u64,
    pub window: WindowToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Position,
    Pick,
    Motor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Submitting,
    Running,
    Stopping,
    Uncertain,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub id: u64,
    pub epoch: u64,
    pub window: String,
    pub command_id: String,
    pub kind: Kind,
    pub phase: Phase,
    pub message: String,
}

struct Task {
    snapshot: Snapshot,
    owner: Owner,
    sent: bool,
    admitted: bool,
    stop_pending: bool,
    seen: Instant,
    probed: Option<Instant>,
    heartbeat_at: Option<Instant>,
    action_next: u64,
    inflight: Option<u64>,
    motor: Option<super::motor_task::Motor>,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    task: Option<Task>,
    migrations: BTreeSet<String>,
    local_operations: BTreeSet<String>,
    motor_context: Option<super::motor_task::Context>,
}

#[derive(Default)]
pub struct Tasks {
    inner: Mutex<Inner>,
}

pub struct Admission {
    pub ticket: Option<u64>,
    pub permit: Option<SendPermit>,
}
pub struct StopAction {
    pub ticket: u64,
    pub action: u64,
    pub message: Value,
    pub permit: SendPermit,
    pub recovery: bool,
    pub heartbeat: bool,
}
pub struct Migration {
    tasks: Arc<Tasks>,
    label: String,
}
pub struct LocalOperation {
    tasks: Arc<Tasks>,
    label: String,
}
impl Drop for LocalOperation {
    fn drop(&mut self) {
        self.tasks.inner.lock().unwrap().local_operations.remove(&self.label);
    }
}

impl Drop for Migration {
    fn drop(&mut self) {
        self.tasks
            .inner
            .lock()
            .unwrap()
            .migrations
            .remove(&self.label);
    }
}

fn start_kind(op: &str) -> Option<Kind> {
    match op {
        "position_move" | "position_group_start" => Some(Kind::Position),
        "visual_pick_start" => Some(Kind::Pick),
        _ => None,
    }
}
fn heartbeat(op: &str) -> bool {
    matches!(op, "position_motion_info" | "visual_pick_status")
}
fn actuation(op: &str, message: &Value) -> bool {
    start_kind(op).is_some()
        || matches!(
            op,
            "trajectory_command"
                | "gravity_id_send_goal"
                | "position_group_resume"
                | "position_group_pause"
        )
        || (op == "joint_command" && message["mode"].as_i64() != Some(3))
}
fn stopped(task: &Task) -> bool {
    matches!(task.snapshot.phase, Phase::Stopping | Phase::Uncertain)
}
fn stop(task: &mut Task, reason: &str) {
    if !stopped(task) {
        task.stop_pending = true;
    }
    task.snapshot.phase = Phase::Stopping;
    task.snapshot.message = reason.into();
}

impl Tasks {
    pub fn configure_motor(&self, epoch: u64, profile: &Value) {
        self.inner.lock().unwrap().motor_context = super::motor_task::Context::new(epoch, profile);
    }

    pub fn snapshot(&self) -> Option<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .task
            .as_ref()
            .map(|task| task.snapshot.clone())
    }

    pub fn local_operation(self: &Arc<Self>, label: &str) -> Result<LocalOperation, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.migrations.contains(label) { return Err("页面正在迁移，不能开始本地任务".into()); }
        if !inner.local_operations.insert(label.into()) { return Err("此页面已有本地任务正在进行".into()); }
        Ok(LocalOperation { tasks: self.clone(), label: label.into() })
    }

    pub fn migration(self: &Arc<Self>, label: &str) -> Result<Migration, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.local_operations.contains(label) { return Err("此页面的本地任务尚未结束，不能迁移窗口".into()); }
        if inner
            .task
            .as_ref()
            .is_some_and(|task| task.owner.window.label == label)
        {
            return Err("此页面的运动任务尚未确认结束，不能迁移窗口".into());
        }
        if !inner.migrations.insert(label.into()) {
            return Err("页面正在迁移".into());
        }
        Ok(Migration {
            tasks: self.clone(),
            label: label.into(),
        })
    }

    pub fn touch(&self, owner: &Owner, now: Instant) {
        if let Some(task) = self
            .inner
            .lock()
            .unwrap()
            .task
            .as_mut()
            .filter(|task| &task.owner == owner)
        {
            if !stopped(task) {
                task.seen = now;
            }
        }
    }

    pub fn lost(&self, owner: Option<&Owner>, reason: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(task) = inner
            .task
            .as_mut()
            .filter(|task| owner.is_none_or(|owner| &task.owner == owner))
        {
            // The writer uses this same lock before setting sent. Clearing an
            // unsent ticket therefore cannot race with a later transmission.
            if !task.sent {
                inner.task = None;
                return;
            }
            stop(task, reason);
        }
    }

    pub fn admit(
        self: &Arc<Self>,
        owner: Owner,
        message: &Value,
        now: Instant,
    ) -> Result<Admission, String> {
        let op = message["op"].as_str().ok_or("请求缺少 op")?;
        let mut inner = self.inner.lock().unwrap();
        if actuation(op, message) && inner.migrations.contains(&owner.window.label) {
            return Err("页面正在迁移，不能提交运动".into());
        }
        let motor_context = inner.motor_context.clone();
        let is_motor = op == "joint_command" && message["mode"].as_i64() != Some(3);
        if is_motor && owner.window.label != "page-motor" {
            return Err("只有 Motor 页面可以发送连续关节指令".into());
        }
        if let Some(task) = &mut inner.task {
            let cancel = (op == "joint_command" && message["mode"].as_i64() == Some(3))
                || (op == "visual_pick_cancel" && task.snapshot.kind == Kind::Pick)
                || (op == "position_cancel"
                    && task.snapshot.kind == Kind::Position
                    && message["command_id"] == task.snapshot.command_id);
            if cancel {
                stop(task, "已请求停止，等待 Bridge 确认任务终态");
                task.stop_pending = false;
                if let Some(motor) = &mut task.motor {
                    motor.stopping(motor_context.as_ref(), owner.epoch, now);
                }
            }
            if actuation(op, message)
                && !(is_motor
                    && task.snapshot.kind == Kind::Motor
                    && task.owner == owner
                    && task.admitted
                    && !stopped(task))
                && !(matches!(op, "position_group_pause" | "position_group_resume")
                    && task.snapshot.kind == Kind::Position
                    && task.owner == owner
                    && message["command_id"] == task.snapshot.command_id
                    && !stopped(task))
            {
                return Err(format!(
                    "{} 持有运动任务 {}；需等待终态确认",
                    task.owner.window.label, task.snapshot.command_id
                ));
            }
        }
        let existing_motor = inner
            .task
            .as_ref()
            .filter(|task| task.snapshot.kind == Kind::Motor)
            .map(|task| task.snapshot.id);
        let ticket = if existing_motor.is_some() && op == "joint_command" {
            existing_motor
        } else if let Some(kind) =
            start_kind(op).or(if is_motor { Some(Kind::Motor) } else { None })
        {
            let generated = format!(
                "motor-{}",
                inner.sequence.checked_add(1).ok_or("原生任务编号耗尽")?
            );
            let command = if is_motor {
                Some(generated.as_str())
            } else {
                message["command_id"].as_str()
            }
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("运动 command_id 无效")?;
            let motor = if is_motor {
                Some(super::motor_task::Motor::start(
                    motor_context.as_ref(),
                    owner.epoch,
                    now,
                )?)
            } else {
                None
            };
            inner.sequence = inner.sequence.checked_add(1).ok_or("原生任务编号耗尽")?;
            let id = inner.sequence;
            inner.task = Some(Task {
                snapshot: Snapshot {
                    id,
                    epoch: owner.epoch,
                    window: owner.window.label.clone(),
                    command_id: command.into(),
                    kind,
                    phase: Phase::Submitting,
                    message: "等待 Bridge 受理".into(),
                },
                owner: owner.clone(),
                sent: false,
                admitted: false,
                stop_pending: false,
                seen: now,
                probed: None,
                heartbeat_at: None,
                action_next: 0,
                inflight: None,
                motor,
            });
            Some(id)
        } else {
            None
        };
        let expected = inner.task.as_ref().map(|task| task.snapshot.id);
        drop(inner);
        // Heartbeats must be checked at write time, including a query queued
        // before another window acquired a task. Never renew for a dead owner.
        let is_heartbeat = heartbeat(op);
        let is_continuation = matches!(op, "position_group_pause" | "position_group_resume");
        let is_cancel = matches!(op, "position_cancel" | "visual_pick_cancel")
            || (op == "joint_command" && message["mode"].as_i64() == Some(3));
        let tasks = self.clone();
        let permit =
            (ticket.is_some() || is_heartbeat || is_continuation || is_cancel).then(|| {
                Arc::new(move || {
                    let mut inner = tasks.inner.lock().unwrap();
                    let Some(task) = inner.task.as_mut() else {
                        return ticket.is_none() && !is_continuation;
                    };
                    if is_cancel {
                        return expected == Some(task.snapshot.id);
                    }
                    if is_heartbeat {
                        // On reconnection, status may prove the previous session ended;
                        // a query on a new socket cannot renew the old Bridge owner.
                        return task.owner.epoch < owner.epoch
                            || (task.owner == owner && !stopped(task));
                    }
                    if expected != Some(task.snapshot.id) || task.owner != owner || stopped(task) {
                        return false;
                    }
                    if ticket.is_some() {
                        task.sent = true;
                        if let Some(motor) = &mut task.motor {
                            motor.last_command = Instant::now();
                        }
                    }
                    true
                }) as SendPermit
            });
        Ok(Admission { ticket, permit })
    }

    pub fn reply(
        &self,
        ticket: Option<u64>,
        epoch: u64,
        request: &Value,
        response: Result<&Value, &str>,
    ) {
        if ticket.is_none() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.task.as_mut() else {
            return;
        };
        if task.snapshot.kind == Kind::Motor && ticket == Some(task.snapshot.id) {
            if request["op"] == "joint_command" && request["mode"] == 3 {
                if let Ok(value) = response {
                    task.motor
                        .as_mut()
                        .unwrap()
                        .acknowledge_disable(epoch, value);
                    if value["op"] == "joint_command_ack" && value["mode"] == 3 {
                        task.snapshot.message =
                            "DISABLE 已发布，等待新鲜 HardwareStatus 确认输出关闭".into();
                    }
                }
                let confirmed = inner
                    .task
                    .as_ref()
                    .unwrap()
                    .motor
                    .as_ref()
                    .unwrap()
                    .stopped(inner.motor_context.as_ref(), Instant::now());
                if confirmed {
                    inner.task = None;
                }
                return;
            }
            if task.owner.epoch != epoch {
                return;
            }
            match response {
                Ok(value)
                    if value["op"] == "joint_command_ack"
                        && value["mode"] == request["mode"]
                        && value["sequence"]
                            .as_u64()
                            .and_then(|v| u32::try_from(v).ok())
                            .is_some() =>
                {
                    task.admitted = true;
                    if !stopped(task) {
                        task.snapshot.phase = Phase::Running;
                        task.snapshot.message = "Motor 连续发送中".into();
                    }
                }
                Ok(value) if value["op"] == "error" && !task.admitted => {
                    inner.task = None;
                }
                Err(_) if !task.sent => {
                    inner.task = None;
                }
                _ => stop(task, "Motor 发布结果未确认，已请求 DISABLE"),
            }
            return;
        }
        if task.owner.epoch != epoch {
            return;
        }
        if ticket != Some(task.snapshot.id) {
            return;
        }
        let expected_ack = format!("{}_ack", request["op"].as_str().unwrap_or(""));
        match response {
            Ok(value)
                if (value["op"] == "error"
                    || (value["op"] == expected_ack
                        && value["command_id"] == task.snapshot.command_id
                        && value["accepted"] == false))
                    && !task.admitted =>
            {
                inner.task = None;
            }
            Ok(value)
                if value["command_id"] == task.snapshot.command_id
                    && ((value["op"] == expected_ack && value["accepted"] == true)
                        || (value["op"] == "visual_pick_state" && value["busy"] == true)) =>
            {
                task.admitted = true;
                if !stopped(task) {
                    task.snapshot.phase = Phase::Running;
                    task.snapshot.message = "Bridge 已受理".into();
                }
            }
            Err(_) if !task.sent => {
                inner.task = None;
            }
            _ => {
                stop(task, "受理结果未确认，已请求取消；不会自动重发运动");
            }
        }
    }

    pub fn recover(&self, ticket: u64, epoch: u64, value: &Value) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.task.as_ref().filter(|task| {
            task.snapshot.id == ticket
                && task.sent
                && epoch >= task.owner.epoch
                && value["command_id"] == task.snapshot.command_id
        }) else {
            return false;
        };
        let terminal = match task.snapshot.kind {
            Kind::Motor => false,
            Kind::Position => {
                value["op"] == "position_task_status"
                    && value["known"] == true
                    && value["terminal"] == true
                    && value["motion_state"]["op"] == "position_motion"
                    && value["motion_state"]["command_id"] == task.snapshot.command_id
                    && value["motion_state"]["motion_phase"] == value["motion_phase"]
                    && matches!(
                        value["motion_phase"].as_str(),
                        Some("succeeded" | "failed" | "canceled")
                    )
            }
            Kind::Pick => {
                value["op"] == "visual_pick_state"
                    && value["busy"] == false
                    && matches!(
                        value["pick_phase"].as_str(),
                        Some("holding" | "failed" | "canceled")
                    )
            }
        };
        if terminal {
            inner.task = None;
        }
        terminal
    }

    pub fn heartbeat_reply(&self, ticket: u64, epoch: u64, response: Result<&Value, &str>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.task.as_mut().filter(|task| {
            task.snapshot.id == ticket && task.owner.epoch == epoch && !stopped(task)
        }) else {
            return;
        };
        if task.snapshot.kind == Kind::Pick
            && response.is_ok_and(|value| {
                value["op"] == "visual_pick_state"
                    && value["command_id"] == task.snapshot.command_id
                    && value["busy"] == false
                    && matches!(
                        value["pick_phase"].as_str(),
                        Some("holding" | "failed" | "canceled")
                    )
            })
        {
            inner.task = None;
            return;
        }
        let renewed = response.is_ok_and(|value| {
            value["command_id"] == task.snapshot.command_id
                && match task.snapshot.kind {
                    Kind::Motor => false,
                    Kind::Position => {
                        value["op"] == "position_motion_heartbeat_ack" && value["renewed"] == true
                    }
                    Kind::Pick => value["op"] == "visual_pick_state" && value["busy"] == true,
                }
        });
        if !renewed {
            stop(task, "任务续租未确认，已请求取消");
        }
    }

    pub fn observe(&self, epoch: u64, message: &Value) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(context) = &mut inner.motor_context {
            context.observe(epoch, message, Instant::now());
        }
        if inner
            .task
            .as_ref()
            .and_then(|task| task.motor.as_ref())
            .is_some_and(|motor| motor.stopped(inner.motor_context.as_ref(), Instant::now()))
        {
            inner.task = None;
            return;
        }
        let Some(task) = inner.task.as_mut().filter(|task| {
            task.owner.epoch == epoch
                && task.sent
                && message["command_id"] == task.snapshot.command_id
        }) else {
            return;
        };
        let terminal = match task.snapshot.kind {
            Kind::Position if message["op"] == "position_motion" => matches!(
                message["motion_phase"].as_str(),
                Some("succeeded" | "failed" | "canceled")
            ),
            Kind::Pick if message["op"] == "visual_pick_state" => {
                message["busy"] == false
                    && matches!(
                        message["pick_phase"].as_str(),
                        Some("holding" | "failed" | "canceled")
                    )
            }
            _ => return,
        };
        if terminal {
            inner.task = None;
            return;
        }
        task.admitted = true;
        if message["motion_phase"] == "stop_failed" || message["pick_phase"] == "stop_failed" {
            task.snapshot.phase = Phase::Uncertain;
            task.snapshot.message = "Bridge 未能确认停止，任务仍被占用".into();
        } else if !stopped(task) {
            task.snapshot.phase = Phase::Running;
            task.snapshot.message = message["message"]
                .as_str()
                .unwrap_or("运动进行中")
                .chars()
                .take(512)
                .collect();
        }
    }

    pub fn poll(self: &Arc<Self>, epoch: u64, now: Instant) -> Option<StopAction> {
        let mut inner = self.inner.lock().unwrap();
        let context = inner.motor_context.clone();
        let task = inner.task.as_mut()?;
        if task.snapshot.kind == Kind::Motor {
            if !task
                .motor
                .as_ref()
                .unwrap()
                .matches(context.as_ref(), epoch)
            {
                task.snapshot.phase = Phase::Uncertain;
                task.snapshot.message =
                    "Motor 停止未确认，请重新连接原机器人核验；未向另一连接发送 DISABLE".into();
                return None;
            }
            if !stopped(task)
                && (task.owner.epoch != epoch
                    || now.saturating_duration_since(task.motor.as_ref().unwrap().last_command)
                        >= Duration::from_millis(250))
            {
                stop(task, "Motor 指令流已中断，已请求 DISABLE");
            }
            if !stopped(task) {
                return None;
            }
            if task.inflight.is_some()
                || task
                    .probed
                    .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
            {
                return None;
            }
            if !task.sent {
                inner.task = None;
                return None;
            }
            task.probed = Some(now);
            task.stop_pending = false;
            task.action_next = task
                .action_next
                .checked_add(1)
                .expect("task action exhausted");
            let action = task.action_next;
            task.inflight = Some(action);
            task.motor
                .as_mut()
                .unwrap()
                .stopping(context.as_ref(), epoch, now);
            let ticket = task.snapshot.id;
            let tasks = self.clone();
            return Some(StopAction {
                ticket,
                action,
                message: json!({"op":"joint_command","mode":3}),
                recovery: false,
                heartbeat: false,
                permit: Arc::new(move || {
                    tasks
                        .inner
                        .lock()
                        .unwrap()
                        .task
                        .as_ref()
                        .is_some_and(|task| task.snapshot.id == ticket)
                }),
            });
        }
        let new_session = task.owner.epoch != epoch;
        if new_session {
            task.stop_pending = false;
        }
        if !new_session
            && now.saturating_duration_since(task.seen) >= Duration::from_secs(5)
            && !stopped(task)
        {
            stop(task, "任务所属窗口失联，已请求取消");
        }
        let recovery = new_session || (stopped(task) && !task.stop_pending);
        if task.inflight.is_some() && !task.stop_pending {
            return None;
        }
        let heartbeat = !recovery && !task.stop_pending;
        if heartbeat {
            if !task.admitted
                || !task.sent
                || task.heartbeat_at.is_some_and(|at| {
                    now.saturating_duration_since(at) < Duration::from_millis(500)
                })
            {
                return None;
            }
            task.heartbeat_at = Some(now);
        } else if recovery {
            if task
                .probed
                .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
            {
                return None;
            }
            task.probed = Some(now);
        } else {
            if !task.stop_pending {
                return None;
            }
            task.stop_pending = false;
            task.probed = Some(now);
            if !task.sent {
                inner.task = None;
                return None;
            }
        }
        let ticket = task.snapshot.id;
        task.action_next = task
            .action_next
            .checked_add(1)
            .expect("task action sequence exhausted");
        let action = task.action_next;
        task.inflight = Some(action);
        let message = match (task.snapshot.kind, recovery, heartbeat) {
            (Kind::Motor, _, _) => unreachable!("Motor handled above"),
            (Kind::Position, false, true) => {
                json!({"op":"position_motion_heartbeat", "command_id":task.snapshot.command_id})
            }
            (Kind::Pick, false, true) => json!({"op":"visual_pick_status"}),
            (Kind::Position, false, false) => {
                json!({"op":"position_cancel", "command_id":task.snapshot.command_id})
            }
            (Kind::Pick, false, false) => json!({"op":"visual_pick_cancel"}),
            (Kind::Position, true, _) => {
                json!({"op":"position_task_status", "command_id":task.snapshot.command_id})
            }
            (Kind::Pick, true, _) => json!({"op":"visual_pick_observe"}),
        };
        let tasks = self.clone();
        Some(StopAction {
            ticket,
            action,
            message,
            recovery,
            heartbeat,
            permit: Arc::new(move || {
                tasks
                    .inner
                    .lock()
                    .unwrap()
                    .task
                    .as_ref()
                    .is_some_and(|task| {
                        task.snapshot.id == ticket
                            && (!heartbeat
                                || (!stopped(task)
                                    && task.owner.epoch == epoch
                                    && task.seen.elapsed() < Duration::from_secs(5)))
                    })
            }),
        })
    }

    pub fn finish_action(&self, ticket: u64, action: u64) {
        if let Some(task) = self
            .inner
            .lock()
            .unwrap()
            .task
            .as_mut()
            .filter(|task| task.snapshot.id == ticket && task.inflight == Some(action))
        {
            task.inflight = None;
        }
    }

    pub fn stop_error(&self, ticket: u64, error: &str) {
        if let Some(task) = self
            .inner
            .lock()
            .unwrap()
            .task
            .as_mut()
            .filter(|task| task.snapshot.id == ticket)
        {
            task.snapshot.phase = Phase::Uncertain;
            task.snapshot.message = format!(
                "停止尚未确认：{}",
                error.chars().take(256).collect::<String>()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(label: &str) -> Owner {
        Owner {
            epoch: 1,
            window: WindowToken {
                label: label.into(),
                incarnation: 1,
            },
        }
    }
    fn start(tasks: &Arc<Tasks>, kind: &str, now: Instant) -> Admission {
        tasks
            .admit(
                owner("page-motion"),
                &json!({"op":kind,"command_id":"command-1"}),
                now,
            )
            .unwrap()
    }
    #[test]
    fn submitting_tasks_are_exclusive_and_migration_is_atomic_in_both_directions() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let migration = tasks.migration("page-motion").unwrap();
        assert!(tasks
            .admit(
                owner("page-motion"),
                &json!({"op":"position_move","command_id":"x"}),
                now
            )
            .is_err());
        drop(migration);
        let admission = start(&tasks, "position_move", now);
        assert!(tasks.migration("page-motion").is_err());
        assert!(tasks.migration("page-handeye").is_ok());
        for op in [
            "position_move",
            "position_group_start",
            "visual_pick_start",
            "trajectory_command",
            "gravity_id_send_goal",
            "joint_command",
        ] {
            assert!(tasks
                .admit(
                    owner("page-motor"),
                    &json!({"op":op,"mode":1,"command_id":"other"}),
                    now
                )
                .is_err());
        }
        tasks.reply(
            admission.ticket,
            1,
            &json!({"op":"position_move"}),
            Ok(&json!({"op":"position_move_ack","command_id":"command-1","accepted":false})),
        );
        assert!(tasks.snapshot().is_none());
        assert!(!admission.permit.unwrap()());
    }
    #[test]
    fn uncertain_admission_cancels_once_and_only_matching_terminal_releases() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "position_move", now);
        assert!(admission.permit.as_ref().unwrap()());
        tasks.reply(
            admission.ticket,
            1,
            &json!({"op":"position_move"}),
            Err("timeout"),
        );
        assert!(!admission.permit.unwrap()());
        let stop = tasks.poll(1, now).unwrap();
        assert_eq!(
            stop.message,
            json!({"op":"position_cancel","command_id":"command-1"})
        );
        assert!(tasks.poll(1, now).is_none());
        tasks.observe(1, &json!({"op":"position_cancel_ack"}));
        tasks.observe(
            1,
            &json!({"op":"position_motion","command_id":"other","motion_phase":"canceled"}),
        );
        tasks.observe(
            1,
            &json!({"op":"position_motion","command_id":"command-1","motion_phase":"stop_failed"}),
        );
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Uncertain);
        tasks.reply(
            admission.ticket,
            1,
            &json!({"op":"position_move"}),
            Ok(&json!({"op":"position_move_ack","accepted":true,"command_id":"command-1"})),
        );
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Uncertain);
        tasks.observe(
            1,
            &json!({"op":"position_motion","command_id":"command-1","motion_phase":"canceled"}),
        );
        assert!(tasks.snapshot().is_none());
        assert!(!(stop.permit)());
    }
    #[test]
    fn other_windows_cannot_renew_a_task_even_with_a_query_prepared_before_admission() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let other = tasks
            .admit(owner("main"), &json!({"op":"position_motion_info"}), now)
            .unwrap();
        let admission = start(&tasks, "position_group_start", now);
        assert!(admission.permit.unwrap()());
        assert!(!other.permit.unwrap()());
        let own = tasks
            .admit(
                owner("page-motion"),
                &json!({"op":"position_motion_info"}),
                now,
            )
            .unwrap();
        assert!(own.permit.as_ref().unwrap()());
        tasks.touch(&owner("main"), now + Duration::from_secs(4));
        assert!(tasks.poll(1, now + Duration::from_secs(5)).is_some());
        assert!(!own.permit.unwrap()());
    }
    #[test]
    fn pick_child_motion_and_false_idle_do_not_release_pick_or_unknown_stop() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "visual_pick_start", now);
        assert!(admission.permit.unwrap()());
        tasks.observe(1, &json!({"op":"position_motion","command_id":"command-1-vp-1","motion_phase":"succeeded"}));
        tasks.observe(1, &json!({"op":"visual_pick_state","command_id":"command-1","pick_phase":"holding","busy":true}));
        assert!(tasks.snapshot().is_some());
        let cancel = tasks
            .admit(owner("main"), &json!({"op":"visual_pick_cancel"}), now)
            .unwrap();
        assert!(cancel.permit.unwrap()());
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Stopping);
        tasks.observe(1, &json!({"op":"visual_pick_state","command_id":"command-1","pick_phase":"canceled","busy":false}));
        assert!(tasks.snapshot().is_none());
    }
    #[test]
    fn owner_incarnation_and_epoch_are_fenced_and_idle_alone_cannot_prove_old_motion_stopped() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "position_move", now);
        assert!(admission.permit.unwrap()());
        let mut reopened = owner("page-motion");
        reopened.window.incarnation += 1;
        let heartbeat = tasks
            .admit(reopened, &json!({"op":"position_motion_info"}), now)
            .unwrap();
        assert!(!heartbeat.permit.unwrap()());
        tasks.lost(None, "disconnected");
        let probe = tasks.poll(2, now).unwrap();
        assert!(probe.recovery);
        for (epoch, value) in [
            (0, json!({"op":"position_motion_info","busy":false})),
            (2, json!({"op":"position_motion_info","busy":true})),
            (2, json!({"op":"position_motion_info"})),
            (2, json!({"op":"visual_pick_state","busy":false})),
        ] {
            tasks.recover(admission.ticket.unwrap(), epoch, &value);
            assert!(tasks.snapshot().is_some());
        }
        tasks.recover(
            admission.ticket.unwrap(),
            2,
            &json!({"op":"position_motion_info","busy":false}),
        );
        assert!(tasks.snapshot().is_some());
    }
    #[test]
    fn reconnect_pick_requires_the_same_command_and_a_confirmed_terminal() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "visual_pick_start", now);
        assert!(admission.permit.unwrap()());
        tasks.lost(None, "disconnected");
        for value in [
            json!({"op":"visual_pick_state","command_id":"","pick_phase":"idle","busy":false}),
            json!({"op":"visual_pick_state","command_id":"other","pick_phase":"canceled","busy":false}),
            json!({"op":"visual_pick_state","command_id":"command-1","pick_phase":"stop_failed","busy":false}),
        ] {
            tasks.recover(admission.ticket.unwrap(), 2, &value);
            assert!(tasks.snapshot().is_some());
        }
        tasks.recover(admission.ticket.unwrap(), 2, &json!({"op":"visual_pick_state","command_id":"command-1","pick_phase":"canceled","busy":false}));
        assert!(tasks.snapshot().is_none());
    }
    #[test]
    fn unsent_admission_failure_and_lost_owner_do_not_leave_a_phantom_task() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "position_move", now);
        tasks.reply(
            admission.ticket,
            1,
            &json!({"op":"position_move"}),
            Err("queue full"),
        );
        assert!(tasks.snapshot().is_none());
        assert!(!admission.permit.unwrap()());
        let admission = start(&tasks, "position_move", now);
        tasks.lost(Some(&owner("page-motion")), "closed");
        assert!(tasks.poll(1, now).is_none());
        assert!(tasks.snapshot().is_none());
        assert!(!admission.permit.unwrap()());
    }

    #[test]
    fn native_heartbeats_never_count_as_owner_liveness_and_cancel_overtakes_slow_heartbeat() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "position_move", now);
        assert!(admission.permit.unwrap()());
        tasks.reply(
            admission.ticket,
            1,
            &json!({"op":"position_move"}),
            Ok(&json!({"op":"position_move_ack","accepted":true,"command_id":"command-1"})),
        );
        let heartbeat = tasks.poll(1, now).unwrap();
        assert!(heartbeat.heartbeat && (heartbeat.permit)());
        assert_eq!(heartbeat.message["op"], "position_motion_heartbeat");
        assert!(tasks.poll(1, now + Duration::from_secs(1)).is_none());
        tasks.touch(&owner("page-monitor"), now + Duration::from_secs(4));
        let cancel = tasks.poll(1, now + Duration::from_secs(5)).unwrap();
        assert_eq!(cancel.message["op"], "position_cancel");
        assert!(!cancel.heartbeat && (cancel.permit)());
        assert!(!(heartbeat.permit)());
        tasks.heartbeat_reply(heartbeat.ticket, 1,
            Ok(&json!({"op":"position_motion_heartbeat_ack","renewed":true,"command_id":"command-1"})));
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Stopping);
        tasks.finish_action(heartbeat.ticket, heartbeat.action);
        // A late heartbeat must not remove the pending cancel's in-flight gate.
        assert!(tasks.poll(1, now + Duration::from_secs(7)).is_none());
        tasks.finish_action(cancel.ticket, cancel.action);
        let recovery = tasks.poll(1, now + Duration::from_secs(7)).unwrap();
        assert!(recovery.recovery);
        assert_eq!(recovery.message["op"], "position_task_status");
        tasks.observe(
            1,
            &json!({"op":"position_motion","command_id":"command-1","motion_phase":"canceled"}),
        );
        let next = start(&tasks, "position_move", now);
        assert!(next.permit.unwrap()());
        assert!(!(recovery.permit)());
    }

    #[test]
    fn failed_renewal_requests_stop_and_late_pick_reply_cannot_release_successor() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let first = start(&tasks, "visual_pick_start", now);
        assert!(first.permit.unwrap()());
        tasks.observe(1, &json!({"op":"visual_pick_state","command_id":"command-1","busy":true,"pick_phase":"approaching"}));
        let heartbeat = tasks.poll(1, now).unwrap();
        assert_eq!(heartbeat.message["op"], "visual_pick_status");
        tasks.heartbeat_reply(heartbeat.ticket, 1, Err("timeout"));
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Stopping);
        assert_eq!(
            tasks.poll(1, now).unwrap().message["op"],
            "visual_pick_cancel"
        );
        tasks.observe(1, &json!({"op":"visual_pick_state","command_id":"command-1","busy":false,"pick_phase":"canceled"}));
        let second = start(&tasks, "visual_pick_start", now);
        assert!(second.permit.unwrap()());
        tasks.heartbeat_reply(heartbeat.ticket, 1, Ok(&json!({"op":"visual_pick_state","command_id":"command-1","busy":false,"pick_phase":"holding"})));
        assert_eq!(tasks.snapshot().unwrap().id, second.ticket.unwrap());
    }

    #[test]
    fn position_recovery_requires_matching_retained_terminal_evidence() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let admission = start(&tasks, "position_group_start", now);
        assert!(admission.permit.unwrap()());
        tasks.lost(None, "disconnected");
        let probe = tasks.poll(2, now).unwrap();
        assert_eq!(probe.message["op"], "position_task_status");
        let proof = json!({"op":"position_task_status","command_id":"command-1","known":true,"terminal":true,"motion_phase":"canceled",
            "motion_state":{"op":"position_motion","command_id":"command-1","motion_phase":"canceled","group_phase":"canceled","group_step_index":2}});
        for (key, bad) in [
            ("known", json!(false)),
            ("terminal", json!(false)),
            ("command_id", json!("other")),
            ("motion_phase", json!("stop_failed")),
            ("motion_state", Value::Null),
            (
                "motion_state",
                json!({"op":"position_motion","command_id":"other","motion_phase":"canceled"}),
            ),
            (
                "motion_state",
                json!({"op":"position_motion","command_id":"command-1","motion_phase":"executing"}),
            ),
        ] {
            let mut invalid = proof.clone();
            invalid[key] = bad;
            tasks.recover(admission.ticket.unwrap(), 2, &invalid);
            assert!(tasks.snapshot().is_some());
        }
        tasks.recover(admission.ticket.unwrap(), 0, &proof);
        assert!(tasks.snapshot().is_some());
        tasks.recover(admission.ticket.unwrap(), 2, &proof);
        assert!(tasks.snapshot().is_none());
        let successor = start(&tasks, "position_move", now);
        assert!(successor.permit.unwrap()());
        assert!(!tasks.recover(admission.ticket.unwrap(), 2, &proof));
        assert_eq!(tasks.snapshot().unwrap().id, successor.ticket.unwrap());
    }
}

#[cfg(test)]
mod motor_tests {
    use super::*;
    fn owner(label: &str, epoch: u64) -> Owner {
        Owner {
            epoch,
            window: WindowToken {
                label: label.into(),
                incarnation: 1,
            },
        }
    }
    fn profile(host: &str) -> Value {
        json!({"host":host,"username":"bot","sshPort":22,"remotePort":8765,"rosDomainId":0,"statusTopic":"/status","commandTopic":"/command"})
    }
    fn feedback(sequence: u32, mode: u8, stamp: u64) -> Value {
        json!({"op":"topic_message","topic":"/status","data":{"mode":mode,"last_command_sequence":sequence,"header":{"stamp":{"sec":stamp,"nanosec":0}}}})
    }
    fn started() -> Arc<Tasks> {
        let tasks = Arc::new(Tasks::default());
        tasks.configure_motor(1, &profile("first"));
        tasks.observe(1, &feedback(1, 3, 1));
        let request = json!({"op":"joint_command","mode":1});
        let admission = tasks
            .admit(owner("page-motor", 1), &request, Instant::now())
            .unwrap();
        assert!(admission.permit.unwrap()());
        tasks.reply(
            admission.ticket,
            1,
            &request,
            Ok(&json!({"op":"joint_command_ack","mode":1,"sequence":2})),
        );
        tasks
    }
    #[test]
    fn motor_preflight_rejection_releases_but_unknown_publish_keeps_task_locked() {
        let tasks = Arc::new(Tasks::default());
        tasks.configure_motor(1, &profile("first"));
        let request = json!({"op":"joint_command","mode":1});
        assert!(tasks
            .admit(owner("page-motor", 1), &request, Instant::now())
            .is_err());
        tasks.observe(1, &feedback(1, 3, 1));
        let first = tasks
            .admit(owner("page-motor", 1), &request, Instant::now())
            .unwrap();
        assert!(first.permit.unwrap()());
        assert!(tasks
            .admit(owner("page-motor", 1), &request, Instant::now())
            .is_err());
        tasks.reply(
            first.ticket,
            1,
            &request,
            Ok(&json!({"op":"error","message":"not armed"})),
        );
        assert!(tasks.snapshot().is_none());
        let next = tasks
            .admit(owner("page-motor", 1), &request, Instant::now())
            .unwrap();
        assert!(next.permit.unwrap()());
        tasks.reply(next.ticket, 1, &request, Err("timeout"));
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Stopping);
        tasks.reply(
            first.ticket,
            1,
            &request,
            Ok(&json!({"op":"error","message":"old reply"})),
        );
        assert_eq!(tasks.snapshot().unwrap().id, next.ticket.unwrap());
        assert_eq!(tasks.poll(1, Instant::now()).unwrap().message["mode"], 3);
    }
    #[test]
    fn motor_owns_global_motion_and_disable_ack_does_not_unlock() {
        let tasks = started();
        assert!(tasks.migration("page-motor").is_err());
        assert!(tasks
            .admit(
                owner("page-motion", 1),
                &json!({"op":"position_move","command_id":"p"}),
                Instant::now()
            )
            .is_err());
        assert!(tasks
            .admit(
                owner("page-main", 1),
                &json!({"op":"joint_command","mode":1}),
                Instant::now()
            )
            .is_err());
        let next = tasks
            .admit(
                owner("page-motor", 1),
                &json!({"op":"joint_command","mode":1}),
                Instant::now(),
            )
            .unwrap();
        let disable = json!({"op":"joint_command","mode":3});
        let stop = tasks
            .admit(owner("page-status", 1), &disable, Instant::now())
            .unwrap();
        assert!(stop.permit.unwrap()());
        assert!(!next.permit.unwrap()());
        tasks.reply(
            stop.ticket,
            1,
            &disable,
            Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":5})),
        );
        assert!(tasks.snapshot().is_some());
        assert!(tasks.migration("page-motor").is_err());
        tasks.observe(1, &feedback(4, 3, 2));
        assert!(tasks.snapshot().is_some());
        tasks.observe(1, &feedback(5, 3, 3));
        assert!(tasks.snapshot().is_none());
        assert!(tasks.migration("page-motor").is_ok());
    }
    #[test]
    fn live_page_cannot_keep_a_dead_command_stream_running_and_stale_stop_cannot_hit_successor() {
        let tasks = started();
        let future = Instant::now() + Duration::from_secs(1);
        tasks.touch(&owner("page-motor", 1), future);
        let stop = tasks.poll(1, future).unwrap();
        assert_eq!(stop.message, json!({"op":"joint_command","mode":3}));
        assert!((stop.permit)());
        tasks.reply(
            Some(stop.ticket),
            1,
            &stop.message,
            Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":5})),
        );
        // Simulated poll time is future, so use a real-time stop admission for feedback receipt.
        let manual = tasks
            .admit(owner("page-motor", 1), &stop.message, Instant::now())
            .unwrap();
        tasks.reply(
            manual.ticket,
            1,
            &stop.message,
            Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":8})),
        );
        tasks.observe(1, &feedback(8, 3, 3));
        assert!(tasks.snapshot().is_none());
        let successor = tasks
            .admit(
                owner("page-motor", 1),
                &json!({"op":"joint_command","mode":1}),
                Instant::now(),
            )
            .unwrap();
        assert!(successor.permit.unwrap()());
        assert!(!(stop.permit)());
    }
    #[test]
    fn reconnect_to_other_robot_never_automatically_disables_it_and_same_robot_can_confirm() {
        let tasks = started();
        tasks.lost(None, "lost");
        tasks.configure_motor(2, &profile("other"));
        assert!(tasks.poll(2, Instant::now()).is_none());
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Uncertain);
        tasks.observe(2, &feedback(100, 3, 4));
        assert!(tasks.snapshot().is_some());
        tasks.configure_motor(3, &profile("first"));
        tasks.observe(3, &feedback(7, 1, 1));
        let stop = tasks.poll(3, Instant::now()).unwrap();
        assert!((stop.permit)());
        tasks.reply(
            Some(stop.ticket),
            3,
            &stop.message,
            Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":10})),
        );
        tasks.observe(3, &feedback(10, 3, 2));
        assert!(tasks.snapshot().is_none());
    }
}
