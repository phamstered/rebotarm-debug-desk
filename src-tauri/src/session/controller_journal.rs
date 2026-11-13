//! Bound remote completion proof for one Controller operation. Only submit can
//! execute, and the native worker calls it exactly once. All recovery is query.
use crate::ConnectionProfile;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

pub fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|e| format!("无法生成 Controller 任务编号：{e}"))?;
    Ok(format!(
        "controller-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
#[derive(Debug, PartialEq, Eq)]
pub enum Proof {
    Pending,
    Unknown,
    Succeeded,
    Rejected(String),
    Uncertain(String),
}
pub struct Job {
    id: String,
    hash: String,
    command: Option<String>,
}
impl Job {
    pub fn new(id: String, command: String) -> Result<Self, String> {
        if id.len() != 59
            || !id.starts_with("controller-")
            || !id[11..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || command.is_empty()
            || command.len() > 32768
            || command.contains('\0')
        {
            return Err("Controller 远端任务参数无效".into());
        }
        Ok(Self {
            id,
            hash: format!("{:x}", Sha256::digest(command.as_bytes())),
            command: Some(command),
        })
    }
    fn query_request(&self) -> Value {
        json!({"op":"query","id":self.id,"command_hash":self.hash})
    }
    fn submission(&mut self) -> Result<Value, String> {
        let command = self
            .command
            .take()
            .ok_or("Controller 切换已提交；只允许查询，禁止重发")?;
        Ok(json!({"op":"submit","id":self.id,"command_hash":self.hash,"command":command}))
    }
    pub async fn submit(&mut self, profile: &ConnectionProfile) -> Result<Proof, String> {
        let request = self.submission()?;
        self.exchange(profile, request).await
    }
    pub async fn query(&self, profile: &ConnectionProfile) -> Result<Proof, String> {
        self.exchange(profile, self.query_request()).await
    }
    fn proof(&self, value: &Value) -> Result<Proof, String> {
        if value["version"] != 1 || value["id"] != self.id || value["command_hash"] != self.hash {
            return Err("Controller 远端记录的版本、编号或命令摘要不匹配".into());
        }
        let detail = value["message"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(512)
            .collect::<String>();
        match value["phase"].as_str() {
            Some("unknown") => Ok(Proof::Unknown),
            Some("reserved") if value["started"] == false => Ok(Proof::Pending),
            Some("running") if value["started"] == true => Ok(Proof::Pending),
            Some("succeeded")
                if value["started"] == true
                    && value["exit_code"] == 0
                    && value["timed_out"] == false =>
            {
                Ok(Proof::Succeeded)
            }
            Some("rejected") if value["started"] == false => Ok(Proof::Rejected(detail)),
            Some("uncertain") if value["started"] == true => Ok(Proof::Uncertain(detail)),
            _ => Err("Controller 远端完成记录无效".into()),
        }
    }
    async fn exchange(&self, profile: &ConnectionProfile, payload: Value) -> Result<Proof, String> {
        let remote = remote_command();
        let request = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let output = tokio::time::timeout(Duration::from_secs(15), async {
            let mut child = crate::ssh_base(profile)
                .kill_on_drop(true)
                .arg("-o")
                .arg("BatchMode=yes")
                .arg(crate::ssh_target(profile))
                .arg(remote)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Controller 记录 SSH 启动失败：{e}"))?;
            let mut stdin = child.stdin.take().ok_or("Controller 记录请求输入不可用")?;
            stdin.write_all(&request).await.map_err(|e| e.to_string())?;
            drop(stdin);
            child.wait_with_output().await.map_err(|e| e.to_string())
        })
        .await
        .map_err(|_| "Controller 记录 SSH 超时；仅查询恢复，不重发切换".to_string())??;
        if !output.status.success() {
            return Err(format!(
                "Controller 记录查询未确认：{}",
                crate::ros_control_error(&String::from_utf8_lossy(&output.stderr))
            ));
        }
        if output.stdout.len() > 16384 {
            return Err("Controller 远端记录超过大小限制".into());
        }
        self.proof(
            &serde_json::from_slice(&output.stdout)
                .map_err(|e| format!("Controller 记录 JSON 无效：{e}"))?,
        )
    }
}

fn remote_command() -> String {
    let script = include_str!("../controller_remote.py");
    format!("python3 -c '{}'", script.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_query_cannot_execute_and_proof_is_bound_to_id_and_full_command() {
        let id = new_id().unwrap();
        assert_ne!(id, new_id().unwrap());
        let mut job = Job::new(id, "echo fixture".into()).unwrap();
        assert_eq!(job.submission().unwrap()["command"], "echo fixture");
        assert!(job.submission().is_err());
        assert!(job.query_request().get("command").is_none());
        let success = json!({"version":1,"id":job.id,"command_hash":job.hash,"phase":"succeeded","started":true,"exit_code":0,"timed_out":false});
        assert_eq!(job.proof(&success).unwrap(), Proof::Succeeded);
        for (key, value) in [
            ("id", json!(new_id().unwrap())),
            ("command_hash", json!("0".repeat(64))),
            ("exit_code", json!(1)),
            ("started", json!(false)),
            ("timed_out", json!(true)),
            ("version", json!(2)),
        ] {
            let mut invalid = success.clone();
            invalid[key] = value;
            assert!(job.proof(&invalid).is_err());
        }
        let mut pending = success.clone();
        pending["phase"] = json!("unknown");
        assert_eq!(job.proof(&pending).unwrap(), Proof::Unknown);
        pending["phase"] = json!("rejected");
        assert!(job.proof(&pending).is_err());
        pending["started"] = json!(false);
        assert!(matches!(job.proof(&pending), Ok(Proof::Rejected(_))));
    }
    #[test]
    fn quoted_remote_helper_accepts_json_stdin_and_missing_query_has_no_side_effect() {
        use std::io::Write;
        let job = Job::new(new_id().unwrap(), "echo do-not-execute".into()).unwrap();
        let home = std::env::temp_dir().join(new_id().unwrap());
        assert!(!home.exists());
        let mut child = std::process::Command::new("bash")
            .arg("-c")
            .arg(remote_command())
            .env("HOME", &home)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&job.query_request()).unwrap())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            job.proof(&serde_json::from_slice(&result.stdout).unwrap())
                .unwrap(),
            Proof::Unknown
        );
        assert!(!home.exists());
    }
    #[test]
    fn actual_journal_subprocess_regressions_run_without_ros_or_ssh() {
        let output = std::process::Command::new("python3")
            .arg("tests/test_controller_remote.py")
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
