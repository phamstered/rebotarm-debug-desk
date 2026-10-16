use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
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

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RosbagStatus {
    recording: bool,
    pid: u32,
    output_path: String,
    message: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RosbagPlayStatus {
    playing: bool,
    pid: u32,
    bag_path: String,
    message: String,
}


#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsbProbeStatus {
    mcu_present: bool,
    mcu_vid_pid: String,
    serial_path: Option<String>,
    realsense_present: bool,
    realsense_lines: Vec<String>,
    raw_lsusb: String,
    error: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArmModeStatus {
    mode: String,
    teleop_running: bool,
    trajectory_running: bool,
    realsense_running: bool,
    teleop_pid: u32,
    trajectory_pid: u32,
    realsense_pid: u32,
    message: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteActionResult {
    ok: bool,
    exit_code: i32,
    message: String,
    detail: String,
}


#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TriggerServiceResponse {
    success: bool,
    message: String,
}

fn ssh_target(profile: &ConnectionProfile) -> String {
    if profile.username.trim().is_empty() {
        profile.host.clone()
    } else {
        format!("{}@{}", profile.username, profile.host)
    }
}

/// Accepts an absolute path or a path relative to the remote user's home
/// (SSH commands start in `$HOME`). Only `[A-Za-z0-9._-/]` are allowed;
/// `~`, empty, `.`/`..` segments and segments starting with `-` are rejected.
fn is_safe_setup_script(path: &str) -> bool {
    if path.is_empty() || path.len() > 4096 {
        return false;
    }
    if !path
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "/._-".contains(character))
    {
        return false;
    }
    let body = path.strip_prefix('/').unwrap_or(path);
    !body.is_empty()
        && body.split('/').all(|segment| {
            !segment.is_empty() && segment != "." && segment != ".." && !segment.starts_with('-')
        })
}

fn valid_topic(topic: &str) -> bool {
    topic.starts_with('/')
        && topic.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '/'
        })
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
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '/'
        })
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

fn joint4_calibration_service(action: &str) -> Option<&'static str> {
    match action {
        "begin_pose" => Some("/joint4_calibration_controller/begin_pose"),
        "release_pose" => Some("/joint4_calibration_controller/release_pose"),
        "capture_pose" => Some("/joint4_calibration_controller/capture_pose"),
        "fit" => Some("/joint4_calibration_controller/fit"),
        "reset" => Some("/joint4_calibration_controller/reset"),
        _ => None,
    }
}

fn joint4_calibration_service_command(
    profile: &ConnectionProfile,
    action: &str,
) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    let service = joint4_calibration_service(action).ok_or("不支持的 joint4 标定操作")?;
    Ok(format!(
        "bash -lc 'source /opt/ros/humble/setup.bash; \
         if [ -f \"{}\" ]; then source \"{}\"; fi; \
         ROS_DOMAIN_ID={} timeout 10 ros2 service call {} std_srvs/srv/Trigger \"{{}}\" 2>&1'",
        profile.ros_setup_script, profile.ros_setup_script, profile.ros_domain_id, service,
    ))
}

fn parse_trigger_service_response(output: &str) -> Result<TriggerServiceResponse, String> {
    let success = if output.contains("success=True") || output.contains("success: true") {
        true
    } else if output.contains("success=False") || output.contains("success: false") {
        false
    } else {
        return Err("无法解析 Trigger 服务响应".into());
    };
    let message = ["message='", "message=\"", "message: '", "message: \""]
        .iter()
        .find_map(|marker| {
            let start = output.rfind(marker)? + marker.len();
            let quote = marker.chars().last()?;
            let rest = &output[start..];
            let end = rest.rfind(quote)?;
            Some(rest[..end].replace("\\'", "'").replace("\\\"", "\""))
        })
        .unwrap_or_else(|| {
            output
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("Trigger 服务已返回")
                .trim()
                .to_string()
        });
    Ok(TriggerServiceResponse { success, message })
}

fn validate_calibration_report(path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("标定报告必须保存到绝对路径".into());
    }
    let extension = path.extension().and_then(|value| value.to_str());
    if !matches!(extension, Some("json" | "csv")) {
        return Err("标定报告只支持 .json 或 .csv".into());
    }
    if content.is_empty() || content.len() > 1_048_576 {
        return Err("标定报告内容为空或超过 1 MiB".into());
    }
    Ok(())
}

fn validate_diagnostics_snapshot(path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("诊断快照必须保存到绝对路径".into());
    }
    if path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("诊断快照只支持 .json".into());
    }
    if content.is_empty() || content.len() > 5 * 1_048_576 {
        return Err("诊断快照内容为空或超过 5 MiB".into());
    }
    Ok(())
}

