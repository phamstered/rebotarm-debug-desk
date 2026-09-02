use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::State;
use tokio::process::{Child, Command};
use tokio::time::{sleep, Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionProfile {
    host: String,
    ssh_port: u16,
    username: String,
    identity_file: String,
    local_port: u16,
    remote_port: u16,
    ros_domain_id: u16,
    ros_setup_script: String,
    robot_joint_state_topic: String,
    joint_state_topic: String,
    command_topic: String,
    status_topic: String,
}

#[derive(Default)]
struct SessionState {
    tunnel: Mutex<Option<Child>>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentServiceStatus {
    load_state: String,
    active_state: String,
    sub_state: String,
    result: String,
    main_pid: u32,
    unit_file_state: String,
    description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerInfo {
    name: String,
    type_name: String,
    state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RosControlStatus {
    manager: String,
    available: bool,
    controllers: Vec<ControllerInfo>,
    message: String,
}

fn ssh_target(profile: &ConnectionProfile) -> String {
    if profile.username.trim().is_empty() {
        profile.host.clone()
    } else {
        format!("{}@{}", profile.username, profile.host)
    }
}

fn is_safe_setup_script(path: &str) -> bool {
    path.chars()
        .all(|character| character.is_ascii_alphanumeric() || "/._-".contains(character))
}

fn valid_topic(topic: &str) -> bool {
    topic.starts_with('/')
        && topic
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '/')
}

fn valid_ros_type(type_name: &str) -> bool {
    let parts: Vec<_> = type_name.split('/').collect();
    parts.len() == 3
        && parts[1] == "msg"
        && parts[0].chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
        && parts[2].chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
        && !parts[0].is_empty()
        && !parts[2].is_empty()
}

fn hex_encode(value: &str) -> String {
    value.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validated_publish_payload(
    profile: &ConnectionProfile,
    topic: &str,
    type_name: &str,
    payload_json: &str,
) -> Result<String, String> {
    if !valid_topic(topic) || !valid_ros_type(type_name) {
        return Err("Topic 名称或消息类型格式无效".into());
    }
    if topic == profile.command_topic {
        return Err("禁止从 Topic Inspector 绕过 Motor Control 发布电机命令".into());
    }
    if payload_json.len() > 65_536 {
        return Err("JSON 内容超过 64 KiB".into());
    }
    let value: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|error| format!("JSON 格式无效：{error}"))?;
    if !value.is_object() {
        return Err("ROS 消息 JSON 顶层必须是对象".into());
    }
    Ok(hex_encode(payload_json))
}

fn topic_info_command(profile: &ConnectionProfile, topic: &str) -> String {
    format!(
        "bash -lc 'source /opt/ros/humble/setup.bash; \
         if [ -f \"{}\" ]; then source \"{}\"; fi; \
         ROS_DOMAIN_ID={} timeout 8 ros2 topic info --no-daemon --spin-time 1 -v {} 2>&1'",
        profile.ros_setup_script, profile.ros_setup_script, profile.ros_domain_id, topic,
    )
}

fn topic_publish_command(
    profile: &ConnectionProfile,
    topic: &str,
    type_name: &str,
    payload_hex: &str,
) -> String {
    format!(
        "bash -lc 'source /opt/ros/humble/setup.bash; \
         if [ -f \"{}\" ]; then source \"{}\"; fi; \
         ROS_DOMAIN_ID={} timeout 10 ros2 topic pub --once \
         --wait-matching-subscriptions 0 {} {} \
         \"$(printf %s {} | xxd -r -p)\" 2>&1'",
        profile.ros_setup_script,
        profile.ros_setup_script,
        profile.ros_domain_id,
        topic,
        type_name,
        payload_hex,
    )
}

fn valid_controller_name(name: &str) -> bool {
    let valid_start = name
        .chars()
        .next()
        .map(|character| character.is_ascii_alphabetic() || character == '_' || character == '/')
        .unwrap_or(false);
    !name.is_empty()
        && name.len() <= 255
        && valid_start
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '/')
}

fn controller_action_flag(action: &str) -> Option<&'static str> {
    match action {
        "activate" => Some("--activate"),
        "deactivate" => Some("--deactivate"),
        _ => None,
    }
}

fn controller_switch_command(
    profile: &ConnectionProfile,
    controller_name: &str,
    action: &str,
) -> Result<String, String> {
    const MANAGER: &str = "/controller_manager";
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    if !valid_controller_name(controller_name) {
        return Err("Controller 名称格式无效".into());
    }
    let flag = controller_action_flag(action).ok_or("不支持的 Controller 操作")?;
    Ok(format!(
        "bash -lc 'source /opt/ros/humble/setup.bash; \
         if [ -f \"{}\" ]; then source \"{}\"; fi; \
         ROS_DOMAIN_ID={} timeout 10 ros2 control switch_controllers \
         {} {} --strict --spin-time 1 -c {} 2>&1'",
        profile.ros_setup_script,
        profile.ros_setup_script,
        profile.ros_domain_id,
        flag,
        controller_name,
        MANAGER
    ))
}

fn parse_agent_status(output: &str) -> AgentServiceStatus {
    let mut status = AgentServiceStatus::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        match key {
            "LoadState" => status.load_state = value.into(),
            "ActiveState" => status.active_state = value.into(),
            "SubState" => status.sub_state = value.into(),
            "Result" => status.result = value.into(),
            "MainPID" => status.main_pid = value.parse().unwrap_or_default(),
            "UnitFileState" => status.unit_file_state = value.into(),
            "Description" => status.description = value.into(),
            _ => {}
        }
    }
    status
}

