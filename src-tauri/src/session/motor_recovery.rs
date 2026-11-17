//! Durable identity for a continuous Motor stream. Never persist commands or
//! gains, and never restore actuation permission. Recovery only confirms DISABLE.
use super::{
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
    pub command_id: String,
    pub profile: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
}
impl Record {
    fn validate(&self) -> Result<(), String> {
        if self.operation.as_deref().is_some_and(|op| !matches!(op,"configuration"|"release"|"stream")) { return Err("Motor 恢复操作无效".into()); }
        if !self.command_id.starts_with("motor-")
            || self.command_id.len() > 128
            || serde_json::to_vec(&self.profile)
                .map_err(|e| e.to_string())?
                .len()
                > 16384
        {
            return Err("Motor 恢复编号或配置大小无效".into());
        }
        serde_json::from_value::<ConnectionProfile>(self.profile.clone())
            .map_err(|_| "Motor 恢复配置格式无效")?;
        super::motor_task::Context::new(0, &self.profile).ok_or("Motor 恢复配置缺少反馈身份")?;
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
        recovery_file::write(
            self.path.as_ref().ok_or("Motor 恢复文件尚未初始化")?,
            &serde_json::to_vec(&File { version: 1, record }).map_err(|e| e.to_string())?,
            24576,
        )
    }
}
#[derive(Default)]
pub struct Recovery {
    inner: Mutex<Store>,
    error: Mutex<Option<String>>,
}
impl Recovery {
    #[cfg(test)]
    pub(super) fn lock_for_test(&self) -> impl Drop + '_ {
        self.inner.lock().unwrap()
    }
    pub(super) fn restore(&self, tasks: &Tasks, path: Result<PathBuf, String>) {
        tasks.enable_motor_recovery();
        let mut store = self.inner.lock().unwrap();
        let result = (|| -> Result<(), String> {
            let path = path?;
            store.path = Some(path.clone());
            let Some(bytes) = recovery_file::read(&path, 24576)? else {
                return Ok(());
            };
            let file: File = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if file.version != 1 {
                return Err("Motor 恢复版本无效".into());
            }
            if let Some(record) = file.record {
                record.validate()?;
                let owner = tasks.restore_motor(record.command_id.clone(), &record.profile, record.operation.is_some())?;
                store.owner = Some(owner);
                store.record = Some(record);
            }
            Ok(())
        })();
        if let Err(error) = result {
            let message = format!("Motor 恢复记录不可用，保留文件并禁止新任务：{error}");
            tasks.recovery_failed(message.clone());
            *self.error.lock().unwrap() = Some(message.clone());
            store.error = Some(message);
        }
    }
    pub fn error_snapshot(&self) -> Option<Snapshot> {
        self.error.lock().unwrap().as_ref().map(|message| Snapshot {
            id: 0,
            epoch: 0,
            window: "page-motor".into(),
            command_id: "".into(),
            kind: Kind::Motor,
            phase: Phase::Uncertain,
            message: message.clone(),
            recovery_error: true,
        })
    }
    pub fn prepare(&self, tasks: &Tasks, id: u64, profile: Value) -> Result<(), String> {
        // Called on a blocking worker without Core or Tasks locks held. Recheck
        // the ticket after fsync; cancellation can happen while the disk stalls.
        let mut store = self.inner.lock().unwrap();
        if !tasks.motor_needs_prepare(id) {
            return Err("Motor 恢复任务已撤销或失效".into());
        }
        let task = tasks
            .snapshot()
            .filter(|t| t.id == id && t.kind == Kind::Motor)
            .ok_or("Motor 恢复任务已失效")?;
        let record = Record {
            command_id: task.command_id,
            profile,
            operation: tasks.motor_record_kind(id),
        };
        record.validate()?;
        if store.owner.is_some_and(|owner| owner != id) {
            return Err("Motor 恢复记录仍属于另一任务".into());
        }
        // Keep an attempted write too: rename can succeed before directory fsync
        // fails, so cleanup must not forget this possible on-disk record.
        store.owner = Some(id);
        store.record = Some(record.clone());
        store.write(Some(record.clone()))?;
        tasks.motor_prepared(id, &record.command_id)
    }
    pub(super) fn cleanup(&self, tasks: &Tasks) -> Result<bool, String> {
        let mut store = self.inner.lock().unwrap();
        let Some(task) = tasks.motor_terminal() else {
            return Ok(false);
        };
        if let Some(owner) = store.owner {
            if owner != task.id
                || store
                    .record
                    .as_ref()
                    .is_none_or(|r| r.command_id != task.command_id)
            {
                return Err("Motor 恢复清理编号不一致，保留占用".into());
            }
            store.write(None)?;
            store.record = None;
            store.owner = None;
        }
        Ok(tasks.motor_release(task.id, &task.command_id))
    }
}
pub fn initialize(app: &AppHandle) {
    let hub = app.state::<Runtime>();
    hub.motor_recovery.restore(
        &hub.tasks,
        app.path()
            .app_config_dir()
            .map(|p| p.join("motor-recovery-v1.json"))
            .map_err(|e| e.to_string()),
    );
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let handle_worker = handle.clone();
            // A disk wait must not occupy the async transport executor.
            let result = tauri::async_runtime::spawn_blocking(move || {
                let hub = handle_worker.state::<Runtime>();
                hub.motor_recovery.cleanup(&hub.tasks)
            })
            .await;
            let hub = handle.state::<Runtime>();
            match result {
                Ok(Ok(true)) => {
                    let _ = handle.emit("native-tasks-changed", ());
                }
                Ok(Err(error)) => {
                    if let Some(task) = hub.tasks.motor_terminal() {
                        let message =
                            format!("Motor 停止已核验，恢复记录清理失败；保留占用：{error}");
                        hub.tasks.motor_cleanup_error(task.id, &message);
                        let _ = handle.emit("native-tasks-changed", ());
                    }
                }
                Err(error) => eprintln!("Motor 恢复清理任务失败：{error}"),
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::super::{
        tasks::{Admission, Owner},
        windows::WindowToken,
    };
    use super::*;
    use serde_json::json;
    use std::{fs, sync::Arc, time::Instant};
    fn profile() -> Value {
        json!({"host":"fixture.invalid","sshPort":22,"username":"","identityFile":"",
            "localPort":18765,"remotePort":8765,"rosDomainId":197,"rosSetupScript":"fixture/install/setup.bash",
            "commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"})
    }
    fn owner(epoch: u64) -> Owner {
        Owner {
            epoch,
            window: WindowToken {
                label: "page-motor".into(),
                incarnation: 1,
            },
        }
    }
    fn path() -> PathBuf {
        std::env::temp_dir()
            .join(super::super::controller_journal::new_id().unwrap())
            .join("motor.json")
    }
    fn status(seq: u32, mode: u8, stamp: u64) -> Value {
        json!({"op":"topic_message","topic":"/status","data":{"mode":mode,"last_command_sequence":seq,
            "header":{"stamp":{"sec":stamp,"nanosec":0}}}})
    }
    fn start(tasks: &Arc<Tasks>) -> (Admission, Value) {
        tasks.configure_motor(1, &profile());
        tasks.observe(1, &status(1, 3, 1));
        let request = json!({"op":"joint_command","mode":1,"position":[1.25],"kp":123.456});
        (
            tasks.admit(owner(1), &request, Instant::now()).unwrap(),
            request,
        )
    }
    #[test]
    fn motor_restart_retains_ownership_and_only_disables_the_original_robot() {
        use std::os::unix::fs::PermissionsExt;
        let path = path();
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        let (admission, request) = start(&tasks);
        let id = admission.ticket.unwrap();
        let permit = admission.permit.unwrap();
        assert!(!permit(), "cannot publish before durable identity");
        recovery.prepare(&tasks, id, profile()).unwrap();
        assert!(permit());
        tasks.reply(
            Some(id),
            1,
            &request,
            Ok(&json!({"op":"joint_command_ack","mode":1,"sequence":2})),
        );
        let bytes = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("123.456"));
        assert!(!String::from_utf8_lossy(&bytes).contains("position"));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let command = tasks.snapshot().unwrap().command_id;
        drop(recovery);
        drop(tasks);
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        assert_eq!(tasks.snapshot().unwrap().command_id, command);
        assert!(tasks.migration("page-motor").is_err());
        assert!(
            tasks.poll(1, Instant::now()).is_none(),
            "no connection means no control"
        );
        for key in [
            "host",
            "username",
            "sshPort",
            "remotePort",
            "rosDomainId",
            "commandTopic",
            "statusTopic",
        ] {
            let mut other = profile();
            other[key] = if other[key].is_number() {
                json!(other[key].as_u64().unwrap() + 1)
            } else {
                json!("different")
            };
            tasks.configure_motor(2, &other);
            assert!(tasks.poll(2, Instant::now()).is_none(), "wrong {key}");
        }
        tasks.configure_motor(3, &profile());
        tasks.observe(3, &status(5, 3, 5));
        assert!(
            tasks.admit(owner(3), &request, Instant::now()).is_err(),
            "cannot resume stream"
        );
        let action = tasks.poll(3, Instant::now()).unwrap();
        assert_eq!(action.message, json!({"op":"joint_command","mode":3}));
        assert!((action.permit)());
        tasks.disable_reply(
            action.ticket,
            action.action,
            3,
            Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":6})),
        );
        assert!(
            tasks.motor_terminal().is_none(),
            "publish ack is not shutdown evidence"
        );
        tasks.observe(3, &status(6, 3, 5));
        assert!(tasks.motor_terminal().is_none(), "old source stamp");
        tasks.observe(3, &status(5, 3, 6));
        assert!(tasks.motor_terminal().is_none(), "old sequence");
        tasks.observe(3, &status(6, 3, 7));
        assert!(tasks.motor_terminal().is_some());
        tasks.motor_cleanup_error(action.ticket, "disk cleanup pending");
        tasks.observe(3, &status(7, 3, 8));
        assert_eq!(tasks.snapshot().unwrap().message, "disk cleanup pending");
        assert!(tasks.snapshot().is_some());
        assert!(!recovery.cleanup(&Tasks::default()).unwrap());
        assert!(recovery.cleanup(&tasks).unwrap());
        assert!(tasks.snapshot().is_none());
        let third = Tasks::default();
        Recovery::default().restore(&third, Ok(path.clone()));
        assert!(third.snapshot().is_none());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn v2_configuration_is_durable_before_send_and_recovery_contains_no_target_or_lease() {
        use super::super::motor_v2_task::tests::{caps,acquire};
        let path = path(); let tasks = Arc::new(Tasks::default()); let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone())); tasks.configure_motor(1, &profile());
        tasks.observe(1, &status(1,3,1)); tasks.observe(1, &json!({"motor_control":caps()}));
        let mut request=acquire(); request["op"]=json!("motor_set_control_mode"); request["support_confirmation"]=json!("SUPPORTED");
        let admission=tasks.admit(owner(1), &request, Instant::now()).unwrap();
        assert!(!admission.permit.as_ref().unwrap()(), "disk record precedes transport permission");
        recovery.prepare(&tasks,admission.ticket.unwrap(),profile()).unwrap(); assert!(admission.permit.unwrap()());
        let stored: Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["record"]["operation"],"configuration");
        for forbidden in ["position","velocity_limit","lease_id","confirmation","support_confirmation","kp","kd","effort"] {
            assert!(stored["record"].get(forbidden).is_none());
        }
        let restarted=Arc::new(Tasks::default()); Recovery::default().restore(&restarted,Ok(path.clone()));
        restarted.configure_motor(2,&profile()); restarted.observe(2,&status(1,3,1));
        assert!(restarted.admit(owner(2),&request,Instant::now()).is_err());
        assert_eq!(restarted.poll(2,Instant::now()).unwrap().message,json!({"op":"joint_command","mode":3}));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn motor_write_and_cleanup_failures_keep_occupancy_without_blocking_tasks() {
        let path = path();
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        let (admission, request) = start(&tasks);
        let id = admission.ticket.unwrap();
        let during = tasks.clone();
        super::super::recovery_file::before_write_for_test(move || {
            // This would deadlock if prepare held Tasks during fsync.
            assert!(during.snapshot().is_some());
            during.lost(None, "window vanished while writing");
            assert!(during.motor_terminal().is_some());
            assert!(during
                .admit(
                    owner(1),
                    &json!({"op":"joint_command","mode":3}),
                    Instant::now()
                )
                .unwrap()
                .permit
                .unwrap()());
        });
        assert!(recovery.prepare(&tasks, id, profile()).is_err());
        assert!(!admission.permit.unwrap()());
        tasks.reply(Some(id), 1, &request, Err("cancelled before send"));
        assert!(tasks.motor_terminal().is_some());
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(recovery.cleanup(&tasks).is_err());
        assert!(tasks.migration("page-motor").is_err());
        fs::remove_dir(&path).unwrap();
        fs::write(&path, bytes).unwrap();
        assert!(recovery.cleanup(&tasks).unwrap());
        assert!(tasks.migration("page-motor").is_ok());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn queued_motor_commands_and_automatic_disable_recheck_connection_before_writing() {
        let path = path();
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        let (admission, request) = start(&tasks);
        let id = admission.ticket.unwrap();
        recovery.prepare(&tasks, id, profile()).unwrap();
        let mut other = profile();
        other["rosDomainId"] = json!(198);
        tasks.configure_motor(1, &other);
        assert!(!admission.permit.as_ref().unwrap()());
        tasks.configure_motor(1, &profile());
        assert!(admission.permit.as_ref().unwrap()());
        tasks.reply(
            Some(id),
            1,
            &request,
            Ok(&json!({"op":"joint_command_ack","mode":1,"sequence":2})),
        );
        tasks.lost(None, "disconnected");
        let action = tasks.poll(1, Instant::now()).unwrap();
        assert!((action.permit)());
        tasks.configure_motor(1, &other);
        assert!(!(action.permit)());
        // An explicit user DISABLE remains available on the current connection.
        assert!(tasks
            .admit(
                owner(1),
                &json!({"op":"joint_command","mode":3}),
                Instant::now()
            )
            .unwrap()
            .permit
            .unwrap()());
        tasks.configure_motor(1, &profile());
        tasks.finish_action(id, action.action);
        assert!(!(action.permit)(), "completed action cannot send again");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn motor_failed_initial_write_prevents_publish_and_corruption_is_preserved() {
        let path = path();
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        let (admission, request) = start(&tasks);
        let id = admission.ticket.unwrap();
        fs::create_dir_all(&path).unwrap();
        assert!(recovery.prepare(&tasks, id, profile()).is_err());
        assert!(!admission.permit.unwrap()());
        tasks.reply(Some(id), 1, &request, Err("disk failure"));
        assert!(tasks.motor_terminal().is_some());
        assert!(recovery.cleanup(&tasks).is_err());
        fs::remove_dir(&path).unwrap();
        assert!(recovery.cleanup(&tasks).unwrap());
        for bytes in [
            b"broken".to_vec(),
            serde_json::to_vec(&json!({"version":9,"record":null})).unwrap(),
            serde_json::to_vec(
                &json!({"version":1,"record":{"command_id":"motor-1","profile":{"host":"x"}}}),
            )
            .unwrap(),
        ] {
            fs::write(&path, &bytes).unwrap();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            recovery.restore(&tasks, Ok(path.clone()));
            assert!(recovery.error_snapshot().unwrap().recovery_error);
            assert!(tasks
                .begin_controller(Owner {
                    epoch: 1,
                    window: WindowToken {
                        label: "page-status".into(),
                        incarnation: 1
                    }
                })
                .is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(tasks
                .admit(
                    owner(1),
                    &json!({"op":"joint_command","mode":3}),
                    Instant::now()
                )
                .is_ok());
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
