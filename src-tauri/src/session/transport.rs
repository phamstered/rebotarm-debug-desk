//! One native upstream WebSocket; no WebView timers or broadcasts on this path.
use super::command_queue::{CommandQueue, SendPermit};
use super::wire::{WireFrame, MAX_FRAME_BYTES};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

type Response = Result<WireFrame, String>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>>;
pub type EventSink = Arc<dyn Fn(WireFrame) + Send + Sync>;
pub type CloseSink = Arc<dyn Fn(String) + Send + Sync>;

struct Outbound {
    id: String,
    text: String,
    permit: Option<SendPermit>,
}

pub struct Transport {
    pub epoch: u64,
    pub hello: WireFrame,
    sequence: AtomicU64,
    pending: Pending,
    normal: mpsc::Sender<Outbound>,
    urgent: mpsc::Sender<Outbound>,
    stop: watch::Sender<bool>,
    commands: Arc<CommandQueue>,
}

struct PendingGuard {
    pending: Pending,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

fn fail_pending(pending: &Pending, error: &str) {
    for (_, sender) in pending.lock().unwrap().drain() {
        let _ = sender.send(Err(error.into()));
    }
}

fn urgent_command(message: &Value) -> bool {
    matches!(
        message["op"].as_str(),
        Some("position_cancel" | "visual_pick_cancel" | "gravity_id_cancel" | "trajectory_cancel")
    ) || (message["op"] == "joint_command" && message["mode"].as_i64() == Some(3))
}

fn message_frame(message: Message) -> Result<Option<WireFrame>, String> {
    match message {
        Message::Text(text) => WireFrame::parse(Arc::from(text.as_bytes()), false).map(Some),
        Message::Binary(bytes) => WireFrame::parse(Arc::from(bytes.as_ref()), true).map(Some),
        Message::Close(_) => Err("Bridge WebSocket 已断开".into()),
        _ => Ok(None),
    }
}

impl Transport {
    /// The caller supplies the actual SSH-forwarded port from SessionState. Never
    /// accepts a frontend URL, remote hostname, credentials or arbitrary endpoint.
    pub async fn connect(
        port: u16,
        epoch: u64,
        events: EventSink,
        closed: CloseSink,
    ) -> Result<Self, String> {
        if port == 0 {
            return Err("Bridge 本地端口无效".into());
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(8),
            connect_async_with_config(format!("ws://127.0.0.1:{port}"), Some(config), true),
        )
        .await
        .map_err(|_| "Bridge WebSocket 连接超时".to_string())?
        .map_err(|e| format!("Bridge WebSocket 连接失败：{e}"))?;
        let hello = tokio::time::timeout(Duration::from_secs(8), async {
            socket
                .send(Message::Text("{\"op\":\"hello\"}".into()))
                .await
                .map_err(|e| e.to_string())?;
            loop {
                let message = socket
                    .next()
                    .await
                    .ok_or("Bridge 在 hello 前断开")?
                    .map_err(|e| e.to_string())?;
                if let Some(frame) = message_frame(message)? {
                    if frame.op() != "hello" {
                        return Err("Bridge 首帧不是 hello".into());
                    }
                    return Ok::<_, String>(frame);
                }
            }
        })
        .await
        .map_err(|_| "Bridge hello 超时".to_string())??;
        let (normal_tx, mut normal_rx) = mpsc::channel::<Outbound>(64);
        let (urgent_tx, mut urgent_rx) = mpsc::channel::<Outbound>(16);
        let (stop, mut reader_stop) = watch::channel(false);
        let mut writer_stop = reader_stop.clone();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let writer_pending = pending.clone();
        let reader_pending = pending.clone();
        let reader_signal = stop.clone();
        let writer_signal = stop.clone();
        let (mut write, mut read) = socket.split();
        let writer_closed = closed.clone();
        tokio::spawn(async move {
            let error = loop {
                let outbound = tokio::select! {
                    biased;
                    _ = writer_stop.changed() => break "Bridge 会话已关闭".to_string(),
                    value = urgent_rx.recv() => value,
                    value = normal_rx.recv() => value,
                };
                let Some(outbound) = outbound else {
                    break "Bridge 会话已关闭".into();
                };
                // A request abandoned before transmission must never execute later.
                if !writer_pending.lock().unwrap().contains_key(&outbound.id) {
                    continue;
                }
                if outbound.permit.as_ref().is_some_and(|permit| !permit()) {
                    if let Some(sender) = writer_pending.lock().unwrap().remove(&outbound.id) {
                        let _ = sender.send(Err("指令在发送前已失效；未下发到 Bridge".into()));
                    }
                    continue;
                }
                let result = tokio::select! {
                    _ = writer_stop.changed() => break "Bridge 会话已关闭".to_string(),
                    result = tokio::time::timeout(Duration::from_secs(3), write.send(Message::Text(outbound.text.into()))) => result,
                };
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => break format!("Bridge 写入失败：{e}"),
                    Err(_) => break "Bridge 写入超时".into(),
                }
            };
            if !writer_signal.send_replace(true) {
                writer_closed(error.clone());
            }
            fail_pending(&writer_pending, &error);
            // Dropping the sink releases the connection once the reader stops.
        });
        tokio::spawn(async move {
            let error = loop {
                let message = tokio::select! {
                    biased;
                    _ = reader_stop.changed() => break "Bridge 会话已关闭".to_string(),
                    message = read.next() => message,
                };
                let frame = match message {
                    Some(Ok(message)) => match message_frame(message) {
                        Ok(Some(frame)) => frame,
                        Ok(None) => continue,
                        Err(error) => break error,
                    },
                    Some(Err(e)) => break format!("Bridge 读取失败：{e}"),
                    None => break "Bridge WebSocket 已断开".into(),
                };
                if let Some(id) = frame.request_id() {
                    let response = reader_pending.lock().unwrap().remove(id);
                    if let Some(response) = response {
                        let _ = response.send(Ok(frame));
                    }
                    // Late/cancelled responses never become new unsolicited state.
                } else {
                    events(frame);
                }
            };
            if !reader_signal.send_replace(true) {
                closed(error.clone());
            }
            fail_pending(&reader_pending, &error);
        });
        Ok(Self {
            epoch,
            hello,
            sequence: AtomicU64::new(0),
            pending,
            normal: normal_tx,
            urgent: urgent_tx,
            stop,
            commands: Arc::new(CommandQueue::default()),
        })
    }

