//! Joint4's pose hold outlives the Trigger response. The Bridge owns the lease
//! and service serialization; the desktop owns the invoking page and identity.
use super::{
    runtime::{Attachment, Runtime},
    tasks::Admission,
    transport::Transport,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};

pub struct State {
    pub action: String,
    pub operation: Option<String>,
}

pub fn validate(label: &str, value: &Value) -> Result<(), String> {
    if label != "page-calibration" {
        return Err("只有 Calibration 页面可以操作 Joint4 标定".into());
    }
    let action = if value["op"] == "joint4_capture" {
        "capture_pose"
    } else {
        value["action"].as_str().ok_or("Joint4 缺少操作类型")?
    };
    match action {
        "begin_pose" | "release_pose" if value["confirmation"] == "SUPPORTED" => (),
        "capture_pose" if value["confirmation"] == "HANDS_CLEAR" => (),
        "fit" | "reset" => (),
        _ => return Err("Joint4 操作无效或缺少现场确认".into()),
    }
    for field in if action == "capture_pose" {
        &["command_id", "operation_id"][..]
    } else {
        &["command_id"][..]
    } {
        if !value[*field].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 80
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
        }) {
            return Err(format!("Joint4 {field} 无效"));
        }
    }
    if value["op"] == "joint4_start" && action == "capture_pose" {
        return Err("Capture 必须属于现有姿态任务".into());
    }
    Ok(())
}

pub fn terminal(v: &Value, action: &str) -> bool {
    if v["op"] != "joint4_task_state" || v["terminal"] != true || v["action"] != action {
        return false;
    }
    match (v["task_phase"].as_str(), v["evidence"].as_str()) {
        (Some("canceled"), Some("pose_released" | "output_disabled")) => true,
        (Some("succeeded"), Some("service_verified")) => matches!(action, "fit" | "reset"),
        (Some("failed"), Some("not_called" | "service_rejected")) => true,
        _ => false,
    }
}

pub fn start_reply(v: &Value, request: &Value) -> bool {
    v["op"] == "joint4_start_ack"
        && v["command_id"] == request["command_id"]
        && v["action"] == request["action"]
        && v["accepted"].is_boolean()
        && v["success"].is_boolean()
        && v["message"].as_str().is_some_and(|s| s.len() <= 16384)
        && (v["accepted"] == true || (v["success"] == false && v["evidence"] == "not_called"))
}

pub fn capture_reply(v: &Value, request: &Value) -> bool {
    v["op"] == "joint4_capture_ack"
        && v["command_id"] == request["command_id"]
        && v["operation_id"] == request["operation_id"]
        && v["success"].is_boolean()
        && v["message"].as_str().is_some_and(|s| s.len() <= 16384)
}

pub struct Job {
    pub attachment: Attachment,
    pub transport: Arc<Transport>,
    pub message: Value,
    pub admission: Admission,
}

pub enum Prepared {
    Job(Job),
    Release(Value),
}

impl Job {
    pub async fn run(self, hub: &Runtime) -> Result<Value, String> {
        let result = self
            .transport
            .request_guarded(
                self.message.clone(),
                Duration::from_secs(15),
                self.admission.permit,
            )
            .await;
        hub.finish_joint4(
            &self.attachment,
            self.admission.ticket,
            &self.message,
            result.as_ref().map(|f| &f.metadata).map_err(String::as_str),
        );
        let value = &result?.metadata;
        let capture = self.message["op"] == "joint4_capture";
        let valid = if capture {
            capture_reply(value, &self.message)
        } else {
            start_reply(value, &self.message)
        };
        if !valid {
            return Err("Joint4 服务回执未确认，保留任务并请求释放；不会重发操作".into());
        }
        Ok(
            json!({"success":value["success"], "message":value["message"],
            "pending": !capture && self.message["action"] == "release_pose",
            "command_id":self.message["command_id"]}),
        )
    }
}

pub async fn start(
    app: AppHandle,
    label: String,
    hub: &Runtime,
    profile: crate::ConnectionProfile,
    action: String,
    confirmation: Option<String>,
) -> Result<Value, String> {
    // Reservation and owner identity are captured before the first await. The
    // detached worker handles any sent request even when the IPC future dies.
    match hub.prepare_joint4(&label, &profile, &action, confirmation.as_deref())? {
        Prepared::Release(reply) => Ok(reply),
        Prepared::Job(job) => owned(async move { job.run(&app.state::<Runtime>()).await }).await,
    }
}

