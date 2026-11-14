//! Stop fences are captured before a request future can yield. The writer checks
//! them again immediately before sending; a stop cannot be followed by an older
//! queued actuation command. Already-written commands still need robot-side stop.
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub type SendPermit = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Default)]
pub struct CommandQueue(Mutex<[u64; 5]>);

fn domain(message: &Value) -> Option<usize> {
    match message["op"].as_str()? {
        "joint_command" if message["mode"].as_i64() != Some(3) => Some(0),
        "trajectory_command" => Some(1),
        "position_move" | "position_group_start" | "position_group_resume" => Some(2),
        "visual_pick_start" => Some(3),
        "gravity_id_send_goal" => Some(4),
        _ => None,
    }
}

impl CommandQueue {
    pub fn prepare(
        self: &Arc<Self>,
        message: &Value,
        permit: Option<SendPermit>,
    ) -> Option<SendPermit> {
        let mut generations = self.0.lock().unwrap();
        let stopped: &[usize] = match message["op"].as_str() {
            Some("joint_command") if message["mode"].as_i64() == Some(3) => &[0, 1, 2, 3, 4],
            Some("position_cancel" | "position_group_pause") => &[2],
            Some("visual_pick_cancel") => &[3],
            Some("gravity_id_cancel") => &[4],
            Some("trajectory_cancel") => &[1],
            _ => &[],
        };
        // Check a task-bound stop while holding the same lock that prepares
        // newer commands. A delayed watchdog cancel for a completed task must
        // not invalidate commands belonging to its successor.
        if !stopped.is_empty() && permit.as_ref().is_some_and(|permit| !permit()) {
            return permit;
        }
        for index in stopped {
            generations[*index] = generations[*index]
                .checked_add(1)
                .expect("command generation exhausted");
        }
        let Some(domain) = domain(message) else {
            return permit;
        };
        let generation = generations[domain];
        let queue = self.clone();
        Some(Arc::new(move || {
            queue.0.lock().unwrap()[domain] == generation
                && permit.as_ref().is_none_or(|permit| permit())
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stop_revokes_only_older_commands_and_never_read_only_queries() {
        let queue = Arc::new(CommandQueue::default());
        let motor = queue
            .prepare(&json!({"op":"joint_command","mode":1}), None)
            .unwrap();
        let position = queue
            .prepare(&json!({"op":"position_group_resume"}), None)
            .unwrap();
        assert!(queue.prepare(&json!({"op":"topics"}), None).is_none());
        queue.prepare(&json!({"op":"position_cancel"}), None);
        assert!(!position());
        assert!(motor());
        queue.prepare(&json!({"op":"joint_command","mode":3}), None);
        assert!(!motor());
        assert!(queue
            .prepare(&json!({"op":"joint_command","mode":1}), None)
            .unwrap()());
    }
    #[test]
    fn disable_revokes_all_actuation_domains_and_caller_permits_cannot_override_it() {
        let queue = Arc::new(CommandQueue::default());
        let permits: Vec<_> = [
            "trajectory_command",
            "position_move",
            "position_group_start",
            "visual_pick_start",
            "gravity_id_send_goal",
        ]
        .map(|op| {
            queue
                .prepare(&json!({"op":op}), Some(Arc::new(|| true)))
                .unwrap()
        })
        .into();
        queue.prepare(&json!({"op":"joint_command","mode":3}), None);
        assert!(permits.iter().all(|permit| !permit()));
        assert!(!queue
            .prepare(&json!({"op":"position_move"}), Some(Arc::new(|| false)))
            .unwrap()());
    }
    #[test]
    fn trajectory_cancel_revokes_only_older_direct_trajectories() {
        let queue=Arc::new(CommandQueue::default());
        let trajectory=queue.prepare(&json!({"op":"trajectory_command"}),None).unwrap();
        let position=queue.prepare(&json!({"op":"position_move"}),None).unwrap();
        queue.prepare(&json!({"op":"trajectory_cancel"}),None);
        assert!(!trajectory());assert!(position());
        let next=queue.prepare(&json!({"op":"trajectory_command"}),None).unwrap();
        let stale=queue.prepare(&json!({"op":"trajectory_cancel"}),Some(Arc::new(||false))).unwrap();
        assert!(!stale());assert!(next());
    }

    #[test]
    fn stale_task_cancel_does_not_revoke_a_successor_start() {
        let queue = Arc::new(CommandQueue::default());
        let current = queue
            .prepare(&json!({"op":"visual_pick_start"}), None)
            .unwrap();
        let stale_cancel = queue
            .prepare(
                &json!({"op":"visual_pick_cancel"}),
                Some(Arc::new(|| false)),
            )
            .unwrap();
        assert!(!stale_cancel());
        assert!(current());
    }
}
