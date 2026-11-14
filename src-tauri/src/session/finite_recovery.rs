//! Crash recovery for finite SSH controls. Persist only a query ticket. A restart
//! never replays control or restores authorization: even a proven remote end must
//! be followed by an explicit DISABLE and fresh firmware proof before release.
use super::{
    controller_journal::{Job, Proof, Ticket},
    controller_task::same_profile,
    recovery_file,
    runtime::Runtime,
    tasks::{Kind, Phase, Snapshot, Tasks},
};
use crate::ConnectionProfile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub window: String,
    pub profile: Value,
    pub ticket: Ticket,
}
impl Record {
    fn kind(&self) -> Result<Kind, String> {
        self.ticket.validate()?;
        if self.ticket.id.starts_with("controller-") {
            Ok(Kind::Controller)
        } else if self.ticket.id.starts_with("arm-mode-") {
            Ok(Kind::ArmMode)
        } else {
            Err("控制恢复票据种类无效".into())
        }
    }
    fn validate(&self) -> Result<(), String> {
        self.kind()?;
        if !matches!(self.window.as_str(), "page-status" | "page-motion")
            || serde_json::to_vec(&self.profile)
                .map_err(|e| e.to_string())?
                .len()
                > 16384
        {
            return Err("控制恢复页面或配置大小无效".into());
        }
        serde_json::from_value::<ConnectionProfile>(self.profile.clone())
            .map_err(|_| "控制恢复配置无效")?;
        super::motor_task::Context::new(0, &self.profile).ok_or("控制恢复配置缺少反馈身份")?;
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    record: Option<Record>,
}
#[derive(Default)]
struct Store {
    path: Option<PathBuf>,
    record: Option<Record>,
    owner: Option<u64>,
    error: Option<String>,
}
impl Store {
    fn write(&self, record: Option<Record>) -> Result<(), String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        let path = self.path.as_ref().ok_or("控制恢复文件尚未初始化")?;
        recovery_file::write(
            path,
            &serde_json::to_vec(&File { version: 1, record }).map_err(|e| e.to_string())?,
            24576,
        )
    }
}
#[derive(Default)]
pub struct Recovery {
    inner: Mutex<Store>,
}
impl Recovery {
    pub(super) fn restore(
        &self,
        tasks: &Tasks,
        path: Result<PathBuf, String>,
    ) -> Option<(u64, Record)> {
        tasks.enable_finite_recovery();
        let mut store = self.inner.lock().unwrap();
        let loaded = (|| -> Result<Option<Record>, String> {
            let path = path?;
            store.path = Some(path.clone());
            let Some(bytes) = recovery_file::read(&path, 24576)? else {
                return Ok(None);
            };
            let file: File = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if file.version != 1 {
                return Err("控制恢复文件版本无效".into());
            }
            if let Some(record) = &file.record {
                record.validate()?;
            }
            Ok(file.record)
        })();
        let restored = loaded.and_then(|record| {
            let Some(record) = record else {
                return Ok(None);
            };
            let id = tasks.restore_finite(
                record.kind()?,
                record.window.clone(),
                record.ticket.id.clone(),
                &record.profile,
            )?;
            store.owner = Some(id);
            store.record = Some(record.clone());
            Ok(Some((id, record)))
        });
        match restored {
            Ok(record) => record,
            Err(error) => {
                let message = format!("控制恢复记录不可用，保留文件并禁止新任务：{error}");
                tasks.recovery_failed(message.clone());
                store.error = Some(message);
                None
            }
        }
    }
    pub fn error_snapshot(&self) -> Option<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .error
            .as_ref()
            .map(|message| Snapshot {
                id: 0,
                epoch: 0,
                window: "main".into(),
                command_id: "".into(),
                kind: Kind::Controller,
                phase: Phase::Uncertain,
                message: message.clone(),
                recovery_error: true,
            })
    }
    pub fn prepare(
        &self,
        tasks: &Tasks,
        id: u64,
        profile: &ConnectionProfile,
        ticket: Ticket,
    ) -> Result<(), String> {
        // Never call this while holding Core/Tasks. A stalled disk cannot hold
        // up DISABLE, and no network submission precedes this durable record.
        let mut store = self.inner.lock().unwrap();
        let task = tasks
            .snapshot()
            .filter(|t| t.id == id && t.command_id == ticket.id)
            .ok_or("控制恢复任务已失效")?;
        if tasks.finite_terminal().is_some() {
            return Err("控制操作已撤销，未提交".into());
        }
        let record = Record {
            window: task.window,
            profile: serde_json::to_value(profile).map_err(|e| e.to_string())?,
            ticket,
        };
        record.validate()?;
        if record.kind()? != task.kind || store.owner.is_some_and(|old| old != id) {
            return Err("控制恢复记录仍属于另一操作".into());
        }
        // Retain an attempted write for cleanup too: rename may succeed before
        // directory fsync reports failure. The command remains unsubmitted.
        store.owner = Some(id);
        store.record = Some(record.clone());
        store.write(Some(record.clone()))?;
        tasks.finite_prepared(id, &record.ticket.id)
    }
    pub(super) fn cleanup(&self, tasks: &Tasks) -> Result<bool, String> {
        let mut store = self.inner.lock().unwrap();
        let Some(task) = tasks.finite_terminal() else {
            return Ok(false);
        };
        if let Some(owner) = store.owner {
            if owner != task.id
                || store
                    .record
                    .as_ref()
                    .is_none_or(|r| r.ticket.id != task.command_id)
            {
                return Err("控制恢复清理编号不一致；保留占用".into());
            }
            store.write(None)?;
            store.record = None;
            store.owner = None;
        }
        Ok(tasks.finite_release(task.id, &task.command_id))
    }
}

