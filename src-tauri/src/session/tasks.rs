//! Native ownership for Bridge's leased Position/Pick tasks. Request admission,
//! the writer's final permission check, and page migration share one lock.
//! Motor/trajectory/gravity and SSH task lifetimes are not yet managed here.
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
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    task: Option<Task>,
    migrations: BTreeSet<String>,
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
    pub message: Value,
    pub permit: SendPermit,
    pub recovery: bool,
}
pub struct Migration {
    tasks: Arc<Tasks>,
    label: String,
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
    pub fn snapshot(&self) -> Option<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .task
            .as_ref()
            .map(|task| task.snapshot.clone())
    }

    pub fn migration(self: &Arc<Self>, label: &str) -> Result<Migration, String> {
        let mut inner = self.inner.lock().unwrap();
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
        if let Some(task) = &mut inner.task {
            let cancel = (op == "joint_command" && message["mode"].as_i64() == Some(3))
                || (op == "visual_pick_cancel" && task.snapshot.kind == Kind::Pick)
                || (op == "position_cancel"
                    && task.snapshot.kind == Kind::Position
                    && message["command_id"] == task.snapshot.command_id);
            if cancel {
                stop(task, "已请求停止，等待 Bridge 确认任务终态");
                task.stop_pending = false;
            }
            if actuation(op, message)
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
        let ticket = if let Some(kind) = start_kind(op) {
            let command = message["command_id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
                .ok_or("运动 command_id 无效")?;
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
        let is_cancel = matches!(op, "position_cancel" | "visual_pick_cancel");
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
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.task.as_mut() else {
            return;
        };
        if task.owner.epoch != epoch {
            // Busy=false alone is not proof: a restarted Bridge has forgotten
            // the previous goal. Pick retains a correlated terminal snapshot.
            // Position's current info protocol hides the old owner's ID; keep
            // that lock until a correlated recovery query is implemented.
            if epoch > task.owner.epoch
                && task.snapshot.kind == Kind::Pick
                && request["op"] == "visual_pick_status"
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
            }
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

    pub fn observe(&self, epoch: u64, message: &Value) {
        let mut inner = self.inner.lock().unwrap();
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
        let task = inner.task.as_mut()?;
        let recovery = task.owner.epoch != epoch;
        if !recovery
            && now.saturating_duration_since(task.seen) >= Duration::from_secs(5)
            && !stopped(task)
        {
            stop(task, "任务所属窗口失联，已请求取消");
        }
        if recovery {
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
            if !task.sent {
                inner.task = None;
                return None;
            }
        }
        let ticket = task.snapshot.id;
        let message = match (task.snapshot.kind, recovery) {
            (Kind::Position, false) => {
                json!({"op":"position_cancel", "command_id":task.snapshot.command_id})
            }
            (Kind::Pick, false) => json!({"op":"visual_pick_cancel"}),
            (Kind::Position, true) => json!({"op":"position_motion_info"}),
            (Kind::Pick, true) => json!({"op":"visual_pick_status"}),
        };
        let tasks = self.clone();
        Some(StopAction {
            ticket,
            message,
            recovery,
            permit: Arc::new(move || {
                tasks
                    .inner
                    .lock()
                    .unwrap()
                    .task
                    .as_ref()
                    .is_some_and(|task| task.snapshot.id == ticket)
            }),
        })
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
            tasks.reply(None, epoch, &probe.message, Ok(&value));
            assert!(tasks.snapshot().is_some());
        }
        tasks.reply(
            None,
            2,
            &probe.message,
            Ok(&json!({"op":"position_motion_info","busy":false})),
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
        let request = json!({"op":"visual_pick_status"});
        for value in [
            json!({"op":"visual_pick_state","command_id":"","pick_phase":"idle","busy":false}),
            json!({"op":"visual_pick_state","command_id":"other","pick_phase":"canceled","busy":false}),
            json!({"op":"visual_pick_state","command_id":"command-1","pick_phase":"stop_failed","busy":false}),
        ] {
            tasks.reply(None, 2, &request, Ok(&value));
            assert!(tasks.snapshot().is_some());
        }
        tasks.reply(None, 2, &request, Ok(&json!({"op":"visual_pick_state","command_id":"command-1","pick_phase":"canceled","busy":false})));
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
}
