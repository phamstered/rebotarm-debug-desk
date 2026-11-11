use super::{
    delivery::{Frame, Limits, Mailbox},
    subscriptions::{Consumer, SubscriptionRegistry, Transition},
    transport::Transport,
    windows::{WindowRegistry, WindowToken},
    wire::WireFrame,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, Notify};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attachment {
    pub epoch: u64,
    pub window: WindowToken,
}

struct Client {
    mailbox: Mailbox,
    notify: Arc<Notify>,
    pulling: Arc<AtomicBool>,
    error: Option<String>,
}

struct Core {
    epoch: u64,
    windows: WindowRegistry,
    clients: BTreeMap<WindowToken, Client>,
    subscriptions: SubscriptionRegistry,
    transport: Option<Arc<Transport>>,
    rgbd_owner: Option<WindowToken>,
    error: Option<String>,
    latest_topics: BTreeMap<String, (WireFrame, u64)>,
    cached_bytes: usize,
    profile: Value,
}

impl Core {
    fn validate(&self, native_label: &str, attachment: &Attachment) -> Result<(), String> {
        if self.epoch != attachment.epoch {
            return Err("Bridge 连接代次已失效".into());
        }
        self.windows
            .validate(native_label, &attachment.window)
            .map_err(String::from)?;
        let client = self
            .clients
            .get(&attachment.window)
            .ok_or("窗口会话已关闭")?;
        if let Some(error) = &client.error {
            return Err(error.clone());
        }
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        Ok(())
    }
}

/// Application lifetime, independent of all visible WebViews. It is deliberately
/// not a static JS singleton (each WebView has a different JS heap).
pub struct Runtime {
    core: Arc<Mutex<Core>>,
    connect_gate: AsyncMutex<()>,
    subscriptions_gate: AsyncMutex<()>,
    origin: Instant,
    changed: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            core: Arc::new(Mutex::new(Core {
                epoch: 0,
                windows: WindowRegistry::default(),
                clients: BTreeMap::new(),
                subscriptions: SubscriptionRegistry::new(0, 256),
                transport: None,
                rgbd_owner: None,
                error: Some("Bridge 尚未连接".into()),
                latest_topics: BTreeMap::new(),
                cached_bytes: 0,
                profile: Value::Null,
            })),
            connect_gate: AsyncMutex::new(()),
            subscriptions_gate: AsyncMutex::new(()),
            origin: Instant::now(),
            changed: Arc::new(Mutex::new(None)),
        }
    }
}

impl Runtime {
    pub fn set_changed(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *self.changed.lock().unwrap() = Some(callback);
    }
    pub fn set_profile(&self, profile: Value) {
        self.core.lock().unwrap().profile = profile;
    }
    pub fn context(&self) -> Value {
        let core = self.core.lock().unwrap();
        json!({ "epoch":core.epoch, "connected":core.transport.is_some() && core.error.is_none(), "profile":core.profile, "error":core.error })
    }
    pub fn close(&self) {
        let transport = {
            let mut core = self.core.lock().unwrap();
            core.epoch += 1;
            core.error = Some("Bridge 会话已关闭".into());
            core.subscriptions = SubscriptionRegistry::new(core.epoch, 256);
            core.rgbd_owner = None;
            core.latest_topics.clear();
            core.cached_bytes = 0;
            for client in core.clients.values() {
                client.notify.notify_one();
            }
            core.clients.clear();
            core.windows = WindowRegistry::default();
            core.transport.take()
        };
        if let Some(transport) = transport {
            transport.close();
        }
        if let Some(changed) = self.changed.lock().unwrap().clone() {
            changed();
        }
    }

