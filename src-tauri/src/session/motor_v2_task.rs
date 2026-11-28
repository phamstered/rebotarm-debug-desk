//! V2 configuration/lease results are bound to current firmware evidence.
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Evidence { pub value: Value, pub boot: String, pub stamp: u64, pub at: Instant }
impl Evidence {
    pub fn parse(value: &Value, at: Instant) -> Option<Self> {
        if value["supported"] != true || value["fresh"] != true || !matches!(value["protocol_version"].as_u64(), Some(2|3))
            || value["age_ms"].as_u64()? >= 1000 { return None; }
        let boot = value["boot_id"].as_str()?.to_owned();
        if boot.parse::<u64>().ok()? == 0 { return None; }
        value["source_id"].as_str()?.parse::<u64>().ok().filter(|v|*v>0)?;
        value["owner_source_id"].as_str()?.parse::<u64>().ok()?;
        u32::try_from(value["control_epoch"].as_u64()?).ok()?;
        let stamp = value["stamp_ns"].as_str()?.parse::<u64>().ok()?;
        if stamp == 0 || value["control_modes"].as_array()?.len() != 7 { return None; }
        Some(Self { value: value.clone(), boot, stamp, at })
    }
    pub fn fresh(&self, now: Instant) -> bool {
        self.value["fresh"] == true && Duration::from_millis(self.value["age_ms"].as_u64().unwrap_or(1000))
            .saturating_add(now.saturating_duration_since(self.at)) < Duration::from_secs(1)
    }
    pub fn disabled(&self) -> bool {
        self.value["disabled_verified"] == true && self.value["mode"] == 3 && self.value["enabled_joint_mask"] == 0
            && self.value["switching"] == false && self.value["lease_id"] == 0
    }
    pub fn recovery_ready(&self) -> bool {
        self.value["protocol_version"] == 3 && self.value["mode"] == 3 && self.value["fault_code"] == 7
            && self.value["enabled_joint_mask"] == 0 && self.value["lease_id"] == 0 && self.value["switching"] == false
    }
    pub fn matches_mode(&self, mask: u32, mode: &str) -> bool {
        let verified = self.value["verified_joint_mask"].as_u64().unwrap_or(0) as u32;
        mask != 0 && mask & !0x7f == 0 && mask & verified == mask
            && (0..7).all(|i| mask & (1 << i) == 0 || self.value["control_modes"][i] == mode)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    pub fn caps() -> Value {
        json!({"supported":true,"fresh":true,"age_ms":0,"protocol_version":2,"boot_id":"99","stamp_ns":"100",
            "source_id":"42","owner_source_id":"42","control_epoch":7,"lease_id":0,"mode":3,"fault_code":0,
            "disabled_verified":true,"selected_joint_mask":1,"enabled_joint_mask":0,"verified_joint_mask":127,"pos_vel_supported_mask":63,"switching":false,
            "control_modes":["POS_VEL","MIT","MIT","MIT","MIT","MIT","MIT"],"operation_state":2,"last_command_sequence":1})
    }
    pub fn acquire() -> Value {
        json!({"op":"motor_control_lease","lease_action":"acquire","control_mode":"POS_VEL","boot_id":"99",
            "control_epoch":7,"active_joint_mask":1,"confirmation":"ARMED"})
    }
    pub fn fault_caps() -> Value {
        let mut c=caps(); c["protocol_version"]=json!(3); c["fault_code"]=json!(7);
        c["disabled_verified"]=json!(false); c
    }
    pub fn recovery() -> Value {
        json!({"op":"motor_recover_fault","boot_id":"99","control_epoch":7,
            "active_joint_mask":4,"confirmation":"ARMED","support_confirmation":"SUPPORTED"})
    }
    pub fn recovered() -> Value {
        let mut c=caps(); c["protocol_version"]=json!(3); c["stamp_ns"]=json!("102");
        c["control_epoch"]=json!(8); c["owner_source_id"]=json!("0"); c["selected_joint_mask"]=json!(0); c["error_code"]=json!(0);
        json!({"op":"motor_recover_fault_result","terminal":true,"motor_control":c})
    }
    #[test]
    fn recovery_requires_fault_stop_and_explicit_confirmation_then_fresh_off_proof() {
        let now=Instant::now(); let request=recovery(); let c=fault_caps();
        let e=Evidence::parse(&c,now).unwrap();
        let mut op=Operation::new(&request,Some(&e),now).unwrap();
        assert_eq!(op.record_kind(),"fault_recovery");
        assert!(op.ready_to_write(&request,Some(&e),now));
        assert!(!op.continuation(&acquire()));
        for (key,value) in [("protocol_version",json!(2)),("fault_code",json!(11)),("fault_code",json!(0)),
            ("enabled_joint_mask",json!(4)),("mode",json!(1)),("lease_id",json!(8)),("switching",json!(true))] {
            let mut bad=c.clone();bad[key]=value;let e=Evidence::parse(&bad,now);
            assert!(Operation::new(&request,e.as_ref(),now).is_err());
            assert!(!op.ready_to_write(&request,e.as_ref(),now));
        }
        for (key,value) in [("boot_id",json!("100")),("control_epoch",json!(8)),("active_joint_mask",json!(0)),
            ("confirmation",json!("")),("support_confirmation",json!(""))] {
            let mut bad=request.clone();bad[key]=value;
            assert!(Operation::new(&bad,Some(&e),now).is_err());
        }
        assert!(matches!(op.reply(&request,&recovered(),now),Reply::Complete));
        for (key,value) in [("fault_code",json!(7)),("error_code",json!(9)),("stamp_ns",json!("100")),("boot_id",json!("100")),
            ("control_epoch",json!(7)),("source_id",json!("43")),("operation_state",json!(3)),("disabled_verified",json!(false)),
            ("lease_id",json!(1)),("owner_source_id",json!("42")),("selected_joint_mask",json!(4)),("enabled_joint_mask",json!(4)),("age_ms",json!(1000))] {
            let mut reply=recovered();reply["motor_control"][key]=value;
            assert!(matches!(op.reply(&request,&reply,now),Reply::Unknown));
        }
        assert!(!op.continuation(&json!({"op":"motor_command_v2"})));
    }
    #[test]
    fn lease_requires_fresh_disabled_matching_capabilities_and_cannot_start_with_a_frame() {
        let now=Instant::now();let request=acquire();let e=Evidence::parse(&caps(),now).unwrap();
        assert!(Operation::new(&request,Some(&e),now).is_ok());
        assert!(Operation::new(&request,None,now).is_err());
        assert!(Operation::new(&request,Some(&e),now+Duration::from_secs(1)).is_err());
        for (key,value) in [("boot_id",json!("100")),("control_epoch",json!(8)),("active_joint_mask",json!(64)),
            ("confirmation",json!("")),("op",json!("motor_command_v2"))] {
            let mut bad=request.clone();bad[key]=value;assert!(Operation::new(&bad,Some(&e),now).is_err());
        }
        let mut bad=caps();bad["enabled_joint_mask"]=json!(1);
        assert!(Operation::new(&request,Evidence::parse(&bad,now).as_ref(),now).is_err());
    }
    #[test]
    fn lease_ack_requires_new_readback_and_only_bound_frames_can_continue() {
        let now=Instant::now();let e=Evidence::parse(&caps(),now).unwrap();let request=acquire();
        let mut op=Operation::new(&request,Some(&e),now).unwrap();
        let mut reply=json!({"op":"motor_control_lease_ack","motor_control":caps()});
        assert!(matches!(op.reply(&request,&reply,now),Reply::Unknown));
        reply["motor_control"]["stamp_ns"]=json!("101");reply["motor_control"]["lease_id"]=json!(12);
        reply["motor_control"]["source_id"]=json!("43");reply["motor_control"]["owner_source_id"]=json!("43");
        assert!(matches!(op.reply(&request,&reply,now),Reply::Unknown));
        reply["motor_control"]["source_id"]=json!("42");reply["motor_control"]["owner_source_id"]=json!("42");
        assert!(matches!(op.reply(&request,&reply,now),Reply::Admitted));
        let mut frame=request.clone();frame["op"]=json!("motor_command_v2");frame["mode"]=json!(1);frame["lease_id"]=json!(12);
        assert!(op.continuation(&frame));
        for (key,value) in [("lease_id",json!(13)),("boot_id",json!("100")),("active_joint_mask",json!(2)),("mode",json!(3))] {
            let mut bad=frame.clone();bad[key]=value;assert!(!op.continuation(&bad));
        }
        assert_eq!(op.timeout(),Duration::from_millis(500));
        op.written(&frame);
        assert_eq!(op.timeout(),Duration::from_millis(250));
    }
    #[test]
    fn configure_needs_terminal_actual_modes_and_new_epoch_not_service_ack() {
        let now=Instant::now();let e=Evidence::parse(&caps(),now).unwrap();let mut request=acquire();
        request["op"]=json!("motor_set_control_mode");request["support_confirmation"]=json!("SUPPORTED");
        let mut op=Operation::new(&request,Some(&e),now).unwrap();
        let mut reply=json!({"op":"motor_set_control_mode_result","terminal":true,"motor_control":caps()});
        reply["motor_control"]["stamp_ns"]=json!("101");assert!(matches!(op.reply(&request,&reply,now),Reply::Unknown));
        reply["motor_control"]["control_epoch"]=json!(8);assert!(matches!(op.reply(&request,&reply,now),Reply::Complete));
        reply["terminal"]=json!(false);assert!(matches!(op.reply(&request,&reply,now),Reply::Unknown));reply["terminal"]=json!(true);
        reply["motor_control"]["control_modes"][0]=json!("MIT");assert!(matches!(op.reply(&request,&reply,now),Reply::Unknown));
    }
    #[test]
    fn source_age_and_verified_disable_are_required_before_admission_and_in_ack() {
        let now = Instant::now(); let mut value = caps(); value["age_ms"] = json!(950);
        let evidence = Evidence::parse(&value, now).unwrap();
        assert!(evidence.fresh(now + Duration::from_millis(49)));
        assert!(!evidence.fresh(now + Duration::from_millis(50)));
        value["disabled_verified"] = json!(false);
        assert!(Operation::new(&acquire(), Evidence::parse(&value, now).as_ref(), now).is_err());
        let evidence = Evidence::parse(&caps(), now).unwrap();
        for (key, invalid) in [("disabled_verified",json!(false)), ("selected_joint_mask",json!(2)), ("source_id",json!("999"))] {
            let mut operation = Operation::new(&acquire(), Some(&evidence), now).unwrap();
            let mut value = caps(); value["stamp_ns"] = json!("101"); value["lease_id"] = json!(12); value[key] = invalid;
            assert!(matches!(operation.reply(&acquire(), &json!({"op":"motor_control_lease_ack","motor_control":value}), now), Reply::Unknown));
        }
    }
}

#[derive(PartialEq)]
enum Purpose { Recover, Configure, Acquire, Release, AwaitingFrame, Stream }
pub struct Operation {
    purpose: Purpose, boot: String, epoch: u32, mask: u32, mode: String,
    stamp: u64, source: Option<String>, lease: Option<u32>,
}
pub enum Reply { Complete, Admitted, Unknown }
impl Operation {
    pub fn new(request: &Value, evidence: Option<&Evidence>, now: Instant) -> Result<Self, String> {
        let evidence = evidence.filter(|e| e.fresh(now)).ok_or("V2 固件状态缺失或过期")?;
        let recovering = request["op"] == "motor_recover_fault";
        if recovering && !evidence.recovery_ready() { return Err("清故障需要新固件、停止及驱动故障 7".into()); }
        if !recovering && (!evidence.disabled() || evidence.value["fault_code"] != 0) { return Err("V2 配置或许可需要已确认输出关闭且无故障".into()); }
        let boot = request["boot_id"].as_str().ok_or("缺少 firmware boot_id")?.to_owned();
        let epoch = request["control_epoch"].as_u64().and_then(|v|u32::try_from(v).ok()).ok_or("无效 control_epoch")?;
        let mask = request["active_joint_mask"].as_u64().and_then(|v|u32::try_from(v).ok()).filter(|m|*m != 0 && m & !0x7f == 0).ok_or("V2 关节掩码无效")?;
        let mode = if recovering { "".to_owned() } else { request["control_mode"].as_str().filter(|m|matches!(*m,"MIT"|"POS_VEL")).ok_or("无效驱动模式")?.to_owned() };
        if boot != evidence.boot || evidence.value["control_epoch"] != epoch { return Err("V2 固件身份或配置代次已变化".into()); }
        if request["confirmation"] != "ARMED" { return Err("Motor 尚未安全确认".into()); }
        let purpose = match request["op"].as_str() {
            Some("motor_recover_fault") if request["support_confirmation"] == "SUPPORTED" => Purpose::Recover,
            Some("motor_set_control_mode") if request["support_confirmation"] == "SUPPORTED" => Purpose::Configure,
            Some("motor_control_lease") if request["lease_action"] == "acquire" && mode == "POS_VEL" => Purpose::Acquire,
            Some("motor_control_lease") if request["lease_action"] == "release" && mode == "MIT" => Purpose::Release,
            _ => return Err("V2 控制须先完成模式配置并申请许可".into()),
        };
        if mode == "POS_VEL" && (evidence.value["pos_vel_supported_mask"].as_u64().unwrap_or(0) as u32 & mask != mask) {
            return Err("所选关节的 POS_VEL 能力未验证".into());
        }
        if !matches!(purpose, Purpose::Configure | Purpose::Recover) && !evidence.matches_mode(mask, &mode) { return Err("实际驱动模式未确认".into()); }
        Ok(Self { purpose, boot, epoch, mask, mode, stamp:evidence.stamp, source:evidence.value["source_id"].as_str().map(String::from), lease:None })
    }
    pub fn record_kind(&self) -> &'static str {
        match self.purpose { Purpose::Recover => "fault_recovery", Purpose::Configure => "configuration", Purpose::Release => "release", _ => "stream" }
    }
    pub fn timeout(&self) -> Duration {
        match self.purpose { Purpose::Recover | Purpose::Configure => Duration::from_secs(20), Purpose::Acquire|Purpose::Release => Duration::from_secs(5), Purpose::AwaitingFrame=>Duration::from_millis(500), Purpose::Stream=>Duration::from_millis(250) }
    }
    pub fn awaiting_first_frame(&self) -> bool { self.purpose == Purpose::AwaitingFrame }
    pub fn written(&mut self, request: &Value) {
        if self.purpose == Purpose::AwaitingFrame && self.continuation(request) { self.purpose = Purpose::Stream; }
    }
    pub fn continuation(&self, request: &Value) -> bool {
        matches!(self.purpose, Purpose::AwaitingFrame | Purpose::Stream) && request["op"] == "motor_command_v2"
            && request["boot_id"] == self.boot && request["control_epoch"] == self.epoch
            && request["active_joint_mask"] == self.mask && request["control_mode"] == "POS_VEL"
            && self.lease.is_some_and(|lease| request["lease_id"] == lease)
            && matches!(request["mode"].as_u64(),Some(0|1)) && request["confirmation"] == "ARMED"
    }
    pub fn ready_to_write(&self, request: &Value, evidence: Option<&Evidence>, now: Instant) -> bool {
        let Some(e) = evidence.filter(|e| e.fresh(now)) else { return false; };
        if e.boot != self.boot || e.value["control_epoch"] != self.epoch
            || e.value["source_id"].as_str() != self.source.as_deref() { return false; }
        if self.purpose == Purpose::Recover {
            return e.recovery_ready() && request["op"] == "motor_recover_fault" && request["boot_id"] == self.boot &&
                request["control_epoch"] == self.epoch && request["active_joint_mask"] == self.mask &&
                request["confirmation"] == "ARMED" && request["support_confirmation"] == "SUPPORTED";
        }
        if e.value["fault_code"] != 0 { return false; }
        if matches!(self.purpose, Purpose::AwaitingFrame | Purpose::Stream) {
            self.continuation(request) && e.matches_mode(self.mask, "POS_VEL")
                && e.value["switching"] == false && e.value["selected_joint_mask"] == self.mask
                && e.value["owner_source_id"].as_str() == self.source.as_deref()
                && self.lease.is_some_and(|lease| e.value["lease_id"] == lease)
        } else {
            e.disabled() && request["boot_id"] == self.boot && request["control_epoch"] == self.epoch
                && request["active_joint_mask"] == self.mask && request["control_mode"] == self.mode
        }
    }
    pub fn reply(&mut self, request: &Value, reply: &Value, now: Instant) -> Reply {
        if matches!(self.purpose, Purpose::AwaitingFrame | Purpose::Stream) {
            return if self.continuation(request) && reply["op"] == "motor_command_v2_ack"
                && reply["mode"] == request["mode"] && reply["boot_id"] == self.boot
                && reply["control_epoch"] == self.epoch && reply["lease_id"] == self.lease.unwrap_or(0)
                && reply["sequence"].as_u64().and_then(|v|u32::try_from(v).ok()).is_some() { Reply::Admitted } else { Reply::Unknown };
        }
        let Some(e) = Evidence::parse(&reply["motor_control"], now) else { return Reply::Unknown; };
        if e.boot != self.boot || e.stamp <= self.stamp || e.value["source_id"].as_str() != self.source.as_deref()
            || (self.purpose != Purpose::Recover && !e.matches_mode(self.mask, &self.mode)) { return Reply::Unknown; }
        match self.purpose {
            Purpose::Recover if request["op"] == "motor_recover_fault" && reply["op"] == "motor_recover_fault_result" && reply["terminal"] == true
                && e.disabled() && e.value["fault_code"] == 0 && e.value["error_code"] == 0 && e.value["operation_state"] == 2
                && e.value["control_epoch"].as_u64().is_some_and(|v|v > u64::from(self.epoch))
                && e.value["owner_source_id"] == "0" && e.value["selected_joint_mask"] == 0 => Reply::Complete,
            Purpose::Configure if reply["op"] == "motor_set_control_mode_result" && reply["terminal"] == true
                && e.disabled() && e.value["operation_state"] == 2
                && e.value["control_epoch"].as_u64().is_some_and(|v|v != u64::from(self.epoch) && v <= u64::from(u32::MAX))
                && e.value["fault_code"] == 0
                && if self.mode == "MIT" { e.value["owner_source_id"] == "0" } else { e.value["owner_source_id"].as_str() == self.source.as_deref() } => Reply::Complete,
            Purpose::Release if reply["op"] == "motor_control_lease_ack" && e.disabled()
                && e.value["owner_source_id"] == "0" => Reply::Complete,
            Purpose::Acquire if reply["op"] == "motor_control_lease_ack" && e.value["control_epoch"] == self.epoch
                && e.value["fault_code"] == 0 && e.value["disabled_verified"] == true && e.value["selected_joint_mask"] == self.mask
                && e.value["mode"] == 3 && e.value["enabled_joint_mask"] == 0
                && e.value["switching"] == false && e.value["owner_source_id"].as_str() == self.source.as_deref()
                && e.value["source_id"].as_str() == self.source.as_deref()
                && e.value["lease_id"].as_u64().is_some_and(|v|v>0 && v<=u64::from(u32::MAX)) => {
                    self.lease=e.value["lease_id"].as_u64().map(|v|v as u32);
                    self.source=e.value["source_id"].as_str().map(String::from);
                    self.purpose=Purpose::AwaitingFrame; Reply::Admitted
                },
            _ => Reply::Unknown,
        }
    }
}