pub(super) fn disable_ack(reply: &Value) -> Result<(), String> {
    if reply["op"] != "joint_command_ack"
        || reply["mode"] != 3
        || reply["sequence"]
            .as_u64()
            .and_then(|s| u32::try_from(s).ok())
            .is_none()
    {
        return Err(format!(
            "DISABLE 受理未确认：{}",
            reply["message"]
                .as_str()
                .unwrap_or("响应类型、模式或序列号无效")
                .chars()
                .take(512)
                .collect::<String>()
        ));
    }
    Ok(())
}

pub async fn wait_released(app: &AppHandle, id: u64) {
    let hub = app.state::<Runtime>();
    while hub.tasks.snapshot().is_some_and(|task| task.id == id) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub fn initialize(app: &AppHandle) {
    let hub = app.state::<Runtime>();
    let path = app
        .path()
        .app_config_dir()
        .map(|p| p.join("finite-control-recovery-v1.json"))
        .map_err(|e| e.to_string());
    let restored = hub.finite_recovery.restore(&hub.tasks, path);
    let handle = app.clone();
    // Cleanup is application-owned, including pre-send cancellation and a
    // terminal produced by the hardware watcher after the invoking page exits.
    tauri::async_runtime::spawn(async move {
        let hub = handle.state::<Runtime>();
        loop {
            match hub.finite_recovery.cleanup(&hub.tasks) {
                Ok(true) => {
                    let _ = handle.emit("native-tasks-changed", ());
                }
                Err(error) => {
                    if let Some(task) = hub.tasks.finite_terminal() {
                        let message: String =
                            format!("控制终态已核验，恢复记录待清理；保留占用：{error}")
                                .chars()
                                .take(512)
                                .collect();
                        if task.message != message {
                            hub.tasks.finite_message(task.id, &message);
                            let _ = handle.emit("native-tasks-changed", ());
                        }
                    }
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    if let Some((id, record)) = restored {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            recover(handle, id, record).await;
        });
    }
}
async fn recover(app: AppHandle, id: u64, record: Record) {
    let hub = app.state::<Runtime>();
    // Already validated at load; errors keep the reservation and cannot execute.
    let (Ok(job), Ok(profile)) = (
        Job::recover(record.ticket),
        serde_json::from_value::<ConnectionProfile>(record.profile.clone()),
    ) else {
        return;
    };
    let mut completed = false;
    loop {
        let Some(task) = hub.tasks.snapshot().filter(|t| t.id == id) else {
            return;
        };
        if hub.tasks.finite_terminal().is_some() {
            return;
        }
        let context = hub.context();
        if !completed
            && context["connected"] == true
            && same_profile(&record.profile, &context["profile"])
        {
            let message = match job.query(&profile).await {
                Ok(Proof::Succeeded | Proof::Rejected(_)) => {
                    completed = true;
                    hub.tasks.controller_remote_completed(id);
                    "远端控制操作已结束；桌面重启不恢复授权。请现场确认支撑后显式 DISABLE，等待新的硬件关闭反馈".into()
                }
                Ok(Proof::Uncertain(detail)) => {
                    format!("远端控制执行结果不确定，保留占用，不重发：{detail}")
                }
                Err(error) => format!("原控制操作查询失败，保留占用：{error}"),
                _ => "原控制操作仍未确认结束；只查询原记录，不重发".into(),
            };
            let message: String = message.chars().take(512).collect();
            if task.message != message {
                hub.tasks.finite_message(id, &message);
                let _ = app.emit("native-tasks-changed", ());
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::{controller_stop::Outcome, tasks::Owner, windows::WindowToken};
    use super::*;
    use serde_json::json;
    use std::{fs, sync::Arc, time::Instant};
    fn profile() -> ConnectionProfile {
        serde_json::from_value(json!({"host":"fixture.invalid","sshPort":22,"username":"","identityFile":"",
            "localPort":18765,"remotePort":8765,"rosDomainId":197,"rosSetupScript":"fixture/install/setup.bash",
            "commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"})).unwrap()
    }
    fn owner() -> Owner {
        Owner {
            epoch: 1,
            window: WindowToken {
                label: "page-motion".into(),
                incarnation: 1,
            },
        }
    }
    fn path() -> PathBuf {
        std::env::temp_dir()
            .join(super::super::controller_journal::new_id().unwrap())
            .join("finite.json")
    }
    fn begin(tasks: &Tasks, arm: bool) -> (u64, Job) {
        let id = if arm {
            tasks.begin_arm_mode(owner())
        } else {
            tasks.begin_controller(owner())
        }
        .unwrap();
        let job = Job::new(
            tasks.snapshot().unwrap().command_id,
            "never replay this control".into(),
        )
        .unwrap();
        (id, job)
    }
    fn status(seq: u32, stamp: u64) -> Value {
        json!({"op":"topic_message","topic":"/status","data":{"mode":3,"last_command_sequence":seq,"header":{"stamp":{"sec":stamp,"nanosec":0}}}})
    }
    fn ack(seq: u32) -> Value {
        json!({"op":"joint_command_ack","mode":3,"sequence":seq})
    }
    #[test]
    fn terminal_cleanup_disable_needs_a_real_disable_ack() {
        assert!(disable_ack(&ack(1)).is_ok());
        for reply in [
            json!({"op":"error","message":"rejected"}),
            json!({"op":"joint_command_ack","mode":1,"sequence":1}),
            json!({"op":"joint_command_ack","mode":3}),
            json!({"op":"joint_command_ack","mode":3,"sequence":4294967296u64}),
        ] {
            assert!(disable_ack(&reply).is_err());
        }
    }

    #[test]
    fn both_kinds_restart_query_only_and_require_explicit_post_completion_disable() {
        use std::os::unix::fs::PermissionsExt;
        for arm in [false, true] {
            let path = path();
            let profile = profile();
            let value = serde_json::to_value(&profile).unwrap();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            assert!(recovery.restore(&tasks, Ok(path.clone())).is_none());
            tasks.configure_motor(1, &value);
            let (id, job) = begin(&tasks, arm);
            assert!(tasks.controller_sent(id).is_err(), "write-ahead gate");
            recovery
                .prepare(&tasks, id, &profile, job.ticket())
                .unwrap();
            tasks.controller_sent(id).unwrap();
            let bytes = fs::read(&path).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("never replay"));
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            drop(tasks);
            drop(recovery);
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            let (id, record) = recovery.restore(&tasks, Ok(path.clone())).unwrap();
            assert_eq!(record.ticket, job.ticket());
            assert_eq!(
                tasks.snapshot().unwrap().kind,
                if arm { Kind::ArmMode } else { Kind::Controller }
            );
            assert!(Job::recover(record.ticket).is_ok());
            assert!(tasks.migration("page-motion").is_err());
            assert!(tasks.playback_operation("page-monitor", true).is_err());
            assert!(tasks
                .admit(
                    owner(),
                    &json!({"op":"position_move","command_id":"new"}),
                    Instant::now()
                )
                .is_err());
            tasks.configure_motor(2, &value);
            tasks.observe(2, &status(4, 1));
            assert!(
                tasks.poll(2, Instant::now()).is_none(),
                "restart must not itself issue DISABLE or renew control"
            );
            assert!(!tasks.controller_finish(
                id,
                true,
                "ordinary matching target state is not authorization"
            ));
            assert!(!recovery.cleanup(&tasks).unwrap());
            // Early user DISABLE cannot finish an operation that may still execute.
            assert!(tasks.request_controller_disable(&value));
            let early = tasks.poll(2, Instant::now()).unwrap();
            tasks.disable_reply(id, early.action, 2, Ok(&ack(10)));
            tasks.observe(2, &status(10, 2));
            assert!(tasks.finite_terminal().is_none());
            tasks.finish_action(id, early.action);
            tasks.controller_remote_completed(id);
            let mut wrong = value.clone();
            wrong["host"] = json!("other.invalid");
            tasks.configure_motor(3, &wrong);
            assert!(
                tasks.poll(3, Instant::now()).is_none(),
                "do not stop another robot"
            );
            tasks.configure_motor(4, &value);
            let after = tasks.poll(4, Instant::now()).unwrap();
            assert!(after.action > early.action);
            tasks.disable_reply(id, early.action, 4, Ok(&ack(20)));
            tasks.observe(4, &status(20, 3));
            assert!(tasks.finite_terminal().is_none());
            tasks.disable_reply(id, after.action, 4, Ok(&ack(30)));
            tasks.observe(4, &status(29, 4));
            assert!(tasks.finite_terminal().is_none());
            tasks.observe(4, &status(30, 5));
            assert_eq!(
                *tasks.controller_outcome(id).unwrap().borrow(),
                Outcome::Disabled
            );
            assert!(
                tasks.snapshot().is_some(),
                "retain ownership until durable cleanup"
            );
            assert!(tasks.migration("page-motion").is_err());
            assert!(recovery.cleanup(&tasks).unwrap());
            assert!(tasks.snapshot().is_none());
            assert!(serde_json::from_slice::<File>(&fs::read(&path).unwrap())
                .unwrap()
                .record
                .is_none());
            assert!(tasks.migration("page-motion").is_ok());
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn normal_terminal_and_disk_failure_hold_ownership_without_blocking_disable() {
        let path = path();
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        let (id, job) = begin(&tasks, false);
        recovery
            .prepare(&tasks, id, &profile(), job.ticket())
            .unwrap();
        tasks.controller_sent(id).unwrap();
        tasks.controller_remote_completed(id);
        assert!(tasks.controller_finish(id, true, "verified"));
        assert!(tasks.snapshot().is_some());
        assert!(tasks.begin_controller(owner()).is_err());
        let saved = path.parent().unwrap().with_extension("saved");
        fs::rename(path.parent().unwrap(), &saved).unwrap();
        fs::write(path.parent().unwrap(), b"block disk").unwrap();
        assert!(recovery.cleanup(&tasks).is_err());
        assert!(tasks.migration("page-motion").is_err());
        assert!((tasks
            .admit(
                owner(),
                &json!({"op":"joint_command","mode":3}),
                Instant::now()
            )
            .unwrap()
            .permit
            .unwrap())());
        tasks.lost(None, "all windows closed");
        assert_eq!(tasks.finite_terminal().unwrap().id, id);
        fs::remove_file(path.parent().unwrap()).unwrap();
        fs::rename(saved, path.parent().unwrap()).unwrap();
        let during_io = tasks.clone();
        super::super::recovery_file::before_write_for_test(move || {
            assert!(
                during_io.snapshot().is_some(),
                "disk I/O does not retain Tasks"
            );
            assert!(during_io.migration("page-motion").is_err());
            assert!((during_io
                .admit(
                    owner(),
                    &json!({"op":"joint_command","mode":3}),
                    Instant::now()
                )
                .unwrap()
                .permit
                .unwrap())());
        });
        assert!(recovery.cleanup(&tasks).unwrap());
        let (next, _) = begin(&tasks, true);
        assert!(!tasks.finite_release(id, &job.ticket().id));
        assert_eq!(tasks.snapshot().unwrap().id, next);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn cancel_during_write_and_failed_presend_write_are_durably_cleaned() {
        for fault in [false, true] {
            let path = path();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            recovery.restore(&tasks, Ok(path.clone()));
            let (id, job) = begin(&tasks, false);
            if fault {
                fs::write(path.parent().unwrap(), b"disk error").unwrap();
            } else {
                let during_io = tasks.clone();
                super::super::recovery_file::before_write_for_test(move || {
                    during_io.lost(None, "disconnect during fsync")
                });
            }
            assert!(recovery
                .prepare(&tasks, id, &profile(), job.ticket())
                .is_err());
            assert!(tasks.controller_sent(id).is_err());
            tasks.controller_finish(id, false, "not submitted");
            if fault {
                assert!(recovery.cleanup(&tasks).is_err());
                fs::remove_file(path.parent().unwrap()).unwrap();
            }
            assert!(recovery.cleanup(&tasks).unwrap());
            assert!(tasks.snapshot().is_none());
            assert!(serde_json::from_slice::<File>(&fs::read(&path).unwrap())
                .unwrap()
                .record
                .is_none());
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn corrupt_unknown_and_executable_records_preserve_file_and_admission_barrier() {
        let path = path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = Record {
            window: "page-status".into(),
            profile: serde_json::to_value(profile()).unwrap(),
            ticket: Job::new(
                super::super::controller_journal::new_id().unwrap(),
                "never run".into(),
            )
            .unwrap()
            .ticket(),
        };
        for case in 0..7 {
            let mut file = serde_json::to_value(File {
                version: 1,
                record: Some(record.clone()),
            })
            .unwrap();
            match case {
                0 => file["version"] = json!(2),
                1 => file["record"]["window"] = json!("page-motor"),
                2 => file["record"]["ticket"]["command"] = json!("must not execute"),
                3 => {
                    file["record"]["ticket"]["id"] =
                        json!(super::super::controller_journal::new_bag_id().unwrap())
                }
                4 => file["record"]["profile"] = json!({}),
                5 => file["record"]["ticket"]["hash"] = json!("bad"),
                _ => file["record"]["profile"]["identityFile"] = json!("x".repeat(24576)),
            }
            let bytes = serde_json::to_vec(&file).unwrap();
            fs::write(&path, &bytes).unwrap();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            assert!(recovery.restore(&tasks, Ok(path.clone())).is_none());
            assert!(recovery.error_snapshot().unwrap().recovery_error);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(tasks.begin_controller(owner()).is_err());
            assert!(tasks
                .admit(
                    owner(),
                    &json!({"op":"position_move","command_id":"new"}),
                    Instant::now()
                )
                .is_err());
            assert!(tasks.sampling_operation("page-handeye").is_err());
            assert!(tasks.local_operation("page-handeye").is_ok());
            assert!(tasks
                .admit(
                    owner(),
                    &json!({"op":"joint_command","mode":3}),
                    Instant::now()
                )
                .is_ok());
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