    /// Only the main window can initiate a connection. The port must come from
    /// the already established SSH tunnel, validated at the native IPC boundary.
    pub async fn connect(&self, port: u16) -> Result<(), String> {
        let _gate = self.connect_gate.lock().await;
        if self.core.lock().unwrap().transport.is_some() {
            return Ok(());
        }
        self.close();
        let epoch = {
            let mut core = self.core.lock().unwrap();
            core.error = None;
            core.epoch
        };
        let events_core = self.core.clone();
        let errors_core = self.core.clone();
        let errors_changed = self.changed.clone();
        let origin = self.origin;
        let transport = Transport::connect(
            port,
            epoch,
            Arc::new(move |frame| {
                let mut core = events_core.lock().unwrap();
                if core.epoch != epoch || core.error.is_some() {
                    return;
                }
                route(&mut core, frame, origin.elapsed().as_millis() as u64);
            }),
            Arc::new(move |error| {
                let mut core = errors_core.lock().unwrap();
                if core.epoch != epoch {
                    return;
                }
                core.error = Some(error);
                core.transport = None;
                for client in core.clients.values() {
                    client.notify.notify_one();
                }
                drop(core);
                if let Some(changed) = errors_changed.lock().unwrap().clone() {
                    changed();
                }
            }),
        )
        .await;
        let transport = match transport {
            Ok(transport) => transport,
            Err(error) => {
                let mut core = self.core.lock().unwrap();
                if core.epoch == epoch {
                    core.error = Some(error.clone());
                }
                return Err(error);
            }
        };
        let mut core = self.core.lock().unwrap();
        if core.epoch != epoch {
            transport.close();
            return Err("连接已被取消".into());
        }
        if let Some(error) = &core.error {
            transport.close();
            return Err(error.clone());
        }
        core.transport = Some(Arc::new(transport));
        drop(core);
        if let Some(changed) = self.changed.lock().unwrap().clone() {
            changed();
        }
        Ok(())
    }

    pub fn attach(&self, native_label: &str) -> Result<(Attachment, Value), String> {
        let mut core = self.core.lock().unwrap();
        if let Some(error) = &core.error {
            return Err(error.clone());
        }
        let hello = core
            .transport
            .as_ref()
            .ok_or("Bridge 尚未连接")?
            .hello
            .metadata
            .clone();
        let token = core.windows.register(native_label).map_err(String::from)?;
        let epoch = core.epoch;
        core.clients.insert(
            token.clone(),
            Client {
                mailbox: Mailbox::new(epoch, Limits::default()),
                notify: Arc::new(Notify::new()),
                pulling: Arc::new(AtomicBool::new(false)),
                error: None,
            },
        );
        Ok((
            Attachment {
                epoch,
                window: token,
            },
            hello,
        ))
    }

    pub async fn detach(&self, native_label: &str, attachment: &Attachment) -> Result<(), String> {
        let _gate = self.subscriptions_gate.lock().await;
        let (transitions, transport, rgbd) = {
            let mut core = self.core.lock().unwrap();
            // Cleanup remains possible even after a stream error.
            if core.epoch != attachment.epoch {
                return Ok(());
            }
            core.windows
                .validate(native_label, &attachment.window)
                .map_err(String::from)?;
            if let Some(client) = core.clients.remove(&attachment.window) {
                client.notify.notify_one();
            }
            core.windows.remove(&attachment.window);
            let transitions = core.subscriptions.release_window(&attachment.window);
            let rgbd = core.rgbd_owner.as_ref() == Some(&attachment.window);
            if rgbd {
                core.rgbd_owner = None;
            }
            (transitions, core.transport.clone(), rgbd)
        };
        if let Some(transport) = transport {
            self.apply_transitions(&transport, transitions).await?;
            if rgbd {
                transport
                    .request(json!({"op":"unsubscribe_rgbd"}), Duration::from_secs(5))
                    .await?;
            }
        }
        Ok(())
    }