fn rosbag_remote_command(profile: &ConnectionProfile, action: &str) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    let setup = format!(
        "source /opt/ros/humble/setup.bash; if [ -f \"{}\" ]; then source \"{}\"; fi; ",
        profile.ros_setup_script, profile.ros_setup_script,
    );
    let paths = "mkdir -p \"$HOME/.cache/robot-console\" \"$HOME/robot-console-bags\"; \
                 pid_file=\"$HOME/.cache/robot-console/rosbag.pid\"; \
                 path_file=\"$HOME/.cache/robot-console/rosbag.path\"; ";
    let alive = "pid=$(cat \"$pid_file\" 2>/dev/null || true); \
                 case \"$pid\" in *[!0-9]*|\"\") alive=0 ;; \
                 *) if kill -0 \"$pid\" 2>/dev/null && ps -p \"$pid\" -o args= | grep -Fq \"ros2 bag record\"; then alive=1; else alive=0; fi ;; esac; ";
    let body = match action {
        "status" => format!(
            "{paths}{alive}output=$(cat \"$path_file\" 2>/dev/null || true); \
             if [ \"$alive\" = 1 ]; then printf \"RECORDING|%s|%s\\n\" \"$pid\" \"$output\"; \
             else printf \"IDLE|0|%s\\n\" \"$output\"; fi"
        ),
        "start" => format!(
            "{setup}{paths}{alive}output=$(cat \"$path_file\" 2>/dev/null || true); \
             if [ \"$alive\" = 1 ]; then printf \"RECORDING|%s|%s\\n\" \"$pid\" \"$output\"; exit 0; fi; \
             output=\"$HOME/robot-console-bags/robot-console-$(date +%Y%m%d-%H%M%S)\"; \
             ROS_DOMAIN_ID={} nohup ros2 bag record -a -o \"$output\" \
             >\"$HOME/.cache/robot-console/rosbag.log\" 2>&1 </dev/null & pid=$!; \
             printf \"%s\\n\" \"$pid\" >\"$pid_file\"; printf \"%s\\n\" \"$output\" >\"$path_file\"; sleep 1; \
             if ! kill -0 \"$pid\" 2>/dev/null; then cat \"$HOME/.cache/robot-console/rosbag.log\" >&2; exit 1; fi; \
             printf \"STARTED|%s|%s\\n\" \"$pid\" \"$output\"",
            profile.ros_domain_id,
        ),
        "stop" => format!(
            "{paths}{alive}output=$(cat \"$path_file\" 2>/dev/null || true); \
             if [ \"$alive\" != 1 ]; then rm -f \"$pid_file\"; printf \"IDLE|0|%s\\n\" \"$output\"; exit 0; fi; \
             kill -INT \"$pid\"; \
             for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
               if ! kill -0 \"$pid\" 2>/dev/null; then break; fi; sleep 0.25; \
             done; \
             if kill -0 \"$pid\" 2>/dev/null; then kill -TERM \"$pid\" 2>/dev/null || true; fi; \
             rm -f \"$pid_file\"; printf \"STOPPED|0|%s\\n\" \"$output\""
        ),
        _ => return Err("不支持的 rosbag 操作".into()),
    };
    Ok(format!("bash -lc '{body}'"))
}

fn parse_rosbag_status(output: &str) -> Result<RosbagStatus, String> {
    let line = output
        .lines()
        .rev()
        .find(|line| {
            ["STARTED|", "RECORDING|", "STOPPED|", "IDLE|"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        })
        .ok_or("无法解析 rosbag 状态")?;
    let mut fields = line.splitn(3, '|');
    let state = fields.next().unwrap_or_default();
    let pid = fields
        .next()
        .unwrap_or_default()
        .parse::<u32>()
        .unwrap_or_default();
    let output_path = fields.next().unwrap_or_default().to_string();
    let recording = matches!(state, "STARTED" | "RECORDING");
    Ok(RosbagStatus {
        recording,
        pid: if recording { pid } else { 0 },
        output_path,
        message: match state {
            "STARTED" => "rosbag 录制已开始",
            "RECORDING" => "rosbag 正在录制",
            "STOPPED" => "rosbag 录制已停止",
            _ => "rosbag 当前未录制",
        }
        .into(),
    })
}

fn rosbag_play_remote_command(
    profile: &ConnectionProfile,
    action: &str,
    bag_path: &str,
) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    if action != "status" && action != "stop" {
        if bag_path.is_empty() || !is_safe_setup_script(bag_path) {
            return Err("bag 路径包含不允许的字符".into());
        }
    } else if !bag_path.is_empty() && !is_safe_setup_script(bag_path) {
        return Err("bag 路径包含不允许的字符".into());
    }
    let setup = format!(
        "source /opt/ros/humble/setup.bash; if [ -f \"{}\" ]; then source \"{}\"; fi; ",
        profile.ros_setup_script, profile.ros_setup_script,
    );
    let paths = "mkdir -p \"$HOME/.cache/robot-console\";                  pid_file=\"$HOME/.cache/robot-console/rosbag-play.pid\";                  path_file=\"$HOME/.cache/robot-console/rosbag-play.path\"; ";
    let alive = "pid=$(cat \"$pid_file\" 2>/dev/null || true);                  case \"$pid\" in *[!0-9]*|\"\") alive=0 ;;                  *) if kill -0 \"$pid\" 2>/dev/null && ps -p \"$pid\" -o args= | grep -Fq \"ros2 bag play\"; then alive=1; else alive=0; fi ;; esac; ";
    let body = match action {
        "status" => format!(
            "{paths}{alive}bag=$(cat \"$path_file\" 2>/dev/null || true);              if [ \"$alive\" = 1 ]; then printf \"PLAYING|%s|%s\\n\" \"$pid\" \"$bag\";              else printf \"IDLE|0|%s\\n\" \"$bag\"; fi"
        ),
        "start" => format!(
            "{setup}{paths}{alive}bag=$(cat \"$path_file\" 2>/dev/null || true);              if [ \"$alive\" = 1 ]; then printf \"PLAYING|%s|%s\\n\" \"$pid\" \"$bag\"; exit 0; fi;              bag=\"{bag_path}\";              if [ ! -e \"$bag\" ]; then echo \"bag path not found: $bag\" >&2; exit 1; fi;              ROS_DOMAIN_ID={domain} nohup ros2 bag play \"$bag\" --clock              >\"$HOME/.cache/robot-console/rosbag-play.log\" 2>&1 </dev/null & pid=$!;              printf \"%s\\n\" \"$pid\" >\"$pid_file\"; printf \"%s\\n\" \"$bag\" >\"$path_file\"; sleep 1;              if ! kill -0 \"$pid\" 2>/dev/null; then cat \"$HOME/.cache/robot-console/rosbag-play.log\" >&2; exit 1; fi;              printf \"STARTED|%s|%s\\n\" \"$pid\" \"$bag\"",
            bag_path = bag_path,
            domain = profile.ros_domain_id,
        ),
        "stop" => format!(
            "{paths}{alive}bag=$(cat \"$path_file\" 2>/dev/null || true);              if [ \"$alive\" != 1 ]; then rm -f \"$pid_file\"; printf \"IDLE|0|%s\\n\" \"$bag\"; exit 0; fi;              kill -INT \"$pid\";              for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do                if ! kill -0 \"$pid\" 2>/dev/null; then break; fi; sleep 0.25;              done;              if kill -0 \"$pid\" 2>/dev/null; then kill -TERM \"$pid\" 2>/dev/null || true; fi;              rm -f \"$pid_file\"; printf \"STOPPED|0|%s\\n\" \"$bag\""
        ),
        _ => return Err("不支持的 rosbag 回放操作".into()),
    };
    Ok(format!("bash -lc '{body}'"))
}