    /// All command admission remains above the transport and at the Bridge. This
    /// layer never retries a command whose execution status may be unknown.
    pub fn request(
        &self,
        message: Value,
        timeout: Duration,
    ) -> impl std::future::Future<Output = Response> + Send + '_ {
        self.request_guarded(message, timeout, None)
    }

    pub fn request_guarded(
        &self,
        message: Value,
        timeout: Duration,
        permit: Option<SendPermit>,
    ) -> impl std::future::Future<Output = Response> + Send + '_ {
        // Synchronous capture: a future held by a caller before cancellation
        // must not acquire the post-stop generation when it is finally polled.
        let permit = self.commands.prepare(&message, permit);
        self.dispatch(message, timeout, permit)
    }

    async fn dispatch(
        &self,
        mut message: Value,
        timeout: Duration,
        permit: Option<SendPermit>,
    ) -> Response {
        if *self.stop.borrow() {
            return Err("Bridge 会话已关闭".into());
        }
        let urgent = urgent_command(&message);
        let object = message.as_object_mut().ok_or("Bridge 请求必须是对象")?;
        let op = object
            .get("op")
            .and_then(Value::as_str)
            .ok_or("Bridge 请求缺少 op")?;
        if op == "hello" {
            return Ok(self.hello.clone());
        }
        // Priority is derived from the command, never a frontend-supplied flag.
        let id = format!(
            "native-{}-{}",
            self.epoch,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        object.insert("request_id".into(), Value::String(id.clone()));
        let text = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        if text.len() > 1024 * 1024 {
            return Err("Bridge 请求超过 1 MiB".into());
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            // Reserve capacity for cancel/DISABLE even with saturated ordinary work.
            if pending.len() >= if urgent { 80 } else { 64 } {
                return Err("Bridge 在途请求已满".into());
            }
            pending.insert(id.clone(), sender);
        }
        let _guard = PendingGuard {
            pending: self.pending.clone(),
            id: id.clone(),
        };
        let target = if urgent { &self.urgent } else { &self.normal };
        target
            .try_send(Outbound { id, text, permit })
            .map_err(|_| "Bridge 发送队列已满或已关闭".to_string())?;
        tokio::time::timeout(timeout, receiver)
            .await
            .map_err(|_| "Bridge 请求超时；未自动重试".to_string())?
            .map_err(|_| "Bridge 会话已关闭".to_string())?
    }

    pub fn close(&self) {
        self.stop.send_replace(true);
        fail_pending(&self.pending, "Bridge 会话已关闭");
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    #[test]
    fn only_disable_and_cancel_get_reserved_command_capacity() {
        assert!(urgent_command(&json!({"op":"joint_command","mode":3})));
        assert!(urgent_command(&json!({"op":"position_cancel"})));
        assert!(urgent_command(&json!({"op":"visual_pick_cancel"})));
        assert!(urgent_command(&json!({"op":"gravity_id_cancel"})));
        assert!(urgent_command(&json!({"op":"trajectory_cancel"})));
        for mode in [0, 1, 2, 4, 5] {
            assert!(!urgent_command(
                &json!({"op":"joint_command","mode":mode,"urgent":true})
            ));
        }
        assert!(!urgent_command(
            &json!({"op":"position_move","urgent":true})
        ));
    }

    #[tokio::test]
    async fn disable_cannot_be_followed_by_older_queued_or_unpolled_motion() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let received = seen.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let value: Value = serde_json::from_str(&text).unwrap();
                received.lock().unwrap().push(value.clone());
                socket
                    .send(Message::Text(value.to_string().into()))
                    .await
                    .unwrap();
            }
        });
        let transport = Transport::connect(port, 1, Arc::new(|_| {}), Arc::new(|_| {}))
            .await
            .unwrap();
        let unscheduled = transport.request(
            json!({"op":"position_move","command_id":"not-polled"}),
            Duration::from_secs(1),
        );
        let mut queued = Box::pin(transport.request(
            json!({"op":"joint_command","mode":1}),
            Duration::from_secs(1),
        ));
        // Deterministically enqueue before the single-threaded writer can run.
        assert!(futures_util::poll!(queued.as_mut()).is_pending());
        transport
            .request(
                json!({"op":"joint_command","mode":3}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert!(queued.await.unwrap_err().contains("未下发"));
        assert!(unscheduled.await.unwrap_err().contains("未下发"));
        transport
            .request(json!({"op":"topics"}), Duration::from_secs(1))
            .await
            .unwrap();
        transport
            .request(
                json!({"op":"joint_command","mode":1}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        let values = seen.lock().unwrap().clone();
        assert_eq!(values.len(), 4);
        assert_eq!(values[1]["mode"], 3);
        assert_eq!(values[2]["op"], "topics");
        assert_eq!(values[3]["mode"], 1);
        transport.close();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn one_native_socket_correlates_concurrent_requests_and_raw_events() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "{\"op\":\"hello\"}"
            );
            socket
                .send(Message::Text(
                    json!({"op":"hello","bridge_build_id":"isolated-test"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let mut requests = Vec::new();
            for _ in 0..2 {
                let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
                requests.push(serde_json::from_str::<Value>(&message).unwrap());
            }
            for request in requests.into_iter().rev() {
                socket
                    .send(Message::Text(
                        json!({"op": request["op"], "request_id": request["request_id"]})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            socket
                .send(Message::Text(
                    json!({"op":"topic_message","topic":"/test","data":42})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            // Verify one socket and explicit close, not a second connection per request.
            let _ = socket.next().await;
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let transport = Transport::connect(
            port,
            42,
            Arc::new(move |frame| {
                tx.send(frame).unwrap();
            }),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        assert_eq!(transport.hello.metadata["bridge_build_id"], "isolated-test");
        let (a, b) = tokio::join!(
            transport.request(json!({"op":"topics"}), Duration::from_secs(1)),
            transport.request(json!({"op":"graph"}), Duration::from_secs(1))
        );
        assert_eq!(a.unwrap().op(), "topics");
        assert_eq!(b.unwrap().op(), "graph");
        let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.metadata["data"], 42);
        transport.close();
        assert!(transport
            .request(json!({"op":"topics"}), Duration::from_secs(1))
            .await
            .is_err());
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn timeout_never_replays_and_late_response_never_becomes_event() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (read_tx, read_rx) = oneshot::channel();
        let (reply_tx, reply_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            socket.next().await.unwrap().unwrap();
            socket
                .send(Message::Text(json!({"op":"hello"}).to_string().into()))
                .await
                .unwrap();
            let request: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            read_tx.send(()).unwrap();
            reply_rx.await.unwrap();
            socket
                .send(Message::Text(
                    json!({"op":"topics","request_id":request["request_id"]})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"op":"topic_message","topic":"/test","data":7})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let _ = socket.next().await;
        });
        let (events, mut observed) = mpsc::unbounded_channel();
        let transport = Transport::connect(
            port,
            1,
            Arc::new(move |frame| {
                events.send(frame).unwrap();
            }),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let request = transport.request(json!({"op":"topics"}), Duration::from_millis(100));
        let (result, _) = tokio::join!(request, read_rx);
        assert!(result.unwrap_err().contains("超时"));
        assert!(transport.pending.lock().unwrap().is_empty());
        reply_tx.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), observed.recv())
                .await
                .unwrap()
                .unwrap()
                .op(),
            "topic_message"
        );
        transport.close();
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }
}
