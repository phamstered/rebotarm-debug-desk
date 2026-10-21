use super::{is_safe_setup_script, ssh_base, ssh_target, stderr_tail, ConnectionProfile};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const REMOTE_HELPER: &str = include_str!("collection_remote.py");
const RESULT_PREFIX: &str = "ROBOT_CONSOLE_COLLECTION=";
/// Per-topic timeout passed to Jetson `check_collection_ready.sh` (hard gate).
const COLLECTION_READY_TOPIC_TIMEOUT_SECS: u32 = 8;

#[derive(Default)]
pub struct CollectionState(AtomicBool);

struct OperationGuard<'a>(&'a AtomicBool);
impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionConfig {
    repo_id: String,
    root: String,
    task: String,
    fps: u32,
    wrist_image_topic: String,
    base_image_topic: String,
    state_topic: String,
    arm_command_topic: String,
    gripper_command_topic: String,
    python_path: String,
    resume: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStatus {
    state: CollectionPhase,
    managed: bool,
    pid: u32,
    recording: bool,
    pending_frames: u64,
    saved_episodes: u64,
    fps: u32,
    task: String,
    repo_id: String,
    root: String,
    message: String,
    log: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CollectionPhase {
    Stopped,
    Starting,
    Idle,
    Recording,
    Finalizing,
}

fn valid_collection_topic(topic: &str) -> bool {
    topic.len() <= 255
        && topic.starts_with('/')
        && topic[1..].split('/').all(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

fn validate_config(config: &CollectionConfig) -> Result<(), String> {
    let parts: Vec<_> = config.repo_id.split('/').collect();
    if parts.len() != 2
        || config.repo_id.len() > 255
        || !parts.iter().all(|part| {
            part.chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric())
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
    {
        return Err("数据集 ID 需为 namespace/dataset 格式".into());
    }
    if !is_safe_setup_script(&config.root) || !is_safe_setup_script(&config.python_path) {
        return Err("保存目录或 Python 路径无效（不支持空格、~ 或 ..）".into());
    }
    if config.task.trim().is_empty()
        || config.task.chars().count() > 2000
        || config
            .task
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err("任务描述需为 1–2000 字符".into());
    }
    if !(1..=120).contains(&config.fps) {
        return Err("采样频率需为 1–120 的整数".into());
    }
    for topic in [
        &config.wrist_image_topic,
        &config.state_topic,
        &config.arm_command_topic,
        &config.gripper_command_topic,
    ] {
        if !valid_collection_topic(topic) {
            return Err("采集 Topic 名称无效".into());
        }
    }
    if !config.base_image_topic.is_empty() && !valid_collection_topic(&config.base_image_topic) {
        return Err("固定相机 Topic 名称无效".into());
    }
    Ok(())
}

fn shell_word(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Workspace root hint from `…/install/setup.bash` (profile rosSetupScript).
/// Empty when the setup path does not end with that suffix.
fn collection_workspace_hint(ros_setup_script: &str) -> Option<String> {
    const SUFFIX: &str = "/install/setup.bash";
    let root = ros_setup_script.strip_suffix(SUFFIX)?;
    if root.is_empty() || !is_safe_setup_script(root) {
        return None;
    }
    Some(root.to_string())
}

/// SSH remote command that hard-runs stack `scripts/check_collection_ready.sh`
/// (no `--warn-only`). Workspace resolution mirrors arm teleop:
/// `LEADER_FOLLOWER_WS` → setup-script parent → `$HOME/Project/rebotarm-ros2-stack`.
fn check_collection_ready_remote_command(profile: &ConnectionProfile) -> Result<String, String> {
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径无效".into());
    }
    let domain = profile.ros_domain_id;
    let timeout_secs = COLLECTION_READY_TOPIC_TIMEOUT_SECS;
    let body = format!(
        "set -e; cd \"$HOME\"; \
setup_script={setup}; \
case \"$setup_script\" in /*) ;; *) setup_script=\"$HOME/$setup_script\";; esac; \
ws=\"${{LEADER_FOLLOWER_WS:-}}\"; \
if [ -z \"$ws\" ]; then \
  case \"$setup_script\" in */install/setup.bash) candidate=\"${{setup_script%/install/setup.bash}}\";; *) candidate=\"\";; esac; \
  if [ -n \"$candidate\" ] && [ -f \"$candidate/scripts/check_collection_ready.sh\" ]; then ws=\"$candidate\"; \
  elif [ -f \"$HOME/Project/rebotarm-ros2-stack/scripts/check_collection_ready.sh\" ]; then ws=\"$HOME/Project/rebotarm-ros2-stack\"; \
  elif [ -f \"$HOME/Project/leader_follower/scripts/check_collection_ready.sh\" ]; then ws=\"$HOME/Project/leader_follower\"; \
  else ws=\"${{candidate:-$HOME/Project/rebotarm-ros2-stack}}\"; fi; \
fi; \
script=\"$ws/scripts/check_collection_ready.sh\"; \
if [ ! -f \"$script\" ]; then echo \"missing $script（需要 rebotarm-ros2-stack 的 check_collection_ready.sh）\" >&2; exit 1; fi; \
export LEADER_FOLLOWER_WS=\"$ws\" ROS_DOMAIN_ID={domain}; \
bash \"$script\" --ros-domain-id={domain} --workspace=\"$ws\" --timeout={timeout}",
        setup = shell_word(&profile.ros_setup_script),
        domain = domain,
        timeout = timeout_secs,
    );
    Ok(format!("bash -lc {}", shell_word(&body)))
}

fn remote_command(
    profile: &ConnectionProfile,
    action: &str,
    config: Option<&CollectionConfig>,
) -> Result<String, String> {
    if ![
        "status",
        "launch",
        "start_episode",
        "save_episode",
        "discard_episode",
        "finish",
    ]
    .contains(&action)
    {
        return Err("不支持的采集操作".into());
    }
    if !is_safe_setup_script(&profile.ros_setup_script) {
        return Err("ROS 环境脚本路径无效".into());
    }
    if action == "launch" {
        validate_config(config.ok_or("缺少采集配置")?)?;
    } else if config.is_some() {
        return Err("此操作不接受启动配置".into());
    }
    let payload = serde_json::to_string(&config).map_err(|error| error.to_string())?;
    let body = format!(
        "set -e; cd \"$HOME\"; source /opt/ros/humble/setup.bash; source {}; export ROS_DOMAIN_ID={}; exec python3 -c {} {} {}",
        shell_word(&profile.ros_setup_script), profile.ros_domain_id, shell_word(REMOTE_HELPER), shell_word(action), shell_word(&payload),
    );
    Ok(format!("bash -lc {}", shell_word(&body)))
}

fn parse_result(stdout: &str) -> Result<CollectionStatus, String> {
    let line = stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(RESULT_PREFIX))
        .ok_or("采集命令未返回有效状态")?;
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|error| format!("采集响应格式无效：{error}"))?;
    if let Some(error) = value.get("error").and_then(|error| error.as_str()) {
        return Err(error.to_string());
    }
    serde_json::from_value(value).map_err(|error| format!("采集状态字段无效：{error}"))
}

fn ssh_output_command(profile: &ConnectionProfile, remote: String) -> Command {
    let mut command = ssh_base(profile);
    command
        .kill_on_drop(true)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("--")
        .arg(ssh_target(profile))
        .arg(remote);
    command
}

async fn run_collection_ready_gate(profile: &ConnectionProfile) -> Result<(), String> {
    let remote = check_collection_ready_remote_command(profile)?;
    let output = timeout(
        Duration::from_secs(u64::from(COLLECTION_READY_TOPIC_TIMEOUT_SECS) * 2 + 20),
        ssh_output_command(profile, remote).output(),
    )
    .await
    .map_err(|_| "采集就绪检查超时；请确认 Jetson 上 Agent /stm32 话题可用后重试")?
    .map_err(|error| format!("采集就绪检查 SSH 失败：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        return Ok(());
    }
    let detail = stderr_tail(&stderr, &stdout);
    Err(if detail.is_empty() {
        "采集就绪检查未通过（Jetson check_collection_ready.sh 退出非零）".into()
    } else {
        format!("采集就绪检查未通过：\n{detail}")
    })
}

#[tauri::command]
pub async fn data_collection_action(
    profile: ConnectionProfile,
    action: String,
    config: Option<CollectionConfig>,
    state: State<'_, CollectionState>,
) -> Result<CollectionStatus, String> {
    let remote = remote_command(&profile, &action, config.as_ref())?;
    state
        .0
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map_err(|_| "另一项采集操作正在执行")?;
    let _guard = OperationGuard(&state.0);
    if action == "launch" || action == "start_episode" {
        run_collection_ready_gate(&profile).await?;
    }
    let output = timeout(Duration::from_secs(150), ssh_output_command(&profile, remote).output())
        .await
        .map_err(|_| "采集操作超时；远端操作可能仍在执行，请刷新状态确认")?
        .map_err(|error| format!("采集 SSH 失败：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() && !stdout.lines().any(|line| line.starts_with(RESULT_PREFIX)) {
        return Err(format!(
            "采集 SSH/ROS 环境失败：{}",
            stderr_tail(&stderr, &stdout)
        ));
    }
    parse_result(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            host: "jetson".into(),
            username: "".into(),
            identity_file: "".into(),
            ssh_port: 22,
            local_port: 18765,
            remote_port: 8765,
            ros_domain_id: 7,
            ros_setup_script: "Project/rebotarm-ros2-stack/install/setup.bash".into(),
            joint_state_topic: "/stm32/joint_states".into(),
            command_topic: "/stm32/joint_commands".into(),
            status_topic: "/stm32/status".into(),
        }
    }

    fn config() -> CollectionConfig {
        CollectionConfig {
            repo_id: "robot/pick_cube".into(),
            root: "lerobot_datasets/pick_cube".into(),
            task: "pick red cube".into(),
            fps: 20,
            wrist_image_topic: "/camera/camera/color/image_raw".into(),
            base_image_topic: "".into(),
            state_topic: "/stm32/joint_states".into(),
            arm_command_topic: "/arm_teleop_controller/commands".into(),
            gripper_command_topic: "/gripper_teleop_controller/commands".into(),
            python_path: "venvs/lerobot/bin/python".into(),
            resume: false,
        }
    }

    #[test]
    fn validates_recorder_inputs_and_actions_before_ssh() {
        let profile = profile();
        let good = config();
        assert!(remote_command(&profile, "launch", Some(&good)).is_ok());
        assert!(remote_command(&profile, "launch", None).is_err());
        assert!(remote_command(&profile, "delete", None).is_err());
        assert!(remote_command(&profile, "status", Some(&good)).is_err());
        for value in ["../data", "~/data", "/tmp/data;bad", "-data", "/tmp//data"] {
            let mut bad = good.clone();
            bad.root = value.into();
            assert!(validate_config(&bad).is_err());
        }
        for value in ["/a//b", "/1bad", "relative", "/a;bad", "/"] {
            let mut bad = good.clone();
            bad.wrist_image_topic = value.into();
            assert!(validate_config(&bad).is_err());
        }
        let mut bad = good.clone();
        bad.repo_id = "invalid".into();
        assert!(validate_config(&bad).is_err());
        bad = good.clone();
        bad.fps = 0;
        assert!(validate_config(&bad).is_err());
        bad = good.clone();
        bad.task = "\0".into();
        assert!(validate_config(&bad).is_err());
        bad = good.clone();
        bad.python_path = "venv/../python".into();
        assert!(validate_config(&bad).is_err());
    }

    #[test]
    fn shell_words_preserve_task_text_without_executing_it() {
        let value = "抓取 'cube' \"red\" $(echo BAD) `echo BAD`\nnext line";
        let output = StdCommand::new("bash")
            .arg("-c")
            .arg(format!("printf %s {}", shell_word(value)))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
        let mut config = config();
        config.task = value.into();
        let remote = remote_command(&profile(), "launch", Some(&config)).unwrap();
        assert!(StdCommand::new("bash")
            .args(["-n", "-c", &remote])
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn parses_structured_results_with_logs_and_errors() {
        let result = parse_result("ROS log\nROBOT_CONSOLE_COLLECTION={\"state\":\"idle\",\"managed\":true,\"pid\":123,\"recording\":false,\"pendingFrames\":0,\"savedEpisodes\":2,\"fps\":20,\"task\":\"拾取\",\"repoId\":\"robot/demo\",\"root\":\"/data\",\"message\":\"ready\",\"log\":\"\"}\n").unwrap();
        assert_eq!(result.saved_episodes, 2);
        assert_eq!(result.task, "拾取");
        assert_eq!(
            parse_result("ROBOT_CONSOLE_COLLECTION={\"error\":\"service timeout\"}").unwrap_err(),
            "service timeout"
        );
        assert!(parse_result("unknown output").is_err());
        assert!(parse_result("ROBOT_CONSOLE_COLLECTION={\"state\":\"bad\"}").is_err());
    }

    #[test]
    fn collection_workspace_hint_from_setup_script() {
        assert_eq!(
            collection_workspace_hint("Project/rebotarm-ros2-stack/install/setup.bash").as_deref(),
            Some("Project/rebotarm-ros2-stack")
        );
        assert_eq!(
            collection_workspace_hint("/home/jialiang/Project/rebotarm-ros2-stack/install/setup.bash")
                .as_deref(),
            Some("/home/jialiang/Project/rebotarm-ros2-stack")
        );
        assert!(collection_workspace_hint("install/setup.bash").is_none());
        assert!(collection_workspace_hint("Project/rebotarm-ros2-stack/setup.bash").is_none());
    }

    #[test]
    fn check_collection_ready_command_is_hard_gate_without_warn_only() {
        let profile = profile();
        let remote = check_collection_ready_remote_command(&profile).unwrap();
        assert!(StdCommand::new("bash")
            .args(["-n", "-c", &remote])
            .status()
            .unwrap()
            .success());
        assert!(remote.contains("check_collection_ready.sh"));
        assert!(remote.contains("--ros-domain-id=7"));
        assert!(remote.contains("--timeout=8"));
        assert!(remote.contains("--workspace="));
        assert!(
            !remote.contains("--warn-only"),
            "Episode/launch must hard-fail; never pass --warn-only: {remote}"
        );
        assert!(remote.contains("LEADER_FOLLOWER_WS"));
        assert!(remote.contains("Project/rebotarm-ros2-stack"));
        let mut bad = profile();
        bad.ros_setup_script = "../evil/install/setup.bash".into();
        assert!(check_collection_ready_remote_command(&bad).is_err());
    }

    #[test]
    fn remote_helper_runs_with_simulated_services_and_processes() {
        let output = StdCommand::new("python3")
            .arg("tests/test_collection_remote.py")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .expect("python3 is needed for recorder adapter tests");
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
