//! Motor completion is a firmware acknowledgement, never a publish ACK alone.
use serde_json::{json, Value};
use std::time::{Duration, Instant};
#[derive(Clone)]
pub struct Status {
    pub sequence: u32,
    pub mode: u64,
    pub stamp: u64,
    pub at: Instant,
}
#[derive(Clone)]
pub struct Context {
    pub epoch: u64,
    pub identity: String,
    pub topic: String,
    pub status: Option<Status>,
}
impl Context {
    pub fn new(epoch: u64, profile: &Value) -> Option<Self> {
        let topic = profile["statusTopic"].as_str()?.to_owned();
        if topic.is_empty() || profile["host"].as_str()?.is_empty() {
            return None;
        }
        Some(Self {
            epoch,
            identity: json!([
                profile["host"],
                profile["username"],
                profile["sshPort"],
                profile["remotePort"],
                profile["rosDomainId"],
                profile["commandTopic"],
                profile["statusTopic"]
            ])
            .to_string(),
            topic,
            status: None,
        })
    }
    pub fn observe(&mut self, epoch: u64, value: &Value, now: Instant) {
        if epoch != self.epoch || value["op"] != "topic_message" || value["topic"] != self.topic {
            return;
        }
        let data = &value["data"];
        let Some(sequence) = data["last_command_sequence"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
        else {
            return;
        };
        let Some(mode) = data["mode"].as_u64().filter(|v| *v <= 3) else {
            return;
        };
        let stamp = &data["header"]["stamp"];
        let Some(sec) = stamp["sec"].as_u64() else {
            return;
        };
        let Some(nanos) = stamp["nanosec"].as_u64().filter(|v| *v < 1_000_000_000) else {
            return;
        };
        let Some(stamp) = sec
            .checked_mul(1_000_000_000)
            .and_then(|v| v.checked_add(nanos))
        else {
            return;
        };
        // A replay cannot refresh source freshness or prove a new DISABLE.
        if self
            .status
            .as_ref()
            .is_some_and(|previous| stamp <= previous.stamp)
        {
            return;
        }
        self.status = Some(Status {
            sequence,
            mode,
            stamp,
            at: now,
        });
    }
}
pub struct Motor {
    pub identity: String,
    pub last_command: Instant,
    stop: Option<Stop>,
}
struct Stop {
    epoch: u64,
    sent_at: Instant,
    stamp: u64,
    sequence: Option<u32>,
}
impl Motor {
    // Captures identity for future output-off confirmation only. It grants no
    // actuation permission; Motor::start still requires fresh feedback.
    pub fn for_confirmation(context: Option<&Context>, epoch: u64, now: Instant) -> Option<Self> {
        context.filter(|c| c.epoch == epoch).map(|c| Self {
            identity: c.identity.clone(),
            last_command: now,
            stop: None,
        })
    }
    pub fn clear_confirmation(&mut self) {
        self.stop = None;
    }
    pub fn start(context: Option<&Context>, epoch: u64, now: Instant) -> Result<Self, String> {
        let context = context
            .filter(|c| c.epoch == epoch)
            .ok_or("Motor 缺少当前连接上下文")?;
        if context
            .status
            .as_ref()
            .is_none_or(|s| now.saturating_duration_since(s.at) >= Duration::from_secs(1))
        {
            return Err("Motor HardwareStatus 缺失或已过期".into());
        }
        Ok(Self {
            identity: context.identity.clone(),
            last_command: now,
            stop: None,
        })
    }
    pub fn matches(&self, context: Option<&Context>, epoch: u64) -> bool {
        context.is_some_and(|c| c.epoch == epoch && c.identity == self.identity)
    }
    pub fn stopping(&mut self, context: Option<&Context>, epoch: u64, now: Instant) {
        if !self.matches(context, epoch) {
            return;
        }
        let stamp = context
            .and_then(|c| c.status.as_ref())
            .map_or(0, |s| s.stamp);
        self.stop = Some(Stop {
            epoch,
            sent_at: now,
            stamp,
            sequence: None,
        });
    }
    pub fn acknowledge_disable(&mut self, epoch: u64, value: &Value) {
        if value["op"] != "joint_command_ack" || value["mode"] != 3 {
            return;
        }
        let Some(stop) = self.stop.as_mut().filter(|s| s.epoch == epoch) else {
            return;
        };
        stop.sequence = value["sequence"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok());
    }
    pub fn stopped(&self, context: Option<&Context>, now: Instant) -> bool {
        let Some(stop) = &self.stop else {
            return false;
        };
        if !self.matches(context, stop.epoch) {
            return false;
        }
        let Some(status) = context.and_then(|c| c.status.as_ref()) else {
            return false;
        };
        status.mode == 3
            && status.stamp > stop.stamp
            && status.at >= stop.sent_at
            && now.saturating_duration_since(status.at) < Duration::from_secs(1)
            && stop
                .sequence
                .is_some_and(|sequence| status.sequence >= sequence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(host: &str) -> Value {
        json!({"host":host,"username":"bot","sshPort":22,"remotePort":8765,"rosDomainId":0,"statusTopic":"/status","commandTopic":"/command"})
    }
    fn status(seq: u32, mode: u8, stamp: u64) -> Value {
        json!({"op":"topic_message","topic":"/status","data":{"last_command_sequence":seq,"mode":mode,"header":{"stamp":{"sec":stamp,"nanosec":0}}}})
    }
    #[test]
    fn disable_publish_ack_requires_new_matching_firmware_feedback() {
        let now = Instant::now();
        let mut context = Context::new(1, &profile("first")).unwrap();
        context.observe(1, &status(10, 3, 1), now);
        let mut motor = Motor::start(Some(&context), 1, now).unwrap();
        motor.stopping(Some(&context), 1, now);
        motor.acknowledge_disable(1, &json!({"op":"joint_command_ack","mode":3,"sequence":13}));
        assert!(!motor.stopped(Some(&context), now));
        context.observe(1, &status(12, 3, 2), now);
        assert!(!motor.stopped(Some(&context), now));
        context.observe(1, &status(13, 1, 3), now);
        assert!(!motor.stopped(Some(&context), now));
        context.observe(1, &status(13, 3, 4), now);
        assert!(motor.stopped(Some(&context), now));
        assert!(!motor.stopped(Some(&context), now + Duration::from_secs(1)));
    }
    #[test]
    fn source_epoch_topic_stamp_and_profile_are_all_required() {
        let now = Instant::now();
        let mut context = Context::new(1, &profile("first")).unwrap();
        assert!(Motor::start(Some(&context), 1, now).is_err());
        context.observe(1, &status(2, 1, 5), now);
        let mut motor = Motor::start(Some(&context), 1, now).unwrap();
        motor.stopping(Some(&context), 1, now);
        motor.acknowledge_disable(1, &json!({"op":"joint_command_ack","mode":3,"sequence":3}));
        let mut wrong = status(3, 3, 6);
        wrong["topic"] = json!("/other");
        context.observe(1, &wrong, now);
        context.observe(0, &status(3, 3, 6), now);
        context.observe(1, &status(3, 3, 5), now);
        assert!(!motor.stopped(Some(&context), now));
        let other = Context::new(2, &profile("other")).unwrap();
        assert!(!motor.matches(Some(&other), 2));
        let mut same = Context::new(2, &profile("first")).unwrap();
        same.observe(2, &status(10, 3, 1), now);
        assert!(!motor.stopped(Some(&same), now));
        motor.stopping(Some(&same), 2, now);
        motor.acknowledge_disable(1, &json!({"op":"joint_command_ack","mode":3,"sequence":13}));
        same.observe(2, &status(13, 3, 2), now);
        assert!(!motor.stopped(Some(&same), now));
        motor.acknowledge_disable(2, &json!({"op":"joint_command_ack","mode":3,"sequence":13}));
        assert!(motor.stopped(Some(&same), now));
    }
}