    async fn apply_transitions(
        &self,
        transport: &Transport,
        mut changes: Vec<Transition>,
    ) -> Result<(), String> {
        while let Some(change) = changes.pop() {
            let reply = transport
                .request(
                    json!({"op":if change.subscribe {"subscribe"} else {"unsubscribe"},
                "topic": change.topic, "type":change.message_type}),
                    Duration::from_secs(5),
                )
                .await;
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    // A timed-out unsubscribe may already have executed. Do not
                    // grant future consumers a guessed upstream subscription.
                    self.close();
                    return Err(format!("订阅状态未确认，会话已失效：{error}"));
                }
            };
            let result: Result<(), String> = (|| {
                let expected = if change.subscribe {
                    "subscribed"
                } else {
                    "unsubscribed"
                };
                if reply.op() != expected {
                    return Err(reply.metadata["message"]
                        .as_str()
                        .unwrap_or("订阅响应无效")
                        .into());
                }
                Ok(())
            })();
            let mut core = self.core.lock().unwrap();
            changes.extend(
                core.subscriptions
                    .acknowledge(&change, result.is_ok())
                    .map_err(String::from)?,
            );
            result?;
        }
        Ok(())
    }

    pub async fn request(
        &self,
        native_label: &str,
        attachment: &Attachment,
        consumer: &str,
        message: Value,
        timeout: Duration,
    ) -> Result<WireFrame, String> {
        let transport = {
            let core = self.core.lock().unwrap();
            core.validate(native_label, attachment)?;
            core.transport.clone().ok_or("Bridge 尚未连接")?
        };
        let op = message["op"].as_str().ok_or("请求缺少 op")?;
        if matches!(op, "subscribe" | "unsubscribe") {
            let _gate = self.subscriptions_gate.lock().await;
            let topic = message["topic"].as_str().ok_or("订阅缺少 topic")?;
            let changes = {
                let mut core = self.core.lock().unwrap();
                core.validate(native_label, attachment)?;
                let consumer = Consumer {
                    window: attachment.window.clone(),
                    name: consumer.into(),
                };
                if op == "subscribe" {
                    core.subscriptions
                        .acquire(
                            topic,
                            message["type"].as_str().ok_or("订阅缺少 type")?,
                            consumer,
                        )
                        .map_err(String::from)?
                } else {
                    core.subscriptions.release(topic, &consumer)
                }
            };
            self.apply_transitions(&transport, changes).await?;
            {
                let mut core = self.core.lock().unwrap();
                core.validate(native_label, attachment)?;
                if op == "subscribe" {
                    let now = self.origin.elapsed().as_millis() as u64;
                    if let Some((frame, at)) = core.latest_topics.get(topic).cloned() {
                        let static_topic =
                            core.subscriptions.message_type(topic) == Some("std_msgs/msg/String");
                        if static_topic || now.saturating_sub(at) <= 500 {
                            let epoch = core.epoch;
                            let client = core.clients.get_mut(&attachment.window).unwrap();
                            enqueue(client, epoch, frame, at, static_topic);
                        }
                    }
                }
            }
            return WireFrame::parse(serde_json::to_vec(&json!({"op":if op == "subscribe" {"subscribed"} else {"unsubscribed"}, "topic":topic})).unwrap().into(), false);
        }
        if matches!(op, "subscribe_rgbd" | "unsubscribe_rgbd") {
            let _gate = self.subscriptions_gate.lock().await;
            {
                let core = self.core.lock().unwrap();
                core.validate(native_label, attachment)?;
                if core
                    .rgbd_owner
                    .as_ref()
                    .is_some_and(|owner| owner != &attachment.window)
                {
                    return Err("RGBD 已由另一功能窗口使用".into());
                }
            }
            let result = transport.request(message.clone(), timeout).await?;
            let mut core = self.core.lock().unwrap();
            core.validate(native_label, attachment)?;
            if result.op() == "subscribed_rgbd" {
                core.rgbd_owner = Some(attachment.window.clone());
            } else if result.op() == "unsubscribed_rgbd" {
                core.rgbd_owner = None;
            }
            return Ok(result);
        }
        let reply = transport.request(message, timeout).await?;
        self.core
            .lock()
            .unwrap()
            .validate(native_label, attachment)?;
        Ok(reply)
    }

    /// One outstanding pull per WebView. No push into an unbounded Tauri Channel.
    /// The response contains one frame; the caller drains again after decoding.
    pub async fn next(
        &self,
        native_label: &str,
        attachment: &Attachment,
    ) -> Result<Vec<u8>, String> {
        let (notify, pulling) = {
            let core = self.core.lock().unwrap();
            core.validate(native_label, attachment)?;
            let client = &core.clients[&attachment.window];
            (client.notify.clone(), client.pulling.clone())
        };
        if pulling.swap(true, Ordering::AcqRel) {
            return Err("窗口已有在途数据拉取".into());
        }
        struct PullGuard(Arc<AtomicBool>);
        impl Drop for PullGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = PullGuard(pulling);
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            let notified = notify.notified();
            {
                let mut core = self.core.lock().unwrap();
                core.validate(native_label, attachment)?;
                let now = self.origin.elapsed().as_millis() as u64;
                if let Some(frame) = core
                    .clients
                    .get_mut(&attachment.window)
                    .unwrap()
                    .mailbox
                    .pop(now, 500)
                {
                    return Ok(pack(
                        frame.binary,
                        now.saturating_sub(frame.received_ms),
                        started.elapsed().as_millis() as u64,
                        &frame.bytes,
                    ));
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(Vec::new());
            }
        }
    }
}

pub fn pack(binary: bool, age_ms: u64, elapsed_ms: u64, bytes: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(17 + bytes.len());
    result.push(u8::from(binary));
    result.extend(age_ms.to_le_bytes());
    result.extend(elapsed_ms.to_le_bytes());
    result.extend(bytes);
    result
}

