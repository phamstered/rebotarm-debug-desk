//! Application-owned finite arm environment transitions. One remote submission;
//! successful completion also needs fresh state from the same robot profile.
use super::{
    controller_journal::{Job, Proof},
    controller_stop::Outcome,
    controller_task::{rows, same_profile},
    observations::{Snapshot, Source},
    runtime::Runtime,
    tasks::Tasks,
};
use crate::{
    arm_workflow::{stage_line, Progress},
    ConnectionProfile, RemoteActionResult,
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};

fn requires_mit(mode: &str) -> bool {
    matches!(mode, "manager-activate" | "teleop" | "trajectory" | "vla" | "teaching")
}

async fn read_only_preflight(profile: &ConnectionProfile, mode: &str) -> Result<(), String> {
    let Some(remote) = crate::arm_mode_preflight_remote_command(profile, mode)? else {
        return Ok(());
    };
    let mut command = crate::ssh_base(profile);
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg(crate::ssh_target(profile))
        .arg(remote);
    preflight_output(command, Duration::from_secs(15)).await
}

async fn preflight_output(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Result<(), String> {
    // This command is deliberately read-only. A lost reply or timeout cannot
    // leave a mode transition running, and never authorizes the mutation below.
    command.kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| "只读预检超时".to_string())?
        .map_err(|error| format!("无法执行只读预检：{error}"))?;
    if !output.status.success() {
        return Err(crate::stderr_tail(
            &String::from_utf8_lossy(&output.stderr),
            &String::from_utf8_lossy(&output.stdout),
        ));
    }
    Ok(())
}

async fn prepare_after_preflight<F, P>(
    tasks: &Tasks,
    id: u64,
    preflight: F,
    prepare: P,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), String>>,
    P: FnOnce() -> Result<(), String>,
{
    let result = match preflight.await {
        Ok(()) => prepare(),
        Err(error) => Err(format!("控制环境预检失败，未提交控制变更：{error}")),
    };
    if let Err(error) = &result {
        // controller_sent has not succeeded on these paths. Retain the task
        // until the existing durable cleanup releases it; never rewrite a
        // submitted/uncertain task or a previous recovery record as rejected.
        tasks.controller_finish(id, false, error);
    }
    result
}

pub fn authorize(label: &str) -> Result<(), String> {
    if matches!(label, "page-status" | "page-control" | "page-motion") {
        Ok(())
    } else {
        Err("只有控制模式、Status 或 Motion 页面可以切换控制环境".into())
    }
}
fn execution_progress(line: &str) -> Option<Progress> {
    let mut event = stage_line(line)?;
    // A remote stage marker is not the native fresh-state completion proof.
    if event.stage == "ready" {
        event.stage = "verify".into();
        event.message = "远端步骤完成，正在核验共享状态".into();
    }
    Some(event)
}

