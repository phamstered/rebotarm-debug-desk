use super::{
    delivery::{Frame, Limits, Mailbox},
    subscriptions::{Consumer, SubscriptionRegistry, Transition},
    tasks::{Owner, Tasks},
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

impl Attachment {
    fn owner(&self) -> Owner {
        Owner {
            epoch: self.epoch,
            window: self.window.clone(),
        }
    }
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
    monitor: super::monitor::History,
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
    pub tasks: Arc<Tasks>,
    pub local_tasks: Arc<super::local_tasks::LocalTasks>,
    pub observations: Arc<super::observations::Observations>,
    resources: Arc<super::resources::Resources>,
    motion_logs: Arc<super::motion_observations::MotionLogs>,
    core: Arc<Mutex<Core>>,
    connect_gate: AsyncMutex<()>,
    subscriptions_gate: AsyncMutex<()>,
    origin: Instant,
    changed: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
    task_changed: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            tasks: Arc::new(Tasks::default()),
            local_tasks: Arc::new(super::local_tasks::LocalTasks::default()),
            observations: Arc::new(super::observations::Observations::default()),
            resources: Arc::new(super::resources::Resources::default()),
            motion_logs: Arc::new(super::motion_observations::MotionLogs::default()),
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
                monitor: super::monitor::History::default(),
            })),
            connect_gate: AsyncMutex::new(()),
            subscriptions_gate: AsyncMutex::new(()),
            origin: Instant::now(),
            changed: Arc::new(Mutex::new(None)),
            task_changed: Arc::new(Mutex::new(None)),
        }
    }
}

impl Runtime {
    pub fn set_observation_changed(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        let observations = Arc::downgrade(&self.observations);
        let core = Arc::downgrade(&self.core);
        let previous = Mutex::new([0_u64; 2]);
        let origin = self.origin;
        self.observations.set_changed(Arc::new(move || {
            if let (Some(observations), Some(core)) = (observations.upgrade(), core.upgrade()) {
                let (epoch, versions) = observations.versions();
                let mut core = core.lock().unwrap();
                if core.epoch == epoch && core.error.is_none() {
                    let mut previous = previous.lock().unwrap();
                    for (index, (source, op)) in [
                        (
                            super::observations::Source::Motion,
                            "native_position_info_changed",
                        ),
                        (
                            super::observations::Source::Pick,
                            "native_visual_pick_changed",
                        ),
                    ]
                    .into_iter()
                    .enumerate()
                    {
                        if let Some(sequence) = versions
                            .get(&source)
                            .filter(|sequence| **sequence > previous[index])
                        {
                            previous[index] = *sequence;
                            let frame = WireFrame::parse(
                                serde_json::to_vec(&json!({"op":op})).unwrap().into(),
                                false,
                            )
                            .unwrap();
                            route(&mut core, frame, origin.elapsed().as_millis() as u64);
                        }
                    }
                }
            }
            callback();
        }));
    }
    pub fn set_task_changed(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *self.task_changed.lock().unwrap() = Some(callback);
    }
    pub fn set_changed(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *self.changed.lock().unwrap() = Some(callback);
    }
    pub fn set_profile(&self, profile: Value) {
        self.core.lock().unwrap().profile = profile;
    }
    pub fn begin_controller(&self, label: &str, profile: &crate::ConnectionProfile) -> Result<u64, String> {
        let core = self.core.lock().unwrap();
        if core.error.is_some() || core.transport.is_none() { return Err("Bridge 尚未连接".into()); }
        if !super::controller_task::same_profile(&core.profile, &serde_json::to_value(profile).map_err(|e| e.to_string())?) {
            return Err("Controller 请求配置与当前共享连接不一致".into());
        }
        let token = core.clients.iter().find(|(token, client)| token.label == label && client.error.is_none())
            .map(|(token, _)| token.clone()).ok_or("功能页面尚未附着当前连接")?;
        self.tasks.begin_controller(Owner { epoch: core.epoch, window: token })
    }

    pub fn send_controller(&self, label: &str, epoch: u64, id: u64, profile: &crate::ConnectionProfile) -> Result<(), String> {
        let core = self.core.lock().unwrap();
        if core.epoch != epoch || core.error.is_some() || core.transport.is_none()
            || !super::controller_task::same_profile(&core.profile, &serde_json::to_value(profile).map_err(|e| e.to_string())?)
            || !core.clients.iter().any(|(token, client)| token.label == label && client.error.is_none()) {
            return Err("Controller 提交前连接或页面已失效".into());
        }
        self.tasks.controller_sent(id)
    }

