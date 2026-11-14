//! A JTC topic ACK is publication, not completion. Only the Bridge verifier's
//! correlated and evidence-bearing terminal may release native ownership.
use serde_json::Value;

/// Exclude the selected local tunnel port, but bind recovery to the original
/// robot, remote Bridge endpoint, ROS graph and feedback configuration.
pub fn connection_identity(profile: &Value) -> Option<String> {
    profile["host"].as_str().filter(|host| !host.is_empty())?;
    Some(
        serde_json::json!([
            profile["host"],
            profile["sshPort"],
            profile["username"],
            profile["identityFile"],
            profile["remotePort"],
            profile["rosDomainId"],
            profile["rosSetupScript"],
            profile["commandTopic"],
            profile["statusTopic"],
            profile["jointStateTopic"]
        ])
        .to_string(),
    )
}

pub fn terminal(value: &Value) -> bool {
    value["op"] == "trajectory_task_state"
        && value["terminal"] == true
        && matches!(
            (value["task_phase"].as_str(), value["evidence"].as_str()),
            (Some("succeeded"), Some("target_observed"))
                | (Some("canceled"), Some("output_disabled"))
                | (Some("failed"), Some("not_published"))
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        tasks::{Owner, Phase, Tasks},
        windows::WindowToken,
    };
    use serde_json::json;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    fn owner(label: &str, epoch: u64) -> Owner {
        Owner {
            epoch,
            window: WindowToken {
                label: label.into(),
                incarnation: epoch,
            },
        }
    }
    fn configured() -> Arc<Tasks> {
        let tasks = Arc::new(Tasks::default());
        tasks.configure_motor(1, &json!({"host":"fixture", "statusTopic":"/status"}));
        tasks
    }
    fn request() -> Value {
        json!({"op":"trajectory_command","command_id":"direct-1"})
    }
    fn proof(phase: &str, evidence: &str) -> Value {
        json!({"op":"trajectory_task_state","command_id":"direct-1","terminal":true,"task_phase":phase,"evidence":evidence})
    }
    fn started() -> (Arc<Tasks>, u64, Instant) {
        let tasks = configured();
        let now = Instant::now();
        let admission = tasks
            .admit(owner("page-motion", 1), &request(), now)
            .unwrap();
        assert!(admission.permit.unwrap()());
        tasks.reply(
            admission.ticket,
            1,
            &request(),
            Ok(&json!({"op":"trajectory_command_ack","command_id":"direct-1","accepted":true})),
        );
        (tasks, admission.ticket.unwrap(), now)
    }
    #[test]
    fn admission_holds_motion_and_migration_until_evidence_bearing_terminal() {
        let tasks = configured();
        assert!(tasks
            .admit(owner("page-monitor", 1), &request(), Instant::now())
            .is_err());
        let (tasks, _, now) = started();
        assert!(tasks.migration("page-motion").is_err());
        assert!(tasks.begin_controller(owner("page-status", 1)).is_err());
        assert!(tasks
            .admit(
                owner("page-motion", 1),
                &json!({"op":"position_move","command_id":"next"}),
                now
            )
            .is_err());
        for message in [
            json!({"op":"trajectory_command_ack","command_id":"direct-1","accepted":true}),
            json!({"op":"trajectory_cancel_ack","command_id":"direct-1","accepted":true}),
            proof("succeeded", "published"),
            proof("canceled", "target_observed"),
            proof("failed", "timeout"),
            {
                let mut v = proof("succeeded", "target_observed");
                v["terminal"] = false.into();
                v
            },
            {
                let mut v = proof("succeeded", "target_observed");
                v["command_id"] = "other".into();
                v
            },
        ] {
            tasks.observe(1, &message);
            assert!(tasks.snapshot().is_some());
        }
        tasks.observe(0, &proof("succeeded", "target_observed"));
        assert!(tasks.snapshot().is_some());
        tasks.observe(1, &proof("succeeded", "target_observed"));
        assert!(tasks.snapshot().is_none());
        assert!(tasks.migration("page-motion").is_ok());
    }
    #[test]
    fn lost_owner_revokes_heartbeat_and_cancels_once_then_only_queries() {
        let (tasks, id, now) = started();
        let beat = tasks.poll(1, now).unwrap();
        assert_eq!(beat.message["op"], "trajectory_heartbeat");
        assert!((beat.permit)());
        tasks.finish_action(id, beat.action);
        tasks.lost(Some(&owner("page-motion", 1)), "owner closed");
        assert!(!(beat.permit)());
        let cancel = tasks.poll(1, now).unwrap();
        assert_eq!(
            cancel.message,
            json!({"op":"trajectory_cancel","command_id":"direct-1"})
        );
        tasks.observe(
            1,
            &json!({"op":"trajectory_cancel_ack","command_id":"direct-1","accepted":true}),
        );
        assert!(tasks.snapshot().is_some());
        tasks.finish_action(id, cancel.action);
        let query = tasks.poll(1, now + Duration::from_secs(1)).unwrap();
        assert_eq!(query.message["op"], "trajectory_task_status");
        tasks.observe(1, &proof("canceled", "output_disabled"));
        assert!(!(cancel.permit)());
        assert!(!(query.permit)());
    }
    #[test]
    fn only_owner_activity_renews_and_disable_ack_is_not_terminal() {
        let (tasks, id, now) = started();
        tasks.touch(&owner("page-monitor", 1), now + Duration::from_secs(5));
        let cancel = tasks.poll(1, now + Duration::from_secs(5)).unwrap();
        assert_eq!(cancel.message["op"], "trajectory_cancel");
        tasks.finish_action(id, cancel.action);
        let disable = json!({"op":"joint_command","mode":3});
        let a = tasks.admit(owner("page-motor", 1), &disable, now).unwrap();
        assert!(a.permit.unwrap()());
        tasks.reply(
            a.ticket,
            1,
            &disable,
            Ok(&json!({"op":"joint_command_ack","mode":3,"sequence":100})),
        );
        assert!(tasks.snapshot().is_some());
        tasks.observe(1, &proof("canceled", "output_disabled"));
        assert!(tasks.snapshot().is_none());
    }
    #[test]
    fn old_bridge_ack_generic_error_and_lost_reply_preserve_uncertain_publication() {
        for response in [
            Ok(json!({"op":"trajectory_command_ack","points":2})),
            Ok(json!({"op":"error","message":"publication failure"})),
            Ok(json!({"op":"trajectory_command_ack","command_id":"direct-1","accepted":false})),
            Err("timeout"),
        ] {
            let tasks = configured();
            let now = Instant::now();
            let a = tasks
                .admit(owner("page-motion", 1), &request(), now)
                .unwrap();
            assert!(a.permit.unwrap()());
            tasks.reply(a.ticket, 1, &request(), response.as_ref().map_err(|e| *e));
            assert_eq!(tasks.snapshot().unwrap().phase, Phase::Stopping);
            assert_eq!(
                tasks.poll(1, now).unwrap().message["op"],
                "trajectory_cancel"
            );
        }
        let tasks = configured();
        let a = tasks
            .admit(owner("page-motion", 1), &request(), Instant::now())
            .unwrap();
        assert!(a.permit.unwrap()());
        tasks.reply(a.ticket,1,&request(),Ok(&json!({"op":"trajectory_command_ack","command_id":"direct-1","accepted":false,"evidence":"not_published"})));
        assert!(tasks.snapshot().is_none());
    }
    #[test]
    fn explicit_cancel_is_id_bound_and_unsent_or_successor_commands_cannot_escape() {
        let tasks = configured();
        let now = Instant::now();
        let a = tasks
            .admit(owner("page-motion", 1), &request(), now)
            .unwrap();
        assert!(tasks
            .cancel_trajectory(a.ticket.unwrap() + 1, "direct-1")
            .is_err());
        assert!(tasks.cancel_trajectory(a.ticket.unwrap(), "other").is_err());
        tasks
            .cancel_trajectory(a.ticket.unwrap(), "direct-1")
            .unwrap();
        assert!(!a.permit.unwrap()());
        assert!(tasks.poll(1, now).is_none());
        assert!(tasks.snapshot().is_none());
        let next = tasks
            .admit(owner("page-motion", 1), &request(), now)
            .unwrap();
        assert!(tasks
            .cancel_trajectory(a.ticket.unwrap(), "direct-1")
            .is_err());
        assert!(next.permit.unwrap()());
    }
    #[test]
    fn reconnected_sessions_query_exact_retained_result_without_resuming_or_canceling() {
        let (tasks, id, now) = started();
        tasks.lost(None, "disconnect");
        tasks.configure_motor(2, &json!({"host":"other", "statusTopic":"/status"}));
        assert!(tasks.poll(2, now).is_none());
        tasks.configure_motor(2, &json!({"host":"fixture", "statusTopic":"/status"}));
        let query = tasks.poll(2, now).unwrap();
        assert!(query.recovery);
        assert_eq!(query.message["op"], "trajectory_task_status");
        let valid = json!({"op":"trajectory_task_status","command_id":"direct-1","known":true,"terminal":true,"busy":false,
            "task_phase":"canceled","result":proof("canceled","output_disabled")});
        tasks.configure_motor(2, &json!({"host":"other", "statusTopic":"/status"}));
        assert!(!tasks.recover(id, 2, &valid));
        tasks.configure_motor(2, &json!({"host":"fixture", "statusTopic":"/status"}));
        for key in [
            "command_id",
            "known",
            "terminal",
            "busy",
            "result",
            "task_phase",
        ] {
            let mut bad = valid.clone();
            bad[key] = Value::Null;
            assert!(!tasks.recover(id, 2, &bad));
        }
        let mut bad = valid.clone();
        bad["result"]["evidence"] = "published".into();
        assert!(!tasks.recover(id, 2, &bad));
        assert!(!tasks.recover(id, 0, &valid));
        assert!(tasks.recover(id, 2, &valid));
        assert!(tasks.snapshot().is_none());
    }
    #[test]
    fn recovery_identity_ignores_local_port_but_includes_robot_graph_and_feedback_sources() {
        let profile = json!({"host":"fixture","localPort":1000,"jointStateTopic":"/joints"});
        let id = connection_identity(&profile);
        let mut local = profile.clone();
        local["localPort"] = 2000.into();
        assert_eq!(connection_identity(&local), id);
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
            let mut other = profile.clone();
            other[key] = "changed".into();
            assert_ne!(connection_identity(&other), id);
        }
        assert!(connection_identity(&Value::Null).is_none());
    }

    #[test]
    fn unknown_or_malformed_state_stops_renewal_and_requests_cancel() {
        for state in [
            serde_json::json!({"task_phase":"uncertain","terminal":false}),
            serde_json::json!({"task_phase":"unrecognized","terminal":false}),
            serde_json::json!({"task_phase":"running","terminal":"false"}),
        ] {
            let (tasks, _, now) = started();
            let mut value = state;
            value["op"] = "trajectory_task_state".into();
            value["command_id"] = "direct-1".into();
            tasks.observe(1, &value);
            assert_eq!(tasks.snapshot().unwrap().phase, Phase::Uncertain);
            assert_eq!(
                tasks.poll(1, now).unwrap().message["op"],
                "trajectory_cancel"
            );
        }
    }
}
