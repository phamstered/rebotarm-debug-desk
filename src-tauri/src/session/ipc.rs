use super::runtime::{pack, Attachment, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{ipc::Response, State, WebviewWindow};

#[derive(Serialize)]
pub struct Attached {
    attachment: Attachment,
    hello: Value,
}

#[tauri::command]
pub async fn native_bridge_attach(
    window: WebviewWindow,
    hub: State<'_, Runtime>,
    tunnel: State<'_, crate::SessionState>,
    port: Option<u16>,
) -> Result<Attached, String> {
    if let Some(port) = port {
        if window.label() != "main" {
            return Err("只有主窗口可以连接机器人".into());
        }
        if *tunnel.local_port.lock().map_err(|_| "隧道状态锁异常")? != Some(port) {
            return Err("本地端口不属于当前 SSH 会话".into());
        }
        hub.connect(port).await?;
    }
    let (attachment, hello) = hub.attach(window.label())?;
    Ok(Attached { attachment, hello })
}

#[tauri::command]
pub async fn native_bridge_detach(
    window: WebviewWindow,
    hub: State<'_, Runtime>,
    attachment: Attachment,
) -> Result<(), String> {
    hub.detach(window.label(), &attachment).await
}

#[tauri::command]
pub async fn native_bridge_next(
    window: WebviewWindow,
    hub: State<'_, Runtime>,
    attachment: Attachment,
) -> Result<Response, String> {
    hub.next(window.label(), &attachment)
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn native_bridge_request(
    window: WebviewWindow,
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