fn strip_ansi(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if code.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            result.push(character);
        }
    }
    result
}

fn parse_controllers(output: &str) -> Vec<ControllerInfo> {
    strip_ansi(output)
        .lines()
        .filter_map(|line| {
            let columns: Vec<_> = line.split_whitespace().collect();
            if columns.len() < 3 || columns[0].starts_with('[') {
                return None;
            }
            Some(ControllerInfo {
                name: columns[0].into(),
                type_name: columns[1..columns.len() - 1].join(" "),
                state: columns[columns.len() - 1].to_ascii_lowercase(),
            })
        })
        .collect()
}

fn ros_control_error(output: &str) -> String {
    if output.contains("Could not contact service") || output.contains("waiting for service") {
        "controller_manager 服务不可用或查询超时".into()
    } else {
        output
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(|line| strip_ansi(line.trim()))
            .unwrap_or_else(|| "ROS Control 查询失败".into())
    }
}

fn probe_local_port(port: u16) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("无法分配本地隧道端口：{error}"))?;
    let assigned = listener
        .local_addr()
        .map_err(|error| format!("无法读取本地隧道端口：{error}"))?
        .port();
    drop(listener);
    Ok(assigned)
}

fn choose_local_port_with<F>(preferred: u16, mut probe: F) -> Result<u16, String>
where
    F: FnMut(u16) -> Result<u16, String>,
{
    match probe(preferred) {
        Ok(_) => Ok(preferred),
        Err(_) => probe(0),
    }
}

fn choose_local_port(preferred: u16) -> Result<u16, String> {
    choose_local_port_with(preferred, probe_local_port)
}

fn ssh_base(profile: &ConnectionProfile) -> Command {
    let mut command = Command::new("ssh");
    command
        .arg("-p")
        .arg(profile.ssh_port.to_string())
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg("-o")
        .arg("ServerAliveInterval=10")
        .arg("-o")
        .arg("ServerAliveCountMax=3");
    if !profile.identity_file.trim().is_empty() {
        command.arg("-i").arg(&profile.identity_file);
    }
    command
}

