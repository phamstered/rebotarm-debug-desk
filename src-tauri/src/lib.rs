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
async fn start_session(
    profile: ConnectionProfile,
    state: State<'_, SessionState>,
) -> Result<u16, String> {
    stop_tunnel(&state).await;

    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    if !valid_topic(&profile.joint_state_topic)
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
            start_session,
            stop_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Easy Debug");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(username: &str) -> ConnectionProfile {
        ConnectionProfile {
            host: "damiao".into(), ssh_port: 22, username: username.into(),
            identity_file: String::new(), local_port: 18765, remote_port: 8765,
            ros_domain_id: 0, ros_setup_script: "/opt/robot/install/setup.bash".into(),
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
