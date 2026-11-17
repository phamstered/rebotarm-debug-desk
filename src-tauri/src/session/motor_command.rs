//! One classification for native ownership, stop fences and durable recovery.
use serde_json::Value;

pub fn disable(message: &Value) -> bool {
    message["op"] == "joint_command" && message["mode"].as_i64() == Some(3)
}
pub fn mutation(message: &Value) -> bool {
    (message["op"] == "joint_command" && !disable(message))
        || matches!(message["op"].as_str(), Some("motor_command_v2" | "motor_set_control_mode" | "motor_control_lease"))
}
pub fn v2(message: &Value) -> bool {
    matches!(message["op"].as_str(), Some("motor_command_v2" | "motor_set_control_mode" | "motor_control_lease"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_motor_mutation_is_owned_but_only_legacy_disable_is_urgent() {
        for op in ["motor_command_v2", "motor_set_control_mode", "motor_control_lease"] {
            let value = json!({"op":op,"mode":3});
            assert!(mutation(&value)); assert!(!disable(&value));
        }
        assert!(disable(&json!({"op":"joint_command","mode":3})));
        assert!(!mutation(&json!({"op":"joint_command","mode":3})));
        assert!(!mutation(&json!({"op":"motor_capabilities"})));
    }
}
