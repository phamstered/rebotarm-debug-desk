//! App-owned finite bag start/stop operations. Remote publication is single-shot;
//! a lost SSH reply is recovered by journal query, never by replaying control.
use super::{
    controller_journal::{Job, Proof},
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
    Succeeded,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
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
        host: String,
    ) -> Result<u64, String> {
        if !kind.authorized(&owner.window.label) {
            return Err("当前页面无权执行此 rosbag 操作".into());
        }
        let permit = tasks.local_operation(&owner.window.label)?;
        let mut inner = self.inner.lock().unwrap();
        if inner.entries.get(&kind).is_some_and(|e| e.permit.is_some()) {
            return Err("此 rosbag 操作仍在原生层核验，不能重复提交".into());
        }
        inner.sequence = inner.sequence.checked_add(1).ok_or("rosbag 操作编号耗尽")?;
        let id = inner.sequence;
        inner.entries.insert(
            kind,
            Entry {
                snapshot: Snapshot {
                    id,
                    kind,
                    window: owner.window.label.clone(),
                    host,
                    starting,
                    phase: Phase::Submitting,
                    message: "等待原生提交".into(),
                },
                owner,
                sent: false,
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
fn verified(snapshot: &Observations, kind: Kind, starting: bool, path: &str) -> Option<Value> {
    if !snapshot.connected {
        return None;
    }
    let entry = snapshot.entries.get(&kind.source())?;
    if entry.error.is_some() || entry.age_ms >= entry.ttl_ms {
        return None;
    }
    let value = entry.value.as_ref()?;
    if value[kind.field()].as_bool() != Some(starting) {
        return None;
    }
    let pid = value["pid"].as_u64()?;
    if (starting && pid == 0) || (!starting && pid != 0) {
        return None;
    }
    if kind == Kind::Play && starting && value["bagPath"].as_str() != Some(path) {
        return None;
    }
    Some(value.clone())
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
    let mut journal = Job::new(super::controller_journal::new_id()?, remote)?;
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
        hub.send_bag(&owner, id, &profile, kind)?;
        // Exactly one attempt. Even a transport timeout may have started the job.
        let mut proof = journal.submit(&profile).await.ok();
        let original = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
        let mut completed = false;
        loop {
            match proof.take() {
                Some(Proof::Succeeded) => completed = true,
                Some(Proof::Rejected(message)) => {
                    guard.update(Phase::Failed, &message, true);
                    return Err(message);
                }
                Some(Proof::Uncertain(message)) => guard.update(Phase::Uncertain, &message, false),
                _ => {}
            }
            let context = hub.context();
            if context["connected"] == true
                && super::controller_task::same_profile(&original, &context["profile"])
            {
                if completed {
                    if let Some(epoch) = context["epoch"].as_u64() {
                        if let Ok(snapshot) =
                            hub.observations.refresh(epoch, kind.source(), true).await
                        {
                            if let Some(value) = verified(&snapshot, kind, starting, &path) {
                                guard.update(
                                    Phase::Succeeded,
                                    "远端操作完成，已核验新鲜状态",
                                    true,
                                );
                                return Ok(value);
                            }
                        }
                    }
                } else {
                    proof = journal.query(&profile).await.ok();
                }
            }
            guard.update(
                if completed {
                    Phase::Verifying
                } else {
                    Phase::Uncertain
                },
                if completed {
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
        let play = operations
            .begin(
                &tasks,
                owner("page-monitor"),
                Kind::Play,
                true,
                "fixture".into(),
            )
            .unwrap();
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
        operations.abandoned(Kind::Play, play);
        assert!(tasks.migration("page-monitor").is_ok());
        operations.update(Kind::Record, id, Phase::Succeeded, "confirmed", true);
        assert!(tasks.migration("page-motion").is_ok());
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
    #[test]
    fn bag_completion_requires_fresh_correct_target_and_requested_playback_path() {
        let make = |kind: Kind, starting: bool| {
            Observations{epoch:1,connected:true,revision:1,handler_elapsed_ms:0,entries:[(kind.source(),Observation{sequence:1,value:Some(json!({kind.field():starting,"pid":if starting {42}else{0},"bagPath":"bags/a"})),error:None,age_ms:0,ttl_ms:8000})].into_iter().collect()}
        };
        for kind in [Kind::Record, Kind::Play] {
            for starting in [true, false] {
                let good = make(kind, starting);
                assert!(verified(&good, kind, starting, "bags/a").is_some());
                for fault in 0..6 {
                    let mut bad = make(kind, starting);
                    let entry = bad.entries.get_mut(&kind.source()).unwrap();
                    match fault {
                        0 => entry.age_ms = 8000,
                        1 => entry.error = Some("SSH".into()),
                        2 => entry.value.as_mut().unwrap()[kind.field()] = json!(!starting),
                        3 => {
                            entry.value.as_mut().unwrap()["pid"] =
                                json!(if starting { 0 } else { 42 })
                        }
                        4 => entry.value = None,
                        _ => bad.connected = false,
                    }
                    assert!(verified(&bad, kind, starting, "bags/a").is_none());
                }
            }
        }
        assert!(verified(&make(Kind::Play, true), Kind::Play, true, "bags/other").is_none());
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