    pub fn context(&self) -> Value {
        let core = self.core.lock().unwrap();
        json!({ "epoch":core.epoch, "connected":core.transport.is_some() && core.error.is_none(), "profile":core.profile, "error":core.error })
    }
    pub fn close(&self) {
        self.close_matching(None);
    }
    fn close_matching(&self, expected_epoch: Option<u64>) {
        let (transport, epoch) = {
            let mut core = self.core.lock().unwrap();
            if expected_epoch.is_some_and(|epoch| core.epoch != epoch) {
                return;
            }
            self.tasks
                .lost(None, "连接已断开；重连后需核验 Bridge 任务已停止");
            core.epoch += 1;
            self.motion_logs.reset(core.epoch);
            self.resources.reset(core.epoch);
            core.error = Some("Bridge 会话已关闭".into());
            core.subscriptions = SubscriptionRegistry::new(core.epoch, 256);
            core.rgbd_owner = None;
            core.latest_topics.clear();
            core.cached_bytes = 0;
            core.monitor = super::monitor::History::default();
            for client in core.clients.values() {
                client.notify.notify_one();
            }
            core.clients.clear();
            core.windows = WindowRegistry::default();
            (core.transport.take(), core.epoch)
        };
        // Observations notify listeners synchronously; those listeners read Core.
        // Stop after releasing Core, with an epoch fence against a newer session.
        self.observations.stop(epoch);
        if let Some(transport) = transport {
            transport.close();
        }
        if let Some(changed) = self.changed.lock().unwrap().clone() {
            changed();
        }
        if let Some(changed) = self.task_changed.lock().unwrap().clone() {
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
            self.tasks.configure_motor(core.epoch, &core.profile);
            core.epoch
        };
        let events_core = self.core.clone();
        let errors_core = self.core.clone();
        let errors_changed = self.changed.clone();
        let observations = self.observations.clone();
        let resources = self.resources.clone();
        let event_tasks = self.tasks.clone();
        let error_tasks = self.tasks.clone();
        let error_task_changed = self.task_changed.clone();
        let origin = self.origin;
        let transport = Transport::connect(
            port,
            epoch,
            Arc::new(move |frame| {
                let mut core = events_core.lock().unwrap();
                if core.epoch != epoch || core.error.is_some() {
                    return;
                }
                event_tasks.observe(epoch, &frame.metadata);
                route(&mut core, frame, origin.elapsed().as_millis() as u64);
            }),
            Arc::new(move |error| {
                let mut core = errors_core.lock().unwrap();
                if core.epoch != epoch {
                    return;
                }
                core.error = Some(error);
                error_tasks.lost(None, "Bridge 连接中断；停止结果尚未确认");
                core.transport = None;
                core.monitor = super::monitor::History::default();
                resources.reset(epoch);
                for client in core.clients.values() {
                    client.notify.notify_one();
                }
                drop(core);
                observations.stop(epoch);
                if let Some(changed) = errors_changed.lock().unwrap().clone() {
                    changed();
                }
                if let Some(changed) = error_task_changed.lock().unwrap().clone() {
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
        {
            let mut core = self.core.lock().unwrap();
            if core.epoch != epoch {
                transport.close();
                return Err("连接已被取消".into());
            }
            if let Some(error) = &core.error {
                transport.close();
                return Err(error.clone());
            }
            let transport = Arc::new(transport);
            core.transport = Some(transport.clone());
            self.observations.start(
                epoch,
                super::motion_observations::reader(
                    super::observations::reader(transport.clone(), core.profile.clone()),
                    transport,
                    self.motion_logs.clone(),
                    epoch,
                ),
            );
        }
        // Firmware stop confirmation must survive the last observing WebView.
        // This native consumer is released with the connection, not with a page.
        let subscription_result = async {
            let _gate = self.subscriptions_gate.lock().await;
            let (transport, changes) = {
                let mut core = self.core.lock().unwrap();
                let context = super::motor_task::Context::new(epoch, &core.profile);
                let changes = if let Some(context) = context {
                    core.subscriptions
                        .acquire(
                            &context.topic,
                            "microros_stm32h723_bridge/msg/HardwareStatus",
                            Consumer {
                                window: WindowToken {
                                    label: "native-motor-feedback".into(),
                                    incarnation: epoch,
                                },
                                name: "firmware-stop".into(),
                            },
                        )
                        .map_err(String::from)?
                } else {
                    Vec::new()
                };
                (core.transport.clone().ok_or("Bridge 尚未连接")?, changes)
            };
            self.apply_transitions(&transport, changes).await
        }
        .await;
        if let Err(error) = subscription_result {
            self.close_matching(Some(epoch));
            return Err(format!("Motor 硬件反馈订阅失败：{error}"));
        }
        self.watch_tasks(epoch);
        if let Some(changed) = self.changed.lock().unwrap().clone() {
            changed();
        }
        Ok(())
    }

    fn watch_tasks(&self, epoch: u64) {
        let core = Arc::downgrade(&self.core);
        let tasks = self.tasks.clone();
        let changed = self.task_changed.clone();
        let origin = self.origin;
        tokio::spawn(async move {
            let mut previous = None;
            loop {
                let Some(core) = core.upgrade() else {
                    break;
                };
                let transport = {
                    let core = core.lock().unwrap();
                    if core.epoch != epoch {
                        break;
                    }
                    if let Some(task) = tasks.snapshot().filter(|task| task.epoch == epoch) {
                        if !core.clients.iter().any(|(token, client)| {
                            token.label == task.window && client.error.is_none()
                        }) {
                            tasks.lost(None, "任务所属窗口已关闭或数据队列失效，已请求取消");
                        }
                    }
                    core.transport.clone()
                };
                let snapshot = tasks.snapshot();
                if snapshot != previous {
                    previous = snapshot;
                    if let Some(changed) = changed.lock().unwrap().clone() {
                        changed();
                    }
                }
                let Some(transport) = transport else {
                    break;
                };
                if let Some(action) = tasks.poll(epoch, Instant::now()) {
                    let core = Arc::downgrade(&core);
                    let tasks = tasks.clone();
                    tokio::spawn(async move {
                        let result = transport
                            .request_guarded(
                                action.message.clone(),
                                Duration::from_secs(3),
                                Some(action.permit),
                            )
                            .await;
                        let Some(core) = core.upgrade() else {
                            tasks.finish_action(action.ticket, action.action);
                            return;
                        };
                        let mut core = core.lock().unwrap();
                        if core.epoch != epoch {
                            tasks.finish_action(action.ticket, action.action);
                            return;
                        }
                        if action.message["op"] == "joint_command" && action.message["mode"] == 3 {
                            tasks.disable_reply(
                                action.ticket,
                                action.action,
                                epoch,
                                result
                                    .as_ref()
                                    .map(|frame| &frame.metadata)
                                    .map_err(String::as_str),
                            );
                        }
                        if action.heartbeat {
                            tasks.heartbeat_reply(
                                action.ticket,
                                epoch,
                                result
                                    .as_ref()
                                    .map(|frame| &frame.metadata)
                                    .map_err(String::as_str),
                            );
                        } else if action.recovery {
                            let recovered = result.as_ref().is_ok_and(|frame| {
                                tasks.recover(action.ticket, epoch, &frame.metadata)
                            });
                            if recovered {
                                if let Ok(frame) = &result {
                                    let state = if frame.op() == "position_task_status" {
                                        &frame.metadata["motion_state"]
                                    } else if frame.op()=="gravity_id_task_status" {
                                        &frame.metadata["result"]
                                    } else {
                                        &frame.metadata
                                    };
                                    if state.is_object() {
                                        if let Ok(event) = WireFrame::parse(
                                            serde_json::to_vec(state).unwrap().into(),
                                            false,
                                        ) {
                                            route(
                                                &mut core,
                                                event,
                                                origin.elapsed().as_millis() as u64,
                                            );
                                        }
                                    }
                                }
                            }
                        } else {
                            match &result {
                                Ok(frame) if frame.op() != "error" => {
                                    tasks.observe(epoch, &frame.metadata)
                                }
                                Ok(frame) => tasks.stop_error(
                                    action.ticket,
                                    frame.metadata["message"].as_str().unwrap_or("取消被拒绝"),
                                ),
                                Err(error) => tasks.stop_error(action.ticket, error),
                            }
                        }
                        tasks.finish_action(action.ticket, action.action);
                    });
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
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
            self.tasks
                .lost(Some(&attachment.owner()), "任务所属窗口已关闭，已请求取消");
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
        let mut errors = Vec::new();
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
                    self.close_matching(Some(change.epoch));
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
            if let Err(error) = result {
                errors.push(format!(
                    "{}: {}",
                    change.topic,
                    error.chars().take(512).collect::<String>()
                ));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }

    pub async fn monitor_configure(
        &self,
        native_label: &str,
        attachment: &Attachment,
        config: super::monitor::Config,
    ) -> Result<(), String> {
        if native_label != "page-monitor" {
            return Err("只有 Monitor 页面可以配置历史采集".into());
        }
        config.validate()?;
        let _gate = self.subscriptions_gate.lock().await;
        let (transport, changes) = {
            let mut core = self.core.lock().unwrap();
            core.validate(native_label, attachment)?;
            let transport = core.transport.clone().ok_or("Bridge 尚未连接")?;
            let consumer = Consumer {
                window: WindowToken {
                    label: "native-monitor-history".into(),
                    incarnation: core.epoch,
                },
                name: "history".into(),
            };
            // Validate the whole replacement before changing capture or ownership.
            let mut registry = core.subscriptions.clone();
            let mut changes = Vec::new();
            for topic in core
                .monitor
                .config()
                .topics
                .keys()
                .filter(|topic| !config.topics.contains_key(*topic))
            {
                changes.extend(registry.release(topic, &consumer));
            }
            for (topic, kind) in &config.topics {
                changes.extend(
                    registry
                        .acquire(topic, kind, consumer.clone())
                        .map_err(String::from)?,
                );
            }
            core.subscriptions = registry;
            core.monitor.configure(config);
            (transport, changes)
        };
        self.apply_transitions(&transport, changes).await?;
        self.core.lock().unwrap().validate(native_label, attachment)
    }

    pub fn monitor_history(
        &self,
        native_label: &str,
        attachment: &Attachment,
        after: u64,
    ) -> Result<super::monitor::Page, String> {
        if native_label != "page-monitor" {
            return Err("此页面不能读取 Monitor 历史".into());
        }
        let core = self.core.lock().unwrap();
        core.validate(native_label, attachment)?;
        core.monitor
            .page(core.epoch, after, self.origin.elapsed().as_millis() as u64)
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
            self.tasks.touch(&attachment.owner(), Instant::now());
            core.transport.clone().ok_or("Bridge 尚未连接")?
        };
        let op = message["op"].as_str().ok_or("请求缺少 op")?;
        if matches!(op, "position_motion_heartbeat" | "gravity_id_heartbeat") {
            return Err("任务续租由原生会话管理，页面不能直接调用".into());
        }
        if op=="gravity_id_send_goal" && transport.hello.metadata["gravity_task_supported"]!=true {
            return Err("请更新 Bridge：重力辨识需要编号、租约与停止确认".into());
        }
        if matches!(
            op,
            "position_move" | "position_group_start" | "visual_pick_start"
        ) && transport.hello.metadata["motion_observation_supported"] != true
        {
            return Err("请更新 Bridge：多窗口执行需要只读运动观察与任务终态查询".into());
        }
        if matches!(op, "position_motion_info" | "visual_pick_status") {
            let source = if op == "position_motion_info" {
                super::observations::Source::Motion
            } else {
                super::observations::Source::Pick
            };
            let snapshot = self.observations.read(attachment.epoch, source).await?;
            self.core
                .lock()
                .unwrap()
                .validate(native_label, attachment)?;
            let entry = snapshot.entries.get(&source).ok_or("等待共享运动观察")?;
            if let Some(error) = &entry.error {
                return Err(error.clone());
            }
            if entry.age_ms >= entry.ttl_ms {
                return Err("共享运动观察已过期".into());
            }
            let mut value = entry.value.clone().ok_or("共享运动观察无数据")?;
            if source == super::observations::Source::Motion {
                self.motion_logs
                    .page(attachment.epoch, &message, &mut value)?;
            }
            let mut frame = WireFrame::parse(
                serde_json::to_vec(&value)
                    .map_err(|e| e.to_string())?
                    .into(),
                false,
            )?;
            frame.source_age_ms = entry.age_ms;
            return Ok(frame);
        }
        if op == "resource" {
            let key = super::resources::Key::new(
                message["uri"].as_str().ok_or("资源缺少 URI")?,
                message["encoding"].as_str().unwrap_or("base64"),
            )?;
            let reply = self
                .resources
                .get(attachment.epoch, key, async move {
                    transport.request(message, timeout).await
                })
                .await?;
            self.core
                .lock()
                .unwrap()
                .validate(native_label, attachment)?;
            return Ok(reply);
        }
        if op == "topics" && self.observations.snapshot().connected {
            let snapshot = if message["refresh"] == true {
                self.observations
                    .refresh(attachment.epoch, super::observations::Source::Topics, false)
                    .await?
            } else {
                self.observations
                    .read(attachment.epoch, super::observations::Source::Topics)
                    .await?
            };
            self.core
                .lock()
                .unwrap()
                .validate(native_label, attachment)?;
            let entry = snapshot
                .entries
                .get(&super::observations::Source::Topics)
                .ok_or("Topics 查询未返回")?;
            if let Some(error) = &entry.error {
                return Err(error.clone());
            }
            return WireFrame::parse(
                serde_json::to_vec(&entry.value)
                    .map_err(|e| e.to_string())?
                    .into(),
                false,
            );
        }
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
        let admission = {
            let core = self.core.lock().unwrap();
            core.validate(native_label, attachment)?;
            self.tasks.touch(&attachment.owner(), Instant::now());
            self.tasks
                .admit(attachment.owner(), &message, Instant::now())?
        };
        let result = transport
            .request_guarded(message.clone(), timeout, admission.permit)
            .await;
        {
            let core = self.core.lock().unwrap();
            if core.epoch == attachment.epoch {
                self.tasks.reply(
                    admission.ticket,
                    attachment.epoch,
                    &message,
                    result
                        .as_ref()
                        .map(|frame| &frame.metadata)
                        .map_err(String::as_str),
                );
                if let Ok(reply) = &result {
                    self.tasks.observe(attachment.epoch, &reply.metadata);
                }
            }
        }
        let reply = result?;
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
            self.tasks.touch(&attachment.owner(), Instant::now());
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
    core.monitor.accept(&frame, at);
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
        "rgbd_frame"
        | "visual_target_frame"
        | "native_position_info_changed"
        | "native_visual_pick_changed" => Some(frame.op().to_string()),
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
                            "hello" => json!({"op":"hello", "motion_observation_supported":true, "gravity_task_supported":true}),
                            "topics" => json!({"op":"topics", "topics":[], "request_id":message["request_id"]}),
                            "resource" => {
                                let metadata = serde_json::to_vec(&json!({"op":"resource", "uri":message["uri"], "request_id":message["request_id"], "data_length":3})).unwrap();
                                let mut binary = b"RCR1".to_vec(); binary.extend((metadata.len() as u32).to_be_bytes()); binary.extend(metadata); binary.extend([7, 8, 9]);
                                socket.send(Message::Binary(binary.into())).await.unwrap();
                                continue;
                            },
                            "subscribe" if message["topic"] == "/z_rejected" => json!({"op":"error", "message":"fixture subscription rejected", "request_id":message["request_id"]}),
                            "subscribe" => json!({"op":"subscribed", "topic":message["topic"], "request_id":message["request_id"]}),
                            "unsubscribe" => json!({"op":"unsubscribed", "topic":message["topic"], "request_id":message["request_id"]}),
                            "position_move" | "position_group_start" | "gravity_id_send_goal" => json!({"op":format!("{}_ack", message["op"].as_str().unwrap()), "accepted":true, "command_id":message["command_id"], "request_id":message["request_id"]}),
                            "joint_command" => json!({"op":"joint_command_ack", "mode":message["mode"], "sequence":123, "request_id":message["request_id"]}),
                            "gravity_id_heartbeat" => json!({"op":"gravity_id_heartbeat_ack","renewed":true,"command_id":message["command_id"],"request_id":message["request_id"]}),
                            "gravity_id_cancel" => json!({"op":"gravity_id_cancel_ack","accepted":true,"command_id":message["command_id"],"request_id":message["request_id"]}),
                            "position_cancel" => json!({"op":"position_cancel_ack", "request_id":message["request_id"]}),
                            "position_motion_info" => json!({"op":"position_motion_info", "busy":false, "request_id":message["request_id"]}),
                            "position_motion_observe" => json!({"op":"position_motion_info", "busy":false, "motion_log_session":"fixture", "motion_log_cursor":0, "motion_logs":[], "request_id":message["request_id"]}),
                            "visual_pick_observe" => json!({"op":"visual_pick_state", "command_id":"", "pick_phase":"idle", "busy":false, "request_id":message["request_id"]}),
                            "position_motion_heartbeat" => json!({"op":"position_motion_heartbeat_ack", "command_id":message["command_id"], "renewed":true, "request_id":message["request_id"]}),
                            "position_task_status" if message["command_id"] == "retained-motion" => json!({"op":"position_task_status", "command_id":message["command_id"], "known":true, "terminal":true, "motion_phase":"canceled", "request_id":message["request_id"],
                                "motion_state":{"op":"position_motion","command_id":message["command_id"],"motion_phase":"canceled","group_id":"retained-group","group_index":1,"group_count":2,"group_phase":"holding","group_elapsed_s":3.5}}),
                            "position_task_status" => json!({"op":"position_task_status", "command_id":message["command_id"], "known":false, "terminal":false, "motion_phase":"unknown", "request_id":message["request_id"]}),
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
    async fn monitor_history_survives_slow_and_absent_windows_without_reusing_telemetry_queue() {
        let (port, events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        let (monitor, _) = hub.attach("page-monitor").unwrap();
        let (main, _) = hub.attach("main").unwrap();
        let cfg = super::super::monitor::Config {
            topics: BTreeMap::from([("/joints".into(), "sensor_msgs/msg/JointState".into())]),
            ..Default::default()
        };
        assert!(hub
            .monitor_configure("main", &main, cfg.clone())
            .await
            .is_err());
        hub.monitor_configure("page-monitor", &monitor, cfg.clone())
            .await
            .unwrap();
        hub.request(
            "page-monitor",
            &monitor,
            "preview",
            json!({"op":"subscribe","topic":"/joints","type":"sensor_msgs/msg/JointState"}),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        for n in 0..600 {
            events
                .send(json!({"op":"topic_message","topic":"/joints","data":{"position":[n]}}))
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while hub
                .monitor_history("page-monitor", &monitor, 0)
                .unwrap()
                .tail
                < 600
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        let first = hub.monitor_history("page-monitor", &monitor, 0).unwrap();
        let second = hub
            .monitor_history("page-monitor", &monitor, first.cursor)
            .unwrap();
        let last = hub
            .monitor_history("page-monitor", &monitor, second.cursor)
            .unwrap();
        assert_eq!(first.rows.len() + second.rows.len() + last.rows.len(), 600);
        assert_eq!(first.rows[0].data["position"][0], 0);
        assert_eq!(last.rows.last().unwrap().data["position"][0], 599);
        let preview = hub.next("page-monitor", &monitor).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&preview[17..]).unwrap()["data"]["position"][0],
            599
        );
        hub.detach("page-monitor", &monitor).await.unwrap();
        events
            .send(json!({"op":"topic_message","topic":"/joints","data":{"position":[600]}}))
            .unwrap();
        let (reopened, _) = hub.attach("page-monitor").unwrap();
        hub.monitor_configure("page-monitor", &reopened, cfg)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while hub
                .monitor_history("page-monitor", &reopened, 600)
                .unwrap()
                .tail
                < 601
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        assert!(hub.monitor_history("page-monitor", &monitor, 0).is_err());
        assert_eq!(
            hub.monitor_history("page-monitor", &reopened, 0)
                .unwrap()
                .rows[0]
                .data["position"][0],
            0
        );
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|m| m["op"] == "subscribe" && m["topic"] == "/joints")
                .count(),
            1
        );
        let old_epoch = reopened.epoch;
        hub.close();
        server.abort();
        let (port, _next_events, _next_seen, next_server) = fake_bridge().await;
        hub.connect(port).await.unwrap();
        let (fresh, _) = hub.attach("page-monitor").unwrap();
        hub.close_matching(Some(old_epoch));
        assert!(hub
            .monitor_history("page-monitor", &fresh, 0)
            .unwrap()
            .rows
            .is_empty());
        assert!(hub.monitor_history("page-monitor", &reopened, 0).is_err());
        hub.close();
        next_server.abort();
    }

    #[tokio::test]
    async fn monitor_batch_subscription_failure_settles_other_topics_and_can_retry() {
        let (port, _events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        let (monitor, _) = hub.attach("page-monitor").unwrap();
        let mut cfg = super::super::monitor::Config {
            topics: BTreeMap::from([
                ("/a_good".into(), "std_msgs/msg/Float64".into()),
                ("/z_rejected".into(), "std_msgs/msg/Float64".into()),
            ]),
            ..Default::default()
        };
        assert!(hub
            .monitor_configure("page-monitor", &monitor, cfg.clone())
            .await
            .unwrap_err()
            .contains("rejected"));
        cfg.topics.remove("/z_rejected");
        hub.monitor_configure("page-monitor", &monitor, cfg)
            .await
            .unwrap();
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|m| m["op"] == "subscribe" && m["topic"] == "/a_good")
                .count(),
            1
        );
        assert!(!hub
            .core
            .lock()
            .unwrap()
            .subscriptions
            .recipients("/a_good")
            .is_empty());
        hub.close();
        server.abort();
    }

    #[tokio::test]
    async fn gravity_window_loss_cancels_by_id_and_waits_for_verified_result() {
        let (port,events,seen,server)=fake_bridge().await;
        let hub=Runtime::default();hub.connect(port).await.unwrap();
        let (gravity,_)=hub.attach("page-gravity").unwrap();
        let timeout=Duration::from_secs(2);
        hub.request("page-gravity",&gravity,"task",json!({"op":"gravity_id_send_goal","command_id":"g"}),timeout).await.unwrap();
        assert!(hub.tasks.migration("page-gravity").is_err());
        hub.detach("page-gravity",&gravity).await.unwrap();
        tokio::time::timeout(timeout,async {
            while !seen.lock().unwrap().iter().any(|m|m["op"]=="gravity_id_cancel" && m["command_id"]=="g"){tokio::task::yield_now().await;}
        }).await.unwrap();
        assert!(hub.tasks.snapshot().is_some());
        events.send(json!({"op":"gravity_id_result","command_id":"g","terminal":true,"task_phase":"canceled"})).unwrap();
        tokio::time::timeout(timeout,async {while hub.tasks.snapshot().is_some(){tokio::task::yield_now().await;}}).await.unwrap();
        assert!(hub.tasks.migration("page-gravity").is_ok());
        hub.close();server.abort();
    }

    #[tokio::test]
    async fn motor_owner_loss_disables_but_only_fresh_firmware_feedback_releases_task() {
        let (port, events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        // Deliberately incomplete ConnectionProfile: SSH readers cannot run.
        hub.set_profile(
            json!({"host":"isolated-invalid", "statusTopic":"/status", "commandTopic":"/command"}),
        );
        hub.connect(port).await.unwrap();
        let (motor, _) = hub.attach("page-motor").unwrap();
        let (main, _) = hub.attach("main").unwrap();
        let timeout = Duration::from_secs(2);
        let status = |sequence, mode, stamp| {
            json!({"op":"topic_message","topic":"/status",
            "data":{"last_command_sequence":sequence,"mode":mode,"header":{"stamp":{"sec":stamp,"nanosec":0}}}})
        };
        // Observe delivery without adding a page subscription: the native owner
        // retains this source even after all pages close.
        events.send(status(1, 3, 1)).unwrap();
        tokio::time::timeout(timeout, async {
            while !hub
                .core
                .lock()
                .unwrap()
                .latest_topics
                .contains_key("/status")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        hub.request(
            "page-motor",
            &motor,
            "control",
            json!({"op":"joint_command","mode":1}),
            timeout,
        )
        .await
        .unwrap();
        assert!(hub.tasks.migration("page-motor").is_err());
        assert!(hub
            .request(
                "main",
                &main,
                "control",
                json!({"op":"position_move","command_id":"conflict"}),
                timeout
            )
            .await
            .is_err());
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|m| m["op"] == "position_move"));
        hub.detach("page-motor", &motor).await.unwrap();
        hub.detach("main", &main).await.unwrap();
        tokio::time::timeout(timeout, async {
            while !seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| m["op"] == "joint_command" && m["mode"] == 3)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(hub.tasks.snapshot().is_some());
        // Deliver wrong sequence/mode after the publish ACK; no WebView polling.
        for frame in [status(122, 3, 2), status(123, 1, 3)] {
            events.send(frame.clone()).unwrap();
            tokio::time::timeout(timeout, async {
                loop {
                    let delivered = hub
                        .core
                        .lock()
                        .unwrap()
                        .latest_topics
                        .get("/status")
                        .is_some_and(|(f, _)| f.metadata == frame);
                    if delivered {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(hub.tasks.snapshot().is_some());
        }
        events.send(status(123, 3, 4)).unwrap();
        tokio::time::timeout(timeout, async {
            while hub.tasks.snapshot().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(hub.tasks.migration("page-motor").is_ok());
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|m| m["op"] == "subscribe" && m["topic"] == "/status")
                .count(),
            1
        );
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|m| m["op"] == "unsubscribe" && m["topic"] == "/status"));
        hub.close();
        server.abort();
    }

    #[tokio::test]
    async fn controller_disable_survives_all_pages_detaching_and_waits_for_post_completion_feedback() {
        let (port, events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        // Incomplete profile prevents SSH readers: this test uses loopback only.
        hub.set_profile(json!({"host":"isolated-invalid", "statusTopic":"/status", "commandTopic":"/command"}));
        hub.connect(port).await.unwrap();
        let (motion, _) = hub.attach("page-motion").unwrap();
        let timeout = Duration::from_secs(3);
        let id = hub.tasks.begin_controller(motion.owner()).unwrap();
        let outcome = hub.tasks.controller_outcome(id).unwrap();
        hub.tasks.controller_sent(id).unwrap();
        hub.request("page-motion", &motion, "control", json!({"op":"joint_command","mode":3}), timeout).await.unwrap();
        hub.detach("page-motion", &motion).await.unwrap();
        let disables = || seen.lock().unwrap().iter().filter(|m| m["op"] == "joint_command" && m["mode"] == 3).count();
        tokio::time::timeout(timeout, async {
            while disables() < 2 { tokio::task::yield_now().await; }
        }).await.unwrap();
        let status = |seq, mode, stamp| json!({"op":"topic_message","topic":"/status",
            "data":{"last_command_sequence":seq,"mode":mode,"header":{"stamp":{"sec":stamp,"nanosec":0}}}});
        let deliver = |frame: Value| {
            let events = &events;
            let hub = &hub;
            async move {
                events.send(frame.clone()).unwrap();
                tokio::time::timeout(timeout, async {
                    loop {
                        if hub.core.lock().unwrap().latest_topics.get("/status").is_some_and(|(f,_)| f.metadata == frame) {break;}
                        tokio::task::yield_now().await;
                    }
                }).await.unwrap();
            }
        };
        deliver(status(123, 3, 1)).await;
        assert!(hub.tasks.snapshot().is_some()); // ACK + DISABLE before remote completion is insufficient.
        let before = disables();
        hub.tasks.controller_remote_completed(id);
        assert!(!hub.tasks.controller_finish(id, true, ""));
        tokio::time::timeout(timeout, async {
            while disables() <= before {tokio::task::yield_now().await;}
        }).await.unwrap();
        for frame in [status(122, 3, 2), status(123, 1, 3)] {
            deliver(frame).await;
            assert!(hub.tasks.snapshot().is_some());
        }
        deliver(status(123, 3, 4)).await;
        tokio::time::timeout(timeout, async {
            while hub.tasks.snapshot().is_some() {tokio::task::yield_now().await;}
        }).await.unwrap();
        assert_eq!(*outcome.borrow(), super::super::controller_stop::Outcome::Disabled);
        assert_eq!(seen.lock().unwrap().iter().filter(|m|m["op"]=="subscribe" && m["topic"]=="/status").count(), 1);
        assert!(!seen.lock().unwrap().iter().any(|m|m["op"]=="unsubscribe" && m["topic"]=="/status"));
        hub.close();
        server.abort();
    }

    #[tokio::test]
    async fn controller_admission_requires_attached_owner_and_exact_shared_profile_and_epoch() {
        let (port, _events, _seen, server)=fake_bridge().await;
        let hub=Runtime::default();
        let profile=json!({"host":"127.0.0.1","sshPort":1,"username":"fixture","identityFile":"", "localPort":port,
            "remotePort":8765,"rosDomainId":220,"rosSetupScript":"test/install/setup.bash", "commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"});
        let request:crate::ConnectionProfile=serde_json::from_value(profile.clone()).unwrap();
        assert!(hub.begin_controller("page-motion",&request).is_err());
        hub.set_profile(profile.clone());hub.connect(port).await.unwrap();
        assert!(hub.begin_controller("page-motion",&request).is_err());
        let (motion,_)=hub.attach("page-motion").unwrap();
        let mut other=request.clone();other.ros_domain_id+=1;
        assert!(hub.begin_controller("page-motion",&other).is_err());
        let id=hub.begin_controller("page-motion",&request).unwrap();
        assert!(hub.send_controller("page-motion",motion.epoch+1,id,&request).is_err());
        assert!(hub.send_controller("page-motion",motion.epoch,id,&other).is_err());
        hub.detach("page-motion",&motion).await.unwrap();
        assert!(hub.send_controller("page-motion",motion.epoch,id,&request).is_err());
        assert!(hub.tasks.snapshot().is_none());
        hub.close();server.abort();
    }

    #[tokio::test]
    async fn native_task_owner_controls_heartbeats_and_detach_waits_for_real_terminal() {
        let (port, events, seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        let (motion, _) = hub.attach("page-motion").unwrap();
        let (main, _) = hub.attach("main").unwrap();
        let timeout = Duration::from_secs(1);
        hub.request(
            "page-motion",
            &motion,
            "test",
            json!({"op":"position_move","command_id":"motion-1"}),
            timeout,
        )
        .await
        .unwrap();
        assert!(hub.tasks.migration("page-motion").is_err());
        assert!(hub
            .request(
                "main",
                &main,
                "test",
                json!({"op":"position_motion_info"}),
                timeout
            )
            .await
            .is_ok());
        assert!(hub
            .request(
                "main",
                &main,
                "test",
                json!({"op":"joint_command","mode":1}),
                timeout
            )
            .await
            .is_err());
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|message| message["op"] == "position_motion_info"
                || message["op"] == "joint_command"));
        hub.request(
            "page-motion",
            &motion,
            "test",
            json!({"op":"position_motion_info"}),
            timeout,
        )
        .await
        .unwrap();
        hub.detach("page-motion", &motion).await.unwrap();
        tokio::time::timeout(timeout, async {
            loop {
                if seen
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|message| message["op"] == "position_cancel")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // ACK only means cancellation was requested, not that the arm stopped.
        assert!(hub.tasks.snapshot().is_some());
        events
            .send(json!({"op":"position_motion","command_id":"motion-1","motion_phase":"canceled"}))
            .unwrap();
        tokio::time::timeout(timeout, async {
            while hub.tasks.snapshot().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        hub.request(
            "main",
            &main,
            "test",
            json!({"op":"position_move","command_id":"motion-2"}),
            timeout,
        )
        .await
        .unwrap();
        hub.close();
        server.abort();
    }

    #[test]
    fn observation_callbacks_can_read_runtime_during_close_without_reentrant_core_lock() {
        let hub = Arc::new(Runtime::default());
        let weak = Arc::downgrade(&hub);
        hub.set_observation_changed(Arc::new(move || {
            assert_eq!(weak.upgrade().unwrap().context()["connected"], false);
        }));
        let (done, recv) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            hub.close();
            done.send(()).unwrap();
        });
        recv.recv_timeout(Duration::from_secs(2))
            .expect("close callback deadlocked");
    }

    #[tokio::test]
    async fn reconnect_recovers_only_retained_task_proof_and_routes_full_group_terminal() {
        let (port, _events, _seen, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        let (motion, _) = hub.attach("page-motion").unwrap();
        hub.request(
            "page-motion",
            &motion,
            "test",
            json!({"op":"position_group_start","command_id":"retained-motion"}),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        hub.close();
        assert!(hub.tasks.snapshot().is_some());
        let (port, _events, seen, next_server) = fake_bridge().await;
        hub.connect(port).await.unwrap();
        let (observer, _) = hub.attach("page-monitor").unwrap();
        let packed = hub.next("page-monitor", &observer).await.unwrap();
        let terminal = WireFrame::parse(Arc::from(&packed[17..]), false).unwrap();
        assert_eq!(terminal.op(), "position_motion");
        assert_eq!(terminal.metadata["command_id"], "retained-motion");
        assert_eq!(terminal.metadata["group_id"], "retained-group");
        assert_eq!(terminal.metadata["group_index"], 1);
        assert!(hub.tasks.snapshot().is_none());
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .any(|m| m["op"] == "position_task_status"));
        assert!(!seen.lock().unwrap().iter().any(|m| matches!(
            m["op"].as_str(),
            Some("position_motion_heartbeat" | "position_cancel")
        )));
        hub.close();
        server.await.unwrap();
        next_server.await.unwrap();
    }

    #[tokio::test]
    async fn nine_pages_read_one_motion_observation_and_transport_failure_notifies_without_deadlock(
    ) {
        let (port, _events, seen, server) = fake_bridge().await;
        let hub = Arc::new(Runtime::default());
        hub.set_observation_changed(Arc::new(|| {}));
        hub.connect(port).await.unwrap();
        let labels = [
            "page-motion",
            "page-status",
            "page-dashboard",
            "page-monitor",
            "page-collection",
            "page-handeye",
            "page-motor",
            "page-calibration",
            "page-gravity",
        ];
        let pages: Vec<_> = labels
            .iter()
            .map(|label| (*label, hub.attach(label).unwrap().0))
            .collect();
        // Wait for the application-owned query, without issuing a page refresh.
        tokio::time::timeout(Duration::from_secs(1), async {
            while !hub
                .observations
                .snapshot()
                .entries
                .contains_key(&super::super::observations::Source::Motion)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        for (label, page) in &pages {
            let reply = hub
                .request(
                    label,
                    page,
                    "test",
                    json!({"op":"position_motion_info"}),
                    Duration::from_secs(1),
                )
                .await
                .unwrap();
            assert_eq!(reply.metadata["motion_log_session"], "fixture");
            assert!(reply.source_age_ms >= 20);
            let mut notified = false;
            for _ in 0..2 {
                let packed = hub.next(label, page).await.unwrap();
                let event = WireFrame::parse(Arc::from(&packed[17..]), packed[0] == 1).unwrap();
                if event.op() == "native_position_info_changed" {
                    notified = true;
                    break;
                }
            }
            assert!(notified);
        }
        let requests = seen.lock().unwrap().clone();
        assert_eq!(
            requests
                .iter()
                .filter(|m| m["op"] == "position_motion_observe")
                .count(),
            1
        );
        assert!(!requests.iter().any(|m| matches!(
            m["op"].as_str(),
            Some("position_motion_info" | "position_motion_heartbeat" | "visual_pick_status")
        )));
        server.abort();
        tokio::time::timeout(Duration::from_secs(1), async {
            while hub.context()["connected"] == true {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!hub.observations.snapshot().connected);
        hub.close();
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
    async fn resource_reads_across_native_pages_use_one_upstream_binary_response() {
        let (port, _events, requests, server) = fake_bridge().await;
        let hub = Runtime::default();
        hub.connect(port).await.unwrap();
        let (motion, _) = hub.attach("page-motion").unwrap();
        let (topics, _) = hub.attach("page-dashboard").unwrap();
        let message =
            json!({"op":"resource", "uri":"package://robot/link.stl", "encoding":"binary"});
        let (first, second) = tokio::join!(
            hub.request(
                "page-motion",
                &motion,
                "model",
                message.clone(),
                Duration::from_secs(1)
            ),
            hub.request(
                "page-dashboard",
                &topics,
                "model",
                message.clone(),
                Duration::from_secs(1)
            ),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert!(first.binary);
        assert!(Arc::ptr_eq(&first.bytes, &second.bytes));
        assert_eq!(&first.bytes[first.bytes.len() - 3..], &[7, 8, 9]);
        hub.detach("page-motion", &motion).await.unwrap();
        let later = hub
            .request(
                "page-dashboard",
                &topics,
                "model",
                message,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&later.bytes, &first.bytes));
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|message| message["op"] == "resource")
                .count(),
            1
        );
        hub.close();
        server.await.unwrap();
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
