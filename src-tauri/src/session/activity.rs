//! Read-only admission policy for activities discovered by the shared poller.
//! This is observation, not ownership: it never adopts or stops remote processes.
use super::{
    bag_operation::Kind,
    bag_receipt::Receipt,
    observations::{Snapshot, Source},
};
use serde_json::Value;

#[derive(Clone, Copy)]
pub enum Check<'a> {
    Motion,
    Sampling,
    RecordStart,
    CollectionStart,
    PlaybackStart,
    Migration(&'a str),
}

fn fresh(snapshot: &Snapshot, source: Source) -> Option<&Value> {
    let entry = snapshot.entries.get(&source)?;
    (entry.error.is_none() && entry.age_ms < entry.ttl_ms)
        .then_some(entry.value.as_ref())
        .flatten()
}
fn idle(snapshot: &Snapshot, source: Source) -> Option<bool> {
    let value = fresh(snapshot, source)?;
    match source {
        Source::BagRecord | Source::BagPlay => {
            let kind = if source == Source::BagPlay {
                Kind::Play
            } else {
                Kind::Record
            };
            let receipt = Receipt::parse(value.get("receipt")?.clone()).ok()?;
            let (active, path) = if source == Source::BagPlay {
                ("playing", "bagPath")
            } else {
                ("recording", "outputPath")
            };
            if receipt.kind != kind
                || value[active].as_bool()? != receipt.active
                || value["pid"].as_u64()? != u64::from(receipt.pid)
                || !receipt.path_matches(value[path].as_str()?)
            {
                return None;
            }
            Some(!receipt.active)
        }
        Source::Collection => {
            let state = value["state"].as_str()?;
            let recording = value["recording"].as_bool()?;
            let pending = value["pendingFrames"].as_u64()?;
            let managed = value["managed"].as_bool()?;
            let pid = value["pid"].as_u64()?;
            let identity = value["processIdentity"].as_str()?;
            if recording != (state == "recording")
                || (managed && (pid <= 1 || identity.is_empty()))
                || (!managed && (pid != 0 || !identity.is_empty()))
            {
                return None;
            }
            match state {
                "idle" => Some(!recording && pending == 0),
                "stopped" if !managed && !recording && pending == 0 => Some(true),
                "recording" | "starting" | "finalizing" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

pub fn check(snapshot: &Snapshot, request: Check<'_>) -> Result<(), String> {
    // Offline pages remain editable. App-owned uncertain tasks have independent
    // persistent-in-process permits; a disconnected observation is never used to release those.
    if !snapshot.connected {
        return Ok(());
    }
    let sources: &[Source] = match request {
        Check::Motion | Check::Sampling => &[Source::BagPlay],
        Check::RecordStart => &[Source::BagPlay, Source::BagRecord],
        Check::CollectionStart => &[Source::BagPlay, Source::Collection],
        Check::PlaybackStart => &[Source::BagPlay, Source::BagRecord, Source::Collection],
        Check::Migration("page-monitor") => &[Source::BagPlay],
        Check::Migration("page-collection") => &[Source::Collection],
        Check::Migration("main" | "page-dashboard" | "page-motion") => &[Source::BagRecord],
        Check::Migration(_) => &[],
    };
    for &source in sources {
        let name = match source {
            Source::BagPlay => "bag 回放",
            Source::BagRecord => "bag 录制",
            _ => "Episode 采集",
        };
        match idle(snapshot, source) {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "共享状态显示 {name} 正在运行或有待处理数据；请先在原控制入口结束该任务"
                ))
            }
            None => {
                return Err(format!(
                    "{name} 状态待确认或已过期；等待共享查询恢复后再试，停止入口仍可用"
                ))
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::super::{
        observations::{Observation, Observations},
        tasks::{Owner, Tasks},
        windows::WindowToken,
    };
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::{sync::Arc, time::Instant};
    pub fn idle_value(source: Source) -> Value {
        match source {
            Source::BagPlay | Source::BagRecord => {
                let (kind, field, path) = if source == Source::BagPlay {
                    ("play", "playing", "bagPath")
                } else {
                    ("record", "recording", "outputPath")
                };
                json!({field:false,"pid":0,path:"","receipt":{"kind":kind,"active":false,"pid":0,"domain":null,
                    "processIdentity":"","pathHash":format!("{:x}",Sha256::digest(b""))}})
            }
            _ => {
                json!({"state":"stopped","recording":false,"pendingFrames":0,"managed":false,"pid":0,"processIdentity":""})
            }
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            epoch: 1,
            connected: true,
            revision: 1,
            handler_elapsed_ms: 0,
            entries: [Source::BagPlay, Source::BagRecord, Source::Collection]
                .into_iter()
                .map(|source| {
                    (
                        source,
                        Observation {
                            sequence: 1,
                            value: Some(idle_value(source)),
                            error: None,
                            age_ms: 0,
                            ttl_ms: 8000,
                        },
                    )
                })
                .collect(),
        }
    }
    pub fn active(source: Source) -> Value {
        let mut v = idle_value(source);
        if source == Source::Collection {
            v["state"] = json!("recording");
            v["recording"] = json!(true);
            v["pendingFrames"] = json!(12);
            // An external recorder need not have a managed PID.
        } else {
            v[if source == Source::BagPlay {
                "playing"
            } else {
                "recording"
            }] = json!(true);
            v["pid"] = json!(42);
            v["receipt"]["active"] = json!(true);
            v["receipt"]["pid"] = json!(42);
            v["receipt"]["domain"] = json!(197);
            v["receipt"]["processIdentity"] = json!("a".repeat(64));
        }
        v
    }
    #[test]
    fn foreign_activity_blocks_conflicts_and_missing_stale_failed_or_malformed_is_not_idle() {
        for (source, check_kind) in [
            (Source::BagPlay, Check::Motion),
            (Source::BagRecord, Check::PlaybackStart),
            (Source::Collection, Check::PlaybackStart),
        ] {
            assert!(check(&snapshot(), check_kind).is_ok());
            for fault in 0..6 {
                let mut s = snapshot();
                let entry = s.entries.get_mut(&source).unwrap();
                match fault {
                    0 => entry.value = Some(active(source)),
                    1 => entry.age_ms = 8000,
                    2 => entry.error = Some("SSH failed".into()),
                    3 => entry.value = Some(json!({"playing":false,"recording":false})),
                    4 => entry.value = None,
                    _ => {
                        s.entries.remove(&source);
                    }
                }
                assert!(check(&s, check_kind).is_err(), "{source:?}/{fault}");
            }
        }
        for source in [Source::BagPlay, Source::BagRecord, Source::Collection] {
            let mut s = snapshot();
            s.entries.get_mut(&source).unwrap().value = Some(active(source));
            let page = match source {
                Source::BagPlay => "page-monitor",
                Source::BagRecord => "page-motion",
                _ => "page-collection",
            };
            assert!(check(&s, Check::Migration(page)).is_err());
            assert!(check(&s, Check::Migration("page-handeye")).is_ok());
            if source != Source::BagPlay {
                assert!(
                    check(&s, Check::Motion).is_ok(),
                    "recording allows demonstration motion"
                );
            }
        }
        let mut s = snapshot();
        s.entries.get_mut(&Source::Collection).unwrap().value = Some(json!({
            "state":"idle","recording":false,"pendingFrames":10,"managed":false,"pid":0,"processIdentity":""}));
        assert!(check(&s, Check::CollectionStart).is_err());
        assert!(check(&s, Check::Migration("page-collection")).is_err());
    }
    fn owner(label: &str) -> Owner {
        Owner {
            epoch: 1,
            window: WindowToken {
                label: label.into(),
                incarnation: 1,
            },
        }
    }
    #[test]
    fn finalizing_external_capture_remains_available_but_holds_off_new_playback() {
        let tasks = Arc::new(Tasks::default());
        let finish = tasks.settling_operation("page-collection").unwrap();
        assert!(tasks.playback_operation("page-monitor", true).is_err());
        assert!(tasks.migration("page-collection").is_err());
        drop(finish);
        let playing = tasks.playback_operation("page-monitor", true).unwrap();
        assert!(tasks.settling_operation("page-collection").is_ok());
        assert!(tasks.settling_operation("page-dashboard").is_ok());
        assert!(tasks.sampling_operation("page-handeye").is_err());
        drop(playing);
        assert!(tasks.playback_operation("page-monitor", true).is_ok());
    }

    #[tokio::test]
    async fn shared_observations_guard_native_admission_writer_and_migration_but_not_stop_or_offline_work(
    ) {
        use std::sync::Mutex;
        let observations = Arc::new(Observations::default());
        let tasks = Arc::new(Tasks::default());
        tasks.bind_observations(&observations);
        let values = Arc::new(Mutex::new(snapshot().entries));
        let inputs = values.clone();
        observations.start(
            1,
            Arc::new(move |source, _| {
                let result = inputs
                    .lock()
                    .unwrap()
                    .get(&source)
                    .and_then(|e| e.value.clone())
                    .ok_or("unused".into());
                Box::pin(async move { result })
            }),
        );
        for source in [Source::BagPlay, Source::BagRecord, Source::Collection] {
            observations.read(1, source).await.unwrap();
        }
        let request = json!({"op":"position_move","command_id":"queued"});
        let admitted = tasks
            .admit(owner("page-motion"), &request, Instant::now())
            .unwrap();
        values
            .lock()
            .unwrap()
            .get_mut(&Source::BagPlay)
            .unwrap()
            .value = Some(active(Source::BagPlay));
        observations
            .refresh(1, Source::BagPlay, true)
            .await
            .unwrap();
        assert!(
            !(admitted.permit.unwrap())(),
            "already queued motion must be revoked at writer"
        );
        assert!(tasks
            .admit(owner("page-motion"), &request, Instant::now())
            .is_err());
        assert!(tasks.begin_controller(owner("page-status")).is_err());
        assert!(tasks.sampling_operation("page-handeye").is_err());
        assert!(tasks.migration("page-monitor").is_err());
        assert!(tasks.local_operation("page-handeye").is_ok());
        assert!(
            tasks.playback_operation("page-monitor", false).is_ok(),
            "explicit stop remains available"
        );
        let disable = tasks
            .admit(
                owner("main"),
                &json!({"op":"joint_command","mode":3}),
                Instant::now(),
            )
            .unwrap();
        assert!((disable.permit.unwrap())());
        values
            .lock()
            .unwrap()
            .get_mut(&Source::BagPlay)
            .unwrap()
            .value = None;
        observations
            .refresh(1, Source::BagPlay, true)
            .await
            .unwrap();
        assert!(
            tasks.sampling_operation("page-handeye").is_err(),
            "query failure is not idle"
        );
        values
            .lock()
            .unwrap()
            .get_mut(&Source::BagPlay)
            .unwrap()
            .value = Some(idle_value(Source::BagPlay));
        observations
            .refresh(1, Source::BagPlay, true)
            .await
            .unwrap();
        assert!(tasks.sampling_operation("page-handeye").is_ok());
        assert!(tasks.migration("page-monitor").is_ok());
        let selected = observations.activity_snapshot();
        assert_eq!(selected.entries.len(), 3);
        observations.stop(2);
        assert!(tasks.local_operation("page-handeye").is_ok());
        assert!(
            tasks.migration("page-monitor").is_ok(),
            "offline editing remains available"
        );
    }
}
