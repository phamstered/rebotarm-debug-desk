//! Finite Controller switches are app-owned. A lost SSH result is not evidence
//! that the remote service stopped. Normal completion requires success plus fresh
//! target states; explicit DISABLE instead waits for a new output-off proof after
//! the remote operation ends. The switch itself is never automatically retried.
use super::{
    observations::{Snapshot, Source},
    runtime::Runtime,
    tasks::Tasks,
};
use crate::ConnectionProfile;
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

pub fn same_profile(a: &Value, b: &Value) -> bool {
    [
        "host",
        "sshPort",
        "username",
        "identityFile",
        "remotePort",
        "rosDomainId",
        "rosSetupScript",
        "commandTopic",
        "statusTopic",
        "jointStateTopic",
    ]
    .iter()
    .all(|key| !a[key].is_null() && a[key] == b[key])
}

#[derive(Clone, Debug)]
struct Target {
    name: String,
    type_name: String,
    state: String,
}
fn rows(snapshot: &Snapshot) -> Result<&Vec<Value>, String> {
    let entry = snapshot
        .entries
        .get(&Source::Controllers)
        .ok_or("缺少 Controller 查询结果")?;
    let value = entry
        .value
        .as_ref()
        .filter(|_| entry.error.is_none())
        .ok_or("Controller 查询失败")?;
    let age = value["snapshot_age_ms"]
        .as_f64()
        .ok_or("Controller 帧龄无效")?;
    if !snapshot.connected
        || entry.age_ms >= entry.ttl_ms
        || !age.is_finite()
        || age < 0.
        || age + entry.age_ms as f64 >= 3100.
        || value["op"] != "controllers_info"
        || value["manager"] != "/controller_manager"
        || value["supported"] != true
        || value["available"] != true
        || value["fresh"] != true
        || value["has_snapshot"] != true
        || !matches!(value["query_state"].as_str(), Some("ready" | "pending"))
    {
        return Err("Controller 状态未确认新鲜".into());
    }
    let rows = value["controllers"]
        .as_array()
        .filter(|rows| rows.len() <= 4096)
        .ok_or("Controller 列表无效")?;
    let mut names = BTreeSet::new();
    for row in rows {
        let name = row["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Controller 名称无效")?;
        if !names.insert(name) {
            return Err("Controller 列表名称重复".into());
        }
    }
    Ok(rows)
}
fn targets(
    snapshot: &Snapshot,
    activate: &[String],
    deactivate: &[String],
) -> Result<Vec<Target>, String> {
    if activate.len() + deactivate.len() > 256 || activate.is_empty() && deactivate.is_empty() {
        return Err("Controller 切换数量无效".into());
    }
    let rows = rows(snapshot)?;
    let mut names = BTreeSet::new();
    activate
        .iter()
        .map(|n| (n, "active"))
        .chain(deactivate.iter().map(|n| (n, "inactive")))
        .map(|(name, state)| {
            if !names.insert(name) {
                return Err("Controller 切换列表重复或激活/停用冲突".into());
            }
            let row = rows
                .iter()
                .find(|r| r["name"] == *name)
                .ok_or("待切换 Controller 不存在")?;
            if !matches!(row["state"].as_str(), Some("active" | "inactive")) {
                return Err("Controller 当前状态不允许切换".into());
            }
            let type_name = row["type_name"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 512)
                .ok_or("Controller 类型无效")?;
            Ok(Target {
                name: name.clone(),
                type_name: type_name.into(),
                state: state.into(),
            })
        })
        .collect()
}
fn verified(snapshot: &Snapshot, expected: &[Target]) -> bool {
    rows(snapshot).is_ok_and(|rows| {
        !expected.is_empty()
            && expected.iter().all(|target| {
                rows.iter().any(|row| {
                    row["name"] == target.name
                        && row["type_name"] == target.type_name
                        && row["state"] == target.state
                })
            })
    })
}
struct Guard {
    tasks: Arc<Tasks>,
    id: u64,
    app: AppHandle,
    outcome: tokio::sync::watch::Receiver<super::controller_stop::Outcome>,
}
impl Guard {
    fn finish(&self, verified: bool, message: &str) -> bool {
        let released = self.tasks.controller_finish(self.id, verified, message);
        let _ = self.app.emit("native-tasks-changed", ());
        released
    }
    async fn wait_for_disable(&self) -> Result<String, String> {
        let mut outcome = self.outcome.clone();
        loop {
            match *outcome.borrow() {
                super::controller_stop::Outcome::Disabled => {
                    return Err(
                        "Controller 切换期间收到 DISABLE；已核验新的硬件反馈确认输出关闭".into(),
                    )
                }
                super::controller_stop::Outcome::Finished => {
                    return Err("Controller 任务已结束".into())
                }
                super::controller_stop::Outcome::Pending => {}
            }
            if outcome.changed().await.is_err() {
                return Err("Controller 输出关闭结果未确认".into());
            }
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if self
            .tasks
            .snapshot()
            .is_some_and(|task| task.id == self.id && task.phase != super::tasks::Phase::Uncertain)
        {
            self.finish(
                false,
                "Controller 执行结果未确认；保留占用，不能重发或用空闲状态解锁",
            );
        }
    }
}

pub async fn start(
    app: AppHandle,
    label: String,
    hub: &Runtime,
    profile: ConnectionProfile,
    activate: Vec<String>,
    deactivate: Vec<String>,
    remote: String,
) -> Result<String, String> {
    // Reserve before any await, using the real invoking WebView and shared profile.
    let id = hub.begin_controller(&label, &profile)?;
    let guard = Guard {
        tasks: hub.tasks.clone(),
        id,
        app: app.clone(),
        outcome: hub.tasks.controller_outcome(id)?,
    };
    let _ = app.emit("native-tasks-changed", ());
    owned(async move {
        let result = run(&guard, &label, profile, activate, deactivate, remote).await;
        if let Err(error) = &result {
            guard.finish(false, error);
        }
        result
    })
    .await
}
async fn owned<F>(work: F) -> Result<String, String>
where
    F: std::future::Future<Output = Result<String, String>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Dropping the invoking WebView/future does not cancel this app-owned worker.
    tokio::spawn(async move {
        let result = work.await;
        let _ = tx.send(result);
    });
    match tokio::time::timeout(Duration::from_secs(25), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Controller 原生任务异常退出，执行结果未确认".into()),
        Err(_) => Err(
            "Controller 仍在原生层等待结果或新状态核验；请查看共享任务提示，不要重复切换".into(),
        ),
    }
}

