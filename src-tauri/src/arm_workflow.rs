use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub message: String,
    pub failed: bool,
}

pub fn stage_line(line: &str) -> Option<Progress> {
    let rest = line.strip_prefix("ARM_STAGE|")?;
    let (stage, message) = rest.split_once('|')?;
    if !["prepare", "safe-stop", "cleanup", "startup", "verify", "planner", "ready"].contains(&stage) { return None; }
    Some(Progress { stage: stage.into(), message: message.chars().take(512).collect(), failed: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_only_real_allowlisted_stage_markers() {
        assert_eq!(stage_line("ARM_STAGE|cleanup|关闭旧进程").unwrap().stage, "cleanup");
        assert!(stage_line("old output ARM_STAGE|ready|x").is_none());
        assert!(stage_line("ARM_STAGE|unknown|x").is_none());
        let progress = stage_line(&format!("ARM_STAGE|verify|{}", "x".repeat(10000))).unwrap();
        assert_eq!(progress.message.len(), 512);
    }
}