fn fresh(snapshot: &Snapshot, source: Source) -> Option<&Value> {
    let entry = snapshot.entries.get(&source)?;
    (snapshot.connected && entry.error.is_none() && entry.age_ms < entry.ttl_ms)
        .then_some(entry.value.as_ref())
        .flatten()
}
fn verified(snapshot: &Snapshot, mode: &str) -> bool {
    // Starting MoveIt is also supported with an externally launched trajectory
    // stack. Do not require a Console-owned arm launcher PID for this operation.
    if mode == "moveit" {
        return rows(snapshot).is_ok_and(|controllers| {
            let active = |name: &str| {
                controllers
                    .iter()
                    .any(|r| r["name"] == name && r["state"] == "active")
            };
            active("arm_trajectory_controller")
                && active("gravity_compensation_controller")
                && !active("vla_position_controller")
                && !active("arm_teleop_controller")
                && !active("joint4_calibration_controller")
        });
    }
    let Some(arm) = fresh(snapshot, Source::Arm) else {
        return false;
    };
    let teleop = arm["teleopRunning"].as_bool();
    let trajectory = arm["trajectoryRunning"].as_bool();
    let teaching = arm["teachingRunning"].as_bool();
    if mode == "realsense" {
        return arm["realsenseRunning"] == true;
    }
    if matches!(mode, "stop" | "disable-stop") {
        return teleop == Some(false) && trajectory == Some(false) && teaching == Some(false);
    }
    let Ok(controllers) = rows(snapshot) else {
        return false;
    };
    let active = |name: &str| {
        controllers
            .iter()
            .any(|r| r["name"] == name && r["state"] == "active")
    };
    let gravity = active("gravity_compensation_controller");
    match mode {
        "teleop" => {
            teleop == Some(true)
                && trajectory == Some(false)
                && teaching == Some(false)
                && arm["teleopOwnsRos2Control"] == true
                && gravity
                && active("arm_teleop_controller")
                && !active("arm_trajectory_controller")
                && !active("vla_position_controller")
                && !active("joint4_calibration_controller")
        }
        "trajectory" => {
            trajectory == Some(true)
                && teleop == Some(false)
                && teaching == Some(false)
                && arm["trajectoryOwnsRos2Control"] == true
                && gravity
                && active("arm_trajectory_controller")
                && !active("arm_teleop_controller")
                && !active("vla_position_controller")
                && !active("joint4_calibration_controller")
        }
        "vla" => {
            trajectory == Some(true)
                && teleop == Some(false)
                && teaching == Some(false)
                && arm["trajectoryOwnsRos2Control"] == true
                && gravity
                && active("vla_position_controller")
                && !active("arm_trajectory_controller")
                && !active("arm_teleop_controller")
                && !active("joint4_calibration_controller")
        }
        "teaching" => {
            teaching == Some(true)
                && teleop == Some(false)
                && trajectory == Some(false)
                && gravity
                && ![
                    "arm_teleop_controller",
                    "arm_trajectory_controller",
                    "vla_position_controller",
                    "joint4_calibration_controller",
                    "gripper_teleop_controller",
                    "gripper_trajectory_controller",
                ]
                .iter()
                .any(|n| active(n))
        }
        _ => false,
    }
}

struct Guard {
    tasks: Arc<Tasks>,
    id: u64,
    app: AppHandle,
}
impl Guard {
    fn finish(&self, success: bool, message: &str) -> bool {
        let released = self.tasks.controller_finish(self.id, success, message);
        let _ = self.app.emit("native-tasks-changed", ());
        released
    }
    fn progress(&self, message: &str) {
        self.tasks.arm_progress(self.id, message);
        let _ = self.app.emit("native-tasks-changed", ());
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.finish(false, "控制环境任务结果未确认；保留占用，不重发操作");
    }
}

