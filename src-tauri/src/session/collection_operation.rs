//! Episode operations survive the invoking WebView. Submit once, recover by
//! journal query, and retain migration ownership through an active Episode.
use super::{
    collection_recovery::{Record, Store},
    controller_journal::{Job, Proof},
    controller_task::same_profile,
    observations::{Snapshot as Observations, Source},
    runtime::Runtime,
    tasks::{LocalOperation, Owner, Tasks},
};
use crate::ConnectionProfile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Launch,
    StartEpisode,
    SaveEpisode,
    DiscardEpisode,
    Finish,
}
impl Action {
    pub fn parse(action: &str) -> Result<Self, String> {
        match action {
            "launch" => Ok(Self::Launch),
            "start_episode" => Ok(Self::StartEpisode),
            "save_episode" => Ok(Self::SaveEpisode),
            "discard_episode" => Ok(Self::DiscardEpisode),
            "finish" => Ok(Self::Finish),
            _ => Err("不支持的采集变更操作".into()),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Preparing,
    Verifying,
    Uncertain,
    Recording,
    Succeeded,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub recovery_error: bool,
    pub id: u64,
    pub action: Action,
    pub phase: Phase,
    pub host: String,
    pub message: String,
    pub busy: bool,
}
struct Entry {
    snapshot: Snapshot,
    owner: Owner,
    profile: Value,
    sent: bool,
    was_recording: bool,
    permit: Option<LocalOperation>,
    recovery: Option<Record>,
    recording_receipt: Option<Receipt>,
    prepared: bool,
    restored: bool,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    entry: Option<Entry>,
    store: Store,
}
#[derive(Default)]
pub struct Operations {
    inner: Mutex<Inner>,
}
impl Operations {
    fn restore(&self, tasks: &Arc<Tasks>, store: Store) -> Option<(u64, Record)> {
        let mut inner = self.inner.lock().unwrap();
        let record = store.record();
        inner.store = store;
        if let Some(error) = &inner.store.error {
            tasks.recovery_failed(error.clone());
            return None;
        }
        let record = record?;
        let permit = match tasks.settling_operation("page-collection") {
            Ok(permit) => permit,
            Err(error) => {
                tasks.recovery_failed(error.clone());
                inner.store.error = Some(error);
                return None;
            }
        };
        inner.sequence += 1;
        let id = inner.sequence;
        inner.entry = Some(Entry {
            snapshot: Snapshot {
                id,
                action: record.action,
                phase: Phase::Uncertain,
                host: record.profile["host"].as_str().unwrap_or("").into(),
                message: "桌面已重启，等待原连接核验采集任务；不会重复操作".into(),
                busy: true,
                recovery_error: false,
            },
            owner: Owner {
                epoch: 0,
                window: super::windows::WindowToken {
                    label: "page-collection".into(),
                    incarnation: 0,
                },
            },
            profile: record.profile.clone(),
            sent: record.recording.is_none(),
            was_recording: record.previous.is_some(),
            permit: Some(permit),
            recording_receipt: record.recording.clone().or(record.previous.clone()),
            recovery: Some(record.clone()),
            prepared: true,
            restored: true,
        });
        Some((id, record))
    }
    fn prepare(&self, id: u64, ticket: super::controller_journal::Ticket) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .entry
            .as_ref()
            .filter(|e| e.snapshot.id == id && e.permit.is_some() && !e.sent)
            .ok_or("采集操作已失效")?;
        if inner.store.error.is_some()
            && !matches!(entry.snapshot.action, Action::Launch | Action::StartEpisode)
        {
            inner.entry.as_mut().unwrap().prepared = true;
            return Ok(());
        }
        let record = Record {
            profile: entry.profile.clone(),
            action: entry.snapshot.action,
            ticket,
            previous: entry.recording_receipt.clone(),
            recording: None,
        };
        inner.store.save(record.clone())?;
        let entry = inner.entry.as_mut().unwrap();
        entry.recovery = Some(record);
        entry.prepared = true;
        Ok(())
    }
    fn checkpoint(&self, id: u64, receipt: Receipt) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner
            .entry
            .as_mut()
            .filter(|e| e.snapshot.id == id && e.permit.is_some())
        {
            entry.recording_receipt = Some(receipt);
        }
    }
    fn follows_previous(&self, id: u64, action: Action, receipt: &Receipt) -> bool {
        let inner = self.inner.lock().unwrap();
        let Some(entry) = inner
            .entry
            .as_ref()
            .filter(|e| e.snapshot.id == id && e.permit.is_some())
        else {
            return false;
        };
        if entry.restored && !receipt.managed {
            return false;
        }
        let Some(previous) = entry.recording_receipt.as_ref() else {
            return true;
        };
        if !matches!(action, Action::SaveEpisode | Action::DiscardEpisode) {
            return true;
        }
        previous.managed == receipt.managed
            && previous.pid == receipt.pid
            && previous.process_identity == receipt.process_identity
            && previous.dataset_hash == receipt.dataset_hash
            && if action == Action::SaveEpisode {
                previous.saved_episodes.checked_add(1) == Some(receipt.saved_episodes)
            } else {
                previous.saved_episodes == receipt.saved_episodes
            }
    }
    fn observe_recording(&self, id: u64, context: &Value, snapshot: &Observations) -> bool {
        let original = self
            .inner
            .lock()
            .unwrap()
            .entry
            .as_ref()
            .filter(|e| e.snapshot.id == id && e.permit.is_some() && !e.sent)
            .and_then(|e| {
                e.recording_receipt
                    .clone()
                    .map(|r| (e.profile.clone(), r, e.restored))
            });
        let Some((profile, receipt, restored)) = original else {
            return false;
        };
        // An external recorder has no process-instance proof, so it cannot be
        // adopted automatically across a desktop restart.
        if (receipt.managed || !restored)
            && context["connected"] == true
            && same_profile(&profile, &context["profile"])
            && context["epoch"].as_u64() == Some(snapshot.epoch)
            && verified(snapshot, Action::StartEpisode, &receipt).is_some()
        {
            self.finish(id, true);
        } else {
            self.uncertain(
                id,
                "等待原连接同一采集器与 Episode 计数的新鲜状态；保留占用",
            );
        }
        true
    }
    pub fn snapshot(&self) -> Option<Snapshot> {
        let inner = self.inner.lock().unwrap();
        if let Some(error) = &inner.store.error {
            return Some(Snapshot {
                id: 0,
                action: Action::Finish,
                phase: Phase::Uncertain,
                host: "".into(),
                message: error.clone(),
                busy: inner.entry.as_ref().is_some_and(|e| e.permit.is_some()),
                recovery_error: true,
            });
        }
        inner.entry.as_ref().map(|e| e.snapshot.clone())
    }
    pub fn begin(
        &self,
        tasks: &Arc<Tasks>,
        owner: Owner,
        profile: Value,
        action: Action,
    ) -> Result<u64, String> {
        if owner.window.label != "page-collection" {
            return Err("只有数据采集页面可操作 Episode".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if matches!(action, Action::Launch | Action::StartEpisode) {
            tasks.check_activity(super::activity::Check::CollectionStart)?;
        }
        let recording = inner.entry.as_ref().is_some_and(|e| e.permit.is_some());
        let recovery = inner
            .entry
            .as_ref()
            .filter(|e| recording && e.permit.is_some())
            .and_then(|e| e.recovery.clone());
        let recording_receipt = inner
            .entry
            .as_ref()
            .filter(|e| recording && e.permit.is_some())
            .and_then(|e| e.recording_receipt.clone());
        if let Some(entry) = inner.entry.as_ref().filter(|e| e.permit.is_some()) {
            if entry.snapshot.phase != Phase::Recording {
                return Err("采集操作尚未确认完成，禁止重复提交".into());
            }
            if !same_profile(&entry.profile, &profile) {
                return Err("原采集任务属于另一连接，请回到原连接完成 Episode".into());
            }
            if !matches!(
                action,
                Action::SaveEpisode | Action::DiscardEpisode | Action::Finish
            ) {
                return Err("请先保存或丢弃原 Episode".into());
            }
            if action == Action::Finish {
                return Err("请先保存或丢弃原 Episode，再完成数据集".into());
            }
        }
        let id = inner.sequence.checked_add(1).ok_or("采集任务编号耗尽")?;
        let permit = if recording {
            inner.entry.as_mut().unwrap().permit.take().unwrap()
        } else if matches!(action, Action::Launch | Action::StartEpisode) {
            tasks.sampling_operation(&owner.window.label)?
        } else {
            tasks.settling_operation(&owner.window.label)?
        };
        inner.sequence = id;
        inner.entry = Some(Entry {
            snapshot: Snapshot {
                recovery_error: false,
                id,
                action,
                phase: Phase::Preparing,
                host: profile["host"].as_str().unwrap_or("").into(),
                message: "采集操作已由原生层接管".into(),
                busy: true,
            },
            owner,
            profile,
            sent: false,
            was_recording: recording,
            permit: Some(permit),
            recovery,
            recording_receipt,
            prepared: false,
            restored: false,
        });
        Ok(id)
    }
    #[cfg(test)]
    pub fn sending(&self, id: u64, owner: &Owner) -> Result<(), String> {
        self.sending_validated(id, owner, || Ok(()))
    }
    pub fn sending_validated<G>(
        &self,
        id: u64,
        owner: &Owner,
        validate: impl FnOnce() -> Result<G, String>,
    ) -> Result<(), String> {
        // Acquire the potentially I/O-bound operation lock before Core. The
        // returned guard keeps connection validation atomic with admission.
        let mut inner = self.inner.lock().unwrap();
        let _connection = validate()?;
        let durable = inner.store.configured();
        let entry = inner
            .entry
            .as_mut()
            .filter(|e| e.snapshot.id == id && e.owner == *owner && e.permit.is_some() && !e.sent)
            .ok_or("采集操作或来源页面已失效")?;
        if durable && !entry.prepared {
            return Err("采集恢复记录尚未落盘，拒绝提交".into());
        }
        entry.sent = true;
        entry.snapshot.phase = Phase::Verifying;
        entry.snapshot.message = "等待远端回执和新鲜采集状态".into();
        Ok(())
    }
    pub fn uncertain(&self, id: u64, message: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner
            .entry
            .as_mut()
            .filter(|e| e.snapshot.id == id && e.permit.is_some())
        {
            entry.snapshot.phase = Phase::Uncertain;
            entry.snapshot.message = message.chars().take(512).collect();
        }
    }
    pub fn finish(&self, id: u64, recording: bool) -> bool {
        self.finish_validated(id, recording, || Some(()))
    }
    pub fn finish_validated<G>(
        &self,
        id: u64,
        recording: bool,
        validate: impl Fn() -> Option<G>,
    ) -> bool {
        let permit = {
            let mut inner = self.inner.lock().unwrap();
            // Never retain a shared connection guard across durable file I/O.
            let Some(connection) = validate() else {
                return false;
            };
            drop(connection);
            let Some(entry) = inner
                .entry
                .as_ref()
                .filter(|e| e.snapshot.id == id && e.permit.is_some())
            else {
                return false;
            };
            let recovery = entry.recovery.clone();
            if let Some(mut record) = recovery {
                let result = if recording {
                    let Some(receipt) = entry.recording_receipt.clone() else {
                        return false;
                    };
                    record.recording = Some(receipt);
                    inner.store.save(record.clone())
                } else {
                    inner.store.remove(&record.ticket)
                };
                if let Err(error) = result {
                    let entry = inner.entry.as_mut().unwrap();
                    entry.snapshot.phase = Phase::Uncertain;
                    entry.snapshot.message =
                        format!("采集已核验，恢复记录待落盘；保留占用：{error}");
                    return false;
                }
                inner.entry.as_mut().unwrap().recovery = Some(record);
            }
            // Reconnect during fsync must not complete an old observation. The
            // durable receipt remains valid for its original remote task.
            let Some(_connection) = validate() else {
                return false;
            };
            let entry = inner.entry.as_mut().unwrap();
            entry.snapshot.phase = if recording {
                Phase::Recording
            } else {
                Phase::Succeeded
            };
            entry.snapshot.busy = recording;
            entry.snapshot.message = if recording {
                "Episode 仍在采集，请保存或丢弃后再移动页面"
            } else {
                "远端操作及新鲜状态已确认"
            }
            .into();
            if recording {
                entry.sent = false;
                None
            } else {
                entry.permit.take()
            }
        };
        drop(permit);
        true
    }
    // A proven pre-send failure can release only this finite operation. Preserve
    // an earlier active Episode's permit when an attempted save never started.
    pub fn rejected(&self, id: u64, message: &str) -> bool {
        let permit = {
            let mut inner = self.inner.lock().unwrap();
            let Some(entry) = inner
                .entry
                .as_ref()
                .filter(|e| e.snapshot.id == id && e.permit.is_some())
            else {
                return true;
            };
            let recovery = entry.recovery.clone();
            if let Some(mut record) = recovery {
                let result = if entry.was_recording {
                    record.recording = entry.recording_receipt.clone();
                    inner.store.save(record.clone())
                } else {
                    inner.store.remove(&record.ticket)
                };
                if let Err(error) = result {
                    let entry = inner.entry.as_mut().unwrap();
                    entry.snapshot.phase = Phase::Uncertain;
                    entry.snapshot.message = format!("采集拒绝已确认，恢复记录待落盘：{error}");
                    return false;
                }
                inner.entry.as_mut().unwrap().recovery = Some(record);
            }
            let entry = inner.entry.as_mut().unwrap();
            entry.sent = false;
            entry.snapshot.phase = if entry.was_recording {
                Phase::Recording
            } else {
                Phase::Failed
            };
            entry.snapshot.busy = entry.was_recording;
            entry.snapshot.message = message.chars().take(512).collect();
            if entry.was_recording {
                None
            } else {
                entry.permit.take()
            }
        };
        drop(permit);
        true
    }
    fn abandoned(&self, id: u64) {
        let sent = self
            .inner
            .lock()
            .unwrap()
            .entry
            .as_ref()
            .filter(|e| {
                e.snapshot.id == id
                    && e.permit.is_some()
                    && !matches!(e.snapshot.phase, Phase::Recording | Phase::Uncertain)
            })
            .map(|e| e.sent);
        match sent {
            Some(true) => self.uncertain(id, "原生工作异常退出；执行结果未确认，保留占用"),
            Some(false) => {
                self.rejected(id, "操作在发送前撤销");
            }
            None => {}
        }
    }
}
pub fn initialize(app: &AppHandle) {
    let hub = app.state::<Runtime>();
    let store = match app.path().app_config_dir() {
        Ok(path) => Store::open(path.join("collection-recovery-v1.json")),
        Err(error) => Store::failed(format!("采集恢复目录不可用：{error}")),
    };
    if let Some((id, record)) = hub.collection_operations.restore(&hub.tasks, store) {
        let guard = Guard {
            operations: hub.collection_operations.clone(),
            id,
            app: app.clone(),
        };
        tauri::async_runtime::spawn(async move {
            if record.recording.is_some() {
                monitor(guard);
                return;
            }
            match (
                Job::recover(record.ticket),
                serde_json::from_value(record.profile),
            ) {
                (Ok(journal), Ok(profile)) => {
                    let _ = resolve(guard, profile, record.action, journal, None).await;
                }
                _ => {
                    guard.operations.uncertain(id, "采集恢复记录无效，保留占用");
                    guard.notify();
                }
            }
        });
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    state: String,
    managed: bool,
    pid: u32,
    pub(super) recording: bool,
    pending_frames: u64,
    saved_episodes: u64,
    process_identity: String,
    dataset_hash: String,
}
impl Receipt {
    pub(super) fn parse(value: Value) -> Result<Self, String> {
        let receipt: Self =
            serde_json::from_value(value).map_err(|e| format!("采集回执无效：{e}"))?;
        if !matches!(
            receipt.state.as_str(),
            "stopped" | "starting" | "idle" | "recording" | "finalizing"
        ) || receipt.recording != (receipt.state == "recording")
            || (receipt.managed
                && (receipt.pid <= 1
                    || receipt.process_identity.len() != 64
                    || !receipt
                        .process_identity
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))))
            || (!receipt.managed && (receipt.pid != 0 || !receipt.process_identity.is_empty()))
            || receipt.dataset_hash.len() != 64
            || !receipt.dataset_hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("采集回执状态或进程身份无效".into());
        }
        Ok(receipt)
    }
}
fn verified(snapshot: &Observations, action: Action, receipt: &Receipt) -> Option<Value> {
    if !snapshot.connected {
        return None;
    }
    let entry = snapshot.entries.get(&Source::Collection)?;
    if entry.error.is_some() || entry.age_ms >= entry.ttl_ms {
        return None;
    }
    let value = entry.value.as_ref()?;
    let root = value["root"].as_str()?;
    let repo = value["repoId"].as_str()?;
    let hash = format!("{:x}", Sha256::digest(format!("{root}\0{repo}").as_bytes()));
    if hash != receipt.dataset_hash
        || value["managed"].as_bool()? != receipt.managed
        || value["pid"].as_u64()? != u64::from(receipt.pid)
        || value["processIdentity"].as_str()? != receipt.process_identity
        || value["savedEpisodes"].as_u64()? != receipt.saved_episodes
    {
        return None;
    }
    let state = value["state"].as_str()?;
    let recording = value["recording"].as_bool()?;
    let pending = value["pendingFrames"].as_u64()?;
    let matched = match action {
        Action::Launch => {
            receipt.managed
                && matches!(receipt.state.as_str(), "starting" | "idle")
                && state == "idle"
                && !recording
                && pending == 0
        }
        Action::StartEpisode => receipt.recording && state == "recording" && recording,
        Action::SaveEpisode | Action::DiscardEpisode => {
            receipt.state == "idle"
                && !receipt.recording
                && receipt.pending_frames == 0
                && state == "idle"
                && !recording
                && pending == 0
        }
        Action::Finish => {
            receipt.state == "stopped"
                && !receipt.recording
                && receipt.pending_frames == 0
                && state == "stopped"
                && !recording
                && pending == 0
        }
    };
    matched.then(|| value.clone())
}
struct Guard {
    operations: Arc<Operations>,
    id: u64,
    app: AppHandle,
}
impl Guard {
    fn notify(&self) {
        let _ = self.app.emit("native-collection-operation-changed", ());
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.operations.abandoned(self.id);
        self.notify();
    }
}

