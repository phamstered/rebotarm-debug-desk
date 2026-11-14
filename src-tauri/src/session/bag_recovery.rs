//! Bounded write-ahead journal. Contains query tickets, never executable commands.
use super::{bag_operation::Kind, bag_receipt::Receipt, controller_journal::Ticket};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub kind: Kind,
    pub window: String,
    pub profile: Value,
    pub starting: bool,
    pub path: String,
    pub ticket: Ticket,
    pub previous: Option<Receipt>,
    pub running: Option<Receipt>,
}
impl Record {
    fn validate(&self) -> Result<(), String> {
        self.ticket.validate()?;
        if !self.ticket.id.starts_with("bag-")
            || !self.kind.authorized(&self.window)
            || self.path.len() > 4096
            || self.path.contains('\0')
            || serde_json::to_vec(&self.profile)
                .map_err(|e| e.to_string())?
                .len()
                > 16384
        {
            return Err("bag 恢复记录字段无效".into());
        }
        let profile: crate::ConnectionProfile = serde_json::from_value(self.profile.clone())
            .map_err(|_| "bag 恢复记录的机器人配置无效")?;
        if let Some(receipt) = &self.previous {
            Receipt::parse(serde_json::to_value(receipt).map_err(|e| e.to_string())?)?;
            if self.starting
                || receipt.kind != self.kind
                || !receipt.active
                || receipt.domain != Some(profile.ros_domain_id)
            {
                return Err("bag 恢复记录的原进程身份无效".into());
            }
        }
        if let Some(receipt) = &self.running {
            Receipt::parse(serde_json::to_value(receipt).map_err(|e| e.to_string())?)?;
            if receipt.kind != self.kind
                || !receipt.active
                || receipt.domain != Some(profile.ros_domain_id)
                || self
                    .previous
                    .as_ref()
                    .is_some_and(|r| !r.same_instance(receipt))
                || (self.kind == Kind::Play && self.starting && !receipt.path_matches(&self.path))
            {
                return Err("bag 运行恢复回执无效".into());
            }
        }
        Ok(())
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    records: BTreeMap<Kind, Record>,
}
#[derive(Default)]
pub struct Store {
    path: Option<PathBuf>,
    records: BTreeMap<Kind, Record>,
    pub error: Option<String>,
}
impl Store {
    pub fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::default()
        }
    }
    pub fn open(path: PathBuf) -> Self {
        let mut store = Self {
            path: Some(path),
            ..Self::default()
        };
        match store.read() {
            Ok(records) => store.records = records,
            Err(error) => {
                store.error = Some(format!("bag 恢复记录不可用，保留文件并禁止新任务：{error}"))
            }
        }
        store
    }
    fn read(&self) -> Result<BTreeMap<Kind, Record>, String> {
        let path = self.path.as_ref().unwrap();
        let Some(bytes) = super::recovery_file::read(path, 49152)? else {
            return Ok(BTreeMap::new());
        };
        let file: File = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if file.version != 1 || file.records.len() > 2 {
            return Err("恢复文件版本或数量无效".into());
        }
        for (kind, record) in &file.records {
            record.validate()?;
            if *kind != record.kind {
                return Err("恢复记录类型不一致".into());
            }
        }
        Ok(file.records)
    }
    pub fn records(&self) -> Vec<Record> {
        self.records.values().cloned().collect()
    }
    pub fn configured(&self) -> bool {
        self.path.is_some() || self.error.is_some()
    }
    pub fn save(&mut self, record: Record) -> Result<(), String> {
        record.validate()?;
        if self.records.get(&record.kind) == Some(&record) {
            return Ok(());
        }
        let mut next = self.records.clone();
        next.insert(record.kind, record);
        self.write(&next)?;
        self.records = next;
        Ok(())
    }
    pub fn remove(&mut self, kind: Kind, ticket: &Ticket) -> Result<(), String> {
        // A late worker cannot delete its successor's recovery record.
        if self.records.get(&kind).is_none_or(|r| r.ticket != *ticket) {
            return Ok(());
        }
        let mut next = self.records.clone();
        next.remove(&kind);
        self.write(&next)?;
        self.records = next;
        Ok(())
    }
    fn write(&self, records: &BTreeMap<Kind, Record>) -> Result<(), String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        let Some(path) = &self.path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&File {
            version: 1,
            records: records.clone(),
        })
        .map_err(|e| e.to_string())?;
        super::recovery_file::write(path, &bytes, 49152)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Record {
        Record {
            kind: Kind::Play,
            window: "page-monitor".into(),
            starting: true,
            path: "bags/a".into(),
            ticket: super::super::controller_journal::Job::new(
                super::super::controller_journal::new_bag_id().unwrap(),
                "fixture".into(),
            )
            .unwrap()
            .ticket(),
            profile: json!({"host":"fixture","sshPort":22,"username":"","identityFile":"","localPort":18765,"remotePort":8765,
                "rosDomainId":197,"rosSetupScript":"test/install/setup.bash","commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"}),
            previous: None,
            running: None,
        }
    }
    #[test]
    fn bounded_private_store_preserves_bad_files_and_rejects_mismatched_records() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(super::super::controller_journal::new_bag_id().unwrap());
        let path = root.join("recovery.json");
        let mut store = Store::open(path.clone());
        let record = fixture();
        store.save(record.clone()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(Store::open(path.clone()).records(), vec![record.clone()]);
        let valid = serde_json::to_value(File {
            version: 1,
            records: [(Kind::Play, record.clone())].into_iter().collect(),
        })
        .unwrap();
        for case in 0..7 {
            let mut bad = valid.clone();
            match case {
                0 => bad["version"] = json!(2),
                1 => bad["records"]["play"]["window"] = json!("page-handeye"),
                2 => bad["records"]["play"]["kind"] = json!("record"),
                3 => bad["records"]["play"]["ticket"]["command"] = json!("do not execute"),
                4 => bad["records"]["play"]["profile"] = json!({}),
                5 => bad["records"]["play"]["path"] = json!("x".repeat(4097)),
                _ => bad["extra"] = json!(true),
            }
            let bytes = serde_json::to_vec(&bad).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            let mut loaded = Store::open(path.clone());
            assert!(loaded.error.is_some(), "case {case}");
            assert!(loaded.save(record.clone()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::write(&path, vec![b' '; 49153]).unwrap();
        assert!(Store::open(path.clone()).error.is_some());
        std::fs::remove_file(&path).unwrap();
        let source = root.join("source.json");
        std::fs::write(&source, serde_json::to_vec(&valid).unwrap()).unwrap();
        std::os::unix::fs::symlink(&source, &path).unwrap();
        assert!(Store::open(path).error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stale_ticket_cannot_remove_replacement_and_failed_write_does_not_update_memory() {
        let root =
            std::env::temp_dir().join(super::super::controller_journal::new_bag_id().unwrap());
        let path = root.join("recovery.json");
        let mut store = Store::open(path.clone());
        let first = fixture();
        store.save(first.clone()).unwrap();
        let second = fixture();
        store.save(second.clone()).unwrap();
        store.remove(Kind::Play, &first.ticket).unwrap();
        assert_eq!(Store::open(path.clone()).records(), vec![second.clone()]);
        let saved = root.with_extension("saved");
        std::fs::rename(&root, &saved).unwrap();
        std::fs::write(&root, b"fault").unwrap();
        assert!(store.save(fixture()).is_err());
        assert_eq!(store.records(), vec![second.clone()]);
        std::fs::remove_file(&root).unwrap();
        std::fs::rename(saved, &root).unwrap();
        store.remove(Kind::Play, &second.ticket).unwrap();
        assert!(Store::open(path).records().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