fn route(core: &mut Core, frame: WireFrame, at: u64) {
    let topic = frame.metadata["topic"].as_str();
    let static_topic = frame.op() == "topic_message"
        && core.subscriptions.message_type(topic.unwrap_or("")) == Some("std_msgs/msg/String");
    // Transient-local URDF can arrive before subscribe ACK. Retain it, and retain
    // bounded latest non-image feedback for windows joining an existing stream.
    if frame.op() == "topic_message" && !frame.binary && frame.bytes.len() <= 16 * 1024 * 1024 {
        let key = topic.unwrap_or("").to_string();
        if let Some((old, _)) = core.latest_topics.remove(&key) {
            core.cached_bytes -= old.bytes.len();
        }
        while core.cached_bytes + frame.bytes.len() > 16 * 1024 * 1024
            || core.latest_topics.len() >= 256
        {
            let oldest = core
                .latest_topics
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                break;
            };
            if let Some((old, _)) = core.latest_topics.remove(&oldest) {
                core.cached_bytes -= old.bytes.len();
            }
        }
        core.cached_bytes += frame.bytes.len();
        core.latest_topics.insert(key, (frame.clone(), at));
    }
    let recipients = if frame.op() == "topic_message" {
        core.subscriptions.recipients(topic.unwrap_or(""))
    } else if matches!(frame.op(), "rgbd_frame" | "visual_target_frame") {
        core.rgbd_owner.iter().cloned().collect()
    } else {
        core.clients.keys().cloned().collect()
    };
    for token in recipients {
        if let Some(client) = core.clients.get_mut(&token) {
            enqueue(client, core.epoch, frame.clone(), at, static_topic);
        }
    }
}