async fn run(
    guard: &Guard,
    label: &str,
    profile: ConnectionProfile,
    activate: Vec<String>,
    deactivate: Vec<String>,
    remote: String,
) -> Result<String, String> {
    let hub = guard.app.state::<Runtime>();
    let initial = hub.context();
    let epoch = initial["epoch"].as_u64().ok_or("连接代次无效")?;
    let expected = targets(
        &hub.observations
            .refresh(epoch, Source::Controllers, true)
            .await?,
        &activate,
        &deactivate,
    )?;
    let remote_id = guard
        .tasks
        .snapshot()
        .filter(|task| task.id == guard.id)
        .ok_or("Controller 任务已失效")?
        .command_id;
    let mut job = super::controller_journal::Job::new(remote_id, remote)?;
    hub.send_controller(label, epoch, guard.id, &profile)?;
    let _ = guard.app.emit("native-tasks-changed", ());
    // This is the only submit. Losing the SSH reply must never replay control.
    let submitted = job.submit(&profile).await;
    if let Err(error) = &submitted {
        guard.finish(false, error);
    }
    let mut proof = submitted.ok();
    let mut remote_succeeded = false;
    let original_profile = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
    // Controller state queries start only after a matching remote success record.
    // A reconnect may verify only the same robot/profile.
    loop {
        if *guard.outcome.borrow() == super::controller_stop::Outcome::Disabled {
            return guard.wait_for_disable().await;
        }
        if guard
            .tasks
            .snapshot()
            .is_none_or(|task| task.id != guard.id)
        {
            return Err("Controller 任务已失效".into());
        }
        use super::controller_journal::Proof;
        match proof.take() {
            Some(Proof::Succeeded) => {
                remote_succeeded = true;
                guard.tasks.controller_remote_completed(guard.id);
            }
            Some(Proof::Rejected(detail)) => {
                guard.finish(true, "");
                return Err(format!("Controller 远端确认未执行：{detail}"));
            }
            Some(Proof::Uncertain(detail)) => {
                return Err(format!(
                    "Controller 远端命令异常或超时，ROS 服务结果未确认：{detail}"
                ))
            }
            _ => {}
        }
        let context = hub.context();
        if context["connected"] == true && same_profile(&original_profile, &context["profile"]) {
            if !remote_succeeded {
                let queried = job.query(&profile).await;
                let query_error = queried.as_ref().err().cloned();
                proof = queried.ok();
                if matches!(
                    proof,
                    Some(Proof::Succeeded | Proof::Rejected(_) | Proof::Uncertain(_))
                ) {
                    continue;
                }
                guard.finish(
                    false,
                    query_error
                        .as_deref()
                        .unwrap_or("Controller 执行结果待确认；正在按编号查询远端记录，不重发切换"),
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let epoch = context["epoch"].as_u64().ok_or("连接代次无效")?;
            if let Ok(snapshot) = hub
                .observations
                .refresh(epoch, Source::Controllers, true)
                .await
            {
                let current = hub.context();
                if current["epoch"] == context["epoch"]
                    && current["connected"] == true
                    && verified(&snapshot, &expected)
                {
                    if guard.finish(true, "") {
                        return Ok("Controller 切换完成，原生层已核验新状态".into());
                    }
                    return guard.wait_for_disable().await;
                }
            }
        }
        guard.finish(
            false,
            if remote_succeeded {
                "Controller 命令已成功，等待原机器人新鲜列表确认目标状态"
            } else {
                "Controller 执行结果待确认，等待原机器人连接以查询远端记录"
            },
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::observations::Observation;
    use super::*;
    use serde_json::json;
    fn snapshot() -> Snapshot {
        Snapshot { epoch: 1, connected: true, revision: 1, handler_elapsed_ms: 0,
            entries: [(Source::Controllers, Observation { sequence:1, error:None, age_ms:0, ttl_ms:3100,
                value: Some(json!({"op":"controllers_info","manager":"/controller_manager","supported":true,
                    "available":true,"fresh":true,"has_snapshot":true,"snapshot_age_ms":1,"query_state":"ready",
                    "controllers":[{"name":"arm","type_name":"JTC","state":"active"},{"name":"vla","type_name":"VLA","state":"inactive"}]})) })].into() }
    }
    #[test]
    fn refuses_stale_duplicate_or_conflicting_preflight_and_verifies_all_types_and_states() {
        let original = snapshot();
        let goal = targets(&original, &["arm".into()], &["vla".into()]).unwrap();
        assert!(verified(&original, &goal));
        assert!(targets(&original, &["arm".into()], &["arm".into()]).is_err());
        assert!(targets(&original, &["missing".into()], &[]).is_err());
        for (field, value) in [
            ("state", json!("active")),
            ("type_name", json!("replacement")),
        ] {
            let mut changed = snapshot();
            changed
                .entries
                .get_mut(&Source::Controllers)
                .unwrap()
                .value
                .as_mut()
                .unwrap()["controllers"][1][field] = value;
            assert!(!verified(&changed, &goal));
        }
        let mut stale = snapshot();
        stale.entries.get_mut(&Source::Controllers).unwrap().age_ms = 3099;
        assert!(targets(&stale, &["arm".into()], &[]).is_err());
        let mut duplicate = snapshot();
        duplicate
            .entries
            .get_mut(&Source::Controllers)
            .unwrap()
            .value
            .as_mut()
            .unwrap()["controllers"][1]["name"] = json!("arm");
        assert!(targets(&duplicate, &["arm".into()], &[]).is_err());
        let mut offline = snapshot();
        offline.connected = false;
        assert!(!verified(&offline, &goal));
    }
    #[tokio::test]
    async fn caller_loss_does_not_abort_the_owned_worker_or_release_before_verification() {
        let tasks = Arc::new(Tasks::default());
        let owner = super::super::tasks::Owner {
            epoch: 1,
            window: super::super::windows::WindowToken {
                label: "page-motion".into(),
                incarnation: 1,
            },
        };
        let id = tasks.begin_controller(owner.clone()).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (verify_tx, verify_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let running = tasks.clone();
        let caller = tokio::spawn(owned(async move {
            running.controller_sent(id).unwrap();
            started_tx.send(()).unwrap();
            verify_rx.await.unwrap();
            running.controller_finish(id, true, "");
            done_tx.send(()).unwrap();
            Ok("verified".into())
        }));
        started_rx.await.unwrap();
        caller.abort();
        let _ = caller.await;
        tasks.lost(Some(&owner), "page lost");
        assert!(tasks.migration("page-motion").is_err());
        assert!(tasks.begin_controller(owner).is_err());
        verify_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(tasks.snapshot().is_none());
    }

    #[test]
    fn profile_match_ignores_tunnel_port_but_never_robot_domain_or_setup() {
        let a = json!({"host":"robot","sshPort":22,"username":"user","identityFile":"", "localPort":1234,"remotePort":8765,"rosDomainId":0,"rosSetupScript":"ws/install/setup.bash", "commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"});
        let mut b = a.clone();
        b["localPort"] = json!(12345);
        assert!(same_profile(&a, &b));
        for key in [
            "host",
            "rosDomainId",
            "rosSetupScript",
            "commandTopic",
            "identityFile",
        ] {
            let mut changed = b.clone();
            changed[key] = json!("other");
            assert!(!same_profile(&a, &changed));
        }
        assert!(!same_profile(&json!({}), &json!({})));
    }
}
