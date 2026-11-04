use super::{ConnectionProfile, RemoteActionResult, is_safe_setup_script, ros_transport_setup, ssh_base, ssh_target};

fn remote(profile: &ConnectionProfile, operation: &str, command_id: &str, position: Option<f64>, confirmation: &str) -> Result<String, String> {
    if !matches!(operation, "move" | "cancel") || command_id.len() != 36 ||
        !command_id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }) {
        return Err("无效的夹爪操作或 command_id".into());
    }
    if !is_safe_setup_script(&profile.ros_setup_script) { return Err("无效的 ROS 环境脚本".into()); }
    let target = if operation == "move" {
        if confirmation != "ARMED" { return Err("夹爪操作需要现场安全确认".into()); }
        let value = position.ok_or("缺少夹爪目标")?;
        if !value.is_finite() || !(0.0..=0.05).contains(&value) { return Err("夹爪目标必须在 0–50 mm 内".into()); }
        format!(" --position {value}")
    } else { String::new() };
    let body = format!("{}source /opt/ros/humble/setup.bash || exit 1; setup=\"{}\"; case \"$setup\" in /*) ;; *) setup=\"$HOME/$setup\";; esac; source \"$setup\" || exit 1; export ROS_DOMAIN_ID={}; timeout --signal=TERM --kill-after=5 25 ros2 run microros_stm32h723_bridge teaching_gripper.py {operation} --command-id {command_id}{target}", ros_transport_setup(), profile.ros_setup_script, profile.ros_domain_id);
    Ok(format!("bash -lc '{}'", body.replace('\'', "'\\''")))
}

#[tauri::command]
pub async fn teaching_gripper_action(profile: ConnectionProfile, operation: String, command_id: String, position: Option<f64>, confirmation: String) -> Result<RemoteActionResult, String> {
    let command = remote(&profile, &operation, &command_id, position, &confirmation)?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(40),
        ssh_base(&profile).kill_on_drop(true).arg("-o").arg("BatchMode=yes").arg(ssh_target(&profile)).arg(command).output())
        .await.map_err(|_| "夹爪请求超时，停止状态未确认，请检查现场")?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result = stdout.lines().rev().find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok());
    Ok(RemoteActionResult {
        ok: output.status.success() && result.as_ref().and_then(|v| v["ok"].as_bool()) == Some(true),
        exit_code: output.status.code().unwrap_or(1),
        message: result.as_ref().and_then(|v| v["message"].as_str()).unwrap_or("夹爪操作失败或远端不支持，请升级控制栈；停止状态未确认").into(),
        detail: super::stderr_tail(&stderr, &stdout),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targets_confirmation_and_identifiers_are_checked_before_ssh() {
        let p = ConnectionProfile { host: "jetson".into(), ssh_port: 22, username: String::new(), identity_file: String::new(), local_port: 18765, remote_port: 8765, ros_domain_id: 0, ros_setup_script: "Project/rebotarm-ros2-stack/install/setup.bash".into(), joint_state_topic: "/stm32/joint_states".into(), command_topic: "/stm32/joint_commands".into(), status_topic: "/stm32/status".into() };
        let id = "12345678-1234-1234-1234-123456789abc";
        assert!(remote(&p, "move", id, Some(0.02), "ARMED").unwrap().contains("--position 0.02"));
        assert!(remote(&p, "cancel", id, None, "").is_ok());
        for q in [-0.01, 0.051, f64::NAN, f64::INFINITY] { assert!(remote(&p, "move", id, Some(q), "ARMED").is_err()); }
        assert!(remote(&p, "move", id, Some(0.0), "").is_err());
        assert!(remote(&p, "cancel", "$(id)", None, "").is_err());
    }
}
