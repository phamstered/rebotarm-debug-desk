//! App-owned bag operations and process-bound running lifetime. Remote publication is single-shot;
//! a lost SSH reply is recovered by journal query, never by replaying control.
use super::{
    bag_receipt::Receipt,
    controller_journal::{Job, Proof},
    controller_task::same_profile,
    observations::{Snapshot as Observations, Source},
    runtime::Runtime,
    tasks::{LocalOperation, Owner, Tasks},
};
use crate::ConnectionProfile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Record,
    Play,
}
impl Kind {
    pub fn source(self) -> Source {
        match self {
            Self::Record => Source::BagRecord,
            Self::Play => Source::BagPlay,
        }
    }
    fn field(self) -> &'static str {
        match self {
            Self::Record => "recording",
            Self::Play => "playing",
        }
    }
    fn authorized(self, label: &str) -> bool {
        match self {
            Self::Record => matches!(label, "main" | "page-dashboard" | "page-motion"),
            Self::Play => label == "page-monitor",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Submitting,
    Verifying,
    Uncertain,
    Running,
    Succeeded,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub id: u64,
    pub kind: Kind,
    pub window: String,
    pub host: String,
    pub starting: bool,
    pub phase: Phase,
    pub message: String,
}
struct Entry {
    snapshot: Snapshot,
    owner: Owner,
    sent: bool,
    profile: Value,
    receipt: Option<Receipt>,
    permit: Option<LocalOperation>,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    entries: BTreeMap<Kind, Entry>,
}
#[derive(Default)]
pub struct Operations {
    inner: Mutex<Inner>,
}
impl Operations {
    pub fn snapshot(&self) -> Vec<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .entries
            .values()
            .map(|e| e.snapshot.clone())
            .collect()
    }
    pub fn begin(
        &self,
        tasks: &Arc<Tasks>,
        owner: Owner,
        kind: Kind,
        starting: bool,
        profile: Value,
    ) -> Result<u64, String> {
        if !kind.authorized(&owner.window.label) {
            return Err("当前页面无权执行此 rosbag 操作".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if starting && kind == Kind::Record { tasks.check_activity(super::activity::Check::RecordStart)?; }
        let id = inner.sequence.checked_add(1).ok_or("rosbag 操作编号耗尽")?;
        let (permit, receipt) =
            if let Some(previous) = inner.entries.get_mut(&kind).filter(|e| e.permit.is_some()) {
                if starting
                    || previous.sent
                    || previous.receipt.is_none()
                    || !same_profile(&previous.profile, &profile)
                {
                    return Err("此 rosbag 操作仍在原生层核验，或属于另一连接，不能重复提交".into());
                }
                // Explicit stop may transfer ownership to another authorized page.
                previous
                    .permit
                    .as_mut()
                    .unwrap()
                    .transfer(&owner.window.label)?;
                (previous.permit.take().unwrap(), previous.receipt.clone())
            } else {
                let permit = if kind == Kind::Play {
                    tasks.playback_operation(&owner.window.label, starting)?
                } else if starting {
                    tasks.sampling_operation(&owner.window.label)?
                } else {
                    tasks.settling_operation(&owner.window.label)?
                };
                (permit, None)
            };
        inner.sequence = id;
        inner.entries.insert(
            kind,
            Entry {
                snapshot: Snapshot {
                    id,
                    kind,
                    window: owner.window.label.clone(),
                    host: profile["host"].as_str().unwrap_or("").into(),
                    starting,
                    phase: Phase::Submitting,
                    message: "等待原生提交".into(),
                },
                owner,
                sent: false,
                profile,
                receipt,
                permit: Some(permit),
            },
        );
        Ok(id)
    }
    pub fn sending(&self, kind: Kind, id: u64, owner: &Owner) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .entries
            .get_mut(&kind)
            .filter(|e| e.snapshot.id == id && e.owner == *owner && e.permit.is_some() && !e.sent)
            .ok_or("rosbag 操作或所属页面已失效")?;
        entry.sent = true;
        entry.snapshot.phase = Phase::Verifying;
        entry.snapshot.message = "等待远端完成记录及新状态".into();
        Ok(())
    }
    pub fn update(&self, kind: Kind, id: u64, phase: Phase, message: &str, terminal: bool) {
        // Drop migration permits outside our mutex, preserving the global lock order.
        let permit = {
            let mut inner = self.inner.lock().unwrap();
            let Some(entry) = inner
                .entries
                .get_mut(&kind)
                .filter(|e| e.snapshot.id == id && e.permit.is_some())
            else {
                return;
            };
            entry.snapshot.phase = phase;
            entry.snapshot.message = message.chars().take(512).collect();
            if terminal {
                entry.permit.take()
            } else {
                None
            }
        };
        drop(permit);
    }
    fn running(&self, kind: Kind, id: u64, receipt: Receipt) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(entry) = inner
            .entries
            .get_mut(&kind)
            .filter(|e| e.snapshot.id == id && e.permit.is_some())
        else {
            return false;
        };
        entry.receipt = Some(receipt);
        entry.sent = false;
        entry.snapshot.phase = Phase::Running;
        entry.snapshot.message = "进程组正在运行；停止或自然退出核验后释放占用".into();
        true
    }
    fn retained(&self, kind: Kind, id: u64) -> Option<Receipt> {
        self.inner
            .lock()
            .unwrap()
            .entries
            .get(&kind)
            .filter(|e| e.snapshot.id == id && e.permit.is_some())
            .and_then(|e| e.receipt.clone())
    }
    fn check_running(&self, kind: Kind, id: u64, context: &Value, snapshot: &Observations) -> bool {
        let original = {
            let inner = self.inner.lock().unwrap();
            inner
                .entries
                .get(&kind)
                .filter(|e| e.snapshot.id == id && e.permit.is_some() && !e.sent)
                .and_then(|e| e.receipt.as_ref().map(|r| (e.profile.clone(), r.clone())))
        };
        let Some((profile, receipt)) = original else {
            return false;
        };
        if context["connected"] == true
            && same_profile(&profile, &context["profile"])
            && context["epoch"].as_u64() == Some(snapshot.epoch)
        {
            if let Some((_, live)) =
                current(snapshot, kind).filter(|(_, r)| receipt.same_instance(r))
            {
                if !live.active {
                    self.update(kind, id, Phase::Succeeded, "已核验原 bag 进程组退出", true);
                    return false;
                }
                self.update(
                    kind,
                    id,
                    Phase::Running,
                    "进程组运行中，原生层继续核验退出",
                    false,
                );
                return true;
            }
        }
        self.update(
            kind,
            id,
            Phase::Uncertain,
            "等待原连接的新鲜 bag 进程身份与退出状态",
            false,
        );
        true
    }
    fn abandoned(&self, kind: Kind, id: u64) {
        let sent = self
            .inner
            .lock()
            .unwrap()
            .entries
            .get(&kind)
            .filter(|e| e.snapshot.id == id && e.permit.is_some())
            .map(|e| e.sent);
        if let Some(sent) = sent {
            if !sent && self.retained(kind, id).is_some() {
                return;
            }
            self.update(
                kind,
                id,
                if sent {
                    Phase::Uncertain
                } else {
                    Phase::Failed
                },
                if sent {
                    "原生任务异常退出；结果未确认，保留操作占用"
                } else {
                    "操作在发送前撤销"
                },
                !sent,
            );
        }
    }
}
fn current(snapshot: &Observations, kind: Kind) -> Option<(Value, Receipt)> {
    if !snapshot.connected {
        return None;
    }
    let entry = snapshot.entries.get(&kind.source())?;
    if entry.error.is_some() || entry.age_ms >= entry.ttl_ms {
        return None;
    }
    let value = entry.value.as_ref()?;
    let receipt = Receipt::parse(value.get("receipt")?.clone()).ok()?;
    let path_field = if kind == Kind::Play {
        "bagPath"
    } else {
        "outputPath"
    };
    if receipt.kind != kind
        || value[kind.field()].as_bool() != Some(receipt.active)
        || value["pid"].as_u64() != Some(receipt.pid.into())
        || !receipt.path_matches(value[path_field].as_str()?)
    {
        return None;
    }
    Some((value.clone(), receipt))
}
fn verified(
    snapshot: &Observations,
    kind: Kind,
    starting: bool,
    path: &str,
    proof: &Receipt,
) -> Option<Value> {
    let (value, receipt) = current(snapshot, kind)?;
    if (!starting && (receipt.active || proof.active))
        || (starting && !proof.active && receipt.active)
        || !proof.same_instance(&receipt)
        || (kind == Kind::Play && starting && !receipt.path_matches(path))
    {
        return None;
    }
    Some(value)
}