fn enqueue(client: &mut Client, epoch: u64, frame: WireFrame, at: u64, static_topic: bool) {
    let latest = match frame.op() {
        "topic_message" if !static_topic => Some(format!(
            "topic:{}",
            frame.metadata["topic"].as_str().unwrap_or("")
        )),
        "rgbd_frame" | "visual_target_frame" => Some(frame.op().to_string()),
        _ => None,
    };
    if client.error.is_some() {
        return;
    }
    let data = Frame {
        epoch,
        received_ms: at,
        binary: frame.binary,
        bytes: frame.bytes.clone(),
    };
    let result = if let Some(key) = &latest {
        client.mailbox.latest(key.clone(), data)
    } else {
        client.mailbox.reliable(data)
    };
    if let Err(error) = result {
        client.error = Some(format!("窗口数据队列失效：{error:?}"));
    }
    client.notify.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    async fn fake_bridge() -> (
        u16,
        mpsc::UnboundedSender<Value>,
        Arc<Mutex<Vec<Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let received = Arc::new(Mutex::new(Vec::new()));
        let seen = received.clone();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            loop {
                let reply = tokio::select! {
                    message = socket.next() => {
                        let Some(Ok(Message::Text(text))) = message else { break; };
                        let message: Value = serde_json::from_str(&text).unwrap();
                        seen.lock().unwrap().push(message.clone());
                        if message["op"] == "subscribe" && message["type"] == "std_msgs/msg/String" {
                            // Model a transient-local URDF callback preceding ACK.
                            socket.send(Message::Text(json!({"op":"topic_message", "topic":message["topic"], "data":"<robot name='fixture'/>"}).to_string().into())).await.unwrap();
                        }
                        match message["op"].as_str().unwrap() {
                            "hello" => json!({"op":"hello"}),
                            "subscribe" => json!({"op":"subscribed", "topic":message["topic"], "request_id":message["request_id"]}),
                            "unsubscribe" => json!({"op":"unsubscribed", "topic":message["topic"], "request_id":message["request_id"]}),
                            _ => json!({"op":"error", "request_id":message["request_id"], "message":"isolated bridge: unsupported"}),
                        }
                    },
                    event = rx.recv() => { let Some(event) = event else { break; }; event },
                };
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        (port, tx, received, task)
    }

    #[tokio::test]
    async fn two_windows_share_subscription_and_closing_one_preserves_other() {
        let (port, events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        // Calling connect again does not create another socket.
        hub.connect(port).await.unwrap();
        let (main, _) = hub.attach("main").unwrap();
        let (handeye, _) = hub.attach("page-handeye").unwrap();
        assert!(hub.attach("malicious").is_err());
        assert!(hub
            .request(
                "main",
                &handeye,
                "rgb",
                json!({"op":"hello"}),
                Duration::from_secs(1)
            )
            .await
            .is_err());
        let subscribe =
            json!({"op":"subscribe", "topic":"/test/rgb", "type":"sensor_msgs/msg/Image"});
        for (label, client) in [("main", &main), ("page-handeye", &handeye)] {
            hub.request(
                label,
                client,
                "rgb",
                subscribe.clone(),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        }
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|v| v["op"] == "subscribe")
                .count(),
            1
        );
        events
            .send(json!({"op":"topic_message", "topic":"/test/rgb", "data":7}))
            .unwrap();
        for (label, client) in [("main", &main), ("page-handeye", &handeye)] {
            let packed = hub.next(label, client).await.unwrap();
            assert_eq!(
                WireFrame::parse(Arc::from(&packed[17..]), packed[0] == 1)
                    .unwrap()
                    .metadata["data"],
                7
            );
        }
        hub.detach("main", &main).await.unwrap();
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|v| v["op"] == "unsubscribe")
                .count(),
            0
        );
        events
            .send(json!({"op":"topic_message", "topic":"/test/rgb", "data":8}))
            .unwrap();
        let packed = hub.next("page-handeye", &handeye).await.unwrap();
        assert_eq!(
            WireFrame::parse(Arc::from(&packed[17..]), false)
                .unwrap()
                .metadata["data"],
            8
        );
        hub.detach("page-handeye", &handeye).await.unwrap();
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|v| v["op"] == "unsubscribe")
                .count(),
            1
        );
        hub.close();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn close_wakes_pending_pull_and_old_attachment_cannot_access_new_connection() {
        let (port, _events, _seen, server) = fake_bridge().await;
        let hub = Arc::new(Runtime::default());
        hub.connect(port).await.unwrap();
        let (old, _) = hub.attach("main").unwrap();
        let pulling_hub = hub.clone();
        let token = old.clone();
        let pull = tokio::spawn(async move { pulling_hub.next("main", &token).await });
        loop {
            if hub.core.lock().unwrap().clients[&old.window]
                .pulling
                .load(Ordering::Acquire)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(hub.next("main", &old).await.unwrap_err().contains("在途"));
        hub.close();
        assert!(pull.await.unwrap().is_err());
        let (port, _events2, _seen2, next_server) = fake_bridge().await;
        hub.connect(port).await.unwrap();
        let (new, _) = hub.attach("main").unwrap();
        assert_ne!(new.epoch, old.epoch);
        assert!(hub.next("main", &old).await.is_err());
        assert!(hub
            .request(
                "main",
                &old,
                "rgb",
                json!({"op":"hello"}),
                Duration::from_secs(1)
            )
            .await
            .is_err());
        hub.detach("main", &old).await.unwrap(); // late cleanup cannot remove new window
        assert!(hub
            .request(
                "main",
                &new,
                "rgb",
                json!({"op":"hello"}),
                Duration::from_secs(1)
            )
            .await
            .is_ok());
        hub.close();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), next_server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn packed_binary_retains_age_without_base64_or_payload_conversion() {
        let bytes = pack(true, 321, 1000, &[0, 255, 1]);
        assert_eq!(bytes[0], 1);
        assert_eq!(u64::from_le_bytes(bytes[1..9].try_into().unwrap()), 321);
        assert_eq!(u64::from_le_bytes(bytes[9..17].try_into().unwrap()), 1000);
        assert_eq!(&bytes[17..], &[0, 255, 1]);
    }

    #[tokio::test]
    async fn transient_local_model_before_ack_is_replayed_to_later_window_without_resubscription() {
        let (port, _events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        let (main, _) = hub.attach("main").unwrap();
        let request =
            json!({"op":"subscribe", "topic":"/robot_description", "type":"std_msgs/msg/String"});
        hub.request(
            "main",
            &main,
            "model",
            request.clone(),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let first = hub.next("main", &main).await.unwrap();
        assert_eq!(
            WireFrame::parse(Arc::from(&first[17..]), false)
                .unwrap()
                .metadata["data"],
            "<robot name='fixture'/>"
        );
        let (motion, _) = hub.attach("page-motion").unwrap();
        hub.request(
            "page-motion",
            &motion,
            "model",
            request,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let second = hub.next("page-motion", &motion).await.unwrap();
        assert_eq!(
            WireFrame::parse(Arc::from(&second[17..]), false)
                .unwrap()
                .metadata["data"],
            "<robot name='fixture'/>"
        );
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|v| v["op"] == "subscribe")
                .count(),
            1
        );
        hub.close();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }
}
