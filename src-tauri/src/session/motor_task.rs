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
    pub control: Option<super::motor_v2_task::Evidence>,
    pub control_seen: bool,
    pub retired_control_boots: Vec<String>,
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
            control: None, control_seen: false, retired_control_boots: Vec::new(),
        })
    }
    pub fn observe(&mut self, epoch: u64, value: &Value, now: Instant) {
        if epoch == self.epoch && value["motor_control"].is_object() {
            self.control_seen |= value["motor_control"]["supported"] == true;
            if let Some(control) = super::motor_v2_task::Evidence::parse(&value["motor_control"], now) {
                let retired = self.retired_control_boots.contains(&control.boot);
                let rollback = self.control.as_ref().is_some_and(|old| old.boot == control.boot
                    && (control.stamp < old.stamp || control.value["control_epoch"].as_u64() < old.value["control_epoch"].as_u64()));
                let new_boot = self.control.as_ref().is_some_and(|old| old.boot != control.boot);
                if retired || rollback || (new_boot && self.retired_control_boots.len() >= 16) {
                    if let Some(old) = &mut self.control { old.value["fresh"] = json!(false); }
                } else if new_boot {
                    self.retired_control_boots.push(self.control.as_ref().unwrap().boot.clone());
                    self.status = None; self.control = Some(control);
                } else if self.control.as_ref().is_none_or(|old| control.stamp > old.stamp) { self.control = Some(control); }
            } else if self.control_seen {
                // Keep the source watermark so a cached reply cannot make an
                // explicitly invalidated snapshot fresh again.
                if let Some(old) = &mut self.control { old.value["fresh"] = json!(false); }
            }
        }
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
    pub v2: Option<super::motor_v2_task::Operation>,
    pub requires_control_status: bool,
    bound_control: Option<(String, u32)>,
}
struct Stop {
    epoch: u64,
    sent_at: Instant,
    stamp: u64,
    sequence: Option<u32>,
    control_boot: Option<String>,
    control_stamp: u64,
}
impl Motor {
    // Captures identity for future output-off confirmation only. It grants no
    // actuation permission; Motor::start still requires fresh feedback.
    pub fn for_confirmation(context: Option<&Context>, epoch: u64, now: Instant) -> Option<Self> {
        context.filter(|c| c.epoch == epoch).map(|c| Self {
            identity: c.identity.clone(),
            last_command: now,
            stop: None, v2: None, requires_control_status: c.control_seen, bound_control: None,
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
            stop: None, v2: None, requires_control_status: context.control_seen,
            bound_control: context.control.as_ref().and_then(|e|e.value["control_epoch"].as_u64()
                .and_then(|epoch|u32::try_from(epoch).ok()).map(|epoch|(e.boot.clone(),epoch))),
        })
    }
    pub fn start_request(context: Option<&Context>, epoch: u64, now: Instant, request: &Value) -> Result<Self, String> {
        let mut motor = Self::start(context, epoch, now)?;
        if super::motor_command::v2(request) {
            motor.v2 = Some(super::motor_v2_task::Operation::new(request, context.and_then(|c|c.control.as_ref()), now)?);
            motor.requires_control_status = true;
        } else if context.is_some_and(|c| c.control_seen) && !Self::mit_evidence(context, now) {
            return Err("V2 驱动状态未确认整组 MIT 或租约尚未释放".into());
        }
        Ok(motor)
    }
    fn mit_evidence(context: Option<&Context>, now: Instant) -> bool {
        context.and_then(|c| c.control.as_ref()).is_some_and(|e| e.fresh(now)
            && e.matches_mode(0x7f, "MIT") && e.value["lease_id"] == 0
            && e.value["owner_source_id"] == "0" && e.value["switching"] == false && e.value["fault_code"] == 0)
    }
    pub fn ready_to_write(&self, request: &Value, context: Option<&Context>, now: Instant) -> bool {
        if now.saturating_duration_since(self.last_command) >= self.timeout() { return false; }
        self.v2.as_ref().map_or_else(|| !context.is_some_and(|c| c.control_seen)
            || (Self::mit_evidence(context, now) && self.bound_control.as_ref().is_some_and(|(boot,epoch)|
                context.and_then(|c|c.control.as_ref()).is_some_and(|e| &e.boot == boot && e.value["control_epoch"] == *epoch))),
            |op| op.ready_to_write(request, context.and_then(|c| c.control.as_ref()), now))
    }
    pub fn continuation(&self, request: &Value) -> bool {
        self.v2.as_ref().map_or(request["op"] == "joint_command", |v|v.continuation(request))
    }
    pub fn timeout(&self) -> Duration { self.v2.as_ref().map_or(Duration::from_millis(250), |v|v.timeout()) }
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
            control_boot: context.and_then(|c|c.control.as_ref()).map(|c|c.boot.clone()),
            control_stamp: context.and_then(|c|c.control.as_ref()).map_or(0,|c|c.stamp),
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
        let control_off = if self.requires_control_status || context.is_some_and(|c|c.control_seen) {
            context.and_then(|c|c.control.as_ref()).is_some_and(|c| c.fresh(now) && c.disabled()
                && stop.control_boot.as_deref() == Some(c.boot.as_str()) && c.stamp > stop.control_stamp
                && c.at >= stop.sent_at && stop.sequence.is_some_and(|seq| c.value["last_command_sequence"].as_u64()
                    .and_then(|v|u32::try_from(v).ok()).is_some_and(|got| sequence_covers(got,seq))))
        } else { true };
        control_off && status.mode == 3
            && status.stamp > stop.stamp
            && status.at >= stop.sent_at
            && now.saturating_duration_since(status.at) < Duration::from_secs(1)
            && stop
                .sequence
                .is_some_and(|sequence| sequence_covers(status.sequence, sequence))
    }
}