struct Guard {
    operations: Arc<Operations>,
    kind: Kind,
    id: u64,
    app: AppHandle,
}
impl Guard {
    fn update(&self, phase: Phase, message: &str, terminal: bool) {
        self.operations
            .update(self.kind, self.id, phase, message, terminal);
        let _ = self.app.emit("native-bag-operations-changed", ());
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.operations.abandoned(self.kind, self.id);
        let _ = self.app.emit("native-bag-operations-changed", ());
    }
}

pub async fn start(
    app: AppHandle,
    label: String,
    hub: &Runtime,
    profile: ConnectionProfile,
    kind: Kind,
    starting: bool,
    path: String,
    remote: String,
) -> Result<Value, String> {
    let mut journal = Job::new(super::controller_journal::new_bag_id()?, remote)?;
    let (id, owner) = hub.begin_bag(&label, &profile, kind, starting)?;
    let guard = Guard {
        operations: hub.bag_operations.clone(),
        kind,
        id,
        app,
    };
    guard.update(Phase::Submitting, "操作已由原生层接管", false);
    owned(async move {
        let hub = guard.app.state::<Runtime>();
        let check = if starting {
            hub.tasks.check_activity(if kind == Kind::Play { super::activity::Check::PlaybackStart } else { super::activity::Check::RecordStart })
        } else { Ok(()) };
        if let Err(message) = check.and_then(|_| hub.send_bag(&owner, id, &profile, kind)) {
            rejected(guard, profile, &message);
            return Err(message);
        }
        // Exactly one attempt. Even a transport timeout may have started the job.
        let mut proof = journal.submit(&profile).await.ok();
        let original = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
        let mut completed: Option<Receipt> = None;
        loop {
            match proof.take() {
                Some(Proof::BagSucceeded(value)) => match Receipt::parse(value) {
                    Ok(receipt)
                        if receipt.kind == kind
                            && (receipt.domain == Some(profile.ros_domain_id)
                                || (!starting && receipt.domain.is_none())) =>
                    {
                        completed = Some(receipt)
                    }
                    _ => {
                        guard.update(Phase::Uncertain, "bag 完成回执身份无效，保留占用", false);
                        return Err("bag 完成回执无效".into());
                    }
                },
                Some(Proof::Rejected(message)) => {
                    rejected(guard, profile, &message);
                    return Err(message);
                }
                Some(Proof::Uncertain(message)) => guard.update(Phase::Uncertain, &message, false),
                _ => {}
            }
            let context = hub.context();
            if context["connected"] == true
                && super::controller_task::same_profile(&original, &context["profile"])
            {
                if let Some(receipt) = &completed {
                    if let Some(epoch) = context["epoch"].as_u64() {
                        if let Ok(snapshot) =
                            hub.observations.refresh(epoch, kind.source(), true).await
                        {
                            if let Some(value) = verified(&snapshot, kind, starting, &path, receipt)
                            {
                                if let Some(previous) = guard.operations.retained(kind, id) {
                                    if !previous.same_instance(receipt) {
                                        guard.update(
                                            Phase::Uncertain,
                                            "原运行实例与停止回执不一致，保留占用",
                                            false,
                                        );
                                        return Err("rosbag 进程身份已改变".into());
                                    }
                                }
                                if starting && value[kind.field()] == true {
                                    guard.operations.running(kind, id, receipt.clone());
                                    guard.update(
                                        Phase::Running,
                                        "进程组运行中，原生层继续核验退出",
                                        false,
                                    );
                                    monitor(guard);
                                } else {
                                    guard.update(
                                        Phase::Succeeded,
                                        "远端操作完成，已核验进程组退出",
                                        true,
                                    );
                                }
                                return Ok(value);
                            }
                        }
                    }
                } else {
                    proof = journal.query(&profile).await.ok();
                }
            }
            guard.update(
                if completed.is_some() {
                    Phase::Verifying
                } else {
                    Phase::Uncertain
                },
                if completed.is_some() {
                    "远端命令已完成，等待原连接的新鲜 rosbag 状态"
                } else {
                    "执行结果未确认；仅查询原连接的远端记录，不重发操作"
                },
                false,
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
    .await
}
fn rejected(guard: Guard, _profile: ConnectionProfile, message: &str) {
    if let Some(receipt) = guard.operations.retained(guard.kind, guard.id) {
        guard
            .operations
            .running(guard.kind, guard.id, receipt.clone());
        guard.update(Phase::Running, message, false);
        monitor(guard);
    } else {
        guard.update(Phase::Failed, message, true);
    }
}
fn monitor(guard: Guard) {
    tokio::spawn(async move {
        loop {
            let hub = guard.app.state::<Runtime>();
            let before = guard.operations.snapshot();
            let keep = guard.operations.check_running(
                guard.kind,
                guard.id,
                &hub.context(),
                &hub.observations.snapshot(),
            );
            if guard.operations.snapshot() != before {
                let _ = guard.app.emit("native-bag-operations-changed", ());
            }
            if !keep {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

async fn owned<F>(work: F) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    let (send, receive) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let result = work.await;
        let _ = send.send(result);
    });
    match tokio::time::timeout(Duration::from_secs(25), receive).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("rosbag 原生任务异常退出；请查看共享任务状态".into()),
        Err(_) => Err("rosbag 操作仍在原生层核验；不要重复提交，请查看共享任务状态".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{observations::Observation, windows::WindowToken};
    use super::*;
    use serde_json::json;
    use sha2::Digest;
    fn owner(label: &str) -> Owner {
        Owner {
            epoch: 1,
            window: WindowToken {
                label: label.into(),
                incarnation: 1,
            },
        }
    }
    #[test]
    fn bag_admission_reserves_migration_and_serializes_each_resource_across_windows() {
        let tasks = Arc::new(Tasks::default());
        let operations = Operations::default();
        assert!(operations
            .begin(
                &tasks,
                owner("page-handeye"),
                Kind::Record,
                true,
                "fixture".into()
            )
            .is_err());
        assert!(operations
            .begin(
                &tasks,
                owner("page-motion"),
                Kind::Play,
                true,
                "fixture".into()
            )
            .is_err());
        let moving = tasks.migration("page-motion").unwrap();
        assert!(operations
            .begin(
                &tasks,
                owner("page-motion"),
                Kind::Record,
                true,
                "fixture".into()
            )
            .is_err());
        drop(moving);
        let id = operations
            .begin(
                &tasks,
                owner("page-motion"),
                Kind::Record,
                true,
                "fixture".into(),
            )
            .unwrap();
        assert!(tasks.migration("page-motion").is_err());
        assert!(operations
            .begin(
                &tasks,
                owner("page-dashboard"),
                Kind::Record,
                false,
                "fixture".into()
            )
            .is_err());
        assert!(tasks.migration("page-dashboard").is_ok()); // Rejected admission did not leak its permit.
        assert!(operations
            .begin(
                &tasks,
                owner("page-monitor"),
                Kind::Play,
                true,
                "fixture".into(),
            )
            .is_err());
        assert!(operations
            .sending(Kind::Record, id, &owner("page-dashboard"))
            .is_err());
        let mut replaced = owner("page-motion");
        replaced.window.incarnation += 1;
        assert!(operations.sending(Kind::Record, id, &replaced).is_err());
        operations
            .sending(Kind::Record, id, &owner("page-motion"))
            .unwrap();
        assert!(operations
            .sending(Kind::Record, id, &owner("page-motion"))
            .is_err());
        operations.abandoned(Kind::Record, id);
        assert!(tasks.migration("page-motion").is_err());
        assert_eq!(
            operations
                .snapshot()
                .iter()
                .find(|t| t.id == id)
                .unwrap()
                .phase,
            Phase::Uncertain
        );
        assert!(tasks.migration("page-monitor").is_ok());
        operations.update(Kind::Record, id, Phase::Succeeded, "confirmed", true);
        assert!(tasks.migration("page-motion").is_ok());
        let play = operations
            .begin(
                &tasks,
                owner("page-monitor"),
                Kind::Play,
                true,
                "fixture".into(),
            )
            .unwrap();
        operations.abandoned(Kind::Play, play);
        assert!(tasks.migration("page-monitor").is_ok());
        let next = operations
            .begin(
                &tasks,
                owner("page-dashboard"),
                Kind::Record,
                false,
                "fixture".into(),
            )
            .unwrap();
        operations.update(Kind::Record, id, Phase::Succeeded, "old", true);
        assert!(tasks.migration("page-dashboard").is_err());
        assert_ne!(id, next);
        operations.abandoned(Kind::Record, next);
    }
    fn profile() -> Value {
        json!({"host":"fixture","sshPort":22,"username":"","identityFile":"","localPort":18765,"remotePort":8765,
        "rosDomainId":197,"rosSetupScript":"test/install/setup.bash","commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"})
    }
    fn proof(kind: Kind, active: bool) -> Receipt {
        Receipt::parse(json!({"kind":kind,"active":active,"pid":if active {42}else{0},"domain":197,
            "processIdentity":"a".repeat(64),"pathHash":format!("{:x}",sha2::Sha256::digest(b"bags/a"))})).unwrap()
    }
    fn observed(kind: Kind, active: bool) -> Observations {
        Observations{epoch:1,connected:true,revision:1,handler_elapsed_ms:0,entries:[(kind.source(),Observation{sequence:1,
            value:Some(json!({kind.field():active,"pid":if active {42}else{0},"bagPath":"bags/a","outputPath":"bags/a","receipt":proof(kind,active)})),
            error:None,age_ms:0,ttl_ms:8000})].into_iter().collect()}
    }
    #[test]
    fn bag_completion_requires_fresh_correct_instance_domain_and_requested_path() {
        for kind in [Kind::Record, Kind::Play] {
            for active in [true, false] {
                let good = observed(kind, active);
                let receipt = proof(kind, active);
                assert!(verified(&good, kind, active, "bags/a", &receipt).is_some());
                for fault in 0..10 {
                    let mut bad = good.clone();
                    let entry = bad.entries.get_mut(&kind.source()).unwrap();
                    match fault {
                        0 => entry.age_ms = 8000,
                        1 => entry.error = Some("SSH".into()),
                        2 => entry.value.as_mut().unwrap()[kind.field()] = json!(!active),
                        3 => entry.value.as_mut().unwrap()["pid"] = json!(99),
                        4 => entry.value = None,
                        5 => {
                            entry.value.as_mut().unwrap()["receipt"]["processIdentity"] =
                                json!("b".repeat(64))
                        }
                        6 => entry.value.as_mut().unwrap()["receipt"]["domain"] = json!(198),
                        7 => entry.value.as_mut().unwrap()["receipt"] = Value::Null,
                        8 => {
                            entry.value.as_mut().unwrap()["receipt"]["pathHash"] =
                                json!("f".repeat(64))
                        }
                        _ => bad.connected = false,
                    }
                    assert!(
                        verified(&bad, kind, active, "bags/a", &receipt).is_none(),
                        "{kind:?}/{active}/{fault}"
                    );
                }
            }
        }
        assert!(verified(
            &observed(Kind::Play, true),
            Kind::Play,
            true,
            "other",
            &proof(Kind::Play, true)
        )
        .is_none());
        assert!(
            verified(
                &observed(Kind::Play, false),
                Kind::Play,
                true,
                "bags/a",
                &proof(Kind::Play, true)
            )
            .is_some(),
            "fast natural exit is proven by the same identity"
        );
    }
    #[test]
    fn running_process_holds_migration_and_playback_excludes_motion_until_bound_exit() {
        use std::time::Instant;
        for kind in [Kind::Record, Kind::Play] {
            let tasks = Arc::new(Tasks::default());
            let ops = Operations::default();
            let label = if kind == Kind::Play {
                "page-monitor"
            } else {
                "page-motion"
            };
            let id = ops
                .begin(&tasks, owner(label), kind, true, profile())
                .unwrap();
            ops.sending(kind, id, &owner(label)).unwrap();
            ops.running(kind, id, proof(kind, true));
            ops.abandoned(kind, id);
            assert!(tasks.migration(label).is_err());
            let motion = json!({"op":"position_move","command_id":"movement"});
            if kind == Kind::Play {
                assert!(tasks
                    .admit(owner("page-motion"), &motion, Instant::now())
                    .is_err());
            }
            let context = json!({"connected":true,"epoch":1,"profile":profile()});
            for fault in 0..5 {
                let mut ctx = context.clone();
                let mut state = observed(kind, false);
                match fault {
                    0 => ctx["profile"]["host"] = json!("other"),
                    1 => ctx["epoch"] = json!(2),
                    2 => state.connected = false,
                    3 => state.entries.get_mut(&kind.source()).unwrap().age_ms = 8000,
                    _ => {
                        state
                            .entries
                            .get_mut(&kind.source())
                            .unwrap()
                            .value
                            .as_mut()
                            .unwrap()["receipt"]["processIdentity"] = json!("b".repeat(64))
                    }
                }
                assert!(ops.check_running(kind, id, &ctx, &state));
                assert!(tasks.migration(label).is_err());
            }
            assert!(ops.check_running(kind, id, &context, &observed(kind, true)));
            assert_eq!(ops.snapshot()[0].phase, Phase::Running);
            assert!(!ops.check_running(kind, id, &context, &observed(kind, false)));
            assert!(tasks.migration(label).is_ok());
            assert!(tasks
                .admit(owner("page-motion"), &motion, Instant::now())
                .is_ok());
        }
    }
    #[test]
    fn stop_transfers_running_ownership_but_late_monitor_cannot_release_new_operation() {
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let kind = Kind::Record;
        let id = ops
            .begin(&tasks, owner("page-motion"), kind, true, profile())
            .unwrap();
        ops.sending(kind, id, &owner("page-motion")).unwrap();
        ops.running(kind, id, proof(kind, true));
        assert!(ops
            .begin(&tasks, owner("page-dashboard"), kind, true, profile())
            .is_err());
        let mut wrong = profile();
        wrong["host"] = json!("other");
        assert!(ops
            .begin(&tasks, owner("page-dashboard"), kind, false, wrong)
            .is_err());
        let stop = ops
            .begin(&tasks, owner("page-dashboard"), kind, false, profile())
            .unwrap();
        assert!(tasks.migration("page-dashboard").is_err());
        assert!(tasks.migration("page-motion").is_ok());
        let ctx = json!({"connected":true,"epoch":1,"profile":profile()});
        assert!(!ops.check_running(kind, id, &ctx, &observed(kind, false)));
        assert!(tasks.migration("page-dashboard").is_err());
        // Proven pre-submit rejection restores monitoring; unknown submitted stop stays occupied.
        ops.running(kind, stop, proof(kind, true));
        ops.abandoned(kind, stop);
        assert!(ops.check_running(kind, stop, &ctx, &observed(kind, true)));
        ops.sending(kind, stop, &owner("page-dashboard")).unwrap();
        ops.abandoned(kind, stop);
        assert!(ops
            .begin(&tasks, owner("page-dashboard"), kind, false, profile())
            .is_err());
        assert!(tasks.migration("page-dashboard").is_err());
    }
    #[test]
    fn playback_excludes_sampling_but_allows_offline_image_computation() {
        let tasks = Arc::new(Tasks::default());
        let compute = tasks.local_operation("page-handeye").unwrap();
        let playback = tasks.playback_operation("page-monitor", true).unwrap();
        drop(compute);
        assert!(tasks.local_operation("page-handeye").is_ok());
        assert!(tasks.sampling_operation("page-handeye").is_err());
        assert!(tasks.sampling_operation("page-collection").is_err());
        drop(playback);
        let capture = tasks.sampling_operation("page-handeye").unwrap();
        assert!(tasks.playback_operation("page-monitor", true).is_err());
        drop(capture);
        assert!(tasks.playback_operation("page-monitor", true).is_ok());
    }
    #[test]
    fn playback_admission_races_atomically_with_motion_and_keeps_disable_and_stop_available() {
        use std::{sync::Barrier, thread, time::Instant};
        for _ in 0..20 {
            let tasks = Arc::new(Tasks::default());
            let gate = Arc::new(Barrier::new(2));
            let a = tasks.clone();
            let b = gate.clone();
            let motion = thread::spawn(move || {
                b.wait();
                a.admit(
                    owner("page-motion"),
                    &json!({"op":"position_move","command_id":"race"}),
                    Instant::now(),
                )
                .is_ok()
            });
            let a = tasks.clone();
            let b = gate.clone();
            let playback = thread::spawn(move || {
                b.wait();
                a.playback_operation("page-monitor", true)
            });
            let moving = motion.join().unwrap();
            let playing = playback.join().unwrap();
            assert_ne!(moving, playing.is_ok());
            assert!(tasks
                .admit(
                    owner("page-motor"),
                    &json!({"op":"joint_command","mode":3}),
                    Instant::now()
                )
                .is_ok());
        }
        let tasks = Arc::new(Tasks::default());
        tasks
            .admit(
                owner("page-motion"),
                &json!({"op":"position_move","command_id":"running"}),
                Instant::now(),
            )
            .unwrap();
        let stop = tasks.playback_operation("page-monitor", false).unwrap();
        assert!(tasks.migration("page-monitor").is_err());
        drop(stop);
        assert!(tasks.migration("page-monitor").is_ok());
    }
    #[tokio::test]
    async fn bag_worker_survives_invoking_future_exit_and_retains_migration_until_finish() {
        let tasks = Arc::new(Tasks::default());
        let operations = Arc::new(Operations::default());
        let id = operations
            .begin(
                &tasks,
                owner("page-motion"),
                Kind::Record,
                true,
                "fixture".into(),
            )
            .unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let copy = operations.clone();
        let caller = tokio::spawn(owned(async move {
            copy.sending(Kind::Record, id, &owner("page-motion"))?;
            let _ = started.send(());
            wait.await.unwrap();
            copy.update(Kind::Record, id, Phase::Succeeded, "verified", true);
            Ok(json!(true))
        }));
        ready.await.unwrap();
        caller.abort();
        let _ = caller.await;
        assert!(tasks.migration("page-motion").is_err());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while operations.snapshot()[0].phase != Phase::Succeeded {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(tasks.migration("page-motion").is_ok());
    }
}
