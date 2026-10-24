use super::{ssh_base, ssh_target, ConnectionProfile};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const READER: &str = include_str!("control_logs.py");

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlLogSnapshot {
    source: String,
    path: String,
    exists: bool,
    content: String,
    truncated: bool,
    size_bytes: u64,
    revision: String,
}

fn remote_command(source: &str, download: bool) -> Result<String, String> {
    if !matches!(source, "teleop" | "trajectory" | "controller" | "realsense") {
        return Err("不支持的日志来源".into());
    }
    let script = READER.replace('\'', "'\"'\"'");
    Ok(format!(
        "timeout 10 python3 -c '{script}' {source} {}",
        if download { "download" } else { "tail" }
    ))
}

async fn read(
    profile: &ConnectionProfile,
    source: &str,
    download: bool,
) -> Result<ControlLogSnapshot, String> {
    let remote = remote_command(source, download)?;
    let mut command = ssh_base(profile);
    command
        .kill_on_drop(true)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(profile))
        .arg(remote);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "日志读取超时".to_string())?
        .map_err(|e| format!("无法读取日志：{e}"))?;
    if !output.status.success() {
        return Err(read_error(
            output.status.code(),
            &String::from_utf8_lossy(&output.stderr),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("日志响应无效：{e}"))
}

fn read_error(code: Option<i32>, stderr: &str) -> String {
    if code == Some(124) {
        return "日志读取超时（Jetson 10 秒）".into();
    }
    let reason = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("远端日志命令失败");
    format!("日志读取失败：{reason}")
}

#[tauri::command]
pub async fn read_control_log(
    profile: ConnectionProfile,
    source: String,
) -> Result<ControlLogSnapshot, String> {
    read(&profile, &source, false).await
}

fn validate_download_path(path: &str) -> Result<(), String> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some("log") {
        return Err("请选择绝对路径的 .log 文件".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn download_control_log(
    profile: ConnectionProfile,
    source: String,
    local_path: String,
) -> Result<(), String> {
    validate_download_path(&local_path)?;
    let path = std::path::Path::new(&local_path);
    let snapshot = read(&profile, &source, true).await?;
    if !snapshot.exists {
        return Err("日志尚未生成".into());
    }
    std::fs::write(path, snapshot.content).map_err(|e| format!("日志保存失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_allows_known_log_sources() {
        for source in ["teleop", "trajectory", "controller", "realsense"] {
            let cmd = remote_command(source, false).unwrap();
            assert!(cmd.starts_with("timeout 10 python3 -c '"));
            assert!(cmd.ends_with(&format!("{source} tail")));
        }
        for source in ["", "../secret", "teleop;reboot", "$(id)"] {
            assert!(remote_command(source, false).is_err());
        }
        assert!(remote_command("teleop", true)
            .unwrap()
            .ends_with("teleop download"));
    }
    #[test]
    fn reports_timeout_and_actionable_error_without_traceback() {
        assert!(read_error(Some(124), "").contains("超时"));
        assert_eq!(
            read_error(Some(1), "Traceback\nValueError: 日志超过上限\n"),
            "日志读取失败：ValueError: 日志超过上限"
        );
        assert!(read_error(Some(255), "Permission denied").contains("Permission denied"));
        assert!(read_error(None, "").contains("远端日志命令失败"));
    }
    #[test]
    fn rejects_invalid_download_destinations_before_ssh() {
        assert!(validate_download_path("/tmp/control.log").is_ok());
        for path in ["relative.log", "/tmp/report.json", "", "/tmp/no-extension"] {
            assert!(validate_download_path(path).is_err());
        }
    }
    #[test]
    fn log_reader_covers_files_rotation_and_bounds() {
        let result = std::process::Command::new("python3")
            .arg(format!(
                "{}/tests/test_control_logs.py",
                env!("CARGO_MANIFEST_DIR")
            ))
            .output()
            .expect("python3 must be available");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
