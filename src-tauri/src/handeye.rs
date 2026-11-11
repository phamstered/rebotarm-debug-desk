use super::{is_safe_setup_script, ssh_base, ssh_target, ConnectionProfile};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{Manager, State, Webview};
use crate::session::runtime::Runtime;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};

static LOCAL_WORK: Semaphore = Semaphore::const_new(1);
static CAPTURE_WORK: Semaphore = Semaphore::const_new(1);
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn result(output: &[u8]) -> Result<Value, String> {
    if output.len() > 40 * 1024 * 1024 {
        return Err("标定返回数据过大".into());
    }
    let text = std::str::from_utf8(output).map_err(|e| e.to_string())?;
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("标定进程没有返回结果")?;
    let response: Value = serde_json::from_str(line).map_err(|e| format!("标定结果无效：{e}"))?;
    if response["ok"] != true {
        return Err(response["error"].as_str().unwrap_or("标定处理失败").into());
    }
    Ok(response["result"].clone())
}
fn capture_command(profile: &ConnectionProfile, config: &Value) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境路径无效".into());
    }
    let mode = config["mode"].as_str().unwrap_or("");
    if !["capture", "preview", "frames"].contains(&mode) {
        return Err("未知的手眼采集操作".into());
    }
    for key in [
        "image_topic",
        "camera_info_topic",
        "joint_topic",
        "base_frame",
        "eef_frame",
        "sensor_frame",
        "camera_body_frame",
    ] {
        let value = config[key].as_str().ok_or_else(|| format!("缺少 {key}"))?;
        if value.is_empty()
            || value.len() > 200
            || !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '_')
        {
            return Err(format!("无效 Topic / Frame：{key}"));
        }
    }
    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
    if json.len() > 8192 {
        return Err("采集配置过大".into());
    }
    // Fixed read-only script; neither user text nor topic names are shell code.
    let script = format!("source /opt/ros/humble/setup.bash && source {} && export ROS_DOMAIN_ID={} && {} timeout 12s python3 -c {} {}",
        quote(&profile.ros_setup_script), profile.ros_domain_id, super::ros_transport_setup(),
        quote(include_str!("handeye_capture.py")), quote(&json));
    Ok(format!("bash -lc {}", quote(&script)))
}

#[tauri::command]
pub async fn handeye_capture(window: Webview, hub: State<'_, Runtime>, operation_id: String, profile: ConnectionProfile, config: Value) -> Result<Value, String> {
    hub.local_tasks.run(&hub.tasks, window.label(), &operation_id, "capture", capture_work(profile, config)).await
}
async fn capture_work(profile: ConnectionProfile, config: Value) -> Result<Value, String> {
    let _permit = CAPTURE_WORK
        .try_acquire()
        .map_err(|_| "已有手眼采集正在进行")?;
    let script = capture_command(&profile, &config)?;
    let mut cmd = ssh_base(&profile);
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg(ssh_target(&profile))
        .arg(script)
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(18), cmd.output())
        .await
        .map_err(|_| "手眼采集超时")?
        .map_err(|e| format!("手眼采集 SSH 失败：{e}"))?;
    if output.stdout.is_empty() {
        return Err(format!(
            "手眼采集失败：{}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1200)
                .collect::<String>()
        ));
    }
    result(&output.stdout)
}

fn executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("handeye/handeye_solver");
    if packaged.is_file() {
        return Ok(packaged);
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native/build/handeye_solver");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err("未安装手眼计算模块；请重新构建完整应用（prepare:handeye）".into())
}
#[tauri::command]
pub async fn handeye_local(app: tauri::AppHandle, window: Webview, hub: State<'_, Runtime>, operation_id: String, request: Value) -> Result<Value, String> {
    hub.local_tasks.run(&hub.tasks, window.label(), &operation_id, "compute", local_work(app, request)).await
}
async fn local_work(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    let _permit = LOCAL_WORK.try_acquire().map_err(|_| "手眼计算正在进行")?;
    let data = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if data.len() > 32 * 1024 * 1024 {
        return Err("手眼计算请求过大".into());
    }
    let mut child = Command::new(executable(&app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("无法启动手眼计算模块：{e}"))?;
    let work = async {
        let mut stdin = child.stdin.take().ok_or("计算模块输入不可用")?;
        stdin.write_all(&data).await.map_err(|e| e.to_string())?;
        drop(stdin);
        let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
        result(&output.stdout)
    };
    // macOS may validate the bundled dylib signatures on the first launch.
    // Keep this bounded, but allow that cold start without rejecting good data.
    timeout(Duration::from_secs(90), work)
        .await
        .map_err(|_| "手眼计算超时")?
}

#[tauri::command]
pub fn handeye_save(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !path.is_absolute() || !["json", "yaml", "png"].contains(&ext) {
        return Err("请选择 JSON / YAML / PNG 绝对路径".into());
    }
    if content.len() > 128 * 1024 * 1024 {
        return Err("标定文件过大".into());
    }
    let bytes = if ext == "png" {
        decode_png(&content)?
    } else {
        content.into_bytes()
    };
    std::fs::write(path, bytes).map_err(|e| format!("保存标定文件失败：{e}"))
}
fn decode_png(s: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut padded = false;
    if s.len() > 24 * 1024 * 1024 || s.len() % 4 != 0 {
        return Err("PNG 数据无效".into());
    }
    for c in s.bytes() {
        if c == b'=' {
            padded = true;
            continue;
        }
        if padded {
            return Err("PNG 编码无效".into());
        }
        let n = TABLE.iter().position(|x| *x == c).ok_or("PNG 编码无效")?;
        acc = (acc << 6) | n as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 255) as u8);
        }
    }
    if !out.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("不是 PNG 图片".into());
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_errors_and_missing_responses() {
        assert!(result(b"no result").is_err());
        assert_eq!(
            result(br#"{"ok":false,"error":"stale"}"#).unwrap_err(),
            "stale"
        );
        assert_eq!(
            result(b"ROS log\n{\"ok\":true,\"result\":{\"frames\":[]}}\n").unwrap()["frames"],
            serde_json::json!([])
        );
    }
    #[test]
    fn shell_quote_is_literal() {
        assert_eq!(quote("x'$(cmd)"), "'x'\"'\"'$(cmd)'");
    }
    #[test]
    fn rejects_bad_png() {
        assert!(decode_png("Zm9v").is_err());
        assert!(decode_png("====aaa=").is_err());
    }
}
