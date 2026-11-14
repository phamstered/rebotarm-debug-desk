use super::{
    collection_operation::{Action, Receipt},
    controller_journal::Ticket,
    recovery_file,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub profile: Value,
    pub action: Action,
    pub ticket: Ticket,
    pub previous: Option<Receipt>,
    pub recording: Option<Receipt>,
}
impl Record {
    fn validate(&self) -> Result<(), String> {
        self.ticket.validate()?;
        if !self.ticket.id.starts_with("collection-")
            || serde_json::to_vec(&self.profile)
                .map_err(|e| e.to_string())?
                .len()
                > 16384
        {
            return Err("采集恢复记录字段无效".into());
        }
        serde_json::from_value::<crate::ConnectionProfile>(self.profile.clone())
            .map_err(|_| "采集恢复配置无效")?;
        for receipt in [&self.previous, &self.recording].into_iter().flatten() {
            Receipt::parse(serde_json::to_value(receipt).map_err(|e| e.to_string())?)?;
            if !receipt.recording {
                return Err("Episode 恢复检查点必须是采集中回执".into());
            }
        }
        if self.previous.is_some() && matches!(self.action, Action::Launch | Action::StartEpisode) {
            return Err("采集恢复动作与原 Episode 不一致".into());
        }
        if let (Some(previous), Some(recording)) = (&self.previous, &self.recording) {
            if previous != recording {
                return Err("拒绝操作的恢复检查点不一致".into());
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    record: Option<Record>,
}
#[derive(Default)]
pub struct Store {
    path: Option<PathBuf>,
    record: Option<Record>,
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
            path: Some(path.clone()),
            ..Self::default()
        };
        let loaded: Result<Option<Record>, String> = (|| {
            let Some(bytes) = recovery_file::read(&path, 24576)? else {
                return Ok(None);
            };
            let file: File = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if file.version != 1 {
                return Err("采集恢复文件版本无效".into());
            }
            if let Some(record) = &file.record {
                record.validate()?;
            }
            Ok(file.record)
        })();
        match loaded {
            Ok(record) => store.record = record,
            Err(error) => {
                store.error = Some(format!("采集恢复记录不可用，保留文件并禁止新任务：{error}"))
            }
        }
        store
    }
    pub fn record(&self) -> Option<Record> {
        self.record.clone()
    }
    pub fn configured(&self) -> bool {
        self.path.is_some() || self.error.is_some()
    }
    fn write(&self, record: Option<Record>) -> Result<(), String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        if let Some(path) = &self.path {
            recovery_file::write(
                path,
                &serde_json::to_vec(&File { version: 1, record }).map_err(|e| e.to_string())?,
                24576,
            )?;
        }
        Ok(())
    }
    pub fn save(&mut self, record: Record) -> Result<(), String> {
        record.validate()?;
        if self.record.as_ref() != Some(&record) {
            self.write(Some(record.clone()))?;
            self.record = Some(record);
        }
        Ok(())
    }
    pub fn remove(&mut self, ticket: &Ticket) -> Result<(), String> {
        if self.record.as_ref().is_some_and(|r| &r.ticket == ticket) {
            self.write(None)?;
            self.record = None;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Record {
        Record {
            profile: json!({"host":"fixture","sshPort":22,"username":"","identityFile":"","localPort":18765,"remotePort":8765,
            "rosDomainId":197,"rosSetupScript":"test/install/setup.bash","commandTopic":"/cmd","statusTopic":"/status","jointStateTopic":"/joints"}),
            action: Action::StartEpisode,
            ticket: super::super::controller_journal::Job::new(
                super::super::controller_journal::new_collection_id().unwrap(),
                "fixture".into(),
            )
            .unwrap()
            .ticket(),
            previous: None,
            recording: None,
        }
    }
    #[test]
    fn rejects_corrupt_or_executable_records_without_overwriting_and_keeps_private_bounds() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir()
            .join(super::super::controller_journal::new_collection_id().unwrap());
        let path = root.join("collection.json");
        let record = fixture();
        let mut store = Store::open(path.clone());
        store.save(record.clone()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(Store::open(path.clone()).record(), Some(record.clone()));
        let value = serde_json::to_value(File {
            version: 1,
            record: Some(record.clone()),
        })
        .unwrap();
        for case in 0..6 {
            let mut bad = value.clone();
            match case {
                0 => bad["version"] = json!(2),
                1 => bad["record"]["action"] = json!("unknown"),
                2 => bad["record"]["ticket"]["command"] = json!("must not execute"),
                3 => bad["record"]["profile"] = json!({}),
                4 => {
                    bad["record"]["ticket"]["id"] =
                        json!(super::super::controller_journal::new_bag_id().unwrap())
                }
                _ => {
                    bad["record"]["recording"] = json!({"state":"recording","managed":true,"pid":42,"recording":true,"pendingFrames":1,"savedEpisodes":2,"processIdentity":"old-start","datasetHash":"a".repeat(64)})
                }
            }
            let bytes = serde_json::to_vec(&bad).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            let mut loaded = Store::open(path.clone());
            assert!(loaded.error.is_some(), "case {case}");
            assert!(loaded.save(record.clone()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::write(&path, vec![b' '; 24577]).unwrap();
        assert!(Store::open(path.clone()).error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stale_ticket_cannot_clear_a_newer_operation_and_failed_save_preserves_memory() {
        let root = std::env::temp_dir()
            .join(super::super::controller_journal::new_collection_id().unwrap());
        let path = root.join("collection.json");
        let first = fixture();
        let second = fixture();
        let mut store = Store::open(path.clone());
        store.save(first.clone()).unwrap();
        store.save(second.clone()).unwrap();
        store.remove(&first.ticket).unwrap();
        assert_eq!(Store::open(path.clone()).record(), Some(second.clone()));
        let saved = root.with_extension("saved");
        std::fs::rename(&root, &saved).unwrap();
        std::fs::write(&root, b"fault").unwrap();
        assert!(store.save(fixture()).is_err());
        assert_eq!(store.record(), Some(second.clone()));
        std::fs::remove_file(&root).unwrap();
        std::fs::rename(saved, &root).unwrap();
        store.remove(&second.ticket).unwrap();
        assert!(Store::open(path).record().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