pub async fn start(
    app: AppHandle,
    label: String,
    hub: &Runtime,
    profile: ConnectionProfile,
    mode: String,
    remote: String,
    progress: Channel<Progress>,
) -> Result<RemoteActionResult, String> {
    let id = hub.begin_arm_mode(&label, &profile)?;
    let guard = Guard {
        tasks: hub.tasks.clone(),
        id,
        app,
    };
    let mut outcome = hub.tasks.controller_outcome(id)?;
    let task = hub
        .tasks
        .snapshot()
        .filter(|s| s.id == id)
        .ok_or("控制环境任务已失效")?;
    let mut job = Job::new(task.command_id, remote)?;
    let original = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
    guard.progress("控制环境操作已由原生会话接管");
    owned(async move {
        let hub = guard.app.state::<Runtime>();
        // Reserve the original owner/epoch before this first await. A reconnect
        // during preflight/log preparation must not admit an old invocation to a new session.
        // Never delay a stop request for diagnostic preparation.
        let preparation = prepare_after_preflight(
            &hub.tasks,
            id,
            async {
                read_only_preflight(&profile, &mode).await?;
                if requires_mit(&mode) { hub.tasks.manager_activation_ready()?; }
                if !matches!(mode.as_str(), "stop" | "disable-stop") {
                    let _ = crate::control_logs::prepare(
                        &profile,
                        &guard.app.state::<crate::control_logs::LogSessions>(),
                    )
                    .await;
                }
                Ok(())
            },
            || {
                if requires_mit(&mode) { hub.tasks.manager_activation_ready()?; }
                hub.finite_recovery
                    .prepare(&hub.tasks, id, &profile, job.ticket())?;
                hub.send_controller(&label, task.epoch, id, &profile)
            },
        )
        .await;
        if let Err(message) = preparation {
            let _ = progress.send(Progress {
                stage: "prepare".into(),
                message: message.clone(),
                failed: true,
            });
            let _ = guard.app.emit("native-tasks-changed", ());
            super::finite_recovery::wait_released(&guard.app, id).await;
            return Err(message);
        }
        let _ = progress.send(Progress {
            stage: "prepare".into(),
            message: "等待远端控制环境步骤".into(),
            failed: false,
        });
        let mut proof = job.submit(&profile).await.ok();
        let mut completed = false;
        let mut manager_receipt: Option<Value> = None;
        loop {
            if *outcome.borrow() == Outcome::Disabled {
                super::finite_recovery::wait_released(&guard.app, id).await;
                return Err("控制环境切换期间收到 DISABLE；已核验新的输出关闭反馈".into());
            }
            if hub.tasks.snapshot().is_none_or(|s| s.id != id) {
                return Err("控制环境任务已结束或失效".into());
            }
            match proof.take() {
                Some(Proof::ManagerSucceeded(receipt)) if mode.starts_with("manager") => {
                    manager_receipt = Some(receipt);
                    completed = true;
                    hub.tasks.controller_remote_completed(id);
                }
                Some(Proof::Succeeded) => {
                    completed = true;
                    hub.tasks.controller_remote_completed(id);
                }
                Some(Proof::Rejected(detail)) => {
                    if guard.finish(true, &detail) {
                        super::finite_recovery::wait_released(&guard.app, id).await;
                        return Err(format!("远端确认未启动控制环境操作：{detail}"));
                    }
                }
                Some(Proof::Uncertain(detail) | Proof::ArmFailedQuiescent(detail)) => {
                    let handle = guard.app.clone();
                    let record = super::finite_recovery::Record {
                        window: label.clone(), profile: original.clone(), ticket: job.ticket(),
                    };
                    tauri::async_runtime::spawn(async move {
                        super::finite_recovery::recover(handle, id, record).await;
                    });
                    guard.finish(false, &format!("远端步骤异常，控制状态未确认：{detail}"));
                    return Err(format!("控制环境结果未确认：{detail}"));
                }
                Some(Proof::Unknown) => {
                    guard.finish(
                        false,
                        "远端完成记录暂不可用；保持占用，只查询恢复，不重发控制步骤",
                    );
                }
                Some(Proof::Progress(line)) => {
                    if let Some(event) = execution_progress(&line) {
                        guard.progress(&event.message);
                        let _ = progress.send(event);
                    }
                }
                _ => {}
            }
            let context = hub.context();
            if context["connected"] == true && same_profile(&original, &context["profile"]) {
                if completed {
                    if mode.starts_with("manager") {
                        if let Some(receipt) = &manager_receipt {
                            match crate::controller_manager::snapshot(&profile).await {
                                Ok(actual) if crate::controller_manager::verified(&context, &hub.context(), &original, receipt, &actual) => {
                                    if guard.finish(true, "Manager 已核验") {
                                        super::finite_recovery::wait_released(&guard.app, id).await;
                                        return Ok(RemoteActionResult { ok: receipt["ok"] == true, exit_code: 0,
                                            message: if receipt["ok"] == true { "Manager 操作完成，已核验实际状态".into() } else { "Manager 操作未全部完成，已保留实际状态与成功项".into() },
                                            detail: receipt["message"].as_str().unwrap_or("").into() });
                                    }
                                }
                                _ => { guard.progress("Manager 操作已结束，等待实际状态核验；不重发"); }
                            }
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                    let epoch = context["epoch"].as_u64().ok_or("连接代次无效")?;
                    let _ = hub.observations.refresh(epoch, Source::Arm, true).await;
                    if !matches!(mode.as_str(), "stop" | "disable-stop" | "realsense") {
                        let _ = hub
                            .observations
                            .refresh(epoch, Source::Controllers, true)
                            .await;
                    }
                    let latest = hub.context();
                    if latest["epoch"] == context["epoch"]
                        && latest["connected"] == true
                        && verified(&hub.observations.snapshot(), &mode)
                    {
                        if guard.finish(true, "") {
                            super::finite_recovery::wait_released(&guard.app, id).await;
                            let message = format!("{mode} 操作完成，已核验新鲜控制环境状态");
                            let _ = progress.send(Progress {
                                stage: "ready".into(),
                                message: message.clone(),
                                failed: false,
                            });
                            return Ok(RemoteActionResult {
                                ok: true,
                                exit_code: 0,
                                message,
                                detail: String::new(),
                            });
                        }
                        // Explicit DISABLE wins over mode-ready success.
                        while *outcome.borrow() == Outcome::Pending {
                            outcome.changed().await.map_err(|_| "输出关闭结果未确认")?;
                        }
                        super::finite_recovery::wait_released(&guard.app, id).await;
                        return Err("控制环境已结束；已按停止请求核验输出关闭".into());
                    }
                    guard.progress("远端步骤完成，等待原机器人新鲜目标模式状态");
                } else {
                    match job.query(&profile).await {
                        Ok(value) => proof = Some(value),
                        Err(error) => {
                            guard
                                .finish(false, &format!("执行结果待确认，仅查询远端记录：{error}"));
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
}

async fn owned<F>(work: F) -> Result<RemoteActionResult, String>
where
    F: std::future::Future<Output = Result<RemoteActionResult, String>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = tx.send(work.await);
    });
    // Preserve the existing progress UI while the caller exists. Dropping this
    // receiver does not cancel work; another window reads native task metadata.
    rx.await
        .map_err(|_| "原生控制环境任务异常退出，结果未确认".to_string())?
}

#[cfg(test)]
mod tests {
    use super::super::{
        finite_recovery::Recovery, observations::Observation, tasks::Owner, windows::WindowToken,
    };
    use super::*;
    use serde_json::json;
    use std::{cell::Cell, path::PathBuf};

    struct PreflightFixture {
        tasks: Arc<Tasks>,
        recovery: Recovery,
        profile: ConnectionProfile,
        path: PathBuf,
        id: u64,
        job: Job,
    }
    impl PreflightFixture {
        fn new() -> Self {
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            let path = std::env::temp_dir()
                .join(super::super::controller_journal::new_arm_id().unwrap())
                .join("finite.json");
            assert!(recovery.restore(&tasks, Ok(path.clone())).is_none());
            let profile: ConnectionProfile = serde_json::from_value(json!({
                "host":"fixture.invalid", "sshPort":22, "username":"", "identityFile":"",
                "localPort":18765, "remotePort":8765, "rosDomainId":197,
                "rosSetupScript":"fixture/install/setup.bash", "commandTopic":"/cmd",
                "statusTopic":"/status", "jointStateTopic":"/joints"
            }))
            .unwrap();
            tasks.configure_motor(1, &serde_json::to_value(&profile).unwrap());
            let id = tasks.begin_arm_mode(Self::owner()).unwrap();
            let job = Job::new(
                tasks.snapshot().unwrap().command_id,
                "fixture mutation".into(),
            )
            .unwrap();
            Self {
                tasks,
                recovery,
                profile,
                path,
                id,
                job,
            }
        }
        fn owner() -> Owner {
            Owner {
                epoch: 1,
                window: WindowToken {
                    label: "page-status".into(),
                    incarnation: 1,
                },
            }
        }
        fn prepare_and_admit(&self) -> Result<(), String> {
            self.recovery
                .prepare(&self.tasks, self.id, &self.profile, self.job.ticket())?;
            self.tasks.controller_sent(self.id)
        }
        fn assert_released_after_cleanup(&self) {
            assert!(self.tasks.finite_terminal().is_some());
            assert!(
                self.tasks.begin_arm_mode(Self::owner()).is_err(),
                "cleanup still owns the slot"
            );
            assert!(self.recovery.cleanup(&self.tasks).unwrap());
            assert!(self.tasks.snapshot().is_none());
            assert!(
                self.tasks.begin_arm_mode(Self::owner()).is_ok(),
                "next operation is admitted"
            );
        }
    }
    impl Drop for PreflightFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
        }
    }
    #[test]
    fn preset_start_requires_mit_but_stops_and_inactive_loading_do_not() {
        for mode in ["manager-activate", "teleop", "trajectory", "vla", "teaching"] {
            assert!(requires_mit(mode));
        }
        for mode in ["stop", "disable-stop", "manager", "realsense", "moveit"] {
            assert!(!requires_mit(mode));
        }
    }

    fn local_preflight(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[tokio::test]
    async fn missing_teaching_capability_releases_unsent_task_without_a_journal_submission() {
        let fixture = PreflightFixture::new();
        let mutation_count = Cell::new(0);
        let error = prepare_after_preflight(
            &fixture.tasks,
            fixture.id,
            preflight_output(
                local_preflight("printf '缺少手动夹爪示教支持\\n' >&2; exit 1"),
                Duration::from_secs(2),
            ),
            || {
                fixture.prepare_and_admit()?;
                mutation_count.set(mutation_count.get() + 1);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("未提交控制变更"));
        assert!(error.contains("缺少手动夹爪示教支持"));
        assert_eq!(mutation_count.get(), 0);
        assert!(
            !fixture.path.exists(),
            "read-only failure never prepares a remote mutation ticket"
        );
        fixture.assert_released_after_cleanup();
    }

    #[tokio::test]
    async fn timed_out_or_unavailable_preflight_never_submits_and_releases_the_reservation() {
        for command in [
            local_preflight("exec sleep 5"),
            tokio::process::Command::new("/nonexistent/rebotarm-preflight-fixture"),
        ] {
            let fixture = PreflightFixture::new();
            let mutation_count = Cell::new(0);
            let result = prepare_after_preflight(
                &fixture.tasks,
                fixture.id,
                preflight_output(command, Duration::from_millis(30)),
                || {
                    fixture.prepare_and_admit()?;
                    mutation_count.set(mutation_count.get() + 1);
                    Ok(())
                },
            )
            .await;
            assert!(result.unwrap_err().contains("未提交控制变更"));
            assert_eq!(mutation_count.get(), 0);
            assert!(!fixture.path.exists());
            fixture.assert_released_after_cleanup();
        }
    }

    #[tokio::test]
    async fn late_preflight_success_cannot_submit_after_cancel_or_connection_loss() {
        for disconnect in [false, true] {
            let fixture = PreflightFixture::new();
            let mutation_count = Cell::new(0);
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
            let pending = prepare_after_preflight(
                &fixture.tasks,
                fixture.id,
                async {
                    entered_tx.send(()).unwrap();
                    finish_rx.await.unwrap();
                    Ok(())
                },
                || {
                    fixture.prepare_and_admit()?;
                    mutation_count.set(mutation_count.get() + 1);
                    Ok(())
                },
            );
            let invalidate = async {
                entered_rx.await.unwrap();
                assert!(!fixture.path.exists());
                if disconnect {
                    // Runtime::close and transport errors use this same unsent-task path.
                    fixture
                        .tasks
                        .lost(None, "fixture disconnected during preflight");
                } else {
                    assert!(fixture.tasks.request_controller_disable(
                        &serde_json::to_value(&fixture.profile).unwrap()
                    ));
                }
                finish_tx.send(()).unwrap();
            };
            let (result, ()) = tokio::join!(pending, invalidate);
            assert!(result.is_err());
            assert_eq!(mutation_count.get(), 0);
            fixture.assert_released_after_cleanup();
        }
    }

    #[tokio::test]
    async fn passing_preflight_still_keeps_post_submission_failure_uncertain() {
        let fixture = PreflightFixture::new();
        let mutation_count = Cell::new(0);
        prepare_after_preflight(
            &fixture.tasks,
            fixture.id,
            preflight_output(local_preflight("exit 0"), Duration::from_secs(2)),
            || {
                fixture.prepare_and_admit()?;
                mutation_count.set(mutation_count.get() + 1);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(mutation_count.get(), 1);
        assert!(fixture.path.exists());
        assert!(!fixture
            .tasks
            .controller_finish(fixture.id, false, "remote mutation failed"));
        assert!(fixture.tasks.finite_terminal().is_none());
        assert!(!fixture.recovery.cleanup(&fixture.tasks).unwrap());
        assert!(fixture
            .tasks
            .begin_arm_mode(PreflightFixture::owner())
            .is_err());
    }

    fn snapshot() -> Snapshot {
        let mut result = Snapshot {
            epoch: 1,
            connected: true,
            revision: 1,
            handler_elapsed_ms: 0,
            entries: Default::default(),
        };
        result.connected = true;
        result.entries.insert(Source::Arm, Observation { sequence: 1, age_ms: 0, ttl_ms: 15000, error: None,
            value: Some(json!({"teleopRunning":false,"trajectoryRunning":true,"teachingRunning":false,"realsenseRunning":true,"trajectoryOwnsRos2Control":true})) });
        result.entries.insert(Source::Controllers, Observation { sequence: 1, age_ms: 0, ttl_ms: 3100, error: None,
            value: Some(json!({"op":"controllers_info","manager":"/controller_manager","supported":true,"available":true,"fresh":true,"has_snapshot":true,"query_state":"ready","snapshot_age_ms":0,
                "controllers":[{"name":"gravity_compensation_controller","state":"active"},{"name":"arm_trajectory_controller","state":"active"}]})) });
        result
    }
    #[test]
    fn arm_success_requires_current_fresh_mode_and_controller_state() {
        assert!(authorize("page-status").is_ok());
        assert!(authorize("page-control").is_ok());
        assert!(authorize("page-motion").is_ok());
        for caller in ["main", "page-handeye", "page-motor", "page-status-copy"] {
            assert!(authorize(caller).is_err());
        }
        let current = snapshot();
        assert!(verified(&current, "trajectory"));
        assert!(verified(&current, "moveit"));
        let mut externally_started = current.clone();
        externally_started.entries.remove(&Source::Arm);
        assert!(verified(&externally_started, "moveit"));
        assert!(!verified(&current, "vla"));
        assert!(!verified(&current, "teaching"));
        assert!(!verified(&current, "teleop"));
        assert!(!verified(&current, "stop"));
        assert!(!verified(&current, "invalid"));
        for source in [Source::Arm, Source::Controllers] {
            let mut stale = current.clone();
            let entry = stale.entries.get_mut(&source).unwrap();
            entry.age_ms = entry.ttl_ms;
            assert!(!verified(&stale, "trajectory"));
            let mut error = current.clone();
            error.entries.get_mut(&source).unwrap().error = Some("unknown".into());
            assert!(!verified(&error, "trajectory"));
        }
        let mut other = current.clone();
        other.connected = false;
        assert!(!verified(&other, "trajectory"));
        let mut unknown = current.clone();
        unknown
            .entries
            .get_mut(&Source::Arm)
            .unwrap()
            .value
            .as_mut()
            .unwrap()["trajectoryOwnsRos2Control"] = Value::Null;
        assert!(!verified(&unknown, "trajectory"));
    }
    #[test]
    fn remote_ready_marker_cannot_finish_frontend_before_native_verification() {
        assert_eq!(
            execution_progress("ARM_STAGE|ready|remote done")
                .unwrap()
                .stage,
            "verify"
        );
        assert_eq!(
            execution_progress("ARM_STAGE|cleanup|cleaning")
                .unwrap()
                .stage,
            "cleanup"
        );
        assert!(execution_progress("noise ARM_STAGE|ready|done").is_none());
    }
    #[test]
    fn teleop_and_vla_require_the_requested_exclusive_controller() {
        for (mode, target, conflicting) in [
            (
                "teleop",
                "arm_teleop_controller",
                "arm_trajectory_controller",
            ),
            ("vla", "vla_position_controller", "arm_teleop_controller"),
        ] {
            let mut current = snapshot();
            current.entries.get_mut(&Source::Arm).unwrap().value = Some(
                json!({"teleopRunning":mode=="teleop","trajectoryRunning":mode=="vla","teachingRunning":false,"teleopOwnsRos2Control":true,"trajectoryOwnsRos2Control":true}),
            );
            current
                .entries
                .get_mut(&Source::Controllers)
                .unwrap()
                .value
                .as_mut()
                .unwrap()["controllers"] = json!([{"name":"gravity_compensation_controller","state":"active"},{"name":target,"state":"active"}]);
            assert!(verified(&current, mode));
            current
                .entries
                .get_mut(&Source::Controllers)
                .unwrap()
                .value
                .as_mut()
                .unwrap()["controllers"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":conflicting,"state":"active"}));
            assert!(!verified(&current, mode));
        }
    }
    #[test]
    fn teaching_forbids_position_controllers_and_stop_requires_all_arm_modes_gone() {
        let mut current = snapshot();
        *current
            .entries
            .get_mut(&Source::Arm)
            .unwrap()
            .value
            .as_mut()
            .unwrap() =
            json!({"teleopRunning":false,"trajectoryRunning":false,"teachingRunning":true});
        assert!(!verified(&current, "teaching"));
        current
            .entries
            .get_mut(&Source::Controllers)
            .unwrap()
            .value
            .as_mut()
            .unwrap()["controllers"] =
            json!([{"name":"gravity_compensation_controller","state":"active"}]);
        assert!(verified(&current, "teaching"));
        for name in [
            "arm_teleop_controller",
            "arm_trajectory_controller",
            "vla_position_controller",
            "joint4_calibration_controller",
            "gripper_teleop_controller",
            "gripper_trajectory_controller",
        ] {
            let mut conflict = current.clone();
            conflict
                .entries
                .get_mut(&Source::Controllers)
                .unwrap()
                .value
                .as_mut()
                .unwrap()["controllers"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":name,"state":"active"}));
            assert!(!verified(&conflict, "teaching"));
        }
        current
            .entries
            .get_mut(&Source::Arm)
            .unwrap()
            .value
            .as_mut()
            .unwrap()["teachingRunning"] = json!(false);
        assert!(verified(&current, "disable-stop"));
        assert!(verified(&current, "stop"));
        current
            .entries
            .get_mut(&Source::Arm)
            .unwrap()
            .value
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("teachingRunning");
        assert!(!verified(&current, "disable-stop"));
    }
    #[tokio::test]
    async fn arm_worker_survives_invoking_future_exit() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(owned(async move {
            let _ = started_tx.send(());
            let _ = finish_rx.await;
            let _ = completed_tx.send(());
            Ok(RemoteActionResult {
                ok: true,
                exit_code: 0,
                message: "done".into(),
                detail: String::new(),
            })
        }));
        started_rx.await.unwrap();
        caller.abort();
        let _ = caller.await;
        finish_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), completed_rx)
            .await
            .unwrap()
            .unwrap();
    }
}
