//! Typed entry points for the fixed remote Manager worker. Mutations use the
//! same application-owned journal and task exclusion as mode presets.
use crate::{ConnectionProfile, RemoteActionResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    action: String,
    #[serde(default)]
    activate: Vec<String>,
    #[serde(default)]
    deactivate: Vec<String>,
    #[serde(default)]
    expected: String,
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        if !["start", "load", "switch", "stop"].contains(&self.action.as_str()) {
            return Err("未知 Manager 操作".into());
        }
        if self.activate.len() + self.deactivate.len() > 256
            || self.activate.iter().chain(&self.deactivate).any(|n| {
                n.is_empty()
                    || n.len() > 128
                    || !n
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'/')
            })
        {
            return Err("Controller 名称无效".into());
        }
        if ["switch", "stop"].contains(&self.action.as_str())
            && (self.expected.len() != 64 || !self.expected.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("缺少确认时的 Manager 快照".into());
        }
        Ok(())
    }
}
fn command(profile: &ConnectionProfile, request: Value) -> Result<String, String> {
    let setup = crate::arm_mode_setup(profile)?;
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
    Ok(format!(
        "bash -lc {}",
        quote(&format!(
            "{setup}\npython3 -c {} {}",
            quote(include_str!("manager_remote.py")),
            quote(&request.to_string())
        ))
    ))
}
pub async fn snapshot(profile: &ConnectionProfile) -> Result<Value, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        crate::ssh_base(profile)
            .kill_on_drop(true)
            .arg("-o")
            .arg("BatchMode=yes")
            .arg(crate::ssh_target(profile))
            .arg(command(profile, json!({"action":"snapshot"}))?)
            .output(),
    )
    .await
    .map_err(|_| "Manager 只读查询超时")?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(crate::stderr_tail(
            &String::from_utf8_lossy(&output.stderr),
            &String::from_utf8_lossy(&output.stdout),
        ));
    }
    if output.stdout.len() > 1048576 {
        return Err("Manager 快照过大".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Manager 快照无效：{e}"))
}
pub fn verified(
    before: &Value,
    after: &Value,
    original: &Value,
    receipt: &Value,
    actual: &Value,
) -> bool {
    before["connected"] == true
        && after["connected"] == true
        && before["epoch"].is_u64()
        && before["epoch"] == after["epoch"]
        && crate::session::controller_task::same_profile(original, &after["profile"])
        && receipt["ok"].is_boolean()
        && receipt["fingerprint"]
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        && actual["fingerprint"] == receipt["fingerprint"]
}

#[tauri::command]
pub async fn controller_manager_snapshot(
    window: WebviewWindow,
    profile: ConnectionProfile,
) -> Result<Value, String> {
    crate::session::arm_operation::authorize(window.label())?;
    snapshot(&profile).await
}
#[tauri::command]
pub async fn controller_manager_manage(
    app: AppHandle,
    window: WebviewWindow,
    hub: State<'_, crate::session::runtime::Runtime>,
    profile: ConnectionProfile,
    request: Request,
    confirmed: bool,
    on_progress: Channel<crate::arm_workflow::Progress>,
) -> Result<RemoteActionResult, String> {
    crate::session::arm_operation::authorize(window.label())?;
    request.validate()?;
    if !confirmed {
        return Err("请核对控制器切换及现场支撑后确认".into());
    }
    let mode = if request.action == "switch" && !request.activate.is_empty() {
        "manager-activate"
    } else {
        "manager"
    };
    let mut payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
    payload["statusTopic"] = json!(profile.status_topic);
    payload["commandTopic"] = json!(profile.command_topic);
    payload["requireV2"] = json!(hub.tasks.manager_v2_seen());
    let remote = command(&profile, payload)?;
    crate::session::arm_operation::start(
        app,
        window.label().into(),
        &hub,
        profile,
        mode.into(),
        remote,
        on_progress,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_cannot_cross_a_disconnect_or_connection_epoch() {
        let profile = json!({"host":"robot","sshPort":22,"username":"user","identityFile":"","remotePort":8765,"rosDomainId":0,"rosSetupScript":"stack/install/setup.bash","commandTopic":"/command","statusTopic":"/status","jointStateTopic":"/joint_states"});
        let context = json!({"connected":true,"epoch":1,"profile":profile});
        let receipt = json!({"ok":false,"fingerprint":"a".repeat(64)});
        let actual = json!({"fingerprint":"a".repeat(64)});
        assert!(verified(&context, &context, &profile, &receipt, &actual));
        for (key, value) in [
            ("connected", json!(false)),
            ("epoch", json!(2)),
            ("profile", json!({})),
        ] {
            let mut changed = context.clone();
            changed[key] = value;
            assert!(!verified(&context, &changed, &profile, &receipt, &actual));
        }
        assert!(!verified(
            &context,
            &context,
            &profile,
            &receipt,
            &json!({"fingerprint":"b".repeat(64)})
        ));
    }

    #[test]
    fn rejects_unsupported_operations_and_invalid_confirmation_snapshot() {
        let mut request = Request {
            action: "switch".into(),
            activate: vec!["arm/position".into()],
            deactivate: vec![],
            expected: "a".repeat(64),
        };
        assert!(request.validate().is_ok());
        request.activate = vec!["name; echo unsafe".into()];
        assert!(request.validate().is_err());
        request.activate = vec!["position".into()];
        request.expected.clear();
        assert!(request.validate().is_err());
        request.action = "shell".into();
        assert!(request.validate().is_err());
    }

    #[test]
    fn remote_logic_is_tested_without_ros_or_robot() {
        let output = std::process::Command::new("python3")
            .arg("tests/test_manager_remote.py")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
