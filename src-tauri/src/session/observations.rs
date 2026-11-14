//! Read-only polling belongs to the application session, never to a WebView.
//! Windows read bounded snapshots; manual refreshes share the per-source gate.
use super::transport::Transport;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex as AsyncMutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Agent,
    Usb,
    Arm,
    Controllers,
    Topics,
    Clock,
    Motion,
    Pick,
    BagRecord,
    BagPlay,
    Collection,
}
impl Source {
    const ALL: [Self; 11] = [
        Self::Agent,
        Self::Usb,
        Self::Arm,
        Self::Controllers,
        Self::Topics,
        Self::Clock,
        Self::Motion,
        Self::Pick,
        Self::BagRecord,
        Self::BagPlay,
        Self::Collection,
    ];
    fn period(self, topics_ms: u64) -> Duration {
        Duration::from_millis(match self {
            Self::Agent | Self::BagRecord | Self::BagPlay | Self::Collection => 5000,
            Self::Usb | Self::Arm => 10000,
            Self::Topics => topics_ms,
            Self::Pick => 500,
            _ => 1000,
        })
    }
    fn timeout(self) -> Duration {
        Duration::from_millis(match self {
            Self::Controllers => 5500,
            Self::Clock => 2000,
            Self::Motion | Self::Pick => 3000,
            Self::Collection => 15000,
            _ => 10000,
        })
    }
    fn ttl(self, topics_ms: u64) -> u64 {
        match self {
            Self::Agent | Self::BagRecord | Self::BagPlay => 8000,
            Self::Collection => 20000,
            Self::Usb | Self::Arm => 15000,
            Self::Topics => topics_ms + 10000,
            Self::Controllers => 3100,
            Self::Clock => 2500,
            Self::Motion => 1500,
            Self::Pick => 1000,
        }
    }
}
pub type ReadFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type Reader = Arc<dyn Fn(Source, bool) -> ReadFuture + Send + Sync>;
type Changed = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, Serialize)]
pub struct Observation {
    pub sequence: u64,
    pub value: Option<Value>,
    pub error: Option<String>,
    pub age_ms: u64,
    pub ttl_ms: u64,
}
struct Entry {
    sequence: u64,
    result: Result<Value, String>,
    received: Instant,
    overhead_ms: u64,
    forced: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub epoch: u64,
    pub connected: bool,
    pub revision: u64,
    pub handler_elapsed_ms: u64,
    pub entries: BTreeMap<Source, Observation>,
}
struct Session {
    epoch: u64,
    reader: Reader,
    cancel: watch::Sender<bool>,
    entries: Mutex<BTreeMap<Source, Entry>>,
    gates: BTreeMap<Source, AsyncMutex<()>>,
    revision: Arc<AtomicU64>,
    topics_ms: Arc<AtomicU64>,
    changed: Arc<Mutex<Option<Changed>>>,
}
impl Session {
    fn snapshot(&self) -> Snapshot {
        let entries = self.entries.lock().unwrap();
        Snapshot {
            handler_elapsed_ms: 0,
            epoch: self.epoch,
            connected: !*self.cancel.borrow(),
            revision: self.revision.load(Ordering::Acquire),
            entries: entries
                .iter()
                .map(|(&source, entry)| {
                    (
                        source,
                        Observation {
                            sequence: entry.sequence,
                            value: entry.result.as_ref().ok().cloned(),
                            error: entry.result.as_ref().err().cloned(),
                            age_ms: entry
                                .overhead_ms
                                .saturating_add(entry.received.elapsed().as_millis() as u64),
                            ttl_ms: source.ttl(self.topics_ms.load(Ordering::Relaxed)),
                        },
                    )
                })
                .collect(),
        }
    }
    async fn refresh(
        &self,
        source: Source,
        force: bool,
        after_pending: bool,
    ) -> Result<Snapshot, String> {
        let before = self
            .entries
            .lock()
            .unwrap()
            .get(&source)
            .map_or(0, |e| e.sequence);
        let mut cancel = self.cancel.subscribe();
        let _gate = tokio::select! { biased;
            _ = cancel.wait_for(|value| *value) => return Err("共享查询会话已关闭".into()),
            gate = self.gates[&source].lock() => gate,
        };
        if *cancel.borrow() {
            return Err("共享查询会话已关闭".into());
        }
        let completed = self
            .entries
            .lock()
            .unwrap()
            .get(&source)
            .is_some_and(|entry| entry.sequence > before && (!force || entry.forced));
        // Explicit post-action verification must start after older work drains.
        if completed && !after_pending {
            return Ok(self.snapshot());
        }
        let started = Instant::now();
        let result = tokio::select! { biased;
            _ = cancel.wait_for(|value| *value) => return Err("共享查询会话已关闭".into()),
            result = tokio::time::timeout(source.timeout(), (self.reader)(source, force)) => result.unwrap_or_else(|_| Err("共享状态查询超时".into())),
        }.and_then(|value| {
            if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 { Err("共享状态超过 2 MiB 上限".into()) } else { Ok(value) }
        });
        if *cancel.borrow() {
            return Err("共享查询会话已关闭".into());
        }
        let duration = started.elapsed().as_millis() as u64;
        let server_wait = if source == Source::Controllers {
            result
                .as_ref()
                .ok()
                .and_then(|v| v["request_wait_ms"].as_u64())
                .unwrap_or(0)
                .min(duration)
        } else {
            0
        };
        {
            let mut entries = self.entries.lock().unwrap();
            let sequence = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
            entries.insert(
                source,
                Entry {
                    sequence,
                    result,
                    received: Instant::now(),
                    overhead_ms: duration - server_wait,
                    forced: force,
                },
            );
        }
        let changed = self.changed.lock().unwrap().clone();
        if let Some(changed) = changed {
            changed();
        }
        Ok(self.snapshot())
    }
}