#[tauri::command]
async fn check_ssh(profile: ConnectionProfile) -> Result<String, String> {
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg("printf easy-debug-ready")
        .output()
        .await
        .map_err(|error| format!("无法启动 ssh：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "SSH 连接失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
async fn check_micro_ros_agent(profile: ConnectionProfile) -> Result<AgentServiceStatus, String> {
    const SERVICE: &str = "micro-ros-agent-stm32h723.service";
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(format!(
            "systemctl show {SERVICE} --no-page \
             --property=LoadState,ActiveState,SubState,Result,MainPID,UnitFileState,Description"
        ))
        .output()
        .await
        .map_err(|error| format!("无法检查 micro-ROS Agent：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "systemd 状态检查失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(parse_agent_status(&String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
async fn check_ros_controllers(profile: ConnectionProfile) -> Result<RosControlStatus, String> {
    const MANAGER: &str = "/controller_manager";
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    let remote = format!(
        "bash -lc 'source /opt/ros/humble/setup.bash; \
         if [ -f \"{}\" ]; then source \"{}\"; fi; \
         ROS_DOMAIN_ID={} timeout 5 ros2 control list_controllers \
         --spin-time 1 -c {} 2>&1'",
        profile.ros_setup_script,
        profile.ros_setup_script,
        profile.ros_domain_id,
        MANAGER
    );
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法查询 ROS Control：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    if !output.status.success() {
        return Ok(RosControlStatus {
            manager: MANAGER.into(),
            available: false,
            controllers: Vec::new(),
            message: ros_control_error(&combined),
        });
    }
    let controllers = parse_controllers(&stdout);
    let message = if controllers.is_empty() {
        "当前未加载 Controller".into()
    } else {
        String::new()
    };
    Ok(RosControlStatus {
        manager: MANAGER.into(),
        available: true,
        controllers,
        message,
    })
}

#[tauri::command]
async fn switch_ros_controller(
    profile: ConnectionProfile,
    controller_name: String,
    action: String,
) -> Result<String, String> {
    let remote = controller_switch_command(&profile, &controller_name, &action)?;
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法执行 Controller 操作：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    if !output.status.success() {
        return Err(format!("Controller 操作失败：{}", ros_control_error(&combined)));
    }
    Ok(stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| strip_ansi(line.trim()))
        .unwrap_or_else(|| format!("Controller {controller_name} {action} 完成")))
}

#[tauri::command]
async fn get_topic_info(profile: ConnectionProfile, topic: String) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) || !valid_topic(&topic) {
        return Err("ROS 环境脚本或 Topic 名称格式无效".into());
    }
    let remote = topic_info_command(&profile, &topic);
    let output = ssh_base(&profile)
        .arg("-o").arg("BatchMode=yes")
        .arg(ssh_target(&profile)).arg(remote)
        .output().await
        .map_err(|error| format!("无法查询 Topic Info：{error}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(if text.is_empty() { "Topic Info 查询失败或超时".into() } else { text });
    }
    Ok(text)
}

#[tauri::command]
async fn publish_topic_once(
    profile: ConnectionProfile,
    topic: String,
    type_name: String,
    payload_json: String,
) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    let payload_hex = validated_publish_payload(&profile, &topic, &type_name, &payload_json)?;
    let remote = topic_publish_command(&profile, &topic, &type_name, &payload_hex);
    let output = ssh_base(&profile)
        .arg("-o").arg("BatchMode=yes")
        .arg(ssh_target(&profile)).arg(remote)
        .output().await
        .map_err(|error| format!("无法发布 Topic 数据：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(if stdout.is_empty() { "单帧发布失败或超时".into() } else { stdout });
    }
    Ok(stdout.lines().last().unwrap_or("已发布一帧数据").to_string())
}

#[tauri::command]
async fn start_session(
    profile: ConnectionProfile,
    state: State<'_, SessionState>,
) -> Result<u16, String> {
    stop_tunnel(&state).await;

    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    if !valid_topic(&profile.robot_joint_state_topic)
        || !valid_topic(&profile.joint_state_topic)
        || !valid_topic(&profile.command_topic)
        || !valid_topic(&profile.status_topic)
    {
        return Err("ROS Topic 名称格式无效".into());
    }

    let remote = format!(
        "bash -lc 'source /opt/ros/humble/setup.bash; \
         if [ -f \"{}\" ]; then source \"{}\"; fi; \
         source \"$HOME/easy_debug_bridge/install/setup.bash\"; \
         pkill -TERM -f \"^$HOME/easy_debug_bridge/install/easy_debug_bridge/lib/easy_debug_bridge/bridge_node \" \
           >/dev/null 2>&1 || true; \
         for attempt in 1 2 3 4 5 6 7 8 9 10; do \
           if ! ss -ltn | grep -q \":{} \"; then break; fi; sleep 0.1; \
         done; \
         if ss -ltn | grep -q \":{} \"; then echo \"Bridge 端口仍被占用\" >&2; exit 1; fi; \
         ROS_DOMAIN_ID={} nohup ros2 run easy_debug_bridge bridge_node --ros-args -p port:={} \
         -p joint_state_topic:={} -p command_topic:={} -p status_topic:={} \
         >/tmp/easy_debug_bridge.log 2>&1 </dev/null &'",
        profile.ros_setup_script,
        profile.ros_setup_script,
        profile.remote_port,
        profile.remote_port,
        profile.ros_domain_id,
        profile.remote_port,
        profile.joint_state_topic,
        profile.command_topic,
        profile.status_topic
    );
    let started = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法启动远端 Bridge：{error}"))?;
    if !started.status.success() {
        return Err(format!(
            "Bridge 启动失败：{}",
            String::from_utf8_lossy(&started.stderr).trim()
        ));
    }

    let local_port = choose_local_port(profile.local_port)?;
    let forward = format!("127.0.0.1:{}:127.0.0.1:{}", local_port, profile.remote_port);
    let mut tunnel = ssh_base(&profile);
    tunnel
        .kill_on_drop(true)
        .arg("-N")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-L")
        .arg(forward)
        .arg(ssh_target(&profile))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = tunnel
        .spawn()
        .map_err(|error| format!("无法建立 SSH 隧道：{error}"))?;
    sleep(Duration::from_millis(700)).await;
    if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
        let stderr = match child.stderr.take() {
            Some(stderr) => {
                use tokio::io::AsyncReadExt;
                let mut reader = stderr;
                let mut bytes = Vec::new();
                let _ = reader.read_to_end(&mut bytes).await;
                String::from_utf8_lossy(&bytes).into_owned()
            }
            None => String::new(),
        };
        return Err(format!("SSH 隧道提前退出（{status}）：{}", stderr.trim()));
    }
    *state.tunnel.lock().map_err(|_| "隧道状态锁异常")? = Some(child);
    Ok(local_port)
}

async fn stop_tunnel(state: &State<'_, SessionState>) {
    let child = state.tunnel.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

#[tauri::command]
async fn stop_session(state: State<'_, SessionState>) -> Result<(), String> {
    stop_tunnel(&state).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionState::default())
        .invoke_handler(tauri::generate_handler![
            check_ssh,
            check_micro_ros_agent,
            check_ros_controllers,
            switch_ros_controller,
            get_topic_info,
            publish_topic_once,
            start_session,
            stop_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Robot Console");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(username: &str) -> ConnectionProfile {
        ConnectionProfile {
            host: "damiao".into(), ssh_port: 22, username: username.into(),
            identity_file: String::new(), local_port: 18765, remote_port: 8765,
            ros_domain_id: 0, ros_setup_script: "/opt/robot/install/setup.bash".into(),
            robot_joint_state_topic: "/joint_states".into(),
            joint_state_topic: "/stm32/joint_states".into(),
            command_topic: "/stm32/joint_commands".into(), status_topic: "/stm32/status".into(),
        }
    }

    #[test]
    fn builds_ssh_target_with_optional_username() {
        assert_eq!(ssh_target(&profile("")), "damiao");
        assert_eq!(ssh_target(&profile("robot")), "robot@damiao");
    }

    #[test]
    fn validates_setup_script_and_ros_topic_inputs() {
        assert!(is_safe_setup_script("/home/robot/ws_1/install/setup.bash"));
        assert!(!is_safe_setup_script("/tmp/setup.bash;reboot"));
        assert!(valid_topic("/stm32/joint_commands"));
        assert!(!valid_topic("stm32/joint_commands"));
        assert!(!valid_topic("/stm32/joint-commands"));
        assert!(valid_ros_type("sensor_msgs/msg/JointState"));
        assert!(!valid_ros_type("sensor_msgs/JointState"));
        assert!(valid_controller_name("/arm/trajectory_controller"));
        assert!(valid_controller_name("joint_state_broadcaster"));
        assert!(!valid_controller_name("arm-controller"));
        assert!(!valid_controller_name("arm;reboot"));
    }

    #[test]
    fn validates_and_encodes_single_frame_topic_payloads() {
        let profile = profile("");
        let payload = r#"{"data":"hello ' robot"}"#;
        assert_eq!(
            validated_publish_payload(&profile, "/debug", "std_msgs/msg/String", payload).unwrap(),
            hex_encode(payload),
        );
        assert!(validated_publish_payload(&profile, "/debug", "std_msgs/msg/String", "{").is_err());
        assert!(validated_publish_payload(&profile, "/debug", "std_msgs/msg/String", "[]").is_err());
        assert!(validated_publish_payload(
            &profile,
            "/stm32/joint_commands",
            "microros_stm32h723_bridge/msg/JointCommand",
            "{}",
        ).is_err());
        assert!(topic_info_command(&profile, "/joint_states").contains("--no-daemon --spin-time 1 -v /joint_states"));
        let publish = topic_publish_command(&profile, "/debug", "std_msgs/msg/String", "7b7d");
        assert!(publish.contains("--once --wait-matching-subscriptions 0"));
        assert!(publish.contains("std_msgs/msg/String"));
    }

    #[test]
    fn builds_safe_ros_controller_switch_commands() {
        let activate = controller_switch_command(&profile(""), "arm_controller", "activate").unwrap();
        assert!(activate.contains("switch_controllers --activate arm_controller --strict"));
        assert!(activate.contains("--strict --spin-time 1"));
        assert!(!activate.contains("--switch-timeout"));
        assert!(activate.contains("ROS_DOMAIN_ID=0"));
        assert!(activate.contains("-c /controller_manager"));
        let deactivate = controller_switch_command(&profile(""), "/arm/controller", "deactivate").unwrap();
        assert!(deactivate.contains("--deactivate /arm/controller"));
        assert!(controller_switch_command(&profile(""), "arm;reboot", "activate").is_err());
        assert!(controller_switch_command(&profile(""), "arm_controller", "restart").is_err());
    }

    #[test]
    fn csp_allows_threejs_to_fetch_blob_meshes() {
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains("script-src 'self' 'wasm-unsafe-eval'"));
        assert!(config.contains("connect-src 'self' blob:"));
        assert!(config.contains("img-src 'self' asset: http://asset.localhost blob:"));
    }

    #[test]
    fn parses_systemd_agent_status() {
        let status = parse_agent_status(
            "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nMainPID=42\nUnitFileState=enabled\nDescription=micro ROS agent\nIgnored=x\n",
        );
        assert_eq!(status.load_state, "loaded");
        assert_eq!(status.active_state, "active");
        assert_eq!(status.sub_state, "running");
        assert_eq!(status.main_pid, 42);
        assert_eq!(status.unit_file_state, "enabled");
        assert_eq!(status.description, "micro ROS agent");
    }

    #[test]
    fn malformed_pid_falls_back_to_zero() {
        assert_eq!(parse_agent_status("MainPID=invalid").main_pid, 0);
    }

    #[test]
    fn parses_ros_control_controller_rows_and_ansi_colors() {
        let controllers = parse_controllers(
            "joint_state_broadcaster joint_state_broadcaster/JointStateBroadcaster \u{1b}[32mactive\u{1b}[0m\n\
             arm_controller joint_trajectory_controller/JointTrajectoryController inactive\n",
        );
        assert_eq!(controllers, vec![
            ControllerInfo {
                name: "joint_state_broadcaster".into(),
                type_name: "joint_state_broadcaster/JointStateBroadcaster".into(),
                state: "active".into(),
            },
            ControllerInfo {
                name: "arm_controller".into(),
                type_name: "joint_trajectory_controller/JointTrajectoryController".into(),
                state: "inactive".into(),
            },
        ]);
    }

    #[test]
    fn ignores_ros_cli_logs_and_summarizes_manager_timeout() {
        assert!(parse_controllers("[INFO] waiting for service\n").is_empty());
        assert_eq!(
            ros_control_error("[WARN] Could not contact service /controller_manager/list_controllers"),
            "controller_manager 服务不可用或查询超时"
        );
    }

    #[test]
    fn keeps_free_port_and_falls_back_when_preferred_is_busy() {
        assert_eq!(choose_local_port_with(18765, |port| Ok(port)).unwrap(), 18765);
        let mut probes = Vec::new();
        let fallback = choose_local_port_with(18765, |port| {
            probes.push(port);
            if port == 18765 { Err("busy".into()) } else { Ok(23456) }
        }).unwrap();
        assert_eq!(probes, vec![18765, 0]);
        assert_eq!(fallback, 23456);
    }
}
