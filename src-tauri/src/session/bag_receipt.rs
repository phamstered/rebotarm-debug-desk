//! Process-instance proof shared by the one-shot journal and read-only status.
use super::bag_operation::Kind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub kind: Kind,
    pub active: bool,
    pub pid: u32,
    pub domain: Option<u16>,
    pub process_identity: String,
    pub path_hash: String,
}
impl Receipt {
    pub fn parse(value: Value) -> Result<Self, String> {
        let r: Self = serde_json::from_value(value).map_err(|_| "rosbag 进程回执格式无效")?;
        let hash = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !hash(&r.path_hash)
            || (!r.process_identity.is_empty() && !hash(&r.process_identity))
            || (r.active && (r.pid <= 1 || r.domain.is_none() || r.process_identity.is_empty()))
            || (!r.active && r.pid != 0)
            || (r.domain.is_none() != r.process_identity.is_empty())
        {
            return Err("rosbag 进程回执缺少一致的身份或状态".into());
        }
        Ok(r)
    }
    pub fn path_matches(&self, path: &str) -> bool {
        self.path_hash == format!("{:x}", Sha256::digest(path.as_bytes()))
    }
    pub fn same_instance(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.domain == other.domain
            && self.process_identity == other.process_identity
            && self.path_hash == other.path_hash
            && (!self.active || !other.active || self.pid == other.pid)
    }
    pub fn output(
        output: &str,
        kind: Kind,
        active: bool,
        pid: u32,
        path: &str,
    ) -> Result<Option<Self>, String> {
        let mut lines = output
            .lines()
            .filter_map(|l| l.strip_prefix("ROBOT_CONSOLE_BAG_RECEIPT="));
        let Some(line) = lines.next() else {
            return Ok(None);
        }; // Legacy display only, never execution proof.
        if lines.next().is_some() || line.len() > 1024 {
            return Err("rosbag 回执重复或过长".into());
        }
        let r = Self::parse(serde_json::from_str(line).map_err(|_| "rosbag 回执 JSON 无效")?)?;
        if r.kind != kind || r.active != active || r.pid != pid || !r.path_matches(path) {
            return Err("rosbag 显示状态与进程回执不一致".into());
        }
        Ok(Some(r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn status_and_journal_receipts_reject_inconsistent_identity_and_duplicate_lines() {
        let value = json!({"kind":"play","active":true,"pid":42,"domain":197,
            "processIdentity":"a".repeat(64),"pathHash":format!("{:x}",Sha256::digest(b"bags/a"))});
        let line = format!("ROBOT_CONSOLE_BAG_RECEIPT={value}\n");
        assert!(Receipt::output(&line, Kind::Play, true, 42, "bags/a")
            .unwrap()
            .is_some());
        assert!(
            Receipt::output("PLAYING|42|bags/a", Kind::Play, true, 42, "bags/a")
                .unwrap()
                .is_none()
        );
        assert!(Receipt::output(&(line.clone() + &line), Kind::Play, true, 42, "bags/a").is_err());
        for (key, bad) in [
            ("pid", json!(0)),
            ("active", json!(false)),
            ("domain", Value::Null),
            ("processIdentity", json!("")),
            ("pathHash", json!("bad")),
            ("extra", json!(1)),
        ] {
            let mut invalid = value.clone();
            invalid[key] = bad;
            assert!(Receipt::parse(invalid).is_err(), "{key}");
        }
        for (kind, active, pid, path) in [
            (Kind::Record, true, 42, "bags/a"),
            (Kind::Play, false, 42, "bags/a"),
            (Kind::Play, true, 43, "bags/a"),
            (Kind::Play, true, 42, "bags/b"),
        ] {
            assert!(Receipt::output(&line, kind, active, pid, path).is_err());
        }
    }
}