pub fn sequence_covers(current: u32, expected: u32) -> bool { current.wrapping_sub(expected) < 0x8000_0000 }

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
    #[test]
    fn known_v2_cannot_fall_back_to_mit_or_v1_stop_when_evidence_is_lost() {
        let now = Instant::now(); let mut context = Context::new(1, &profile("first")).unwrap();
        context.observe(1, &status(1, 3, 1), now);
        let mut caps = super::super::motor_v2_task::tests::caps();
        context.observe(1, &json!({"op":"motor_control_status","motor_control":caps}), now);
        assert!(Motor::start_request(Some(&context), 1, now, &json!({"op":"joint_command","mode":1})).is_err());
        caps["control_modes"] = json!(["MIT","MIT","MIT","MIT","MIT","MIT","MIT"]); caps["owner_source_id"] = json!("0"); caps["stamp_ns"] = json!("101");
        context.observe(1, &json!({"motor_control":caps}), now);
        let mut motor = Motor::start_request(Some(&context), 1, now, &json!({"op":"joint_command","mode":1})).unwrap();
        motor.stopping(Some(&context), 1, now); motor.acknowledge_disable(1, &json!({"op":"joint_command_ack","mode":3,"sequence":2}));
        context.observe(1, &json!({"motor_control":{"supported":false,"fresh":false}}), now);
        context.observe(1, &status(2, 3, 2), now);
        assert!(context.control_seen); assert!(!motor.stopped(Some(&context), now));
        assert!(!motor.ready_to_write(&json!({"op":"joint_command","mode":1}), Some(&context), now));
    }
    #[test]
    fn v2_watermarks_survive_invalidation_and_reject_old_boot_and_epoch() {
        let now=Instant::now(); let mut context=Context::new(1,&profile("first")).unwrap();
        let mut caps=super::super::motor_v2_task::tests::caps();
        context.observe(1,&json!({"motor_control":caps}),now);
        context.observe(1,&json!({"motor_control":{"supported":false}}),now);
        context.observe(1,&json!({"motor_control":caps}),now+Duration::from_millis(20));
        assert!(!context.control.as_ref().unwrap().fresh(now));
        caps["stamp_ns"]=json!("101"); caps["control_epoch"]=json!(6);
        context.observe(1,&json!({"motor_control":caps}),now);
        assert_eq!(context.control.as_ref().unwrap().value["control_epoch"],7);
        caps["boot_id"]=json!("100"); caps["stamp_ns"]=json!("1"); caps["control_epoch"]=json!(0);
        context.observe(1,&json!({"motor_control":caps}),now);
        assert!(context.control.as_ref().unwrap().fresh(now));
        context.observe(1,&json!({"motor_control":super::super::motor_v2_task::tests::caps()}),now);
        assert_eq!(context.control.as_ref().unwrap().boot,"100");
        assert!(!context.control.as_ref().unwrap().fresh(now));
    }
    #[test]
    fn an_existing_mit_stream_cannot_resume_after_firmware_boot_or_configuration_changes() {
        let now=Instant::now();
        for (key,value) in [("boot_id",json!("100")),("control_epoch",json!(8))] {
            let mut context=Context::new(1,&profile("first")).unwrap(); context.observe(1,&status(1,3,1),now);
            let mut caps=super::super::motor_v2_task::tests::caps();
            caps["control_modes"]=json!(["MIT","MIT","MIT","MIT","MIT","MIT","MIT"]); caps["owner_source_id"]=json!("0");
            context.observe(1,&json!({"motor_control":caps}),now);
            let frame=json!({"op":"joint_command","mode":1}); let motor=Motor::start_request(Some(&context),1,now,&frame).unwrap();
            assert!(motor.ready_to_write(&frame,Some(&context),now));
            caps[key]=value; caps["stamp_ns"]=json!("101"); context.observe(1,&json!({"motor_control":caps}),now);
            assert!(!motor.ready_to_write(&frame,Some(&context),now));
        }
    }
}