pub async fn start(
    app: AppHandle,
    hub: &Runtime,
    owner: Owner,
    profile: ConnectionProfile,
    action: Action,
    remote: String,
) -> Result<Value, String> {
    let mut journal = Job::new(super::controller_journal::new_collection_id()?, remote)?;
    let original = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
    let id =
        hub.collection_operations
            .begin(&hub.tasks, owner.clone(), original.clone(), action)?;
    let guard = Guard {
        operations: hub.collection_operations.clone(),
        id,
        app,
    };
    guard.notify();
    owned(async move {
        let hub = guard.app.state::<Runtime>();
        if matches!(action, Action::Launch | Action::StartEpisode) {
            if let Err(message) = crate::data_collection::run_collection_ready_gate(&profile).await
            {
                reject(guard, message.clone());
                return Err(message);
            }
        }
        let check = if matches!(action, Action::Launch | Action::StartEpisode) {
            hub.tasks
                .check_activity(super::activity::Check::CollectionStart)
        } else {
            Ok(())
        };
        if let Err(message) = check
            .and_then(|_| guard.operations.prepare(id, journal.ticket()))
            .and_then(|_| hub.send_collection(&owner, id, &profile))
        {
            reject(guard, message.clone());
            return Err(message);
        }
        guard.notify();
        let proof = journal.submit(&profile).await.ok();
        resolve(guard, profile, action, journal, proof).await
    })
    .await
}
async fn resolve(
    guard: Guard,
    profile: ConnectionProfile,
    action: Action,
    journal: Job,
    mut proof: Option<Proof>,
) -> Result<Value, String> {
    let hub = guard.app.state::<Runtime>();
    let id = guard.id;
    let original = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
    let mut receipt = None;
    loop {
        match proof.take() {
            Some(Proof::CollectionSucceeded(value)) => match Receipt::parse(value) {
                Ok(value) if guard.operations.follows_previous(id, action, &value) => {
                    receipt = Some(value)
                }
                Ok(_) => {
                    guard
                        .operations
                        .uncertain(id, "采集回执与原 Episode 的进程或保存计数不一致，保留占用");
                    guard.notify();
                    return Err("采集回执与原 Episode 不一致".into());
                }
                Err(message) => {
                    guard.operations.uncertain(id, &message);
                    guard.notify();
                    return Err(message);
                }
            },
            Some(Proof::Rejected(message)) => {
                reject(guard, message.clone());
                return Err(message);
            }
            Some(Proof::Uncertain(message)) => {
                guard.operations.uncertain(id, &message);
                guard.notify();
                return Err(format!("采集执行结果未确认：{message}"));
            }
            _ => {}
        }
        let context = hub.context();
        if context["connected"] == true && same_profile(&original, &context["profile"]) {
            if let Some(receipt) = &receipt {
                if let Some(epoch) = context["epoch"].as_u64() {
                    if let Ok(snapshot) = hub
                        .observations
                        .refresh(epoch, Source::Collection, true)
                        .await
                    {
                        if let Some(value) = verified(&snapshot, action, receipt) {
                            if value["recording"] == true {
                                guard.operations.checkpoint(id, receipt.clone());
                            }
                            if hub.finish_collection(
                                id,
                                &profile,
                                snapshot.epoch,
                                value["recording"] == true,
                            ) {
                                guard.notify();
                                if value["recording"] == true {
                                    monitor(guard);
                                }
                                return Ok(value);
                            }
                            guard.notify();
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            continue;
                        }
                    }
                }
            } else {
                proof = journal.query(&profile).await.ok();
            }
        }
        guard.operations.uncertain(
            id,
            if receipt.is_some() {
                "远端操作已完成，等待原连接匹配采集器的新鲜状态"
            } else {
                "采集结果待确认；只查询完成记录，不重发操作"
            },
        );
        guard.notify();
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
fn reject(guard: Guard, message: String) {
    tokio::spawn(async move {
        while !guard.operations.rejected(guard.id, &message) {
            guard.notify();
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        guard.notify();
        monitor(guard);
    });
}
fn monitor(guard: Guard) {
    tokio::spawn(async move {
        loop {
            let hub = guard.app.state::<Runtime>();
            let before = guard.operations.snapshot();
            if !guard.operations.observe_recording(
                guard.id,
                &hub.context(),
                &hub.observations.activity_snapshot(),
            ) {
                break;
            }
            if guard.operations.snapshot() != before {
                guard.notify();
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
        let _ = send.send(work.await);
    });
    match tokio::time::timeout(Duration::from_secs(25), receive).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("采集原生工作异常退出；请查看共享任务状态".into()),
        Err(_) => Err("采集操作仍由原生层核验；请勿重复提交".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{observations::Observation, windows::WindowToken};
    use super::*;
    use serde_json::json;
    fn owner() -> Owner {
        Owner {
            epoch: 1,
            window: WindowToken {
                label: "page-collection".into(),
                incarnation: 1,
            },
        }
    }
    fn profile() -> Value {
        json!({"host":"fixture","sshPort":22,"username":"","identityFile":"","localPort":18765,"remotePort":8765,
        "rosDomainId":197,"rosSetupScript":"test/install/setup.bash","commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"})
    }
    fn value(recording: bool) -> Value {
        json!({"state":if recording {"recording"} else {"idle"},"recording":recording,
        "managed":true,"pid":42,"processIdentity":"a".repeat(64),"pendingFrames":if recording {12} else {0},"savedEpisodes":3,
        "root":"/tmp/dataset","repoId":"test/cube"})
    }
    fn receipt(value: &Value) -> Receipt {
        let mut data = value.clone();
        let obj = data.as_object_mut().unwrap();
        let root = obj.remove("root").unwrap();
        let repo = obj.remove("repoId").unwrap();
        obj.insert(
            "datasetHash".into(),
            json!(format!(
                "{:x}",
                Sha256::digest(
                    format!("{}\0{}", root.as_str().unwrap(), repo.as_str().unwrap()).as_bytes()
                )
            )),
        );
        Receipt::parse(data).unwrap()
    }
    fn observation(value: Value) -> Observations {
        Observations {
            epoch: 1,
            connected: true,
            revision: 1,
            handler_elapsed_ms: 0,
            entries: [(
                Source::Collection,
                Observation {
                    sequence: 1,
                    value: Some(value),
                    error: None,
                    age_ms: 0,
                    ttl_ms: 20000,
                },
            )]
            .into_iter()
            .collect(),
        }
    }
    fn recovery_path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(super::super::controller_journal::new_collection_id().unwrap())
            .join("collection.json")
    }
    fn prepare(ops: &Operations, id: u64) -> super::super::controller_journal::Ticket {
        let job = Job::new(
            super::super::controller_journal::new_collection_id().unwrap(),
            "never replay".into(),
        )
        .unwrap();
        ops.prepare(id, job.ticket()).unwrap();
        job.ticket()
    }
    #[test]
    fn durable_completion_releases_connection_lock_and_revalidates_after_io() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        ops.restore(&tasks, Store::open(path.clone()));
        let id = ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .unwrap();
        prepare(&ops, id);
        ops.sending(id, &owner()).unwrap();
        let connected = Arc::new(Mutex::new(true));
        let during_io = connected.clone();
        super::super::recovery_file::before_write_for_test(move || {
            let mut core = during_io
                .try_lock()
                .expect("disk I/O must not hold the connection lock");
            *core = false; // A disconnect while the durable write is in progress.
        });
        let validate = || {
            let core = connected.lock().unwrap();
            if *core {
                Some(core)
            } else {
                None
            }
        };
        assert!(!ops.finish_validated(id, false, validate));
        assert!(tasks.migration("page-collection").is_err());
        assert!(
            Store::open(path.clone()).record().is_none(),
            "original remote terminal proof was durably cleaned"
        );
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Verifying);
        *connected.lock().unwrap() = true;
        assert!(ops.finish_validated(id, false, validate));
        assert!(tasks.migration("page-collection").is_ok());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn pending_recovery_holds_ownership_and_never_accepts_idle_or_another_profile_as_completion() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        assert!(ops.restore(&tasks, Store::open(path.clone())).is_none());
        let id = ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .unwrap();
        assert!(ops.sending(id, &owner()).is_err());
        let ticket = prepare(&ops, id);
        ops.sending(id, &owner()).unwrap();
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("never replay"));
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let (id, record) = ops.restore(&tasks, Store::open(path.clone())).unwrap();
        assert_eq!(record.ticket, ticket);
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Uncertain);
        assert!(tasks.migration("page-collection").is_err());
        assert!(tasks.playback_operation("page-monitor", true).is_err());
        assert!(!ops.observe_recording(
            id,
            &json!({"connected":true,"epoch":1,"profile":profile()}),
            &observation(value(false))
        ));
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .is_err());
        assert!(Store::open(path.clone()).record().is_some());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn recording_checkpoint_recovers_only_same_instance_and_rejected_save_keeps_it() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        ops.restore(&tasks, Store::open(path.clone()));
        let id = ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .unwrap();
        prepare(&ops, id);
        ops.sending(id, &owner()).unwrap();
        ops.checkpoint(id, receipt(&value(true)));
        assert!(ops.finish(id, true));
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let (id, _) = ops.restore(&tasks, Store::open(path.clone())).unwrap();
        let context = json!({"connected":true,"epoch":1,"profile":profile()});
        let mut other = context.clone();
        other["profile"]["host"] = json!("other");
        assert!(ops.observe_recording(id, &other, &observation(value(true))));
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Uncertain);
        for (key, bad) in [
            ("processIdentity", json!("b".repeat(64))),
            ("root", json!("/other")),
            ("savedEpisodes", json!(9)),
        ] {
            let mut source = value(true);
            source[key] = bad;
            assert!(ops.observe_recording(id, &context, &observation(source)));
            assert_eq!(ops.snapshot().unwrap().phase, Phase::Uncertain);
        }
        assert!(ops.observe_recording(id, &context, &observation(value(true))));
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Recording);
        let save = ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .unwrap();
        prepare(&ops, save);
        assert!(!ops.finish(id, false));
        assert!(ops.rejected(save, "proven not submitted"));
        assert!(Store::open(path.clone())
            .record()
            .unwrap()
            .recording
            .is_some());
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let (id, _) = ops.restore(&tasks, Store::open(path.clone())).unwrap();
        ops.observe_recording(id, &context, &observation(value(true)));
        let save = ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .unwrap();
        prepare(&ops, save);
        ops.sending(save, &owner()).unwrap();
        assert!(ops.finish(save, false));
        assert!(Store::open(path.clone()).record().is_none());
        assert!(tasks.migration("page-collection").is_ok());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn external_recorder_can_be_used_in_current_session_but_is_not_adopted_after_restart() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        ops.restore(&tasks, Store::open(path.clone()));
        let mut external = value(true);
        external["managed"] = json!(false);
        external["pid"] = json!(0);
        external["processIdentity"] = json!("");
        let id = ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .unwrap();
        prepare(&ops, id);
        ops.checkpoint(id, receipt(&external));
        ops.finish(id, true);
        let context = json!({"connected":true,"epoch":1,"profile":profile()});
        ops.observe_recording(id, &context, &observation(external.clone()));
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Recording);
        drop(ops);
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let (id, _) = ops.restore(&tasks, Store::open(path.clone())).unwrap();
        assert!(
            !ops.follows_previous(id, Action::StartEpisode, &receipt(&external)),
            "query-only pending recovery must not adopt an unmanaged journal receipt either"
        );
        ops.observe_recording(id, &context, &observation(external));
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Uncertain);
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn saved_or_discarded_receipt_must_follow_original_instance_and_episode_count() {
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let id = ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .unwrap();
        ops.checkpoint(id, receipt(&value(true)));
        ops.finish(id, true);
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::Finish)
            .is_err());
        let save = ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .unwrap();
        let mut after = value(false);
        after["savedEpisodes"] = json!(4);
        assert!(ops.follows_previous(save, Action::SaveEpisode, &receipt(&after)));
        assert!(!ops.follows_previous(save, Action::SaveEpisode, &receipt(&value(false))));
        assert!(ops.follows_previous(save, Action::DiscardEpisode, &receipt(&value(false))));
        for key in ["processIdentity", "repoId", "root"] {
            let mut wrong = after.clone();
            wrong[key] = json!(if key == "processIdentity" {
                "b".repeat(64)
            } else {
                "other".into()
            });
            assert!(!ops.follows_previous(save, Action::SaveEpisode, &receipt(&wrong)));
        }
    }
    #[test]
    fn durable_cleanup_failure_holds_permit_until_retry_and_corruption_preserves_stop_access() {
        let path = recovery_path();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        ops.restore(&tasks, Store::open(path.clone()));
        let id = ops
            .begin(&tasks, owner(), profile(), Action::Launch)
            .unwrap();
        prepare(&ops, id);
        ops.sending(id, &owner()).unwrap();
        let parent = path.parent().unwrap();
        let saved = parent.with_extension("saved");
        std::fs::rename(parent, &saved).unwrap();
        std::fs::write(parent, b"fault").unwrap();
        assert!(!ops.finish(id, false));
        assert!(tasks.migration("page-collection").is_err());
        std::fs::remove_file(parent).unwrap();
        std::fs::rename(saved, parent).unwrap();
        assert!(ops.finish(id, false));
        assert!(Store::open(path.clone()).record().is_none());
        std::fs::write(&path, b"corrupt").unwrap();
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        assert!(ops.restore(&tasks, Store::open(path.clone())).is_none());
        assert!(ops.snapshot().unwrap().recovery_error);
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .is_err());
        let id = ops
            .begin(&tasks, owner(), profile(), Action::Finish)
            .unwrap();
        prepare(&ops, id);
        ops.sending(id, &owner()).unwrap();
        assert!(ops.snapshot().unwrap().busy);
        assert!(ops.finish(id, false));
        assert!(!ops.snapshot().unwrap().busy);
        assert_eq!(std::fs::read(&path).unwrap(), b"corrupt");
        assert!(tasks
            .admit(
                Owner {
                    window: super::super::windows::WindowToken {
                        label: "page-motor".into(),
                        incarnation: 1
                    },
                    epoch: 1
                },
                &json!({"op":"joint_command","mode":3}),
                std::time::Instant::now()
            )
            .is_ok());
        std::fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn ownership_spans_recording_and_failed_presend_save_but_not_completed_episode() {
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let moving = tasks.migration("page-collection").unwrap();
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .is_err());
        drop(moving);
        let id = ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .unwrap();
        assert!(tasks.migration("page-collection").is_err());
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .is_err());
        ops.sending(id, &owner()).unwrap();
        assert!(ops.sending(id, &owner()).is_err());
        ops.finish(id, true);
        ops.abandoned(id);
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Recording);
        assert!(tasks.migration("page-collection").is_err());
        assert!(tasks.migration("page-motion").is_ok()); // Recording permits demonstration motion.
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .is_err());
        assert!(ops
            .begin(
                &tasks,
                owner(),
                json!({"host":"another"}),
                Action::SaveEpisode
            )
            .is_err());
        let mut replacement = owner();
        replacement.window.incarnation += 1;
        let save = ops
            .begin(&tasks, replacement.clone(), profile(), Action::SaveEpisode)
            .unwrap();
        assert!(ops.sending(save, &owner()).is_err());
        ops.rejected(save, "preflight failed");
        ops.abandoned(save);
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Recording);
        assert!(tasks.migration("page-collection").is_err());
        let retry = ops
            .begin(
                &tasks,
                replacement.clone(),
                profile(),
                Action::DiscardEpisode,
            )
            .unwrap();
        ops.finish(save, false);
        assert!(tasks.migration("page-collection").is_err());
        ops.sending(retry, &replacement).unwrap();
        ops.finish(retry, false);
        assert!(tasks.migration("page-collection").is_ok());
    }
    #[test]
    fn uncertain_submitted_work_cannot_be_released_by_page_exit_or_new_requests() {
        let tasks = Arc::new(Tasks::default());
        let ops = Operations::default();
        let id = ops
            .begin(&tasks, owner(), profile(), Action::Launch)
            .unwrap();
        ops.sending(id, &owner()).unwrap();
        ops.abandoned(id);
        assert_eq!(ops.snapshot().unwrap().phase, Phase::Uncertain);
        assert!(ops
            .begin(&tasks, owner(), profile(), Action::Finish)
            .is_err());
        assert!(tasks.migration("page-collection").is_err());
        let other = Operations::default();
        let mut wrong = owner();
        wrong.window.label = "page-motion".into();
        assert!(other
            .begin(&tasks, wrong, profile(), Action::Launch)
            .is_err());
    }
    #[test]
    fn verification_binds_action_receipt_dataset_instance_counts_and_freshness() {
        for (action, recording) in [
            (Action::Launch, false),
            (Action::StartEpisode, true),
            (Action::SaveEpisode, false),
            (Action::DiscardEpisode, false),
        ] {
            let source = value(recording);
            let proof = receipt(&source);
            let good = observation(source);
            assert!(verified(&good, action, &proof).is_some());
            for (key, bad) in [
                ("pid", json!(43)),
                ("processIdentity", json!("reused")),
                ("root", json!("/other")),
                ("repoId", json!("other/cube")),
                ("savedEpisodes", json!(4)),
                ("recording", json!(!recording)),
                ("managed", json!(false)),
            ] {
                let mut snapshot = good.clone();
                snapshot
                    .entries
                    .get_mut(&Source::Collection)
                    .unwrap()
                    .value
                    .as_mut()
                    .unwrap()[key] = bad;
                assert!(
                    verified(&snapshot, action, &proof).is_none(),
                    "{action:?} {key}"
                );
            }
            let mut stale = good.clone();
            stale.entries.get_mut(&Source::Collection).unwrap().age_ms = 20000;
            assert!(verified(&stale, action, &proof).is_none());
            stale = good.clone();
            stale.entries.get_mut(&Source::Collection).unwrap().error = Some("SSH".into());
            assert!(verified(&stale, action, &proof).is_none());
            stale = good.clone();
            stale.connected = false;
            assert!(verified(&stale, action, &proof).is_none());
        }
        let mut stopped = value(false);
        stopped["state"] = json!("stopped");
        stopped["pid"] = json!(0);
        stopped["managed"] = json!(false);
        stopped["processIdentity"] = json!("");
        assert!(verified(
            &observation(stopped.clone()),
            Action::Finish,
            &receipt(&stopped)
        )
        .is_some());
        let mut invalid = serde_json::to_value(json!({})).unwrap();
        invalid["state"] = json!("idle");
        assert!(Receipt::parse(invalid).is_err());
        let source = value(false);
        let mut pending = source.clone();
        pending["pendingFrames"] = json!(4);
        assert!(verified(
            &observation(pending),
            Action::SaveEpisode,
            &receipt(&source)
        )
        .is_none());
    }
    #[tokio::test]
    async fn caller_exit_does_not_drop_worker_or_unlock_capture() {
        let tasks = Arc::new(Tasks::default());
        let ops = Arc::new(Operations::default());
        let id = ops
            .begin(&tasks, owner(), profile(), Action::StartEpisode)
            .unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (done, wait) = tokio::sync::oneshot::channel();
        let worker = ops.clone();
        let caller = tokio::spawn(owned(async move {
            worker.sending(id, &owner())?;
            let _ = started.send(());
            wait.await.unwrap();
            worker.finish(id, true);
            Ok(value(true))
        }));
        ready.await.unwrap();
        caller.abort();
        let _ = caller.await;
        assert!(tasks.migration("page-collection").is_err());
        done.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while ops.snapshot().unwrap().phase != Phase::Recording {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(tasks.migration("page-collection").is_err());
        let save = ops
            .begin(&tasks, owner(), profile(), Action::SaveEpisode)
            .unwrap();
        ops.finish(save, false);
        assert!(tasks.migration("page-collection").is_ok());
    }
}
