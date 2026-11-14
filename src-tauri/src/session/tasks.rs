//! Native ownership for Bridge's leased Position/Pick and Motor tasks. Request admission,
//! the writer's final permission check, and page migration share one lock.
//! Controller switches and leased direct trajectories share admission. Direct
//! trajectory terminals require explicit verifier evidence, never a publish ACK.
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
    Gravity,
    Motor,
    Controller,
    ArmMode,
    Trajectory,
    Joint4,
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
    controller: Option<super::controller_stop::Stop>,
    leased_origin: Option<String>,
    joint4: Option<super::joint4_task::State>,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    task: Option<Task>,
    migrations: BTreeSet<String>,
    local_operations: BTreeSet<String>,
    playback_conflicts: BTreeSet<String>,
    playback: bool,
    motor_context: Option<super::motor_task::Context>,
    connection_identity: Option<(u64, String)>,
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
    playback: bool,
}
impl Drop for LocalOperation {
    fn drop(&mut self) {
        let mut inner = self.tasks.inner.lock().unwrap();
        inner.local_operations.remove(&self.label);
        inner.playback_conflicts.remove(&self.label);
        if self.playback { inner.playback = false; }
    }
}

impl LocalOperation {
    pub fn transfer(&mut self, label: &str) -> Result<(), String> {
        if self.label == label { return Ok(()); }
        let mut inner = self.tasks.inner.lock().unwrap();
        if inner.migrations.contains(label) || inner.local_operations.contains(label) {
            return Err("接管页面正在迁移或已有任务".into());
        }
        inner.local_operations.remove(&self.label);
        if inner.playback_conflicts.remove(&self.label) { inner.playback_conflicts.insert(label.into()); }
        inner.local_operations.insert(label.into());
        self.label = label.into();
        Ok(())
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
        "gravity_id_send_goal" => Some(Kind::Gravity),
        "trajectory_command" => Some(Kind::Trajectory),
        "joint4_start" => Some(Kind::Joint4),
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
                | "joint4_capture"
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
    /// Records stop intent only. The application worker performs the correlated
    /// cancel; a new connection may only query the old task's retained result.
    pub fn cancel_trajectory(&self, id: u64, command_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let task = inner.task.as_mut().filter(|task| task.snapshot.id == id
            && task.snapshot.kind == Kind::Trajectory && task.snapshot.command_id == command_id)
            .ok_or("直接轨迹任务已改变，请刷新状态")?;
        stop(task, "已请求取消直接轨迹，等待停止证据");
        Ok(())
    }

    pub fn joint4_command(&self, owner: &Owner, release: bool) -> Result<Option<String>, String> {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.task.as_mut() else { return Ok(None); };
        if task.snapshot.kind != Kind::Joint4 || &task.owner != owner {
            return Err("已有其他页面或连接持有任务，请等待终态确认".into());
        }
        if release { stop(task, "已请求释放 Joint4 姿态，等待核验；重力前馈不会因此关闭"); }
        Ok(Some(task.snapshot.command_id.clone()))
    }

    pub fn begin_controller(&self, owner: Owner) -> Result<u64, String> {
        self.begin_finite_control(owner, Kind::Controller)
    }

    pub fn begin_arm_mode(&self, owner: Owner) -> Result<u64, String> {
        self.begin_finite_control(owner, Kind::ArmMode)
    }

    fn begin_finite_control(&self, owner: Owner, kind: Kind) -> Result<u64, String> {
        if !matches!(owner.window.label.as_str(), "page-motion" | "page-status") {
            return Err("只有 Motion 或 Status 页面可以切换 Controller".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.task.is_some() || inner.playback { return Err("已有共享运动、回放或控制任务，等待终态后再切换 Controller".into()); }
        if inner.migrations.contains(&owner.window.label) { return Err("页面正在迁移，不能切换 Controller".into()); }
        inner.sequence = inner.sequence.checked_add(1).ok_or("原生任务编号耗尽")?;
        let id = inner.sequence;
        let controller=super::controller_stop::Stop::new(inner.motor_context.as_ref(),owner.epoch,Instant::now());
        inner.task = Some(Task {
            snapshot: Snapshot { id, epoch: owner.epoch, window: owner.window.label.clone(),
                command_id: if kind == Kind::ArmMode { super::controller_journal::new_arm_id()? } else { super::controller_journal::new_id()? }, kind,
                phase: Phase::Submitting, message: "核验 Controller 切换前状态".into() },
            owner, sent: false, admitted: false, stop_pending: false, seen: Instant::now(),
            probed: None, heartbeat_at: None, action_next: 0, inflight: None, motor: None, controller: Some(controller), leased_origin: None, joint4: None,
        });
        Ok(id)
    }

    pub fn arm_progress(&self, id: u64, message: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(task) = inner.task.as_mut().filter(|t| t.snapshot.id == id && t.snapshot.kind == Kind::ArmMode && !t.controller.as_ref().unwrap().requested()) {
            task.snapshot.message = message.chars().take(512).collect();
            if task.sent { task.snapshot.phase = Phase::Running; }
        }
    }

    pub fn controller_sent(&self, id: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let task = inner.task.as_mut().filter(|t| t.snapshot.id == id && matches!(t.snapshot.kind, Kind::Controller | Kind::ArmMode))
            .ok_or("Controller 任务已失效，未发送切换")?;
        if task.sent || stopped(task) { return Err("Controller 任务已发送或撤销".into()); }
        task.sent = true;
        task.snapshot.phase = Phase::Running;
        task.snapshot.message = "Controller 切换中，完成后核验新状态".into();
        Ok(())
    }

    pub fn request_controller_disable(&self, profile: &Value) -> bool {
        let mut inner=self.inner.lock().unwrap();
        let Some(task)=inner.task.as_mut().filter(|task|task.controller.is_some()) else {return false;};
        let control=task.controller.as_mut().unwrap();
        if !control.matches_profile(profile) {return false;}
        control.request();
        task.snapshot.phase=Phase::Stopping;
        task.snapshot.message="已确认支撑并请求 DISABLE，等待 Controller 结束及输出关闭确认".into();
        true
    }

    pub fn controller_outcome(&self, id: u64) -> Result<tokio::sync::watch::Receiver<super::controller_stop::Outcome>,String> {
        self.inner.lock().unwrap().task.as_ref().filter(|t|t.snapshot.id==id)
            .and_then(|t|t.controller.as_ref()).map(|c|c.outcome()).ok_or("Controller 任务已失效".into())
    }
    pub fn controller_remote_completed(&self, id: u64) {
        let mut inner=self.inner.lock().unwrap();
        if let Some(task)=inner.task.as_mut().filter(|t|t.snapshot.id==id && t.sent) {
            if let Some(control)=&mut task.controller {
                if !control.completed() {control.complete(task.action_next);task.probed=None;}
            }
        }
    }
    pub fn controller_finish(&self, id: u64, verified: bool, message: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(task) = inner.task.as_mut().filter(|t| t.snapshot.id == id && matches!(t.snapshot.kind, Kind::Controller | Kind::ArmMode)) else { return false; };
        let control=task.controller.as_mut().unwrap();
        if !task.sent || verified && !control.requested() {
            control.finish(super::controller_stop::Outcome::Finished);
            inner.task = None;return true;
        }
        if verified && !control.completed() {control.complete(task.action_next);task.probed=None;}
        if control.requested() && control.completed() {
            task.snapshot.phase=Phase::Stopping;
            task.snapshot.message="Controller 已结束；等待新的 DISABLE 序列及硬件输出关闭反馈".into();
        } else {
            task.snapshot.phase = Phase::Uncertain;
            task.snapshot.message = message.chars().take(512).collect();
        }
        false
    }

    pub fn configure_motor(&self, epoch: u64, profile: &Value) {
        let mut inner = self.inner.lock().unwrap();
        inner.motor_context = super::motor_task::Context::new(epoch, profile);
        inner.connection_identity = super::trajectory_task::connection_identity(profile).map(|identity| (epoch, identity));
    }

    pub fn snapshot(&self) -> Option<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .task
            .as_ref()
            .map(|task| task.snapshot.clone())
    }

    /// Serialize an offline context change against native task/migration
    /// admission. A retained uncertain task is still an active reservation.
    pub fn with_idle_context<T>(&self, change: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let inner = self.inner.lock().unwrap();
        if inner.task.is_some() || !inner.local_operations.is_empty() || !inner.migrations.is_empty() {
            return Err("任务或窗口迁移尚未结束，不能切换离线配置".into());
        }
        change()
    }

    pub fn local_operation(self: &Arc<Self>, label: &str) -> Result<LocalOperation, String> {
        self.local_activity(label, false)
    }
    pub fn sampling_operation(self: &Arc<Self>, label: &str) -> Result<LocalOperation, String> {
        self.local_activity(label, true)
    }
    fn local_activity(self: &Arc<Self>, label: &str, conflicts: bool) -> Result<LocalOperation, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.migrations.contains(label) { return Err("页面正在迁移，不能开始本地任务".into()); }
        if conflicts && inner.playback { return Err("回放运行中或结果待确认，不能开始采样/录制".into()); }
        if !inner.local_operations.insert(label.into()) { return Err("此页面已有本地任务正在进行".into()); }
        if conflicts { inner.playback_conflicts.insert(label.into()); }
        Ok(LocalOperation { tasks: self.clone(), label: label.into(), playback: false })
    }

    pub fn playback_operation(self: &Arc<Self>, label: &str, starting: bool) -> Result<LocalOperation, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.playback || inner.migrations.contains(label) || inner.local_operations.contains(label)
            || (starting && (inner.task.is_some() || !inner.playback_conflicts.is_empty())) {
            return Err("运动、采样、本地操作或页面迁移未结束，不能开始回放".into());
        }
        inner.local_operations.insert(label.into());
        inner.playback = true;
        Ok(LocalOperation { tasks: self.clone(), label: label.into(), playback: true })
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
                if let Some(control)=&task.controller {control.finish(super::controller_stop::Outcome::Finished);}
                inner.task = None;
                return;
            }
            if matches!(task.snapshot.kind, Kind::Controller | Kind::ArmMode) {
                if task.snapshot.phase != Phase::Uncertain && !task.controller.as_ref().unwrap().requested() {
                    task.snapshot.phase = Phase::Uncertain;
                    task.snapshot.message = "Controller 操作结果未确认；窗口退出或断线不代表操作结束".into();
                }
            } else { stop(task, reason); }
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
        if actuation(op, message) && inner.playback { return Err("回放仍在运行或退出未确认，不能提交运动".into()); }
        if actuation(op, message) && inner.migrations.contains(&owner.window.label) {
            return Err("页面正在迁移，不能提交运动".into());
        }
        let motor_context = inner.motor_context.clone();
        let leased_origin = if matches!(op, "trajectory_command" | "joint4_start") {
            Some(inner.connection_identity.as_ref().filter(|(epoch, _)| *epoch == owner.epoch)
                .ok_or("任务缺少当前机器人连接身份")?.1.clone())
        } else { None };
        if matches!(op, "joint4_start" | "joint4_capture") {
            super::joint4_task::validate(&owner.window.label, message)?;
        }
        if op == "joint4_capture" && !inner.task.as_ref().is_some_and(|task|
            task.snapshot.kind == Kind::Joint4 && task.owner == owner && task.admitted
            && !stopped(task) && message["command_id"] == task.snapshot.command_id
            && task.joint4.as_ref().is_some_and(|j| j.action == "begin_pose" && j.capture_ready && j.operation.is_none())) {
            return Err("Capture 需要本页面已受理的 Joint4 姿态任务，且没有在途采样".into());
        }
        let is_motor = op == "joint_command" && message["mode"].as_i64() != Some(3);
        if is_motor && owner.window.label != "page-motor" {
            return Err("只有 Motor 页面可以发送连续关节指令".into());
        }
        if op == "trajectory_command" && owner.window.label != "page-motion" {
            return Err("只有 Motion 页面可以下发直接轨迹".into());
        }
        if op=="gravity_id_send_goal" && owner.window.label!="page-gravity" {return Err("只有重力辨识页面可以开始辨识".into());}
        if let Some(task) = &mut inner.task {
            if op=="gravity_id_cancel" && (task.snapshot.kind!=Kind::Gravity || message["command_id"]!=task.snapshot.command_id) {
                return Err("取消编号不匹配当前重力辨识任务".into());
            }
            if op == "trajectory_cancel" && (task.snapshot.kind != Kind::Trajectory || message["command_id"] != task.snapshot.command_id) {
                return Err("取消编号不匹配当前直接轨迹任务".into());
            }
            if op == "joint4_cancel" && (task.snapshot.kind != Kind::Joint4 || message["command_id"] != task.snapshot.command_id) {
                return Err("取消编号不匹配当前 Joint4 任务".into());
            }
            let cancel = (op == "joint_command" && message["mode"].as_i64() == Some(3))
                || (op == "joint4_cancel" && task.snapshot.kind == Kind::Joint4 && message["command_id"] == task.snapshot.command_id)
                || (op == "trajectory_cancel" && task.snapshot.kind == Kind::Trajectory && message["command_id"] == task.snapshot.command_id)
                || (op == "visual_pick_cancel" && task.snapshot.kind == Kind::Pick)
                || (op == "gravity_id_cancel" && task.snapshot.kind == Kind::Gravity && message["command_id"]==task.snapshot.command_id)
                || (op == "position_cancel"
                    && task.snapshot.kind == Kind::Position
                    && message["command_id"] == task.snapshot.command_id);
            if cancel {
                if let Some(control)=&mut task.controller {control.request();}
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
                && op != "joint4_capture"
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
                controller: None,
                leased_origin,
                joint4: (kind == Kind::Joint4).then(|| super::joint4_task::State {
                    action: message["action"].as_str().unwrap().into(), operation: None, capture_ready: false,
                }),
            });
            Some(id)
        } else {
            None
        };
        if op == "joint4_capture" {
            inner.task.as_mut().unwrap().joint4.as_mut().unwrap().operation = message["operation_id"].as_str().map(String::from);
        }
        let expected = inner.task.as_ref().map(|task| task.snapshot.id);
        drop(inner);
        // Heartbeats must be checked at write time, including a query queued
        // before another window acquired a task. Never renew for a dead owner.
        let is_heartbeat = heartbeat(op);
        let is_continuation = matches!(op, "position_group_pause" | "position_group_resume" | "joint4_capture");
        let is_cancel = matches!(op, "position_cancel" | "visual_pick_cancel" | "gravity_id_cancel" | "trajectory_cancel" | "joint4_cancel")
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

    pub fn disable_reply(&self, ticket: u64, action: u64, epoch: u64, response: Result<&Value,&str>) {
        {
            let mut inner=self.inner.lock().unwrap();
            if let Some(task)=inner.task.as_mut().filter(|t|t.snapshot.id==ticket && t.controller.is_some()) {
                if task.inflight != Some(action) {return;}
                if let Ok(value)=response { task.controller.as_mut().unwrap().acknowledge(action,epoch,value); }
                let confirmed=inner.task.as_ref().unwrap().controller.as_ref().unwrap().confirmed(inner.motor_context.as_ref(),Instant::now());
                if confirmed {
                    inner.task.as_ref().unwrap().controller.as_ref().unwrap().finish(super::controller_stop::Outcome::Disabled);
                    inner.task=None;
                }
                return;
            }
        }
        self.reply(Some(ticket),epoch,&json!({"op":"joint_command","mode":3}),response);
    }

    pub fn reply(
        &self,
        ticket: Option<u64>,
        epoch: u64,
        request: &Value,
        response: Result<&Value, &str>,
    ) {
        if request["op"] == "joint4_capture" {
            let mut inner = self.inner.lock().unwrap();
            if let Some(task) = inner.task.as_mut().filter(|t| t.owner.epoch == epoch
                && t.snapshot.kind == Kind::Joint4 && request["command_id"] == t.snapshot.command_id) {
                let state = task.joint4.as_mut().unwrap();
                if state.operation.as_deref() == request["operation_id"].as_str() {
                    state.operation = None;
                    if !response.is_ok_and(|v| super::joint4_task::capture_reply(v, request)) {
                        stop(task, "Joint4 采样结果未确认，已请求释放姿态；不会重发采样");
                    }
                }
            }
            return;
        }
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
                if (value["op"] == "error" && !matches!(task.snapshot.kind, Kind::Trajectory | Kind::Joint4)
                    || (value["op"] == expected_ack
                        && value["command_id"] == task.snapshot.command_id
                        && value["accepted"] == false
                        && (match task.snapshot.kind { Kind::Trajectory => value["evidence"] == "not_published", Kind::Joint4 => super::joint4_task::start_reply(value, request), _ => true })))
                    && !task.admitted =>
            {
                inner.task = None;
            }
            Ok(value)
                if value["command_id"] == task.snapshot.command_id
                    && ((value["op"] == expected_ack && value["accepted"] == true
                        && (task.snapshot.kind != Kind::Joint4 || super::joint4_task::start_reply(value, request)))
                        || (task.snapshot.kind == Kind::Pick && value["op"] == "visual_pick_state" && value["busy"] == true)) =>
            {
                task.admitted = true;
                if let Some(joint4) = &mut task.joint4 { joint4.capture_ready = value["success"] == true; }
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
        if matches!(task.snapshot.kind, Kind::Trajectory | Kind::Joint4) && !inner.connection_identity.as_ref().is_some_and(|(current_epoch, identity)|
            *current_epoch == epoch && task.leased_origin.as_ref() == Some(identity)) { return false; }
        let terminal = match task.snapshot.kind {
            Kind::Motor | Kind::Controller | Kind::ArmMode => false,
            Kind::Joint4 => value["op"] == "joint4_task_status" && value["known"] == true
                && value["terminal"] == true && value["busy"] == false
                && value["result"]["command_id"] == task.snapshot.command_id
                && value["task_phase"] == value["result"]["task_phase"]
                && super::joint4_task::terminal(&value["result"], &task.joint4.as_ref().unwrap().action),
            Kind::Trajectory => value["op"] == "trajectory_task_status" && value["known"] == true
                && value["terminal"] == true && value["busy"] == false
                && value["result"]["command_id"] == task.snapshot.command_id
                && value["task_phase"] == value["result"]["task_phase"]
                && super::trajectory_task::terminal(&value["result"]),
            Kind::Gravity => value["op"]=="gravity_id_task_status" && value["known"]==true && value["terminal"]==true &&
                value["result"]["op"]=="gravity_id_result" && value["result"]["command_id"]==task.snapshot.command_id &&
                value["result"]["terminal"]==true && value["status"]==value["result"]["task_phase"] &&
                matches!(value["status"].as_str(),Some("succeeded" | "failed" | "canceled")),
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
                    Kind::Motor | Kind::Controller | Kind::ArmMode => false,
                    Kind::Joint4 => value["op"] == "joint4_heartbeat_ack" && value["renewed"] == true,
                    Kind::Trajectory => value["op"] == "trajectory_heartbeat_ack" && value["renewed"] == true,
                    Kind::Gravity => value["op"]=="gravity_id_heartbeat_ack" && value["renewed"]==true,
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
        if inner.task.as_ref().and_then(|task|task.controller.as_ref())
            .is_some_and(|control|control.confirmed(inner.motor_context.as_ref(),Instant::now())) {
            inner.task.as_ref().unwrap().controller.as_ref().unwrap().finish(super::controller_stop::Outcome::Disabled);
            inner.task=None;return;
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
        if matches!(task.snapshot.kind, Kind::Controller | Kind::ArmMode) { return; }
        let terminal = match task.snapshot.kind {
            Kind::Joint4 if message["op"] == "joint4_task_state" => super::joint4_task::terminal(message, &task.joint4.as_ref().unwrap().action),
            Kind::Trajectory if message["op"] == "trajectory_task_state" => super::trajectory_task::terminal(message),
            Kind::Gravity if message["op"]=="gravity_id_result" => message["terminal"]==true && matches!(message["task_phase"].as_str(),Some("succeeded" | "failed" | "canceled")),
            Kind::Gravity if matches!(message["op"].as_str(),Some("gravity_id_status" | "gravity_id_feedback")) => false,
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
        if matches!(task.snapshot.kind, Kind::Trajectory | Kind::Joint4) && (message["terminal"] != false
            || (task.snapshot.kind == Kind::Joint4 && message["action"] != task.joint4.as_ref().unwrap().action)
            || !matches!(message["task_phase"].as_str(), Some("queued" | "running" | "stopping"))) {
            stop(task, "任务状态或终态证据未确认，已请求取消并保留占用");
            task.snapshot.phase = Phase::Uncertain;
            return;
        }
        task.admitted = true;
        if message["task_phase"] == "running" {
            if let Some(joint4) = &mut task.joint4 { joint4.capture_ready = true; }
        }
        if matches!(task.snapshot.kind, Kind::Trajectory | Kind::Joint4) && message["task_phase"] == "stopping" && !stopped(task) {
            task.snapshot.phase = Phase::Stopping;
            task.snapshot.message = "Bridge 正在停止任务，等待终态证据".into();
            return;
        }
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
        let identity = inner.connection_identity.clone();
        let task = inner.task.as_mut()?;
        if matches!(task.snapshot.kind, Kind::Trajectory | Kind::Joint4) && !identity.as_ref().is_some_and(|(current_epoch, identity)|
            *current_epoch == epoch && task.leased_origin.as_ref() == Some(identity)) {
            task.snapshot.phase = Phase::Uncertain;
            task.snapshot.message = "任务结果未确认，请重连原机器人配置核验；未向其他连接发送控制请求".into();
            return None;
        }
        if let Some(control)=&mut task.controller {
            if !control.requested() {return None;}
            if !task.sent {
                control.finish(super::controller_stop::Outcome::Finished);inner.task=None;return None;
            }
            if task.inflight.is_some() || task.probed.is_some_and(|at|now.saturating_duration_since(at)<Duration::from_secs(1)) {return None;}
            if let Err(error)=control.prepare(context.as_ref(),epoch,now) {
                task.snapshot.phase=Phase::Uncertain;task.snapshot.message=error;return None;
            }
            task.snapshot.phase=Phase::Stopping;
            task.snapshot.message=if control.completed() {"Controller 已结束，正在重新确认 DISABLE 输出关闭"} else {"DISABLE 已请求；Controller 远端结果尚未确认，保留占用并继续关闭输出"}.into();
            task.probed=Some(now);
            task.action_next=task.action_next.checked_add(1).expect("task action exhausted");
            let action=task.action_next;task.inflight=Some(action);
            let ticket=task.snapshot.id;let tasks=self.clone();
            return Some(StopAction {ticket,action,message:json!({"op":"joint_command","mode":3}),recovery:false,heartbeat:false,
                permit:Arc::new(move || tasks.inner.lock().unwrap().task.as_ref().is_some_and(|t|t.snapshot.id==ticket && t.inflight==Some(action))) });
        }
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
            (Kind::Motor | Kind::Controller | Kind::ArmMode, _, _) => unreachable!("Native task handled above"),
            (Kind::Joint4, false, true) => json!({"op":"joint4_heartbeat","command_id":task.snapshot.command_id}),
            (Kind::Joint4, false, false) => json!({"op":"joint4_cancel","command_id":task.snapshot.command_id}),
            (Kind::Joint4, true, _) => json!({"op":"joint4_task_status","command_id":task.snapshot.command_id}),
            (Kind::Trajectory, false, true) => json!({"op":"trajectory_heartbeat","command_id":task.snapshot.command_id}),
            (Kind::Trajectory, false, false) => json!({"op":"trajectory_cancel","command_id":task.snapshot.command_id}),
            (Kind::Trajectory, true, _) => json!({"op":"trajectory_task_status","command_id":task.snapshot.command_id}),
            (Kind::Gravity, false, true) => json!({"op":"gravity_id_heartbeat","command_id":task.snapshot.command_id}),
            (Kind::Gravity, false, false) => json!({"op":"gravity_id_cancel","command_id":task.snapshot.command_id}),
            (Kind::Gravity, true, _) => json!({"op":"gravity_id_task_status","command_id":task.snapshot.command_id}),
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
    fn controller_reservation_conflicts_with_motion_and_migration_and_unknown_stays_owned() {
        let tasks=Arc::new(Tasks::default());let now=Instant::now();
        assert!(tasks.begin_controller(owner("page-handeye")).is_err());
        let moving=tasks.migration("page-motion").unwrap();
        assert!(tasks.begin_controller(owner("page-motion")).is_err());drop(moving);
        let id=tasks.begin_controller(owner("page-motion")).unwrap();
        for op in ["position_move","visual_pick_start","trajectory_command"] {
            assert!(tasks.admit(owner("page-status"),&json!({"op":op,"command_id":"x"}),now).is_err());
        }
        assert!(tasks.migration("page-motion").is_err());
        tasks.controller_sent(id).unwrap();
        assert!(tasks.controller_sent(id).is_err());
        let command_id=tasks.snapshot().unwrap().command_id;
        tasks.controller_finish(id,false,"SSH result unknown");
        tasks.lost(None,"disconnected");
        assert_eq!(tasks.snapshot().unwrap().message,"SSH result unknown");
        tasks.observe(1,&json!({"op":"position_motion","command_id":command_id,"motion_phase":"succeeded"}));
        assert!(tasks.poll(2,now+Duration::from_secs(30)).is_none());
        assert!(!tasks.recover(id,2,&json!({"command_id":command_id,"terminal":true})));
        assert!(tasks.snapshot().is_some());
        tasks.controller_finish(id+1,true,"");assert!(tasks.snapshot().is_some());
        tasks.controller_finish(id,true,"");assert!(tasks.snapshot().is_none());
        let next=tasks.begin_controller(owner("page-status")).unwrap();
        tasks.controller_finish(id,false,"old");assert_eq!(tasks.snapshot().unwrap().id,next);
        tasks.controller_finish(next,false,"preflight rejected");assert!(tasks.snapshot().is_none());
        let motion=start(&tasks,"position_move",now);
        assert!(tasks.begin_controller(owner("page-motion")).is_err());
        drop(motion);
    }
    #[test]
    fn arm_operation_owns_global_control_and_survives_page_loss_until_proven() {
        let tasks = Arc::new(Tasks::default());
        let now = Instant::now();
        let moving = tasks.migration("page-status").unwrap();
        assert!(tasks.begin_arm_mode(owner("page-status")).is_err()); drop(moving);
        let id = tasks.begin_arm_mode(owner("page-status")).unwrap();
        assert_eq!(tasks.snapshot().unwrap().kind, Kind::ArmMode);
        assert!(tasks.snapshot().unwrap().command_id.starts_with("arm-mode-"));
        assert!(tasks.begin_controller(owner("page-motion")).is_err());
        assert!(tasks.begin_arm_mode(owner("page-status")).is_err());
        assert!(tasks.migration("page-status").is_err());
        for op in ["position_move", "visual_pick_start", "gravity_id_send_goal", "trajectory_command"] {
            assert!(tasks.admit(owner("page-motion"), &json!({"op":op,"command_id":"conflict"}), now).is_err());
        }
        tasks.controller_sent(id).unwrap();
        tasks.lost(Some(&owner("page-status")), "page exited");
        assert_eq!(tasks.snapshot().unwrap().id, id);
        assert_eq!(tasks.snapshot().unwrap().phase, Phase::Uncertain);
        assert!(!tasks.controller_finish(id, false, "unknown"));
        tasks.controller_remote_completed(id);
        assert!(tasks.controller_finish(id, true, "verified"));
        assert!(tasks.migration("page-status").is_ok());
        assert!(tasks.begin_arm_mode(owner("page-handeye")).is_err());
    }

    #[test]
    fn controller_disable_requires_reassertion_after_remote_completion_and_fresh_output_proof() {
        let tasks=Arc::new(Tasks::default());let now=Instant::now();
        tasks.configure_motor(1,&json!({"host":"original","commandTopic":"/cmd","statusTopic":"/status"}));
        let status=|seq,stamp| json!({"op":"topic_message","topic":"/status","data":{"mode":3,"last_command_sequence":seq,"header":{"stamp":{"sec":stamp,"nanosec":0}}}});
        tasks.observe(1,&status(1,1));
        let id=tasks.begin_controller(owner("page-motion")).unwrap();
        let outcome=tasks.controller_outcome(id).unwrap();tasks.controller_sent(id).unwrap();
        let disabled=tasks.admit(owner("page-motor"),&json!({"op":"joint_command","mode":3}),now).unwrap();
        assert!((disabled.permit.unwrap())()); // User stop always remains sendable.
        let early=tasks.poll(1,now).unwrap();assert!((early.permit)());
        tasks.disable_reply(id,early.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":10})));
        tasks.observe(1,&status(10,2));assert!(tasks.snapshot().is_some());
        tasks.controller_remote_completed(id);
        tasks.disable_reply(id,early.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":10})));
        tasks.observe(1,&status(10,3));assert!(tasks.snapshot().is_some());
        assert!(!tasks.controller_finish(id,true,"")); // Target state verification cannot clear a requested stop.
        tasks.finish_action(id,early.action);
        let after=tasks.poll(1,Instant::now()).unwrap();assert!(after.action>early.action);
        tasks.disable_reply(id,early.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":20})));
        tasks.observe(1,&status(20,4));assert!(tasks.snapshot().is_some()); // wrong action number
        tasks.disable_reply(id,after.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":30})));
        tasks.observe(1,&status(29,5));assert!(tasks.snapshot().is_some());
        tasks.observe(1,&status(30,6));assert!(tasks.snapshot().is_none());
        assert_eq!(*outcome.borrow(),super::super::controller_stop::Outcome::Disabled);
        let next=tasks.begin_controller(owner("page-status")).unwrap();
        tasks.disable_reply(id,after.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":40})));
        assert_eq!(tasks.snapshot().unwrap().id,next);
    }
    #[test]
    fn arm_mode_disable_requires_reassertion_after_remote_completion_and_fresh_output_proof() {
        let tasks=Arc::new(Tasks::default());let now=Instant::now();
        tasks.configure_motor(1,&json!({"host":"original","commandTopic":"/cmd","statusTopic":"/status"}));
        let status=|seq,stamp| json!({"op":"topic_message","topic":"/status","data":{"mode":3,"last_command_sequence":seq,"header":{"stamp":{"sec":stamp,"nanosec":0}}}});
        tasks.observe(1,&status(1,1));
        let id=tasks.begin_arm_mode(owner("page-motion")).unwrap();
        let outcome=tasks.controller_outcome(id).unwrap();tasks.controller_sent(id).unwrap();
        let disabled=tasks.admit(owner("page-motor"),&json!({"op":"joint_command","mode":3}),now).unwrap();
        assert!((disabled.permit.unwrap())()); // User stop always remains sendable.
        let early=tasks.poll(1,now).unwrap();assert!((early.permit)());
        tasks.disable_reply(id,early.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":10})));
        tasks.observe(1,&status(10,2));assert!(tasks.snapshot().is_some());
        tasks.controller_remote_completed(id);
        tasks.disable_reply(id,early.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":10})));
        tasks.observe(1,&status(10,3));assert!(tasks.snapshot().is_some());
        assert!(!tasks.controller_finish(id,true,"")); // Target state verification cannot clear a requested stop.
        tasks.finish_action(id,early.action);
        let after=tasks.poll(1,Instant::now()).unwrap();assert!(after.action>early.action);
        tasks.disable_reply(id,early.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":20})));
        tasks.observe(1,&status(20,4));assert!(tasks.snapshot().is_some()); // wrong action number
        tasks.disable_reply(id,after.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":30})));
        tasks.observe(1,&status(29,5));assert!(tasks.snapshot().is_some());
        tasks.observe(1,&status(30,6));assert!(tasks.snapshot().is_none());
        assert_eq!(*outcome.borrow(),super::super::controller_stop::Outcome::Disabled);
        let next=tasks.begin_arm_mode(owner("page-status")).unwrap();
        tasks.disable_reply(id,after.action,1,Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":40})));
        assert_eq!(tasks.snapshot().unwrap().id,next);
    }
    #[test]
    fn supported_disable_stop_is_scoped_to_the_original_robot() {
        let tasks=Arc::new(Tasks::default());let now=Instant::now();
        let profile=json!({"host":"original","commandTopic":"/cmd","statusTopic":"/status"});
        tasks.configure_motor(1,&profile);
        let id=tasks.begin_controller(owner("page-status")).unwrap();tasks.controller_sent(id).unwrap();
        let mut other=profile.clone();other["host"]=json!("other");
        assert!(!tasks.request_controller_disable(&other));assert!(tasks.poll(1,now).is_none());
        assert!(tasks.request_controller_disable(&profile));assert!(tasks.poll(1,now).is_some());
        assert!(!tasks.controller_finish(id,true,""));
    }

    #[test]
    fn controller_stop_before_submission_cancels_switch_but_not_disable_send_permission() {
        let tasks=Arc::new(Tasks::default());let now=Instant::now();
        let id=tasks.begin_controller(owner("page-motion")).unwrap();
        let outcome=tasks.controller_outcome(id).unwrap();
        let stop=tasks.admit(owner("main"),&json!({"op":"joint_command","mode":3}),now).unwrap();
        assert!(tasks.controller_sent(id).is_err());
        assert!(tasks.poll(1,now).is_none());
        assert!(tasks.snapshot().is_none());assert!((stop.permit.unwrap())());
        assert_eq!(*outcome.borrow(),super::super::controller_stop::Outcome::Finished);
    }

    #[test]
    fn controller_and_page_migration_race_has_exactly_one_winner() {
        for _ in 0..32 {
            let tasks=Arc::new(Tasks::default());
            let barrier=Arc::new(std::sync::Barrier::new(2));
            let moving=tasks.clone();let start=barrier.clone();
            let thread=std::thread::spawn(move || {start.wait();moving.migration("page-motion")});
            barrier.wait();let operation=tasks.begin_controller(owner("page-motion"));
            let migration=thread.join().unwrap();
            assert_ne!(operation.is_ok(),migration.is_ok());
        }
    }
    #[test]
    fn controller_lost_before_send_cannot_later_execute() {
        let tasks=Arc::new(Tasks::default());let owner=owner("page-motion");
        let id=tasks.begin_controller(owner.clone()).unwrap();
        tasks.lost(Some(&owner),"window lost");
        assert!(tasks.controller_sent(id).is_err());assert!(tasks.snapshot().is_none());
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

#[cfg(test)]
mod gravity_tests {
    use super::*;
    fn owner() -> Owner { Owner { epoch: 1, window: WindowToken { label:"page-gravity".into(),incarnation:1 } } }
    #[test]
    fn gravity_requires_owner_and_correlated_terminal_not_cancel_ack_or_feedback() {
        let tasks=Arc::new(Tasks::default()); let now=Instant::now();
        let request=json!({"op":"gravity_id_send_goal","command_id":"gravity-1"});
        let mut wrong=owner();wrong.window.label="main".into();
        assert!(tasks.admit(wrong,&request,now).is_err());
        let admitted=tasks.admit(owner(),&request,now).unwrap();
        assert!(tasks.migration("page-gravity").is_err()); assert!(admitted.permit.unwrap()());
        tasks.reply(admitted.ticket,1,&request,Ok(&json!({"op":"gravity_id_send_goal_ack","accepted":true,"command_id":"gravity-1"})));
        let heartbeat=tasks.poll(1,now).unwrap();
        assert_eq!(heartbeat.message["op"],"gravity_id_heartbeat");
        tasks.finish_action(heartbeat.ticket,heartbeat.action);
        tasks.lost(Some(&owner()),"closed");
        assert!(!(heartbeat.permit)());
        let cancel=tasks.poll(1,now).unwrap();assert_eq!(cancel.message["command_id"],"gravity-1");
        assert_eq!(cancel.message["op"],"gravity_id_cancel");
        for event in [
            json!({"op":"gravity_id_cancel_ack","accepted":true,"command_id":"gravity-1"}),
            json!({"op":"gravity_id_status","status":"idle","command_id":"gravity-1"}),
            json!({"op":"gravity_id_feedback","phase":8,"command_id":"gravity-1"}),
            json!({"op":"gravity_id_result","terminal":false,"task_phase":"succeeded","command_id":"gravity-1"}),
            json!({"op":"gravity_id_result","terminal":true,"task_phase":"succeeded","command_id":"old"}),
        ] {tasks.observe(1,&event); assert!(tasks.snapshot().is_some());}
        tasks.observe(1,&json!({"op":"gravity_id_result","terminal":true,"task_phase":"canceled","command_id":"gravity-1"}));
        assert!(tasks.snapshot().is_none());assert!(tasks.migration("page-gravity").is_ok());
    }
    #[test]
    fn gravity_recovery_requires_full_retained_matching_terminal() {
        let tasks=Arc::new(Tasks::default());let now=Instant::now();
        let a=tasks.admit(owner(),&json!({"op":"gravity_id_send_goal","command_id":"g"}),now).unwrap();
        assert!(a.permit.unwrap()());tasks.lost(None,"disconnected");
        let probe=tasks.poll(2,now).unwrap();assert_eq!(probe.message["op"],"gravity_id_task_status");
        let proof=json!({"op":"gravity_id_task_status","command_id":"g","known":true,"terminal":true,"status":"failed",
            "result":{"op":"gravity_id_result","command_id":"g","terminal":true,"task_phase":"failed"}});
        for key in ["command_id","known","terminal","result"] {let mut bad=proof.clone();bad[key]=Value::Null;assert!(!tasks.recover(a.ticket.unwrap(),2,&bad));}
        assert!(tasks.recover(a.ticket.unwrap(),2,&proof));
        assert!(!(probe.permit)());assert!(tasks.snapshot().is_none());
    }
}
