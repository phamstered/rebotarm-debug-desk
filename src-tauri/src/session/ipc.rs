use super::runtime::{pack, Attachment, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{ipc::Response, State, Webview};

#[derive(Serialize)]
pub struct Attached {
    attachment: Attachment,
    hello: Value,
}

#[tauri::command]
pub async fn native_bridge_attach(
    window: Webview,
    hub: State<'_, Runtime>,
    tunnel: State<'_, crate::SessionState>,
    port: Option<u16>,
    profile: Option<Value>,
) -> Result<Attached, String> {
    if let Some(port) = port {
        if window.label() != "main" {
            return Err("只有主窗口可以连接机器人".into());
        }
        if *tunnel.local_port.lock().map_err(|_| "隧道状态锁异常")? != Some(port) {
            return Err("本地端口不属于当前 SSH 会话".into());
        }
        let profile = profile.ok_or("连接缺少 Profile")?;
        hub.connect_profile(port, profile).await?;
    }
    let (attachment, hello) = hub.attach(window.label())?;
    Ok(Attached { attachment, hello })
}

#[tauri::command]
pub async fn native_offline_profile(window: Webview, hub: State<'_, Runtime>, profile: Value) -> Result<Value, String> {
    hub.select_offline_profile(window.label(), profile).await
}

#[tauri::command]
pub fn native_bridge_context(window: Webview, hub: State<'_, Runtime>) -> Result<Value, String> {
    if window.label() != "main" && super::windows::Page::from_label(window.label()).is_none() {
        return Err("未授权的功能页面".into());
    }
    Ok(hub.context())
}

fn observation_caller(window: &Webview) -> Result<(), String> {
    if window.label() == "main" || super::windows::Page::from_label(window.label()).is_some() {
        Ok(())
    } else {
        Err("未授权的功能页面".into())
    }
}

#[tauri::command]
pub fn native_bag_operation_snapshot(window:Webview,hub:State<'_,Runtime>)->Result<Vec<super::bag_operation::Snapshot>,String> {
    observation_caller(&window)?;Ok(hub.bag_operations.snapshot())
}

#[tauri::command]
pub fn native_collection_operation_snapshot(window: Webview, hub: State<'_, Runtime>) -> Result<Option<super::collection_operation::Snapshot>, String> {
    observation_caller(&window)?;
    Ok(hub.collection_operations.snapshot())
}

#[tauri::command]
pub fn native_task_snapshot(
    window: Webview,
    hub: State<'_, Runtime>,
) -> Result<Option<super::tasks::Snapshot>, String> {
    observation_caller(&window)?;
    Ok(hub.tasks.snapshot())
}

#[tauri::command]
pub fn native_trajectory_cancel(
    window: Webview,
    hub: State<'_, Runtime>,
    id: u64,
    command_id: String,
) -> Result<(), String> {
    observation_caller(&window)?;
    // Intent is local and correlated. The native watchdog alone sends the
    // cancellation, and never sends it to a replacement connection's task.
    hub.cancel_trajectory(id, &command_id)
}

#[tauri::command]
pub fn native_local_task_snapshot(window: Webview, hub: State<'_, Runtime>) -> Result<Option<super::local_tasks::Snapshot>, String> {
    observation_caller(&window)?;
    Ok(hub.local_tasks.snapshot())
}
#[tauri::command]
pub fn native_local_task_touch(window: Webview, hub: State<'_, Runtime>, operation_id: String) -> Result<(), String> {
    hub.local_tasks.touch(window.label(), &operation_id)
}
#[tauri::command]
pub fn native_local_task_cancel(window: Webview, hub: State<'_, Runtime>, operation_id: String) -> Result<(), String> {
    hub.local_tasks.cancel(window.label(), &operation_id)
}

#[tauri::command]
pub fn native_observation_snapshot(
    window: Webview,
    hub: State<'_, Runtime>,
) -> Result<super::observations::Snapshot, String> {
    observation_caller(&window)?;
    Ok(hub.observations.snapshot())
}

#[tauri::command]
pub async fn native_observation_refresh(
    window: Webview,
    hub: State<'_, Runtime>,
    epoch: u64,
    source: super::observations::Source,
    after_pending: bool,
) -> Result<super::observations::Snapshot, String> {
    observation_caller(&window)?;
    let started = Instant::now();
    let mut snapshot = hub
        .observations
        .refresh(epoch, source, after_pending)
        .await?;
    snapshot.handler_elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(snapshot)
}

#[tauri::command]
pub fn native_observation_interval(
    window: Webview,
    hub: State<'_, Runtime>,
    seconds: u64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以修改全局刷新间隔".into());
    }
    hub.observations.set_topics_interval(seconds)
}

#[tauri::command]
pub async fn native_bridge_detach(
    window: Webview,
    hub: State<'_, Runtime>,
    attachment: Attachment,
) -> Result<(), String> {
    hub.detach(window.label(), &attachment).await
}

#[tauri::command]
pub async fn native_bridge_next(
    window: Webview,
    hub: State<'_, Runtime>,
    attachment: Attachment,
) -> Result<Response, String> {
    hub.next(window.label(), &attachment)
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn native_monitor_configure(
    window: Webview,
    hub: State<'_, Runtime>,
    attachment: Attachment,
    config: super::monitor::Config,
) -> Result<(), String> {
    hub.monitor_configure(window.label(), &attachment, config)
        .await
}

#[tauri::command]
pub fn native_monitor_history(
    window: Webview,
    hub: State<'_, Runtime>,
    attachment: Attachment,
    after: u64,
) -> Result<super::monitor::Page, String> {
    hub.monitor_history(window.label(), &attachment, after)
}

#[tauri::command]
pub async fn native_bridge_request(
    window: Webview,
    hub: State<'_, Runtime>,
    attachment: Attachment,
    consumer: String,
    message: Value,
    timeout_ms: u64,
) -> Result<Response, String> {
    if !(1..=60_000).contains(&timeout_ms) {
        return Err("请求超时范围无效".into());
    }
    let started = Instant::now();
    let reply = hub
        .request(
            window.label(),
            &attachment,
            &consumer,
            message,
            Duration::from_millis(timeout_ms),
        )
        .await?;
    Ok(Response::new(pack(
        reply.binary,
        reply.source_age_ms,
        started.elapsed().as_millis() as u64,
        &reply.bytes,
    )))
}