fn parse_rosbag_play_status(output: &str) -> Result<RosbagPlayStatus, String> {
    let line = output
        .lines()
        .rev()
        .find(|line| {
            ["STARTED|", "PLAYING|", "STOPPED|", "IDLE|"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        })
        .ok_or("无法解析 rosbag 回放状态")?;
    let mut fields = line.splitn(3, '|');
    let state = fields.next().unwrap_or_default();
    let pid = fields
        .next()
        .unwrap_or_default()
        .parse::<u32>()
        .unwrap_or_default();
    let bag_path = fields.next().unwrap_or_default().to_string();
    let playing = matches!(state, "STARTED" | "PLAYING");
    Ok(RosbagPlayStatus {
        playing,
        pid: if playing { pid } else { 0 },
        bag_path,
        message: match state {
            "STARTED" => "rosbag 回放已开始",
            "PLAYING" => "rosbag 正在回放",
            "STOPPED" => "rosbag 回放已停止",
            _ => "rosbag 当前未回放",
        }
        .into(),
    })
}

fn parse_agent_status(output: &str) -> AgentServiceStatus {
    let mut status = AgentServiceStatus::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
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


const MCU_VID_PID: &str = "0483:5740";
const AGENT_SERVICE: &str = "micro-ros-agent-stm32h723.service";

fn usb_probe_remote_command() -> String {
    "bash -lc 'lsusb 2>&1; echo __USB_SEP__; \
     ls -1 /dev/serial/by-id/ 2>/dev/null || true; echo __BYID_SEP__; \
     ls -1 /dev/ttyACM* 2>/dev/null || true'".into()
}

fn parse_usb_probe(output: &str) -> UsbProbeStatus {
    let mut parts = output.split("__USB_SEP__");
    let lsusb = parts.next().unwrap_or("").trim().to_string();
    let rest = parts.next().unwrap_or("");
    let mut byid_parts = rest.split("__BYID_SEP__");
    let byid = byid_parts.next().unwrap_or("").trim().to_string();
    let ttyacm = byid_parts.next().unwrap_or("").trim().to_string();

    let mcu_present = lsusb.to_ascii_lowercase().contains("0483:5740");
    let mut realsense_lines = Vec::new();
    for line in lsusb.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("8086:") {
            realsense_lines.push(line.trim().to_string());
        }
    }
    let realsense_present = !realsense_lines.is_empty();

    let mut serial_path = None;
    for line in byid.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if lower.contains("stm") || lower.contains("cdc") || lower.contains("0483") {
            serial_path = Some(format!("/dev/serial/by-id/{name}"));
            break;
        }
    }
    if serial_path.is_none() {
        if let Some(name) = byid.lines().map(str::trim).find(|line| !line.is_empty()) {
            serial_path = Some(format!("/dev/serial/by-id/{name}"));
        }
    }
    if serial_path.is_none() {
        if let Some(path) = ttyacm
            .lines()
            .map(str::trim)
            .find(|line| line.starts_with("/dev/ttyACM"))
        {
            serial_path = Some(path.to_string());
        }
    }

    let raw_snippet = lsusb.lines().take(8).collect::<Vec<_>>().join("\n");

    UsbProbeStatus {
        mcu_present,
        mcu_vid_pid: if mcu_present {
            MCU_VID_PID.into()
        } else {
            String::new()
        },
        serial_path: if mcu_present { serial_path } else { None },
        realsense_present,
        realsense_lines,
        raw_lsusb: raw_snippet,
        error: None,
    }
}

