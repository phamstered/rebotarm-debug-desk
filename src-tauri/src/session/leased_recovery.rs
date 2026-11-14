//! Write-ahead identity for leased Bridge tasks. A restart only queries the
//! original task; it never replays commands or resumes ownership heartbeats.
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
    pub kind: Kind,
    pub window: String,
    pub command_id: String,
    pub profile: Value,
    pub joint4_action: Option<String>,
}
impl Record {
    pub(super) fn validate(&self) -> Result<(), String> {
        if !matches!(
            self.kind,
            Kind::Position | Kind::Pick | Kind::Gravity | Kind::Trajectory | Kind::Joint4
        ) || (self.window != "main" && super::windows::Page::from_label(&self.window).is_none())
            || self.command_id.is_empty()
            || self.command_id.len() > 128
            || serde_json::to_vec(&self.profile)
                .map_err(|e| e.to_string())?
                .len()
                > 16384
        {
            return Err("运动恢复类型、页面、编号或配置大小无效".into());
        }
        if (self.kind == Kind::Joint4
            && !matches!(
                self.joint4_action.as_deref(),
                Some("begin_pose" | "release_pose" | "fit" | "reset")
            ))
            || (self.kind != Kind::Joint4 && self.joint4_action.is_some())
        {
            return Err("运动恢复 Joint4 类型无效".into());
        }
        serde_json::from_value::<ConnectionProfile>(self.profile.clone())
            .map_err(|_| "运动恢复配置格式无效")?;
        super::trajectory_task::connection_identity(&self.profile).ok_or("运动恢复缺少连接身份")?;
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
            self.path.as_ref().ok_or("运动恢复文件尚未初始化")?,
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
        tasks.enable_leased_recovery();
        let mut store = self.inner.lock().unwrap();
        let result = (|| -> Result<(), String> {
            let path = path?;
            store.path = Some(path.clone());
            let Some(bytes) = recovery_file::read(&path, 24576)? else {
                return Ok(());
            };
            let file: File = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if file.version != 1 {
                return Err("运动恢复版本无效".into());
            }
            if let Some(record) = file.record {
                record.validate()?;
                let owner = tasks.restore_leased(&record)?;
                store.owner = Some(owner);
                store.record = Some(record);
            }
            Ok(())
        })();
        if let Err(error) = result {
            let message = format!("运动恢复记录不可用，保留文件并禁止新任务：{error}");
            tasks.recovery_failed(message.clone());
            *self.error.lock().unwrap() = Some(message.clone());
            store.error = Some(message);
        }
    }
    pub fn error_snapshot(&self) -> Option<Snapshot> {
        self.error.lock().unwrap().as_ref().map(|message| Snapshot {
            id: 0,
            epoch: 0,
            window: "main".into(),
            command_id: "".into(),
            kind: Kind::Position,
            phase: Phase::Uncertain,
            message: message.clone(),
            recovery_error: true,
        })
    }
    pub fn prepare(&self, tasks: &Tasks, id: u64, profile: Value) -> Result<(), String> {
        // Called on a blocking worker without Core or Tasks locks held. Recheck
        // the ticket after fsync; cancellation can happen while the disk stalls.
        let mut store = self.inner.lock().unwrap();
        if !tasks.leased_needs_prepare(id) {
            return Err("运动恢复任务已撤销或失效".into());
        }
        let record = tasks.leased_record(id, profile)?;
        record.validate()?;
        if store.owner.is_some_and(|owner| owner != id) {
            return Err("运动恢复记录仍属于另一任务".into());
        }
        // Keep an attempted write too: rename can succeed before directory fsync
        // fails, so cleanup must not forget this possible on-disk record.
        store.owner = Some(id);
        store.record = Some(record.clone());
        store.write(Some(record.clone()))?;
        tasks.leased_prepared(id, &record.command_id)
    }
    pub(super) fn cleanup(&self, tasks: &Tasks) -> Result<bool, String> {
        let mut store = self.inner.lock().unwrap();
        let Some(task) = tasks.leased_terminal() else {
            return Ok(false);
        };
        if let Some(owner) = store.owner {
            if owner != task.id
                || store
                    .record
                    .as_ref()
                    .is_none_or(|r| r.command_id != task.command_id)
            {
                return Err("运动恢复清理编号不一致，保留占用".into());
            }
            store.write(None)?;
            store.record = None;
            store.owner = None;
        }
        Ok(tasks.leased_release(task.id, &task.command_id))
    }
}
pub fn initialize(app: &AppHandle) {
    let hub = app.state::<Runtime>();
    hub.leased_recovery.restore(
        &hub.tasks,
        app.path()
            .app_config_dir()
            .map(|p| p.join("leased-recovery-v1.json"))
            .map_err(|e| e.to_string()),
    );
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let handle_worker = handle.clone();
            // A disk wait must not occupy the async transport executor.
            let result = tauri::async_runtime::spawn_blocking(move || {
                let hub = handle_worker.state::<Runtime>();
                hub.leased_recovery.cleanup(&hub.tasks)
            })
            .await;
            let hub = handle.state::<Runtime>();
            match result {
                Ok(Ok(true)) => {
                    let _ = handle.emit("native-tasks-changed", ());
                }
                Ok(Err(error)) => {
                    if let Some(task) = hub.tasks.leased_terminal() {
                        let message =
                            format!("运动停止已核验，恢复记录清理失败；保留占用：{error}");
                        hub.tasks.leased_cleanup_error(task.id, &message);
                        let _ = handle.emit("native-tasks-changed", ());
                    }
                }
                Err(error) => eprintln!("运动恢复清理任务失败：{error}"),
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
        json!({"host":"fixture.invalid","sshPort":22,"username":"fixture","identityFile":"",
            "localPort":18765,"remotePort":8765,"rosDomainId":197,"rosSetupScript":"fixture/install/setup.bash",
            "commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"})
    }
    fn path() -> PathBuf {
        std::env::temp_dir()
            .join(super::super::controller_journal::new_id().unwrap())
            .join("leased.json")
    }
    fn setup(kind: Kind, action: Option<&str>) -> (String, Value, &'static str) {
        let (label, op, query) = match kind {
            Kind::Position => ("page-motion", "position_move", "position_task_status"),
            Kind::Pick => ("page-motion", "visual_pick_start", "visual_pick_observe"),
            Kind::Gravity => (
                "page-gravity",
                "gravity_id_send_goal",
                "gravity_id_task_status",
            ),
            Kind::Trajectory => (
                "page-motion",
                "trajectory_command",
                "trajectory_task_status",
            ),
            Kind::Joint4 => ("page-calibration", "joint4_start", "joint4_task_status"),
            _ => unreachable!(),
        };
        (
            label.into(),
            json!({"op":op,"command_id":"durable-test","action":action,"confirmation":"SUPPORTED","target":"DO-NOT-REPLAY"}),
            query,
        )
    }
    fn begin(tasks: &Arc<Tasks>, kind: Kind, action: Option<&str>) -> (Admission, Value, Owner) {
        tasks.configure_motor(1, &profile());
        let (label, request, _) = setup(kind, action);
        let owner = Owner {
            epoch: 1,
            window: WindowToken {
                label,
                incarnation: 1,
            },
        };
        (
            tasks
                .admit(owner.clone(), &request, Instant::now())
                .unwrap(),
            request,
            owner,
        )
    }
    fn proof(kind: Kind, action: Option<&str>) -> Value {
        let id = "durable-test";
        match kind {
            Kind::Position => {
                json!({"op":"position_task_status","command_id":id,"known":true,"terminal":true,"motion_phase":"canceled",
                "motion_state":{"op":"position_motion","command_id":id,"motion_phase":"canceled"}})
            }
            Kind::Pick => {
                json!({"op":"visual_pick_state","command_id":id,"busy":false,"pick_phase":"canceled"})
            }
            Kind::Gravity => {
                json!({"op":"gravity_id_task_status","command_id":id,"known":true,"terminal":true,"status":"canceled",
                "result":{"op":"gravity_id_result","command_id":id,"task_phase":"canceled","terminal":true}})
            }
            Kind::Trajectory => {
                json!({"op":"trajectory_task_status","command_id":id,"known":true,"terminal":true,"busy":false,"task_phase":"canceled",
                "result":{"op":"trajectory_task_state","command_id":id,"task_phase":"canceled","terminal":true,"evidence":"output_disabled"}})
            }
            Kind::Joint4 => {
                json!({"op":"joint4_task_status","command_id":id,"known":true,"terminal":true,"busy":false,"task_phase":"canceled",
                "result":{"op":"joint4_task_state","command_id":id,"action":action,"task_phase":"canceled","terminal":true,"evidence":"pose_released"}})
            }
            _ => unreachable!(),
        }
    }
    fn cases() -> Vec<(Kind, Option<&'static str>)> {
        vec![
            (Kind::Position, None),
            (Kind::Pick, None),
            (Kind::Gravity, None),
            (Kind::Trajectory, None),
            (Kind::Joint4, Some("begin_pose")),
            (Kind::Joint4, Some("release_pose")),
            (Kind::Joint4, Some("fit")),
            (Kind::Joint4, Some("reset")),
        ]
    }
    #[test]
    fn all_leased_kinds_restart_query_only_and_retain_reservation_until_durable_cleanup() {
        use std::os::unix::fs::PermissionsExt;
        for (kind, action) in cases() {
            let path = path();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            recovery.restore(&tasks, Ok(path.clone()));
            let (admission, _, _) = begin(&tasks, kind, action);
            let id = admission.ticket.unwrap();
            let permit = admission.permit.unwrap();
            assert!(!permit());
            recovery.prepare(&tasks, id, profile()).unwrap();
            assert!(permit());
            let bytes = fs::read(&path).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("DO-NOT-REPLAY"));
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            drop(tasks);
            drop(recovery);
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            recovery.restore(&tasks, Ok(path.clone()));
            let snapshot = tasks.snapshot().unwrap();
            assert_eq!(snapshot.kind, kind);
            assert!(tasks.migration(&snapshot.window).is_err());
            assert!(tasks.poll(1, Instant::now()).is_none());
            tasks.configure_motor(2, &profile());
            let query = tasks.poll(2, Instant::now()).unwrap();
            assert!(query.recovery && !query.heartbeat);
            assert!((query.permit)());
            assert_eq!(query.message["op"], setup(kind, action).2);
            assert!(!query.message.to_string().contains("DO-NOT-REPLAY"));
            assert!(tasks
                .admit(
                    Owner {
                        epoch: 2,
                        window: WindowToken {
                            label: snapshot.window.clone(),
                            incarnation: 2
                        }
                    },
                    &setup(kind, action).1,
                    Instant::now()
                )
                .is_err());
            assert!(!tasks.recover(
                snapshot.id,
                2,
                &json!({"command_id":"durable-test","known":false,"terminal":false})
            ));
            let mut wrong = proof(kind, action);
            wrong["command_id"] = json!("other-task");
            assert!(!tasks.recover(snapshot.id, 2, &wrong));
            let mut insufficient = proof(kind, action);
            match kind {
                Kind::Position => insufficient["motion_state"]["command_id"] = json!("other-task"),
                Kind::Pick => insufficient["busy"] = json!(true),
                Kind::Gravity => insufficient["result"]["command_id"] = json!("other-task"),
                Kind::Trajectory => insufficient["result"]["evidence"] = json!("published"),
                Kind::Joint4 => insufficient["result"]["action"] = json!("other-action"),
                _ => unreachable!(),
            }
            assert!(!tasks.recover(snapshot.id, 2, &insufficient));
            assert!(tasks.snapshot().is_some());
            assert!(tasks.recover(snapshot.id, 2, &proof(kind, action)));
            assert!(tasks.leased_terminal().is_some());
            assert!(tasks.migration(&snapshot.window).is_err());
            assert!(!tasks.leased_release(snapshot.id + 1, &snapshot.command_id));
            tasks.leased_cleanup_error(snapshot.id, "cleanup pending");
            assert!(!tasks.recover(snapshot.id, 2, &proof(kind, action)));
            assert_eq!(tasks.snapshot().unwrap().message, "cleanup pending");
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            assert!(recovery.cleanup(&tasks).is_err());
            assert!(tasks.snapshot().is_some());
            fs::remove_dir(&path).unwrap();
            fs::write(&path, bytes).unwrap();
            assert!(recovery.cleanup(&tasks).unwrap());
            assert!(tasks.snapshot().is_none());
            let next = Tasks::default();
            Recovery::default().restore(&next, Ok(path.clone()));
            assert!(next.snapshot().is_none());
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn position_group_records_only_query_identity_and_never_restores_group_resume() {
        let path = path();
        let tasks = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        tasks.configure_motor(1, &profile());
        let owner = Owner {
            epoch: 1,
            window: WindowToken {
                label: "page-motion".into(),
                incarnation: 1,
            },
        };
        let request = json!({"op":"position_group_start","command_id":"durable-test","group_id":"never-replay-group","items":[{"joints":[1,2,3]}]});
        let admission = tasks
            .admit(owner.clone(), &request, Instant::now())
            .unwrap();
        recovery
            .prepare(&tasks, admission.ticket.unwrap(), profile())
            .unwrap();
        assert!(admission.permit.unwrap()());
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("never-replay-group"));
        let restored = Arc::new(Tasks::default());
        let recovery = Recovery::default();
        recovery.restore(&restored, Ok(path.clone()));
        restored.configure_motor(2, &profile());
        let query = restored.poll(2, Instant::now()).unwrap();
        assert_eq!(query.message["op"], "position_task_status");
        assert!(restored
            .admit(
                Owner { epoch: 2, ..owner },
                &json!({"op":"position_group_resume","command_id":"durable-test"}),
                Instant::now()
            )
            .is_err());
        assert!(restored.recover(query.ticket, 2, &proof(Kind::Position, None)));
        assert!(recovery.cleanup(&restored).unwrap());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn restored_leases_reject_wrong_connections_and_late_queued_queries() {
        for (kind, action) in cases() {
            let tasks = Arc::new(Tasks::default());
            let record = Record {
                kind,
                window: setup(kind, action).0,
                command_id: "durable-test".into(),
                profile: profile(),
                joint4_action: action.map(String::from),
            };
            let id = tasks.restore_leased(&record).unwrap();
            for key in [
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
            ] {
                let mut other = profile();
                other[key] = if other[key].is_number() {
                    json!(other[key].as_u64().unwrap() + 1)
                } else {
                    json!("different")
                };
                tasks.configure_motor(2, &other);
                assert!(tasks.poll(2, Instant::now()).is_none(), "{kind:?} {key}");
                assert!(!tasks.recover(id, 2, &proof(kind, action)));
            }
            tasks.configure_motor(3, &profile());
            let query = tasks.poll(3, Instant::now()).unwrap();
            assert!((query.permit)());
            let mut other = profile();
            other["host"] = json!("wrong");
            tasks.configure_motor(3, &other);
            assert!(!(query.permit)());
            assert!(!tasks.recover(id, 3, &proof(kind, action)));
            assert!(tasks
                .admit(
                    Owner {
                        epoch: 3,
                        window: WindowToken {
                            label: "main".into(),
                            incarnation: 1
                        }
                    },
                    &json!({"op":"joint_command","mode":3}),
                    Instant::now()
                )
                .unwrap()
                .permit
                .unwrap()());
        }
    }
    #[test]
    fn write_failure_and_page_loss_before_write_never_publish_or_forget_a_possible_record() {
        for (kind, action) in cases() {
            let path = path();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            recovery.restore(&tasks, Ok(path.clone()));
            let (admission, request, owner) = begin(&tasks, kind, action);
            let id = admission.ticket.unwrap();
            let during = tasks.clone();
            super::super::recovery_file::before_write_for_test(move || {
                during.lost(Some(&owner), "page lost during fsync");
                assert!(during.leased_terminal().is_some());
            });
            assert!(recovery.prepare(&tasks, id, profile()).is_err());
            assert!(!admission.permit.unwrap()());
            tasks.reply(Some(id), 1, &request, Err("cancelled"));
            assert!(tasks.leased_terminal().is_some());
            assert!(fs::read(&path).is_ok());
            assert!(recovery.cleanup(&tasks).unwrap());
            let (admission, request, _) = begin(&tasks, kind, action);
            let id = admission.ticket.unwrap();
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            assert!(recovery.prepare(&tasks, id, profile()).is_err());
            assert!(!admission.permit.unwrap()());
            tasks.reply(Some(id), 1, &request, Err("disk failed"));
            assert!(tasks.leased_terminal().is_some());
            assert!(recovery.cleanup(&tasks).is_err());
            fs::remove_dir(&path).unwrap();
            assert!(recovery.cleanup(&tasks).unwrap());
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn malformed_or_conflicting_recovery_records_keep_original_bytes_and_block_new_motion() {
        let path = path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for value in [
            json!({"version":2,"record":null}),
            json!({"version":1,"record":{"kind":"motor","window":"page-motor","command_id":"durable-test","profile":profile(),"joint4_action":null}}),
            json!({"version":1,"record":{"kind":"joint4","window":"page-calibration","command_id":"durable-test","profile":profile(),"joint4_action":null}}),
            json!({"version":1,"record":{"kind":"position","window":"unknown","command_id":"durable-test","profile":profile(),"joint4_action":null}}),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(&path, &bytes).unwrap();
            let tasks = Arc::new(Tasks::default());
            let recovery = Recovery::default();
            recovery.restore(&tasks, Ok(path.clone()));
            assert!(recovery.error_snapshot().unwrap().recovery_error);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(tasks
                .admit(
                    Owner {
                        epoch: 1,
                        window: WindowToken {
                            label: "page-motion".into(),
                            incarnation: 1
                        }
                    },
                    &json!({"op":"position_move","command_id":"new"}),
                    Instant::now()
                )
                .is_err());
        }
        let record = Record {
            kind: Kind::Position,
            window: "page-motion".into(),
            command_id: "durable-test".into(),
            profile: profile(),
            joint4_action: None,
        };
        fs::write(
            &path,
            serde_json::to_vec(&File {
                version: 1,
                record: Some(record),
            })
            .unwrap(),
        )
        .unwrap();
        let tasks = Tasks::default();
        let motor = tasks.restore_motor("motor-old".into(), &profile()).unwrap();
        let recovery = Recovery::default();
        recovery.restore(&tasks, Ok(path.clone()));
        assert!(recovery.error_snapshot().is_some());
        assert_eq!(tasks.snapshot().unwrap().id, motor);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
