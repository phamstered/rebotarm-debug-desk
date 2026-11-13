//! A finite controller switch may complete after an earlier DISABLE. Its final
//! stop proof must belong to a new DISABLE issued after remote completion.
use super::motor_task::{Context, Motor};
use serde_json::Value;
use std::time::Instant;
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Finished,
    Disabled,
}
pub struct Stop {
    requested: bool,
    completed: bool,
    completion_barrier: u64,
    proof: Option<Motor>,
    outcome: watch::Sender<Outcome>,
}
impl Stop {
    pub fn new(context: Option<&Context>, epoch: u64, now: Instant) -> Self {
        Self {
            requested: false,
            completed: false,
            completion_barrier: 0,
            proof: Motor::for_confirmation(context, epoch, now),
            outcome: watch::channel(Outcome::Pending).0,
        }
    }
    pub fn outcome(&self) -> watch::Receiver<Outcome> {
        self.outcome.subscribe()
    }
    pub fn finish(&self, outcome: Outcome) {
        self.outcome.send_replace(outcome);
    }
    pub fn request(&mut self) {
        self.requested = true;
    }
    pub fn matches_profile(&self, profile: &Value) -> bool {
        let context = Context::new(0, profile);
        self.proof
            .as_ref()
            .is_some_and(|proof| proof.matches(context.as_ref(), 0))
    }
    pub fn requested(&self) -> bool {
        self.requested
    }
    pub fn completed(&self) -> bool {
        self.completed
    }
    pub fn complete(&mut self, last_issued_action: u64) {
        if self.completed {
            return;
        }
        self.completed = true;
        self.completion_barrier = last_issued_action;
        if let Some(proof) = &mut self.proof {
            proof.clear_confirmation();
        }
    }
    pub fn prepare(
        &mut self,
        context: Option<&Context>,
        epoch: u64,
        now: Instant,
    ) -> Result<(), String> {
        let proof = self
            .proof
            .as_mut()
            .ok_or("缺少原控制会话身份，无法确认 DISABLE")?;
        if !proof.matches(context, epoch) {
            return Err("请重连原机器人以确认输出关闭；未向另一连接发送 DISABLE".into());
        }
        proof.stopping(context, epoch, now);
        Ok(())
    }
    pub fn acknowledge(&mut self, action: u64, epoch: u64, value: &Value) {
        if self.requested && self.completed && action > self.completion_barrier {
            if let Some(proof) = &mut self.proof {
                proof.acknowledge_disable(epoch, value);
            }
        }
    }
    pub fn confirmed(&self, context: Option<&Context>, now: Instant) -> bool {
        self.requested
            && self.completed
            && self
                .proof
                .as_ref()
                .is_some_and(|proof| proof.stopped(context, now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn context(epoch: u64, host: &str) -> Context {
        Context::new(
            epoch,
            &json!({"host":host,"statusTopic":"/status","commandTopic":"/command"}),
        )
        .unwrap()
    }
    fn frame(seq: u32, mode: u8, stamp: u64) -> Value {
        json!({"op":"topic_message","topic":"/status","data":{"last_command_sequence":seq,"mode":mode,"header":{"stamp":{"sec":stamp,"nanosec":0}}}})
    }
    fn ack(seq: u32) -> Value {
        json!({"op":"joint_command_ack","mode":3,"sequence":seq})
    }
    #[test]
    fn early_ack_and_late_old_ack_never_satisfy_the_post_completion_barrier() {
        let now = Instant::now();
        let mut context = context(1, "first");
        let mut stop = Stop::new(Some(&context), 1, now);
        let outcome = stop.outcome();
        stop.request();
        stop.prepare(Some(&context), 1, now).unwrap();
        stop.acknowledge(1, 1, &ack(10));
        context.observe(1, &frame(10, 3, 1), now);
        assert!(!stop.confirmed(Some(&context), now));
        stop.complete(1);
        stop.prepare(Some(&context), 1, now).unwrap();
        stop.acknowledge(1, 1, &ack(10));
        context.observe(1, &frame(10, 3, 2), now);
        assert!(!stop.confirmed(Some(&context), now));
        stop.acknowledge(2, 1, &ack(20));
        context.observe(1, &frame(19, 3, 3), now);
        assert!(!stop.confirmed(Some(&context), now));
        context.observe(1, &frame(20, 1, 4), now);
        assert!(!stop.confirmed(Some(&context), now));
        context.observe(1, &frame(20, 3, 4), now);
        assert!(!stop.confirmed(Some(&context), now));
        context.observe(1, &frame(20, 3, 5), now);
        assert!(stop.confirmed(Some(&context), now));
        stop.finish(Outcome::Disabled);
        drop(stop);
        assert_eq!(*outcome.borrow(), Outcome::Disabled);
    }
    #[test]
    fn new_robot_is_never_disabled_and_reconnect_requires_new_ack_and_feedback() {
        let now = Instant::now();
        let original = context(1, "first");
        let mut stop = Stop::new(Some(&original), 1, now);
        stop.request();
        stop.complete(0);
        assert!(stop.prepare(Some(&context(2, "other")), 2, now).is_err());
        let mut same = context(2, "first");
        same.observe(2, &frame(99, 3, 1), now);
        stop.prepare(Some(&same), 2, now).unwrap();
        stop.acknowledge(1, 1, &ack(100));
        same.observe(2, &frame(100, 3, 2), now);
        assert!(!stop.confirmed(Some(&same), now));
        stop.acknowledge(1, 2, &ack(100));
        assert!(stop.confirmed(Some(&same), now));
        let mut missing = Stop::new(None, 1, now);
        missing.request();
        missing.complete(0);
        assert!(missing.prepare(Some(&same), 2, now).is_err());
    }
}