fn arm_mode_remote_command(profile: &ConnectionProfile, mode: &str) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    let setup = format!(
        "source /opt/ros/humble/setup.bash 2>/dev/null || true; \
         ws=\"${{LEADER_FOLLOWER_WS:-$HOME/Project/rebotarm-ros2-stack}}\"; \
         if [ -f \"$ws/install/setup.bash\" ]; then source \"$ws/install/setup.bash\"; \
         elif [ -f \"{setup_script}\" ]; then source \"{setup_script}\"; fi; \
         ROS_DOMAIN_ID={domain}; ",
        setup_script = profile.ros_setup_script,
        domain = profile.ros_domain_id,
    );
    let paths = "mkdir -p \"$HOME/.cache/robot-console\"; \
                 teleop_pid_file=\"$HOME/.cache/robot-console/arm-teleop.pid\"; \
                 traj_pid_file=\"$HOME/.cache/robot-console/arm-trajectory.pid\"; \
                 rs_pid_file=\"$HOME/.cache/robot-console/arm-realsense.pid\"; ";
    let alive_fn = "alive_pid() { p=\"$1\"; marker=\"$2\"; case \"$p\" in *[!0-9]*|\"\") echo 0; return; esac; \
                    if kill -0 \"$p\" 2>/dev/null; then \
                      if [ -z \"$marker\" ] || ps -p \"$p\" -o args= | grep -Fq \"$marker\"; then echo 1; return; fi; \
                    fi; echo 0; }; ";
    let stop_fn = "stop_pg() { file=\"$1\"; marker=\"$2\"; pid=$(cat \"$file\" 2>/dev/null || true); \
                   if [ \"$(alive_pid \"$pid\" \"$marker\")\" = 1 ]; then \
                     kill -INT -\"$pid\" 2>/dev/null || kill -INT \"$pid\" 2>/dev/null || true; \
                     for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
                       if [ \"$(alive_pid \"$pid\" \"$marker\")\" != 1 ]; then break; fi; sleep 0.25; \
                     done; \
                     if [ \"$(alive_pid \"$pid\" \"$marker\")\" = 1 ]; then kill -TERM -\"$pid\" 2>/dev/null || kill -TERM \"$pid\" 2>/dev/null || true; fi; \
                   fi; rm -f \"$file\"; }; ";
    let status_body = format!(
        "{paths}{alive_fn}\
         tpid=$(cat \"$teleop_pid_file\" 2>/dev/null || true); \
         jpid=$(cat \"$traj_pid_file\" 2>/dev/null || true); \
         rpid=$(cat \"$rs_pid_file\" 2>/dev/null || true); \
         talive=$(alive_pid \"$tpid\" \"start_arm_teleop\"); \
         jalive=$(alive_pid \"$jpid\" \"\"); \
         ralive=$(alive_pid \"$rpid\" \"realsense\"); \
         nodes=$(timeout 5 ros2 node list 2>/dev/null || true); \
         echo \"$nodes\" | grep -Eqi \"teleop|leader_follower\" && talive=1; \
         echo \"$nodes\" | grep -Eqi \"move_group\" && jalive=1; \
         echo \"$nodes\" | grep -Eqi \"realsense|camera/camera\" && ralive=1; \
         mode=idle; \
         if [ \"$talive\" = 1 ]; then mode=teleop; elif [ \"$jalive\" = 1 ]; then mode=trajectory; elif [ \"$ralive\" = 1 ]; then mode=realsense; fi; \
         printf \"ARM|%s|%s|%s|%s|%s|%s|%s\\n\" \"$mode\" \"$talive\" \"$jalive\" \"$ralive\" \
           \"${{tpid:-0}}\" \"${{jpid:-0}}\" \"${{rpid:-0}}\""
    );
    let body = match mode {
        "status" => format!("{setup}{status_body}"),
        "stop" => format!(
            "{paths}{alive_fn}{stop_fn}\
             stop_pg \"$teleop_pid_file\" \"start_arm_teleop\"; \
             stop_pg \"$traj_pid_file\" \"\"; \
             printf \"OK|0|stopped\\n\""
        ),
        "teleop" => format!(
            "{setup}{paths}{alive_fn}{stop_fn}\
             stop_pg \"$traj_pid_file\" \"\"; \
             stop_pg \"$teleop_pid_file\" \"start_arm_teleop\"; \
             if [ ! -f \"$ws/scripts/start_arm_teleop.sh\" ]; then echo \"missing $ws/scripts/start_arm_teleop.sh\" >&2; exit 1; fi; \
             setsid nohup bash \"$ws/scripts/start_arm_teleop.sh\" --position-controller=teleop \
               >\"$HOME/.cache/robot-console/arm-teleop.log\" 2>&1 </dev/null & pid=$!; \
             printf \"%s\\n\" \"$pid\" >\"$teleop_pid_file\"; sleep 1; \
             if [ \"$(alive_pid \"$pid\" \"\")\" != 1 ]; then cat \"$HOME/.cache/robot-console/arm-teleop.log\" >&2; exit 1; fi; \
             printf \"OK|%s|teleop\\n\" \"$pid\""
        ),
        "trajectory" => format!(
            "{setup}{paths}{alive_fn}{stop_fn}\
             stop_pg \"$teleop_pid_file\" \"start_arm_teleop\"; \
             stop_pg \"$traj_pid_file\" \"\"; \
             if [ -f \"$ws/scripts/start_arm_teleop.sh\" ]; then \
               setsid nohup bash \"$ws/scripts/start_arm_teleop.sh\" --position-controller=trajectory \
                 >\"$HOME/.cache/robot-console/arm-trajectory.log\" 2>&1 </dev/null & pid=$!; \
             else \
               setsid nohup ros2 launch rebotarm_moveit_config move_group.launch.py \
                 >\"$HOME/.cache/robot-console/arm-trajectory.log\" 2>&1 </dev/null & pid=$!; \
             fi; \
             printf \"%s\\n\" \"$pid\" >\"$traj_pid_file\"; sleep 1; \
             if [ \"$(alive_pid \"$pid\" \"\")\" != 1 ]; then cat \"$HOME/.cache/robot-console/arm-trajectory.log\" >&2; exit 1; fi; \
             printf \"OK|%s|trajectory\\n\" \"$pid\""
        ),
        "realsense" => format!(
            "{setup}{paths}{alive_fn}{stop_fn}\
             stop_pg \"$rs_pid_file\" \"realsense\"; \
             setsid nohup ros2 launch realsense2_camera rs_launch.py \
               >\"$HOME/.cache/robot-console/arm-realsense.log\" 2>&1 </dev/null & pid=$!; \
             printf \"%s\\n\" \"$pid\" >\"$rs_pid_file\"; sleep 1; \
             if [ \"$(alive_pid \"$pid\" \"\")\" != 1 ]; then cat \"$HOME/.cache/robot-console/arm-realsense.log\" >&2; exit 1; fi; \
             printf \"OK|%s|realsense\\n\" \"$pid\""
        ),
        _ => return Err("不支持的 arm mode 操作".into()),
    };
    Ok(format!("bash -lc '{body}'"))
}

fn parse_arm_mode_status(output: &str) -> Result<ArmModeStatus, String> {
    let line = output
        .lines()
        .rev()
        .find(|line| line.starts_with("ARM|"))
        .ok_or("无法解析 arm mode 状态")?;
    let fields: Vec<_> = line.trim_start_matches("ARM|").split('|').collect();
    if fields.len() < 7 {
        return Err("arm mode 状态字段不足".into());
    }
    let mode = fields[0].to_string();
    let teleop_running = fields[1] == "1";
    let trajectory_running = fields[2] == "1";
    let realsense_running = fields[3] == "1";
    let teleop_pid = fields[4].parse().unwrap_or_default();
    let trajectory_pid = fields[5].parse().unwrap_or_default();
    let realsense_pid = fields[6].parse().unwrap_or_default();
    Ok(ArmModeStatus {
        mode,
        teleop_running,
        trajectory_running,
        realsense_running,
        teleop_pid: if teleop_running { teleop_pid } else { 0 },
        trajectory_pid: if trajectory_running {
            trajectory_pid
        } else {
            0
        },
        realsense_pid: if realsense_running { realsense_pid } else { 0 },
        message: "arm mode 状态已刷新".into(),
    })
}

fn parse_remote_action_ok(output: &str) -> Option<(u32, String)> {
    let line = output.lines().rev().find(|line| line.starts_with("OK|"))?;
    let mut fields = line.trim_start_matches("OK|").splitn(2, '|');
    let pid = fields.next()?.parse().unwrap_or_default();
    let label = fields.next().unwrap_or("").to_string();
    Some((pid, label))
}