async fn owned<F>(work: F) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    tokio::spawn(work)
        .await
        .map_err(|e| format!("Joint4 原生任务异常，需核验终态：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        command_queue::CommandQueue,
        tasks::{Owner, Phase, Tasks},
        windows::WindowToken,
    };
    use std::time::Instant;
    fn owner(epoch: u64) -> Owner {
        Owner {
            epoch,
            window: WindowToken {
                label: "page-calibration".into(),
                incarnation: epoch,
            },
        }
    }
    fn request(action: &str) -> Value {
        json!({"op":"joint4_start","command_id":"pose-1","action":action,"confirmation":"SUPPORTED"})
    }
    fn ack() -> Value {
        json!({"op":"joint4_start_ack","command_id":"pose-1","action":"begin_pose","accepted":true,"success":true,"message":"holding"})
    }
    fn proof(action: &str, phase: &str, evidence: &str) -> Value {
        json!({"op":"joint4_task_state","command_id":"pose-1","action":action,"terminal":true,"task_phase":phase,"evidence":evidence})
    }
    fn capture() -> Value {
        json!({"op":"joint4_capture","command_id":"pose-1","operation_id":"sample-1","confirmation":"HANDS_CLEAR"})
    }
    fn configured() -> Arc<Tasks> {
        let t = Arc::new(Tasks::default());
        t.configure_motor(1, &json!({"host":"fixture"}));
        t
    }
    fn started() -> (Arc<Tasks>, u64, Instant) {
        let t = configured();
        let now = Instant::now();
        let a = t.admit(owner(1), &request("begin_pose"), now).unwrap();
        assert!(a.permit.unwrap()());
        t.reply(a.ticket, 1, &request("begin_pose"), Ok(&ack()));
        (t, a.ticket.unwrap(), now)
    }
    #[test]
    fn joint4_whitelist_confirmation_and_ids_are_required() {
        for action in ["begin_pose", "release_pose", "fit", "reset"] {
            assert!(validate("page-calibration", &request(action)).is_ok());
        }
        assert!(validate("page-calibration", &capture()).is_ok());
        assert!(validate("page-motion", &request("begin_pose")).is_err());
        assert!(validate("page-calibration", &request("shell;reboot")).is_err());
        assert!(validate("page-calibration", &request("capture_pose")).is_err());
        for action in ["begin_pose", "release_pose"] {
            let mut v = request(action);
            v["confirmation"] = Value::Null;
            assert!(validate("page-calibration", &v).is_err());
        }
        for field in ["operation_id", "confirmation", "command_id"] {
            let mut v = capture();
            v[field] = Value::Null;
            assert!(validate("page-calibration", &v).is_err());
        }
        let mut v = request("fit");
        v["command_id"] = json!("x".repeat(81));
        assert!(validate("page-calibration", &v).is_err());
    }
    #[test]
    fn pose_ack_keeps_global_lock_and_only_matching_evidence_finishes() {
        let (t, _, now) = started();
        assert!(t.migration("page-calibration").is_err());
        let mut other = owner(1);
        other.window.label = "page-motion".into();
        assert!(t.begin_controller(other.clone()).is_err());
        assert!(t
            .admit(
                other.clone(),
                &json!({"op":"position_move","command_id":"conflict"}),
                now
            )
            .is_err());
        assert!(t.joint4_command(&other, true).is_err());
        for p in [
            ack(),
            proof("begin_pose", "succeeded", "service_verified"),
            proof("begin_pose", "canceled", "service_verified"),
            proof("fit", "succeeded", "service_verified"),
            proof("begin_pose", "failed", "timeout"),
        ] {
            t.observe(1, &p);
            assert!(t.snapshot().is_some());
        }
        t.observe(0, &proof("begin_pose", "canceled", "pose_released"));
        assert!(t.snapshot().is_some());
        t.observe(1, &proof("begin_pose", "canceled", "pose_released"));
        assert!(t.snapshot().is_none());
        assert!(t.migration("page-calibration").is_ok());
    }
    #[test]
    fn capture_has_one_inflight_operation_and_requires_same_owner_admission() {
        let t = configured();
        let now = Instant::now();
        assert!(t.admit(owner(1), &capture(), now).is_err());
        let a = t.admit(owner(1), &request("begin_pose"), now).unwrap();
        assert!(a.permit.unwrap()());
        assert!(t.admit(owner(1), &capture(), now).is_err());
        t.reply(a.ticket, 1, &request("begin_pose"), Ok(&ack()));
        assert!(t.admit(owner(2), &capture(), now).is_err());
        let a = t.admit(owner(1), &capture(), now).unwrap();
        assert!(a.ticket.is_none());
        assert!(a.permit.unwrap()());
        assert!(t.admit(owner(1), &capture(), now).is_err());
        let mut old = capture();
        old["operation_id"] = "old".into();
        t.reply(None, 1, &old, Err("late"));
        assert!(t.admit(owner(1), &capture(), now).is_err());
        let response = json!({"op":"joint4_capture_ack","command_id":"pose-1","operation_id":"sample-1","success":true,"message":"sample 1"});
        t.reply(None, 1, &capture(), Ok(&response));
        assert_eq!(t.snapshot().unwrap().phase, Phase::Running);
        let mut next = capture();
        next["operation_id"] = "sample-2".into();
        let a = t.admit(owner(1), &next, now).unwrap();
        t.joint4_command(&owner(1), true).unwrap();
        assert!(!a.permit.unwrap()());
        assert!(t.admit(owner(1), &capture(), now).is_err());
        t.reply(None, 1, &next, Err("canceled before send"));
        assert_eq!(t.snapshot().unwrap().phase, Phase::Stopping);
    }
    #[test]
    fn lost_or_malformed_service_reply_cancels_without_replaying() {
        for reply in [
            Err("timeout"),
            Ok(json!({"op":"error"})),
            Ok(json!({"op":"joint4_start_ack","accepted":false,"command_id":"pose-1"})),
            Ok({
                let mut v = ack();
                v["success"] = Value::Null;
                v
            }),
        ] {
            let t = configured();
            let now = Instant::now();
            let a = t.admit(owner(1), &request("begin_pose"), now).unwrap();
            assert!(a.permit.unwrap()());
            t.reply(
                a.ticket,
                1,
                &request("begin_pose"),
                reply.as_ref().map_err(|e| *e),
            );
            assert_eq!(t.snapshot().unwrap().phase, Phase::Stopping);
            assert_eq!(t.poll(1, now).unwrap().message["op"], "joint4_cancel");
        }
        let t = configured();
        let a = t
            .admit(owner(1), &request("begin_pose"), Instant::now())
            .unwrap();
        assert!(a.permit.unwrap()());
        let mut rejected = ack();
        rejected["accepted"] = false.into();
        rejected["success"] = false.into();
        rejected["evidence"] = "not_called".into();
        t.reply(a.ticket, 1, &request("begin_pose"), Ok(&rejected));
        assert!(t.snapshot().is_none());
        let (t, _, now) = started();
        let a = t.admit(owner(1), &capture(), now).unwrap();
        assert!(a.permit.unwrap()());
        t.reply(None, 1, &capture(), Err("sample reply lost"));
        assert_eq!(t.poll(1, now).unwrap().message["op"], "joint4_cancel");
    }
    #[test]
    fn owner_loss_revokes_renewal_and_cancel_ack_never_claims_output_off() {
        let (t, id, now) = started();
        let beat = t.poll(1, now).unwrap();
        assert_eq!(beat.message["op"], "joint4_heartbeat");
        assert!((beat.permit)());
        t.finish_action(id, beat.action);
        t.lost(Some(&owner(1)), "window lost");
        assert!(!(beat.permit)());
        let cancel = t.poll(1, now).unwrap();
        assert_eq!(cancel.message["op"], "joint4_cancel");
        t.observe(
            1,
            &json!({"op":"joint4_cancel_ack","command_id":"pose-1","accepted":true}),
        );
        assert!(t.snapshot().is_some());
        t.finish_action(id, cancel.action);
        let query = t.poll(1, now + Duration::from_secs(1)).unwrap();
        assert_eq!(query.message["op"], "joint4_task_status");
        t.observe(1, &proof("begin_pose", "canceled", "output_disabled"));
        assert!(t.snapshot().is_none());
        assert!(!(cancel.permit)());
    }
    #[test]
    fn unsubmitted_release_and_disable_revoke_queued_start_and_capture() {
        let t = configured();
        let now = Instant::now();
        let a = t.admit(owner(1), &request("begin_pose"), now).unwrap();
        t.joint4_command(&owner(1), true).unwrap();
        assert!(!a.permit.unwrap()());
        assert!(t.poll(1, now).is_none());
        assert!(t.snapshot().is_none());
        let queue = Arc::new(CommandQueue::default());
        for stop in [
            json!({"op":"joint4_cancel"}),
            json!({"op":"joint_command","mode":3}),
        ] {
            let begin = queue.prepare(&request("begin_pose"), None).unwrap();
            let capture = queue.prepare(&capture(), None).unwrap();
            queue.prepare(&stop, None);
            assert!(!begin());
            assert!(!capture());
            let next = queue.prepare(&request("begin_pose"), None).unwrap();
            queue.prepare(&stop, Some(Arc::new(|| false)));
            assert!(next());
        }
    }
    #[test]
    fn reconnect_only_queries_original_robot_and_requires_complete_retained_proof() {
        let (t, id, now) = started();
        t.lost(None, "disconnected");
        t.configure_motor(2, &json!({"host":"another"}));
        assert!(t.poll(2, now).is_none());
        let valid = json!({"op":"joint4_task_status","command_id":"pose-1","known":true,"terminal":true,"busy":false,"task_phase":"canceled","result":proof("begin_pose","canceled","pose_released")});
        assert!(!t.recover(id, 2, &valid));
        t.configure_motor(2, &json!({"host":"fixture"}));
        let query = t.poll(2, now).unwrap();
        assert!(query.recovery);
        assert_eq!(query.message["op"], "joint4_task_status");
        for key in [
            "command_id",
            "known",
            "terminal",
            "busy",
            "task_phase",
            "result",
        ] {
            let mut invalid = valid.clone();
            invalid[key] = Value::Null;
            assert!(!t.recover(id, 2, &invalid));
        }
        assert!(!t.recover(id, 1, &valid));
        assert!(t.recover(id, 2, &valid));
        assert!(t.snapshot().is_none());
    }
    #[test]
    fn finite_service_success_and_rejection_are_action_bound() {
        for action in ["fit", "reset"] {
            assert!(terminal(
                &proof(action, "succeeded", "service_verified"),
                action
            ));
            assert!(terminal(
                &proof(action, "failed", "service_rejected"),
                action
            ));
            assert!(!terminal(
                &proof("begin_pose", "succeeded", "service_verified"),
                action
            ));
        }
        assert!(!capture_reply(
            &json!({"op":"joint4_capture_ack","success":true,"message":"unrelated"}),
            &capture()
        ));
    }
    #[tokio::test]
    async fn service_worker_finishes_after_invoking_future_is_aborted() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (reply, pending) = tokio::sync::oneshot::channel();
        let (complete, finished) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(owned(async move {
            started.send(()).unwrap();
            let result = pending.await.unwrap();
            complete.send(result).unwrap();
            Ok(json!({"success":true}))
        }));
        ready.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        reply.send("service reply verified").unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), finished)
                .await
                .unwrap()
                .unwrap(),
            "service reply verified"
        );
    }
    #[test]
    fn mismatched_nonterminal_action_never_admits_capture() {
        let t = configured();
        let now = Instant::now();
        let a = t.admit(owner(1), &request("begin_pose"), now).unwrap();
        assert!(a.permit.unwrap()());
        t.observe(1, &json!({"op":"joint4_task_state","command_id":"pose-1","terminal":false,"task_phase":"running","action":"fit"}));
        assert_eq!(t.snapshot().unwrap().phase, Phase::Uncertain);
        assert!(t.admit(owner(1), &capture(), now).is_err());
        assert_eq!(t.poll(1, now).unwrap().message["op"], "joint4_cancel");
    }
}