pub struct Observations {
    session: Mutex<Option<Arc<Session>>>,
    epoch: AtomicU64,
    revision: Arc<AtomicU64>,
    topics_ms: Arc<AtomicU64>,
    changed: Arc<Mutex<Option<Changed>>>,
}
impl Default for Observations {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            epoch: AtomicU64::new(0),
            revision: Arc::new(AtomicU64::new(0)),
            topics_ms: Arc::new(AtomicU64::new(30000)),
            changed: Arc::new(Mutex::new(None)),
        }
    }
}
impl Drop for Observations {
    fn drop(&mut self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            session.cancel.send_replace(true);
        }
    }
}
impl Observations {
    pub fn set_changed(&self, changed: Changed) {
        *self.changed.lock().unwrap() = Some(changed);
    }
    pub fn stop(&self, epoch: u64) {
        // A stale transport failure cannot stop the replacement connection.
        let mut current = self.session.lock().unwrap();
        if epoch < self.epoch.load(Ordering::Acquire) {
            return;
        }
        self.epoch.store(epoch, Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
        if let Some(session) = current.take() {
            session.cancel.send_replace(true);
        }
        drop(current);
        let changed = self.changed.lock().unwrap().clone();
        if let Some(changed) = changed {
            changed();
        }
    }
    pub fn start(&self, epoch: u64, reader: Reader) {
        let mut current = self.session.lock().unwrap();
        if epoch < self.epoch.load(Ordering::Acquire) {
            return;
        }
        if let Some(old) = current.take() {
            old.cancel.send_replace(true);
        }
        self.epoch.store(epoch, Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
        let session = Arc::new(Session {
            epoch,
            reader,
            cancel: watch::channel(false).0,
            entries: Mutex::new(BTreeMap::new()),
            gates: Source::ALL
                .into_iter()
                .map(|s| (s, AsyncMutex::new(())))
                .collect(),
            revision: self.revision.clone(),
            topics_ms: self.topics_ms.clone(),
            changed: self.changed.clone(),
        });
        *current = Some(session.clone());
        drop(current);
        for source in Source::ALL {
            let session = session.clone();
            tokio::spawn(async move {
                let mut cancel = session.cancel.subscribe();
                loop {
                    if session.refresh(source, false, false).await.is_err() {
                        break;
                    }
                    if matches!(
                        source,
                        Source::Controllers | Source::Clock | Source::Motion | Source::Pick
                    ) {
                        let unsupported =
                            session
                                .entries
                                .lock()
                                .unwrap()
                                .get(&source)
                                .is_some_and(|entry| match &entry.result {
                                    Ok(value) => value["supported"] == false,
                                    Err(error) => ["未知操作", "unknown op", "unsupported"]
                                        .iter()
                                        .any(|word| error.to_lowercase().contains(word)),
                                });
                        if unsupported {
                            break;
                        }
                    }
                    tokio::select! { biased;
                        _ = cancel.wait_for(|value| *value) => break,
                        _ = tokio::time::sleep(source.period(session.topics_ms.load(Ordering::Relaxed))) => {},
                    }
                }
            });
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.session.lock().unwrap().as_ref().map_or_else(
            || Snapshot {
                handler_elapsed_ms: 0,
                epoch: self.epoch.load(Ordering::Acquire),
                connected: false,
                revision: self.revision.load(Ordering::Acquire),
                entries: BTreeMap::new(),
            },
            |session| session.snapshot(),
        )
    }
    pub fn versions(&self) -> (u64, BTreeMap<Source, u64>) {
        let current = self.session.lock().unwrap();
        current.as_ref().map_or(
            (self.epoch.load(Ordering::Acquire), BTreeMap::new()),
            |session| {
                (
                    session.epoch,
                    session
                        .entries
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(source, entry)| (*source, entry.sequence))
                        .collect(),
                )
            },
        )
    }
    pub async fn refresh(
        &self,
        epoch: u64,
        source: Source,
        after_pending: bool,
    ) -> Result<Snapshot, String> {
        let session = self
            .session
            .lock()
            .unwrap()
            .clone()
            .filter(|session| session.epoch == epoch)
            .ok_or("共享查询会话已改变")?;
        session.refresh(source, true, after_pending).await
    }
    pub async fn read(&self, epoch: u64, source: Source) -> Result<Snapshot, String> {
        let session = self
            .session
            .lock()
            .unwrap()
            .clone()
            .filter(|session| session.epoch == epoch)
            .ok_or("共享查询会话已改变")?;
        let snapshot = session.snapshot();
        if snapshot
            .entries
            .get(&source)
            .is_some_and(|entry| entry.age_ms < entry.ttl_ms)
        {
            return Ok(snapshot);
        }
        session.refresh(source, false, false).await
    }
    pub fn set_topics_interval(&self, seconds: u64) -> Result<(), String> {
        if !(5..=300).contains(&seconds) {
            return Err("Topics 刷新间隔须为 5–300 秒".into());
        }
        self.topics_ms.store(seconds * 1000, Ordering::Relaxed);
        Ok(())
    }
}

/// Only a fixed read-only allowlist can be scheduled. No control command is retried.
pub fn reader(transport: Arc<Transport>, profile: Value) -> Reader {
    Arc::new(move |source, force| {
        let transport = transport.clone();
        let profile = profile.clone();
        Box::pin(async move {
            let profile = || {
                serde_json::from_value::<crate::ConnectionProfile>(profile.clone())
                    .map_err(|e| e.to_string())
            };
            let serialize = |result| serde_json::to_value(result).map_err(|e| e.to_string());
            match source {
                Source::Agent => serialize(crate::check_micro_ros_agent(profile()?).await?),
                Source::Usb => serde_json::to_value(crate::probe_jetson_usb(profile()?).await?)
                    .map_err(|e| e.to_string()),
                Source::Arm => serde_json::to_value(crate::probe_arm_mode(profile()?).await?)
                    .map_err(|e| e.to_string()),
                Source::BagRecord => serde_json::to_value(crate::get_rosbag_status(profile()?).await?)
                    .map_err(|e| e.to_string()),
                Source::BagPlay => serde_json::to_value(crate::get_rosbag_play_status(profile()?).await?)
                    .map_err(|e| e.to_string()),
                Source::Collection => serde_json::to_value(crate::data_collection::read_status(profile()?).await?)
                    .map_err(|e| e.to_string()),
                _ => {
                    if source == Source::Controllers
                        && transport.hello.metadata["controllers_info_supported"] != true
                    {
                        return Ok(json!({"op":"controllers_info", "supported":false}));
                    }
                    let request = match source {
                        Source::Controllers => json!({"op":"controllers_info", "refresh":force}),
                        Source::Topics => json!({"op":"topics"}),
                        Source::Clock => json!({"op":"clock_sync_info"}),
                        Source::Motion | Source::Pick => {
                            return Err("unsupported: 运动观察未接入".into())
                        }
                        _ => unreachable!(),
                    };
                    let response = transport.request(request.clone(), source.timeout()).await?;
                    if response.op() != request["op"].as_str().unwrap() {
                        return Err(response.metadata["message"]
                            .as_str()
                            .unwrap_or("共享查询响应无效")
                            .into());
                    }
                    Ok(response.metadata)
                }
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{mpsc, oneshot};

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }
    fn controlled() -> (
        Arc<Observations>,
        mpsc::UnboundedReceiver<(bool, oneshot::Sender<Value>)>,
    ) {
        let service = Arc::new(Observations::default());
        let (send, receive) = mpsc::unbounded_channel();
        service.start(
            1,
            Arc::new(move |source, force| {
                let send = send.clone();
                Box::pin(async move {
                    if source != Source::Controllers {
                        return Ok(json!({"source":source}));
                    }
                    let (result, response) = oneshot::channel();
                    send.send((force, result)).unwrap();
                    response.await.map_err(|_| "test query dropped".into())
                })
            }),
        );
        (service, receive)
    }

    #[tokio::test]
    async fn nine_windows_share_a_poll_and_refresh_but_post_action_verification_starts_later() {
        let (service, mut requests) = controlled();
        let (forced, automatic) = requests.recv().await.unwrap();
        assert!(!forced);
        let readers: Vec<_> = (0..9)
            .map(|_| {
                let service = service.clone();
                tokio::spawn(async move { service.read(1, Source::Controllers).await.unwrap() })
            })
            .collect();
        settle().await;
        assert!(requests.try_recv().is_err());
        automatic.send(json!({"state":"inactive"})).unwrap();
        for reader in readers {
            assert_eq!(
                reader.await.unwrap().entries[&Source::Controllers]
                    .value
                    .as_ref()
                    .unwrap()["state"],
                "inactive"
            );
        }
        assert!(requests.try_recv().is_err());
        let refreshes: Vec<_> = (0..9)
            .map(|_| {
                let service = service.clone();
                tokio::spawn(async move {
                    service
                        .refresh(1, Source::Controllers, false)
                        .await
                        .unwrap()
                })
            })
            .collect();
        let (forced, before) = requests.recv().await.unwrap();
        assert!(forced);
        settle().await;
        let verifier = {
            let service = service.clone();
            tokio::spawn(
                async move { service.refresh(1, Source::Controllers, true).await.unwrap() },
            )
        };
        settle().await;
        assert!(requests.try_recv().is_err());
        before.send(json!({"state":"before-switch"})).unwrap();
        let (forced, after) = requests.recv().await.unwrap();
        assert!(forced);
        for refresh in refreshes {
            assert_eq!(
                refresh.await.unwrap().entries[&Source::Controllers]
                    .value
                    .as_ref()
                    .unwrap()["state"],
                "before-switch"
            );
        }
        after.send(json!({"state":"active"})).unwrap();
        assert_eq!(
            verifier.await.unwrap().entries[&Source::Controllers]
                .value
                .as_ref()
                .unwrap()["state"],
            "active"
        );
        service.stop(2);
    }

    #[tokio::test]
    async fn stop_cancels_inflight_work_and_old_failures_cannot_stop_replacement_session() {
        let (service, mut requests) = controlled();
        let (_, old) = requests.recv().await.unwrap();
        let waiter = {
            let service = service.clone();
            tokio::spawn(async move { service.refresh(1, Source::Controllers, true).await })
        };
        settle().await;
        service.stop(2);
        assert!(waiter.await.unwrap().is_err());
        settle().await;
        assert!(old.send(json!({"state":"old"})).is_err());
        service.start(
            3,
            Arc::new(|_, _| Box::pin(async { Ok(json!({"state":"new"})) })),
        );
        settle().await;
        service.stop(1);
        let snapshot = service.snapshot();
        assert!(snapshot.connected);
        assert_eq!(snapshot.epoch, 3);
        assert_eq!(
            snapshot.entries[&Source::Controllers]
                .value
                .as_ref()
                .unwrap()["state"],
            "new"
        );
        assert!(service.refresh(1, Source::Arm, true).await.is_err());
        service.stop(4);
        assert!(service.snapshot().entries.is_empty());
    }

    #[tokio::test]
    async fn polling_runs_without_any_webview_and_stops_without_leaking_tasks() {
        let service = Observations::default();
        let counts = Arc::new(Mutex::new(BTreeMap::<Source, usize>::new()));
        let seen = counts.clone();
        service.start(
            1,
            Arc::new(move |source, _| {
                *seen.lock().unwrap().entry(source).or_default() += 1;
                Box::pin(async { Ok(json!({})) })
            }),
        );
        settle().await;
        for _ in 0..9 {
            let _ = service.snapshot();
        }
        assert_eq!(counts.lock().unwrap().values().sum::<usize>(), 11);
        tokio::time::sleep(Duration::from_millis(1050)).await;
        assert_eq!(counts.lock().unwrap()[&Source::Controllers], 2);
        assert_eq!(counts.lock().unwrap()[&Source::Clock], 2);
        assert_eq!(counts.lock().unwrap()[&Source::Agent], 1);
        assert_eq!(counts.lock().unwrap()[&Source::BagRecord], 1);
        assert_eq!(counts.lock().unwrap()[&Source::BagPlay], 1);
        assert_eq!(counts.lock().unwrap()[&Source::Collection], 1);
        service.stop(2);
        let before = counts.lock().unwrap().clone();
        tokio::time::sleep(Duration::from_millis(1050)).await;
        assert_eq!(*counts.lock().unwrap(), before);
    }

    #[tokio::test]
    async fn collection_queries_are_shared_and_late_results_cannot_cross_connections() {
        let service = Arc::new(Observations::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        service.start(1, Arc::new(move |source, _| {
            let tx = tx.clone();
            Box::pin(async move {
                if source != Source::Collection { return Ok(json!({"supported":false})); }
                let (done, reply) = oneshot::channel();
                tx.send(done).unwrap();
                reply.await.map_err(|_| "query dropped".into())
            })
        }));
        let first = rx.recv().await.unwrap();
        let readers: Vec<_> = (0..9).map(|_| {
            let service = service.clone();
            tokio::spawn(async move { service.read(1, Source::Collection).await.unwrap() })
        }).collect();
        settle().await;
        assert!(rx.try_recv().is_err());
        first.send(json!({"state":"recording","recording":true})).unwrap();
        for reader in readers {
            assert_eq!(reader.await.unwrap().entries[&Source::Collection].value.as_ref().unwrap()["recording"], true);
        }
        let refresh = tokio::spawn({ let service = service.clone(); async move {
            service.refresh(1, Source::Collection, true).await
        }});
        let late = rx.recv().await.unwrap();
        service.stop(2);
        assert!(refresh.await.unwrap().is_err());
        assert!(late.send(json!({"state":"idle"})).is_err());
        assert!(service.snapshot().entries.is_empty());
        assert_eq!(Source::Collection.period(30000), Duration::from_secs(5));
        assert_eq!(Source::Collection.timeout(), Duration::from_secs(15));
    }

    #[tokio::test]
    async fn bag_readers_share_pending_queries_and_keep_recording_independent_from_playback() {
        let service=Arc::new(Observations::default());
        let (tx,mut rx)=mpsc::unbounded_channel();
        service.start(1,Arc::new(move |source,_| {
            let tx=tx.clone();
            Box::pin(async move {
                if !matches!(source,Source::BagRecord|Source::BagPlay) {return Ok(json!({"supported":false}));}
                let (done,reply)=oneshot::channel();
                tx.send((source,done)).unwrap();
                reply.await.map_err(|_| "canceled".to_string())
            })
        }));
        let first=rx.recv().await.unwrap();let second=rx.recv().await.unwrap();
        assert_ne!(first.0,second.0);
        let readers:Vec<_>=(0..9).map(|_| {
            let service=service.clone();
            tokio::spawn(async move {service.read(1,Source::BagRecord).await.unwrap()})
        }).collect();
        settle().await;assert!(rx.try_recv().is_err());
        for (source,reply) in [first,second] {
            reply.send(if source==Source::BagRecord {json!({"recording":true,"pid":42})} else {json!({"playing":false,"pid":0})}).unwrap();
        }
        for reader in readers {
            assert_eq!(reader.await.unwrap().entries[&Source::BagRecord].value.as_ref().unwrap()["recording"],true);
        }
        settle().await;
        assert_eq!(service.snapshot().entries[&Source::BagPlay].value.as_ref().unwrap()["playing"],false);
        let pending=tokio::spawn({let service=service.clone();async move {service.refresh(1,Source::BagRecord,true).await}});
        let (source,reply)=rx.recv().await.unwrap();assert_eq!(source,Source::BagRecord);
        service.stop(2);
        assert!(pending.await.unwrap().is_err());
        assert!(reply.send(json!({"recording":true})).is_err());
        assert!(service.snapshot().entries.is_empty());
    }

    #[tokio::test]
    async fn source_age_is_monotonic_and_failed_or_oversized_replies_do_not_retain_ready_data() {
        let service = Observations::default();
        service.start(
            1,
            Arc::new(|_, force| {
                Box::pin(async move {
                    if force {
                        Err("SSH gone".into())
                    } else {
                        Ok(json!({"ready":true}))
                    }
                })
            }),
        );
        settle().await;
        let session = service.session.lock().unwrap().clone().unwrap();
        session
            .entries
            .lock()
            .unwrap()
            .get_mut(&Source::Arm)
            .unwrap()
            .received -= Duration::from_secs(16);
        let before = service.snapshot();
        assert!(before.entries[&Source::Arm].age_ms >= 16000);
        assert!(
            service.snapshot().entries[&Source::Arm].age_ms >= before.entries[&Source::Arm].age_ms
        );
        let failed = service.refresh(1, Source::Arm, true).await.unwrap();
        assert_eq!(failed.entries[&Source::Arm].value, None);
        assert_eq!(
            failed.entries[&Source::Arm].error.as_deref(),
            Some("SSH gone")
        );
        assert!(service.set_topics_interval(0).is_err());
        assert!(service.set_topics_interval(301).is_err());
        service.set_topics_interval(5).unwrap();
        assert_eq!(service.snapshot().entries[&Source::Topics].ttl_ms, 15000);
        service.start(
            2,
            Arc::new(|_, _| Box::pin(async { Ok(Value::String("x".repeat(2 * 1024 * 1024))) })),
        );
        settle().await;
        assert!(service
            .snapshot()
            .entries
            .values()
            .all(|entry| entry.value.is_none() && entry.error.as_ref().unwrap().contains("2 MiB")));
        service.stop(3);
    }
}