fn restart_agent_remote_command() -> String {
    format!(
        "bash -lc 'systemctl restart {AGENT_SERVICE}; code=$?; \
         if [ $code -ne 0 ]; then \
           systemctl status {AGENT_SERVICE} --no-pager -l 2>&1 | tail -n 30; \
           journalctl -u {AGENT_SERVICE} -n 20 --no-pager 2>&1 | tail -n 20; \
           exit $code; \
         fi; \
         systemctl show {AGENT_SERVICE} --no-page --property=ActiveState,SubState,MainPID; \
         printf \"OK|0|restarted\\n\"'"
    )
}

fn stderr_tail(stderr: &str, stdout: &str) -> String {
    let combined = format!("{stdout}\n{stderr}");
    combined
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
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
        profile.ros_setup_script, profile.ros_setup_script, profile.ros_domain_id, MANAGER
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
        return Err(format!(
            "Controller 操作失败：{}",
            ros_control_error(&combined)
        ));
    }
    Ok(stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| strip_ansi(line.trim()))
        .unwrap_or_else(|| format!("Controller {controller_name} {action} 完成")))
}

#[tauri::command]
async fn call_joint4_calibration_service(
    profile: ConnectionProfile,
    action: String,
) -> Result<TriggerServiceResponse, String> {
    let remote = joint4_calibration_service_command(&profile, &action)?;
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法执行 joint4 标定服务调用：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "joint4 标定服务调用失败：{}",
            ros_control_error(&format!("{stdout}\n{stderr}"))
        ));
    }
    parse_trigger_service_response(&stdout)
}

#[tauri::command]
fn save_joint4_calibration_report(local_path: String, content: String) -> Result<(), String> {
    validate_calibration_report(&local_path, &content)?;
    std::fs::write(&local_path, content).map_err(|error| format!("标定报告保存失败：{error}"))
}

#[tauri::command]
fn save_diagnostics_snapshot(local_path: String, content: String) -> Result<(), String> {
    validate_diagnostics_snapshot(&local_path, &content)?;
    std::fs::write(&local_path, content).map_err(|error| format!("诊断快照保存失败：{error}"))
}

async fn run_rosbag_action(
    profile: ConnectionProfile,
    action: &str,
) -> Result<RosbagStatus, String> {
    let remote = rosbag_remote_command(&profile, action)?;
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法执行 rosbag 操作：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "rosbag 操作失败：{}",
            stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("远端命令失败")
        ));
    }
    parse_rosbag_status(&stdout)
}

#[tauri::command]
async fn get_rosbag_status(profile: ConnectionProfile) -> Result<RosbagStatus, String> {
    run_rosbag_action(profile, "status").await
}

#[tauri::command]
async fn start_rosbag_recording(profile: ConnectionProfile) -> Result<RosbagStatus, String> {
    run_rosbag_action(profile, "start").await
}

#[tauri::command]
async fn stop_rosbag_recording(profile: ConnectionProfile) -> Result<RosbagStatus, String> {
    run_rosbag_action(profile, "stop").await
}

async fn run_rosbag_play_action(
    profile: ConnectionProfile,
    action: &str,
    bag_path: &str,
) -> Result<RosbagPlayStatus, String> {
    let remote = rosbag_play_remote_command(&profile, action, bag_path)?;
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法执行 rosbag 回放：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "rosbag 回放失败：{}",
            stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("远端命令失败")
        ));
    }
    parse_rosbag_play_status(&stdout)
}

#[tauri::command]
async fn get_rosbag_play_status(profile: ConnectionProfile) -> Result<RosbagPlayStatus, String> {
    run_rosbag_play_action(profile, "status", "").await
}

#[tauri::command]
async fn start_rosbag_playback(
    profile: ConnectionProfile,
    bag_path: String,
) -> Result<RosbagPlayStatus, String> {
    run_rosbag_play_action(profile, "start", &bag_path).await
}

#[tauri::command]
async fn stop_rosbag_playback(profile: ConnectionProfile) -> Result<RosbagPlayStatus, String> {
    run_rosbag_play_action(profile, "stop", "").await
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


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployBridgeResult {
    ok: bool,
    log: String,
    message: String,
}

fn find_project_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("REBOTARM_DEBUG_DESK_ROOT") {
        let path = PathBuf::from(root);
        if looks_like_project_root(&path) {
            return Ok(path);
        }
        return Err(format!(
            "REBOTARM_DEBUG_DESK_ROOT 不是有效仓库根目录：{}",
            path.display()
        ));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));

    for start in candidates {
        let mut current = start;
        for _ in 0..10 {
            if looks_like_project_root(&current) {
                return Ok(current
                    .canonicalize()
                    .unwrap_or(current));
            }
            if !current.pop() {
                break;
            }
        }
    }
    Err(
        "找不到仓库根目录（需含 scripts/deploy-bridge.mjs 与 bridge/easy_debug_bridge）。请在仓库内运行，或设置 REBOTARM_DEBUG_DESK_ROOT。"
            .into(),
    )
}

fn looks_like_project_root(path: &Path) -> bool {
    path.join("scripts/deploy-bridge.mjs").is_file()
        && path
            .join("bridge/easy_debug_bridge/package.xml")
            .is_file()
}

fn node_binary() -> String {
    std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".into())
}

fn deploy_bridge_args(profile: &ConnectionProfile) -> Result<Vec<String>, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径包含不允许的字符".into());
    }
    let host = ssh_target(profile);
    if host.trim().is_empty() || host.starts_with('-') {
        return Err("SSH 主机无效".into());
    }
    let mut args = vec![
        "scripts/deploy-bridge.mjs".into(),
        "--host".into(),
        host,
        "--port".into(),
        profile.remote_port.to_string(),
        "--ros-domain-id".into(),
        profile.ros_domain_id.to_string(),
        "--ros-setup".into(),
        profile.ros_setup_script.clone(),
        "--restart".into(),
    ];
    if profile.ssh_port != 0 {
        args.push("--ssh-port".into());
        args.push(profile.ssh_port.to_string());
    }
    if !profile.identity_file.trim().is_empty() {
        let identity = profile.identity_file.trim();
        if identity.starts_with('-')
            || identity.chars().any(|c| " \t\n;|&$`'\\\"<>()".contains(c))
        {
            return Err("私钥路径包含不允许的字符".into());
        }
        args.push("--identity-file".into());
        args.push(identity.to_string());
    }
    Ok(args)
}

