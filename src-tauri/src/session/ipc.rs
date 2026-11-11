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
        if serde_json::to_vec(&profile)
            .map_err(|e| e.to_string())?
            .len()
            > 16 * 1024
        {
            return Err("Profile 超出大小限制".into());
        }
        serde_json::from_value::<crate::ConnectionProfile>(profile.clone())
            .map_err(|_| "Profile 格式无效")?;
        hub.set_profile(profile);
        hub.connect(port).await?;
    }
    let (attachment, hello) = hub.attach(window.label())?;
    Ok(Attached { attachment, hello })
}

#[tauri::command]
pub fn native_bridge_context(window: Webview, hub: State<'_, Runtime>) -> Result<Value, String> {
    if window.label() != "main" && super::windows::Page::from_label(window.label()).is_none() {
        return Err("未授权的功能页面".into());
    }
    Ok(hub.context())
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
        0,
        started.elapsed().as_millis() as u64,
        &reply.bytes,
    )))
}
