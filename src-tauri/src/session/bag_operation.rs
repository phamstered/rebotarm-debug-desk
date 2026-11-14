//! App-owned bag operations and process-bound running lifetime. Remote publication is single-shot;
//! a lost SSH reply is recovered by journal query, never by replaying control.
use super::{
    bag_receipt::Receipt,
    bag_recovery::{Record, Store},
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
    pub(super) fn authorized(self, label: &str) -> bool {
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
    pub recovery_error: bool,
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
    recovery: Option<Record>,
    prepared: bool,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    entries: BTreeMap<Kind, Entry>,
    store: Store,
}
#[derive(Default)]
pub struct Operations {
    inner: Mutex<Inner>,
}
impl Operations {
    fn restore(&self, tasks: &Arc<Tasks>, store: Store) -> Vec<(u64, Record)> {
        let mut inner = self.inner.lock().unwrap();
        let records = store.records();
        inner.store = store;
        let mut recovered = Vec::new();
        for record in records {
            let permit = if record.kind == Kind::Play {
                tasks.playback_operation(&record.window, false)
            } else {
                tasks.settling_operation(&record.window)
            };
            match permit {
                Ok(permit) => {
                    inner.sequence += 1;
                    let id = inner.sequence;
                    inner.entries.insert(
                        record.kind,
                        Entry {
                            snapshot: Snapshot {
                                recovery_error: false,
                                id,
                                kind: record.kind,
                                window: record.window.clone(),
                                host: record.profile["host"].as_str().unwrap_or("").into(),
                                starting: record.starting,
                                phase: Phase::Uncertain,
                                message: "桌面已重启，等待连接原机器人查询任务；不会重新提交"
                                    .into(),
                            },
                            owner: Owner {
                                epoch: 0,
                                window: super::windows::WindowToken {
                                    label: record.window.clone(),
                                    incarnation: 0,
                                },
                            },
                            sent: record.running.is_none(),
                            profile: record.profile.clone(),
                            receipt: record.running.clone().or(record.previous.clone()),
                            permit: Some(permit),
                            recovery: Some(record.clone()),
                            prepared: true,
                        },
                    );
                    recovered.push((id, record));
                }
                Err(error) => inner.store.error = Some(format!("bag 恢复占用失败：{error}")),
            }
        }
        if let Some(error) = &inner.store.error {
            tasks.recovery_failed(error.clone());
        }
        recovered
    }
    pub fn snapshot(&self) -> Vec<Snapshot> {
        let inner = self.inner.lock().unwrap();
        let mut snapshots: Vec<_> = inner.entries.values().map(|e| e.snapshot.clone()).collect();
        if let Some(error) = &inner.store.error {
            snapshots.push(Snapshot {
                recovery_error: true,
                id: 0,
                kind: Kind::Play,
                window: "main".into(),
                host: "".into(),
                starting: false,
                phase: Phase::Uncertain,
                message: error.clone(),
            });
        }
        snapshots
    }
    #[cfg(test)]
    pub fn begin(
        &self,
        tasks: &Arc<Tasks>,
        owner: Owner,
        kind: Kind,
        starting: bool,
        profile: Value,
    ) -> Result<u64, String> {
        self.begin_validated(tasks, kind, starting, profile, || Ok((owner, ())))
    }
    pub fn begin_validated<G>(
        &self,
        tasks: &Arc<Tasks>,
        kind: Kind,
        starting: bool,
        profile: Value,
        validate: impl FnOnce() -> Result<(Owner, G), String>,
    ) -> Result<u64, String> {
        let mut inner = self.inner.lock().unwrap();
        let (owner, _connection) = validate()?;
        if !kind.authorized(&owner.window.label) {
            return Err("当前页面无权执行此 rosbag 操作".into());
        }
        if starting {
            if let Some(error) = &inner.store.error {
                return Err(error.clone());
            }
        }
        if starting && kind == Kind::Record {
            tasks.check_activity(super::activity::Check::RecordStart)?;
        }
        let id = inner.sequence.checked_add(1).ok_or("rosbag 操作编号耗尽")?;
        let (permit, receipt, recovery) =
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
                (
                    previous.permit.take().unwrap(),
                    previous.receipt.clone(),
                    previous.recovery.clone(),
                )
            } else {
                let permit = if kind == Kind::Play {
                    tasks.playback_operation(&owner.window.label, starting)?
                } else if starting {
                    tasks.sampling_operation(&owner.window.label)?
                } else {
                    tasks.settling_operation(&owner.window.label)?
                };
                (permit, None, None)
            };
        inner.sequence = id;
        inner.entries.insert(
            kind,
            Entry {
                snapshot: Snapshot {
                    recovery_error: false,
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
                recovery,
                prepared: false,
            },
        );
        Ok(id)
    }
    fn prepare(
        &self,
        kind: Kind,
        id: u64,
        ticket: super::controller_journal::Ticket,
        path: String,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .entries
            .get(&kind)
            .filter(|e| e.snapshot.id == id && e.permit.is_some() && !e.sent)
            .ok_or("bag 操作已失效，不能保存恢复记录")?;
        // A corrupt journal keeps a global admission barrier. Explicit stops may
        // still run without overwriting forensic evidence, just like DISABLE.
        if inner.store.error.is_some() && !entry.snapshot.starting {
            inner.entries.get_mut(&kind).unwrap().prepared = true;
            return Ok(());
        }
        let record = Record {
            kind,
            window: entry.snapshot.window.clone(),
            profile: entry.profile.clone(),
            starting: entry.snapshot.starting,
            path,
            ticket,
            previous: entry.receipt.clone(),
            running: None,
        };
        inner.store.save(record.clone())?;
        inner.entries.get_mut(&kind).unwrap().recovery = Some(record);
        inner.entries.get_mut(&kind).unwrap().prepared = true;
        Ok(())
    }
    #[cfg(test)]
    pub fn sending(&self, kind: Kind, id: u64, owner: &Owner) -> Result<(), String> {
        self.sending_validated(kind, id, owner, || Ok(()))
    }
    pub fn sending_validated<G>(
        &self,
        kind: Kind,
        id: u64,
        owner: &Owner,
        validate: impl FnOnce() -> Result<G, String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let _connection = validate()?;
        let durable = inner.store.configured();
        let entry = inner
            .entries
            .get_mut(&kind)
            .filter(|e| e.snapshot.id == id && e.owner == *owner && e.permit.is_some() && !e.sent)
            .ok_or("rosbag 操作或所属页面已失效")?;
        if durable && !entry.prepared {
            return Err("bag 恢复记录尚未落盘，拒绝提交".into());
        }
        entry.sent = true;
        entry.snapshot.phase = Phase::Verifying;
        entry.snapshot.message = "等待远端完成记录及新状态".into();
        Ok(())
    }
    pub fn update(&self, kind: Kind, id: u64, phase: Phase, message: &str, terminal: bool) -> bool {
        // Drop migration permits outside our mutex, preserving the global lock order.
        let permit = {
            let mut inner = self.inner.lock().unwrap();
            let Some(entry) = inner
                .entries
                .get(&kind)
                .filter(|e| e.snapshot.id == id && e.permit.is_some())
            else {
                return false;
            };
            if terminal {
                if let Some(ticket) = entry.recovery.as_ref().map(|r| r.ticket.clone()) {
                    if let Err(error) = inner.store.remove(kind, &ticket) {
                        let entry = inner.entries.get_mut(&kind).unwrap();
                        entry.snapshot.phase = Phase::Uncertain;
                        entry.snapshot.message =
                            format!("退出已核验，但恢复记录未清理，保留占用：{error}");
                        return false;
                    }
                }
            }
            let entry = inner.entries.get_mut(&kind).unwrap();
            entry.snapshot.phase = phase;
            entry.snapshot.message = message.chars().take(512).collect();
            if terminal {
                entry.permit.take()
            } else {
                None
            }
        };
        drop(permit);
        true
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
        entry.receipt = Some(receipt.clone());
        entry.sent = false;
        let record = entry.recovery.as_mut().map(|record| {
            record.running = Some(receipt);
            record.window = entry.snapshot.window.clone();
            record.clone()
        });
        if let Some(record) = record {
            if let Err(error) = inner.store.save(record) {
                let entry = inner.entries.get_mut(&kind).unwrap();
                entry.snapshot.phase = Phase::Uncertain;
                entry.snapshot.message = format!("进程运行中，恢复记录待落盘：{error}");
                return false;
            }
        }
        let entry = inner.entries.get_mut(&kind).unwrap();
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
                    return !self.update(
                        kind,
                        id,
                        Phase::Succeeded,
                        "已核验原 bag 进程组退出",
                        true,
                    );
                }
                self.running(kind, id, receipt);
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
/// Restore reservations before workspace initialization can admit any new task.
pub fn initialize(app: &AppHandle) {
    let hub = app.state::<Runtime>();
    let store = match app.path().app_config_dir() {
        Ok(path) => Store::open(path.join("bag-recovery-v1.json")),
        Err(error) => Store::failed(format!("bag 恢复目录不可用：{error}")),
    };
    for (id, record) in hub.bag_operations.restore(&hub.tasks, store) {
        let guard = Guard {
            operations: hub.bag_operations.clone(),
            kind: record.kind,
            id,
            app: app.clone(),
        };
        tauri::async_runtime::spawn(async move {
            if record.running.is_some() {
                monitor(guard);
                return;
            }
            // Records have already been validated by Store::open. Recovery has
            // no command payload and no path to Job::submit.
            let result = match (
                Job::recover(record.ticket),
                serde_json::from_value(record.profile),
            ) {
                (Ok(journal), Ok(profile)) => {
                    resolve(guard, profile, journal, None, record.starting, record.path).await
                }
                _ => {
                    guard.update(Phase::Uncertain, "恢复记录无效，保留占用", false);
                    return;
                }
            };
            let _ = result;
        });
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
    fn update(&self, phase: Phase, message: &str, terminal: bool) -> bool {
        let updated = self
            .operations
            .update(self.kind, self.id, phase, message, terminal);
        let _ = self.app.emit("native-bag-operations-changed", ());
        updated
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
            hub.tasks.check_activity(if kind == Kind::Play {
                super::activity::Check::PlaybackStart
            } else {
                super::activity::Check::RecordStart
            })
        } else {
            Ok(())
        };
        if let Err(message) = check
            .and_then(|_| {
                guard
                    .operations
                    .prepare(kind, id, journal.ticket(), path.clone())
            })
            .and_then(|_| hub.send_bag(&owner, id, &profile, kind))
        {
            rejected(guard, profile, &message);
            return Err(message);
        }
        // Exactly one attempt. Even a transport timeout may have started the job.
        let proof = journal.submit(&profile).await.ok();
        resolve(guard, profile, journal, proof, starting, path).await
    })
    .await
}
async fn resolve(
    guard: Guard,
    profile: ConnectionProfile,
    journal: Job,
    mut proof: Option<Proof>,
    starting: bool,
    path: String,
) -> Result<Value, String> {
    let hub = guard.app.state::<Runtime>();
    let kind = guard.kind;
    let id = guard.id;
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
            Some(Proof::Uncertain(message)) => {
                guard.update(Phase::Uncertain, &message, false);
            }
            _ => {}
        }
        let context = hub.context();
        if context["connected"] == true
            && super::controller_task::same_profile(&original, &context["profile"])
        {
            if let Some(receipt) = &completed {
                if let Some(epoch) = context["epoch"].as_u64() {
                    if let Ok(snapshot) = hub.observations.refresh(epoch, kind.source(), true).await
                    {
                        if let Some(value) = verified(&snapshot, kind, starting, &path, receipt) {
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
                                let _ = guard.app.emit("native-bag-operations-changed", ());
                                monitor(guard);
                            } else {
                                if !guard.update(
                                    Phase::Succeeded,
                                    "远端操作完成，已核验进程组退出",
                                    true,
                                ) {
                                    tokio::time::sleep(Duration::from_secs(2)).await;
                                    continue;
                                }
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
}

fn rejected(guard: Guard, _profile: ConnectionProfile, message: &str) {
    if let Some(receipt) = guard.operations.retained(guard.kind, guard.id) {
        guard
            .operations
            .running(guard.kind, guard.id, receipt.clone());
        let _ = guard.app.emit("native-bag-operations-changed", ());
        monitor(guard);
    } else {
        let message = message.to_string();
        tokio::spawn(async move {
            while guard.operations.snapshot().iter().any(|s| {
                s.kind == guard.kind
                    && s.id == guard.id
                    && s.phase != Phase::Succeeded
                    && s.phase != Phase::Failed
            }) && !guard.update(Phase::Failed, &message, true)
            {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
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
    fn recovery_path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(super::super::controller_journal::new_bag_id().unwrap())
            .join("bag.json")
    }
    #[test]
    fn restart_restores_write_ahead_ownership_and_never_treats_missing_reply_as_idle() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        assert!(ops.restore(&tasks, Store::open(path.clone())).is_empty());
        let id = ops
            .begin(&tasks, owner("page-monitor"), Kind::Play, true, profile())
            .unwrap();
        assert!(ops.sending(Kind::Play, id, &owner("page-monitor")).is_err());
        let job = Job::new(
            super::super::controller_journal::new_bag_id().unwrap(),
            "must-never-replay".into(),
        )
        .unwrap();
        ops.prepare(Kind::Play, id, job.ticket(), "bags/a".into())
            .unwrap();
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("must-never-replay"));
        ops.sending(Kind::Play, id, &owner("page-monitor")).unwrap();
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let restored = Operations::default();
        let pending = restored.restore(&tasks, Store::open(path.clone()));
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1.ticket, job.ticket());
        assert_eq!(restored.snapshot()[0].phase, Phase::Uncertain);
        assert!(tasks.migration("page-monitor").is_err());
        assert!(tasks
            .admit(
                owner("page-motion"),
                &json!({"op":"position_move","command_id":"forbidden"}),
                std::time::Instant::now()
            )
            .is_err());
        assert!(tasks
            .admit(
                owner("page-motor"),
                &json!({"op":"joint_command","mode":3}),
                std::time::Instant::now()
            )
            .is_ok());
        assert!(restored
            .begin(&tasks, owner("page-monitor"), Kind::Play, true, profile())
            .is_err());
        // A shared idle status alone cannot finish an unacknowledged submission.
        assert!(!restored.check_running(
            Kind::Play,
            pending[0].0,
            &json!({"connected":true,"epoch":1,"profile":profile()}),
            &observed(Kind::Play, false)
        ));
        assert_eq!(restored.snapshot()[0].phase, Phase::Uncertain);
        assert_eq!(Store::open(path.clone()).records().len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn restart_running_receipt_requires_original_profile_and_durable_terminal_cleanup() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        ops.restore(&tasks, Store::open(path.clone()));
        let id = ops
            .begin(&tasks, owner("page-monitor"), Kind::Play, true, profile())
            .unwrap();
        let job = Job::new(
            super::super::controller_journal::new_bag_id().unwrap(),
            "fixture".into(),
        )
        .unwrap();
        ops.prepare(Kind::Play, id, job.ticket(), "bags/a".into())
            .unwrap();
        ops.sending(Kind::Play, id, &owner("page-monitor")).unwrap();
        assert!(ops.running(Kind::Play, id, proof(Kind::Play, true)));
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let pending = ops.restore(&tasks, Store::open(path.clone()));
        let id = pending[0].0;
        assert!(pending[0].1.running.is_some());
        let context = json!({"connected":true,"epoch":1,"profile":profile()});
        let mut other = context.clone();
        other["profile"]["host"] = json!("another-robot");
        assert!(ops.check_running(Kind::Play, id, &other, &observed(Kind::Play, false)));
        assert!(tasks.migration("page-monitor").is_err());
        let mut replacement = observed(Kind::Play, false);
        replacement
            .entries
            .get_mut(&Source::BagPlay)
            .unwrap()
            .value
            .as_mut()
            .unwrap()["receipt"]["processIdentity"] = json!("b".repeat(64));
        assert!(ops.check_running(Kind::Play, id, &context, &replacement));
        // Make the parent unwritable by replacing this test-only directory with a file.
        let parent = path.parent().unwrap();
        let saved = parent.with_extension("saved");
        std::fs::rename(parent, &saved).unwrap();
        std::fs::write(parent, b"fault").unwrap();
        assert!(ops.check_running(Kind::Play, id, &context, &observed(Kind::Play, false)));
        assert_eq!(ops.snapshot()[0].phase, Phase::Uncertain);
        assert!(tasks.migration("page-monitor").is_err());
        std::fs::remove_file(parent).unwrap();
        std::fs::rename(saved, parent).unwrap();
        assert!(!ops.check_running(Kind::Play, id, &context, &observed(Kind::Play, false)));
        assert!(tasks.migration("page-monitor").is_ok());
        assert!(Store::open(path.clone()).records().is_empty());
        std::fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn rejected_stop_restores_running_checkpoint_and_stale_worker_cannot_clear_successor() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        ops.restore(&tasks, Store::open(path.clone()));
        let kind = Kind::Record;
        let id = ops
            .begin(&tasks, owner("page-motion"), kind, true, profile())
            .unwrap();
        let job = Job::new(
            super::super::controller_journal::new_bag_id().unwrap(),
            "record".into(),
        )
        .unwrap();
        ops.prepare(kind, id, job.ticket(), "".into()).unwrap();
        ops.sending(kind, id, &owner("page-motion")).unwrap();
        ops.running(kind, id, proof(kind, true));
        let stop = ops
            .begin(&tasks, owner("page-dashboard"), kind, false, profile())
            .unwrap();
        let journal = Job::new(
            super::super::controller_journal::new_bag_id().unwrap(),
            "stop".into(),
        )
        .unwrap();
        ops.prepare(kind, stop, journal.ticket(), "".into())
            .unwrap();
        ops.sending(kind, stop, &owner("page-dashboard")).unwrap();
        assert!(!ops.update(kind, id, Phase::Succeeded, "late", true));
        assert_eq!(
            Store::open(path.clone()).records()[0].ticket,
            journal.ticket()
        );
        // A proven rejection (or failure before send) resumes the known process.
        assert!(ops.running(kind, stop, proof(kind, true)));
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let restored = ops.restore(&tasks, Store::open(path.clone()));
        assert!(restored[0].1.running.is_some());
        assert!(tasks.migration("page-dashboard").is_err());
        assert!(!ops.check_running(
            kind,
            restored[0].0,
            &json!({"connected":true,"epoch":1,"profile":profile()}),
            &observed(kind, false)
        ));
        assert!(Store::open(path.clone()).records().is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn corrupted_recovery_keeps_evidence_blocks_new_work_but_allows_stop_and_disable() {
        let path = recovery_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"broken evidence").unwrap();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        assert!(ops.restore(&tasks, Store::open(path.clone())).is_empty());
        assert!(ops.snapshot()[0].message.contains("恢复记录不可用"));
        assert!(tasks
            .admit(
                owner("page-motion"),
                &json!({"op":"position_move","command_id":"forbidden"}),
                std::time::Instant::now()
            )
            .is_err());
        assert!(tasks.sampling_operation("page-handeye").is_err());
        assert!(tasks.local_operation("page-handeye").is_ok());
        assert!(tasks
            .admit(
                owner("page-motor"),
                &json!({"op":"joint_command","mode":3}),
                std::time::Instant::now()
            )
            .is_ok());
        assert!(ops
            .begin(&tasks, owner("page-monitor"), Kind::Play, true, profile())
            .is_err());
        let id = ops
            .begin(&tasks, owner("page-monitor"), Kind::Play, false, profile())
            .unwrap();
        let job = Job::new(
            super::super::controller_journal::new_bag_id().unwrap(),
            "stop only".into(),
        )
        .unwrap();
        ops.prepare(Kind::Play, id, job.ticket(), "".into())
            .unwrap();
        ops.sending(Kind::Play, id, &owner("page-monitor")).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"broken evidence");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
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
