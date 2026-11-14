//! Episode operations survive the invoking WebView. Submit once, recover by
//! journal query, and retain migration ownership through an active Episode.
use super::{
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
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
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    entry: Option<Entry>,
}
#[derive(Default)]
pub struct Operations {
    inner: Mutex<Inner>,
}
impl Operations {
    pub fn snapshot(&self) -> Option<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .entry
            .as_ref()
            .map(|e| e.snapshot.clone())
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
        let recording = inner.entry.as_ref().is_some_and(|e| e.permit.is_some());
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
        }
        let id = inner.sequence.checked_add(1).ok_or("采集任务编号耗尽")?;
        let permit = if recording {
            inner.entry.as_mut().unwrap().permit.take().unwrap()
        } else {
            tasks.sampling_operation(&owner.window.label)?
        };
        inner.sequence = id;
        inner.entry = Some(Entry {
            snapshot: Snapshot {
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
        });
        Ok(id)
    }
    pub fn sending(&self, id: u64, owner: &Owner) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .entry
            .as_mut()
            .filter(|e| e.snapshot.id == id && e.owner == *owner && e.permit.is_some() && !e.sent)
            .ok_or("采集操作或来源页面已失效")?;
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
        let permit = {
            let mut inner = self.inner.lock().unwrap();
            let Some(entry) = inner
                .entry
                .as_mut()
                .filter(|e| e.snapshot.id == id && e.permit.is_some())
            else {
                return false;
            };
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
    pub fn rejected(&self, id: u64, message: &str) {
        let permit = {
            let mut inner = self.inner.lock().unwrap();
            let Some(entry) = inner
                .entry
                .as_mut()
                .filter(|e| e.snapshot.id == id && e.permit.is_some())
            else {
                return;
            };
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
            Some(false) => self.rejected(id, "操作在发送前撤销"),
            None => {}
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    state: String,
    managed: bool,
    pid: u32,
    recording: bool,
    pending_frames: u64,
    saved_episodes: u64,
    process_identity: String,
    dataset_hash: String,
}
impl Receipt {
    fn parse(value: Value) -> Result<Self, String> {
        let receipt: Self =
            serde_json::from_value(value).map_err(|e| format!("采集回执无效：{e}"))?;
        if !matches!(
            receipt.state.as_str(),
            "stopped" | "starting" | "idle" | "recording" | "finalizing"
        ) || receipt.recording != (receipt.state == "recording")
            || (receipt.managed && (receipt.pid <= 1 || receipt.process_identity.is_empty()))
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
                guard.operations.rejected(id, &message);
                guard.notify();
                return Err(message);
            }
        }
        if let Err(message) = hub.send_collection(&owner, id, &profile) {
            guard.operations.rejected(id, &message);
            guard.notify();
            return Err(message);
        }
        guard.notify();
        let mut proof = journal.submit(&profile).await.ok();
        let mut receipt = None;
        loop {
            match proof.take() {
                Some(Proof::CollectionSucceeded(value)) => match Receipt::parse(value) {
                    Ok(value) => receipt = Some(value),
                    Err(message) => {
                        guard.operations.uncertain(id, &message);
                        guard.notify();
                        return Err(message);
                    }
                },
                Some(Proof::Rejected(message)) => {
                    guard.operations.rejected(id, &message);
                    guard.notify();
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
                                if hub.finish_collection(
                                    id,
                                    &profile,
                                    snapshot.epoch,
                                    value["recording"] == true,
                                ) {
                                    guard.notify();
                                    return Ok(value);
                                }
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
    })
    .await
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
        "managed":true,"pid":42,"processIdentity":"12345","pendingFrames":if recording {12} else {0},"savedEpisodes":3,
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