#[tauri::command]
async fn deploy_bridge(
    app: AppHandle,
    profile: ConnectionProfile,
) -> Result<DeployBridgeResult, String> {
    let root = find_project_root()?;
    let args = deploy_bridge_args(&profile)?;
    let script = root.join(&args[0]);
    if !script.is_file() {
        return Err(format!("找不到部署脚本：{}", script.display()));
    }

    let _ = app.emit(
        "bridge-deploy-progress",
        format!("开始升级 Bridge（host={}）…", ssh_target(&profile)),
    );

    let mut child = Command::new(node_binary())
        .args(&args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "无法启动 node 部署脚本（确认 PATH 中有 node，或设置 NODE_BINARY）：{error}"
            )
        })?;

    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = Vec::new();
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_out.emit("bridge-deploy-progress", line.clone());
                lines.push(line);
            }
        }
        lines
    });
    let app_err = app.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = Vec::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_err.emit("bridge-deploy-progress", line.clone());
                lines.push(line);
            }
        }
        lines
    });

    let status = child
        .wait()
        .await
        .map_err(|error| format!("等待部署进程失败：{error}"))?;
    let out_lines = out_task.await.unwrap_or_default();
    let err_lines = err_task.await.unwrap_or_default();
    let mut log = String::new();
    if !out_lines.is_empty() {
        log.push_str(&out_lines.join("\n"));
    }
    if !err_lines.is_empty() {
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str(&err_lines.join("\n"));
    }

    if !status.success() {
        let detail = if log.trim().is_empty() {
            format!("exit {status}")
        } else {
            log.trim().to_string()
        };
        return Err(format!("Bridge 升级失败：{detail}"));
    }

    let _ = app.emit("bridge-deploy-progress", "Bridge 升级完成".to_string());
    Ok(DeployBridgeResult {
        ok: true,
        log,
        message: "Bridge 已同步、编译并重启".into(),
    })
}


#[tauri::command]
async fn probe_jetson_usb(profile: ConnectionProfile) -> Result<UsbProbeStatus, String> {
    let remote = usb_probe_remote_command();
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法探测 Jetson USB：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() && stdout.trim().is_empty() {
        return Ok(UsbProbeStatus {
            mcu_present: false,
            mcu_vid_pid: String::new(),
            serial_path: None,
            realsense_present: false,
            realsense_lines: Vec::new(),
            raw_lsusb: String::new(),
            error: Some(format!(
                "SSH/lsusb 失败：{}",
                stderr_tail(&stderr, &stdout)
            )),
        });
    }
    Ok(parse_usb_probe(&stdout))
}

#[tauri::command]
async fn restart_micro_ros_agent(profile: ConnectionProfile) -> Result<RemoteActionResult, String> {
    let remote = restart_agent_remote_command();
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法重启 micro-ROS Agent：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit_code = output.status.code().unwrap_or(1);
    if !output.status.success() {
        return Ok(RemoteActionResult {
            ok: false,
            exit_code,
            message: "micro-ROS Agent 重启失败".into(),
            detail: stderr_tail(&stderr, &stdout),
        });
    }
    Ok(RemoteActionResult {
        ok: true,
        exit_code: 0,
        message: "micro-ROS Agent 已重启".into(),
        detail: stderr_tail(&stderr, &stdout),
    })
}

#[tauri::command]
async fn probe_arm_mode(profile: ConnectionProfile) -> Result<ArmModeStatus, String> {
    let remote = arm_mode_remote_command(&profile, "status")?;
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法探测 arm mode：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "arm mode 探测失败：{}",
            stderr_tail(&stderr, &stdout)
        ));
    }
    parse_arm_mode_status(&stdout)
}

#[tauri::command]
async fn start_arm_mode(profile: ConnectionProfile, mode: String) -> Result<RemoteActionResult, String> {
    let remote = arm_mode_remote_command(&profile, &mode)?;
    let output = ssh_base(&profile)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(ssh_target(&profile))
        .arg(remote)
        .output()
        .await
        .map_err(|error| format!("无法执行 arm mode：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit_code = output.status.code().unwrap_or(1);
    if !output.status.success() {
        return Ok(RemoteActionResult {
            ok: false,
            exit_code,
            message: format!("arm mode `{mode}` 失败"),
            detail: stderr_tail(&stderr, &stdout),
        });
    }
    let (pid, label) = parse_remote_action_ok(&stdout).unwrap_or((0, mode.clone()));
    Ok(RemoteActionResult {
        ok: true,
        exit_code: 0,
        message: if mode == "stop" {
            "Teleop/Trajectory 已停止".into()
        } else {
            format!("{label} 已启动 (pid {pid})")
        },
        detail: stderr_tail(&stderr, &stdout),
    })
}


#[tauri::command]
async fn stop_session(state: State<'_, SessionState>) -> Result<(), String> {
    stop_tunnel(&state).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .invoke_handler(tauri::generate_handler![
            check_ssh,
            check_micro_ros_agent,
            probe_jetson_usb,
            restart_micro_ros_agent,
            probe_arm_mode,
            start_arm_mode,
            check_ros_controllers,
            switch_ros_controller,
            call_joint4_calibration_service,
            save_joint4_calibration_report,
            save_diagnostics_snapshot,
            get_rosbag_status,
            start_rosbag_recording,
            stop_rosbag_recording,
            get_rosbag_play_status,
            start_rosbag_playback,
            stop_rosbag_playback,
            start_session,
            stop_session,
            deploy_bridge
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Robot Console");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(username: &str) -> ConnectionProfile {
        ConnectionProfile {
            host: "jetson".into(),
            ssh_port: 22,
            username: username.into(),
            identity_file: String::new(),
            local_port: 18765,
            remote_port: 8765,
            ros_domain_id: 0,
            ros_setup_script: "/opt/robot/install/setup.bash".into(),
            joint_state_topic: "/stm32/joint_states".into(),
            command_topic: "/stm32/joint_commands".into(),
            status_topic: "/stm32/status".into(),
        }
    }

    #[test]
    fn builds_ssh_target_with_optional_username() {
        assert_eq!(ssh_target(&profile("")), "jetson");
        assert_eq!(ssh_target(&profile("robot")), "robot@jetson");
    }

    #[test]
    fn validates_setup_script_and_ros_topic_inputs() {
        assert!(is_safe_setup_script("/home/robot/ws_1/install/setup.bash"));
        assert!(!is_safe_setup_script("/tmp/setup.bash;reboot"));
        assert!(is_safe_setup_script("leader_follower/install/setup.bash"));
        assert!(!is_safe_setup_script(""));
        assert!(!is_safe_setup_script("/"));
        assert!(!is_safe_setup_script("~/ws/install/setup.bash"));
        assert!(!is_safe_setup_script("../ws/install/setup.bash"));
        assert!(!is_safe_setup_script("/opt/ws/../etc/setup.bash"));
        assert!(!is_safe_setup_script("ws/./install/setup.bash"));
        assert!(!is_safe_setup_script("ws//install/setup.bash"));
        assert!(!is_safe_setup_script("-rf/setup.bash"));
        assert!(!is_safe_setup_script("ws/install/setup.bash\"$(reboot)"));
        assert!(valid_topic("/stm32/joint_commands"));
        assert!(!valid_topic("stm32/joint_commands"));
        assert!(!valid_topic("/stm32/joint-commands"));
        assert!(valid_controller_name("/arm/trajectory_controller"));
        assert!(valid_controller_name("joint_state_broadcaster"));
        assert!(!valid_controller_name("arm-controller"));
        assert!(!valid_controller_name("arm;reboot"));
    }

    #[test]
    fn builds_safe_ros_controller_switch_commands() {
        let activate =
            controller_switch_command(&profile(""), "arm_controller", "activate").unwrap();
        assert!(activate.contains("switch_controllers --activate arm_controller --strict"));
        assert!(activate.contains("--strict --spin-time 1"));
        assert!(!activate.contains("--switch-timeout"));
        assert!(activate.contains("ROS_DOMAIN_ID=0"));
        assert!(activate.contains("-c /controller_manager"));
        let deactivate =
            controller_switch_command(&profile(""), "/arm/controller", "deactivate").unwrap();
        assert!(deactivate.contains("--deactivate /arm/controller"));
        assert!(controller_switch_command(&profile(""), "arm;reboot", "activate").is_err());
        assert!(controller_switch_command(&profile(""), "arm_controller", "restart").is_err());
    }

    #[test]
    fn restricts_and_parses_joint4_calibration_trigger_calls() {
        let command = joint4_calibration_service_command(&profile(""), "capture_pose").unwrap();
        assert!(command.contains("/joint4_calibration_controller/capture_pose"));
        assert!(command.contains("std_srvs/srv/Trigger"));
        assert!(command.contains("ROS_DOMAIN_ID=0"));
        assert!(joint4_calibration_service_command(&profile(""), "shell;reboot").is_err());

        assert_eq!(
            parse_trigger_service_response(
                "response:\nstd_srvs.srv.Trigger_Response(success=True, message='captured sample 4')\n",
            )
            .unwrap(),
            TriggerServiceResponse {
                success: true,
                message: "captured sample 4".into(),
            }
        );
        assert_eq!(
            parse_trigger_service_response("success: false\nmessage: 'pose is not stable'\n")
                .unwrap(),
            TriggerServiceResponse {
                success: false,
                message: "pose is not stable".into(),
            }
        );
        assert!(parse_trigger_service_response("service unavailable").is_err());
    }

    #[test]
    fn validates_joint4_calibration_report_paths_and_sizes() {
        assert!(validate_calibration_report("/tmp/joint4.json", "{}").is_ok());
        assert!(validate_calibration_report("/tmp/joint4.csv", "pose,q4").is_ok());
        assert!(validate_calibration_report("relative.json", "{}").is_err());
        assert!(validate_calibration_report("/tmp/joint4.yaml", "x").is_err());
        assert!(validate_calibration_report("/tmp/joint4.json", "").is_err());
    }

    #[test]
    fn validates_diagnostics_snapshot_paths_and_sizes() {
        assert!(validate_diagnostics_snapshot("/tmp/robot-diagnostics.json", "{}").is_ok());
        assert!(validate_diagnostics_snapshot("relative.json", "{}").is_err());
        assert!(validate_diagnostics_snapshot("/tmp/robot-diagnostics.txt", "{}").is_err());
        assert!(validate_diagnostics_snapshot("/tmp/robot-diagnostics.json", "").is_err());
    }

    #[test]
    fn builds_and_parses_rosbag_recording_commands() {
        let start = rosbag_remote_command(&profile(""), "start").unwrap();
        assert!(start.contains("ROS_DOMAIN_ID=0 nohup ros2 bag record -a"));
        assert!(start.contains("$HOME/robot-console-bags"));
        assert!(start.contains("rosbag.pid"));
        let stop = rosbag_remote_command(&profile(""), "stop").unwrap();
        assert!(stop.contains("kill -INT"));
        assert!(rosbag_remote_command(&profile(""), "delete").is_err());

        assert_eq!(
            parse_rosbag_status("noise\nSTARTED|42|/home/robot/robot-console-bags/run\n").unwrap(),
            RosbagStatus {
                recording: true,
                pid: 42,
                output_path: "/home/robot/robot-console-bags/run".into(),
                message: "rosbag 录制已开始".into(),
            }
        );
        assert_eq!(
            parse_rosbag_status("STOPPED|0|/home/robot/robot-console-bags/run\n").unwrap(),
            RosbagStatus {
                recording: false,
                pid: 0,
                output_path: "/home/robot/robot-console-bags/run".into(),
                message: "rosbag 录制已停止".into(),
            }
        );
        assert!(parse_rosbag_status("unexpected").is_err());
    }

    #[test]
    fn builds_and_parses_rosbag_playback_commands() {
        let start = rosbag_play_remote_command(
            &profile(""),
            "start",
            "robot-console-bags/robot-console-demo",
        )
        .unwrap();
        assert!(start.contains("ROS_DOMAIN_ID=0 nohup ros2 bag play"));
        assert!(start.contains("robot-console-bags/robot-console-demo"));
        assert!(start.contains("rosbag-play.pid"));
        assert!(start.contains("--clock"));
        let stop = rosbag_play_remote_command(&profile(""), "stop", "").unwrap();
        assert!(stop.contains("kill -INT"));
        assert!(rosbag_play_remote_command(&profile(""), "start", "bad;rm").is_err());
        assert!(rosbag_play_remote_command(&profile(""), "delete", "").is_err());

        assert_eq!(
            parse_rosbag_play_status(
                "noise\nSTARTED|9|/home/robot/robot-console-bags/run\n"
            )
            .unwrap(),
            RosbagPlayStatus {
                playing: true,
                pid: 9,
                bag_path: "/home/robot/robot-console-bags/run".into(),
                message: "rosbag 回放已开始".into(),
            }
        );
        assert_eq!(
            parse_rosbag_play_status("STOPPED|0|/home/robot/robot-console-bags/run\n").unwrap(),
            RosbagPlayStatus {
                playing: false,
                pid: 0,
                bag_path: "/home/robot/robot-console-bags/run".into(),
                message: "rosbag 回放已停止".into(),
            }
        );
        assert!(parse_rosbag_play_status("unexpected").is_err());
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
        assert_eq!(
            controllers,
            vec![
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
            ]
        );
    }

    #[test]
    fn ignores_ros_cli_logs_and_summarizes_manager_timeout() {
        assert!(parse_controllers("[INFO] waiting for service\n").is_empty());
        assert_eq!(
            ros_control_error(
                "[WARN] Could not contact service /controller_manager/list_controllers"
            ),
            "controller_manager 服务不可用或查询超时"
        );
    }

    #[test]
    fn keeps_free_port_and_falls_back_when_preferred_is_busy() {
        assert_eq!(
            choose_local_port_with(18765, |port| Ok(port)).unwrap(),
            18765
        );
        let mut probes = Vec::new();
        let fallback = choose_local_port_with(18765, |port| {
            probes.push(port);
            if port == 18765 {
                Err("busy".into())
            } else {
                Ok(23456)
            }
        })
        .unwrap();
        assert_eq!(probes, vec![18765, 0]);
        assert_eq!(fallback, 23456);
    }

    #[test]
    fn builds_deploy_bridge_args_from_connection_profile() {
        let mut p = profile("robot");
        p.ssh_port = 2222;
        p.identity_file = "/tmp/id_ed25519".into();
        p.remote_port = 8765;
        p.ros_domain_id = 3;
        let args = deploy_bridge_args(&p).unwrap();
        assert!(args.windows(2).any(|w| w == ["--host", "robot@jetson"]));
        assert!(args.windows(2).any(|w| w == ["--ssh-port", "2222"]));
        assert!(args.windows(2).any(|w| w == ["--identity-file", "/tmp/id_ed25519"]));
        assert!(args.windows(2).any(|w| w == ["--ros-domain-id", "3"]));
        assert!(args.iter().any(|a| a == "--restart"));
        assert!(deploy_bridge_args(&profile("")).is_ok());
        let mut bad = profile("");
        bad.identity_file = "bad;rm".into();
        assert!(deploy_bridge_args(&bad).is_err());
    }

    #[test]
    fn finds_repo_project_root_from_cargo_manifest() {
        let root = find_project_root().expect("project root");
        assert!(root.join("scripts/deploy-bridge.mjs").is_file());
        assert!(root.join("bridge/easy_debug_bridge/package.xml").is_file());
    }

    #[test]
    fn parses_usb_probe_for_mcu_and_realsense() {
        let sample = "Bus 001 Device 003: ID 0483:5740 STMicroelectronics Virtual COM Port\n\
Bus 001 Device 004: ID 8086:0b3a Intel Corp. Intel(R) RealSense(TM) Depth Camera 455\n\
__USB_SEP__\n\
usb-STMicroelectronics_STM32_STLink_ABC\n\
__BYID_SEP__\n\
/dev/ttyACM0\n";
        let parsed = parse_usb_probe(sample);
        assert!(parsed.mcu_present);
        assert_eq!(parsed.mcu_vid_pid, "0483:5740");
        assert!(parsed.realsense_present);
        assert!(parsed
            .serial_path
            .as_deref()
            .unwrap_or("")
            .contains("by-id"));
        assert!(parsed.error.is_none());
    }

    #[test]
    fn parses_usb_probe_missing_devices() {
        let parsed = parse_usb_probe("Bus 001 Device 001: ID 1d6b:0002 Linux Foundation\n__USB_SEP__\n__BYID_SEP__\n");
        assert!(!parsed.mcu_present);
        assert!(!parsed.realsense_present);
        assert!(parsed.serial_path.is_none());
    }

    #[test]
    fn builds_arm_mode_and_agent_restart_commands() {
        let teleop = arm_mode_remote_command(&profile(""), "teleop").unwrap();
        assert!(teleop.contains("start_arm_teleop.sh"));
        assert!(teleop.contains("rebotarm-ros2-stack"));
        assert!(teleop.contains("LEADER_FOLLOWER_WS"));
        assert!(teleop.contains("--position-controller=teleop"));
        assert!(teleop.contains("kill -INT"));
        let traj = arm_mode_remote_command(&profile(""), "trajectory").unwrap();
        assert!(traj.contains("trajectory") || traj.contains("move_group"));
        let stop = arm_mode_remote_command(&profile(""), "stop").unwrap();
        assert!(stop.contains("stop_pg"));
        assert!(arm_mode_remote_command(&profile(""), "delete").is_err());
        let bad = ConnectionProfile {
            ros_setup_script: "bad;rm".into(),
            ..profile("")
        };
        assert!(arm_mode_remote_command(&bad, "teleop").is_err());
        let agent = restart_agent_remote_command();
        assert!(agent.contains("systemctl restart micro-ros-agent-stm32h723.service"));
        assert!(!agent.to_ascii_lowercase().contains("flash"));
    }

    #[test]
    fn parses_arm_mode_status_line() {
        let status = parse_arm_mode_status("noise\nARM|teleop|1|0|0|42|0|0\n").unwrap();
        assert_eq!(status.mode, "teleop");
        assert!(status.teleop_running);
        assert!(!status.trajectory_running);
        assert_eq!(status.teleop_pid, 42);
        assert!(parse_arm_mode_status("unexpected").is_err());
    }

}
