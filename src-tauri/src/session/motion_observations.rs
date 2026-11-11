//! Shared read-only motion queries and a bounded, session-fenced log history.
use super::{
    observations::{Reader, Source},
    transport::Transport,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct History {
    epoch: u64,
    session: String,
    cursor: u64,
    gap_until: u64,
    bytes: usize,
    entries: VecDeque<(u64, Value, usize)>,
}
#[derive(Default)]
pub struct MotionLogs(Mutex<History>);
impl MotionLogs {
    pub fn reset(&self, epoch: u64) {
        *self.0.lock().unwrap() = History {
            epoch,
            ..History::default()
        };
    }
    fn cursor(&self, epoch: u64) -> Result<(String, u64), String> {
        let history = self.0.lock().unwrap();
        if history.epoch != epoch {
            return Err("运动日志会话已改变".into());
        }
        Ok((history.session.clone(), history.cursor))
    }
    fn ingest(&self, epoch: u64, response: &mut Value) -> Result<(), String> {
        let session = response["motion_log_session"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or("运动日志缺少有效 session")?
            .to_string();
        let cursor = response["motion_log_cursor"]
            .as_u64()
            .ok_or("运动日志 cursor 无效")?;
        let entries = response["motion_logs"]
            .as_array()
            .ok_or("运动日志数据无效")?;
        if entries.len() > 256 {
            return Err("运动日志单页超过 256 项".into());
        }
        let mut validated = Vec::new();
        let mut previous = 0;
        for value in entries {
            let seq = value["seq"]
                .as_u64()
                .filter(|seq| *seq > previous && *seq <= cursor)
                .ok_or("运动日志序号无效")?;
            let size = serde_json::to_vec(value).map_err(|e| e.to_string())?.len();
            // Bridge bounds message text at 8 KiB before JSON escaping (which
            // can expand each byte to six), plus a small metadata envelope.
            if size > 64 * 1024 {
                return Err("单项运动日志超过 64 KiB".into());
            }
            validated.push((seq, value.clone(), size));
            previous = seq;
        }
        let mut history = self.0.lock().unwrap();
        if history.epoch != epoch {
            return Err("运动日志会话已改变".into());
        }
        if session != history.session {
            *history = History {
                epoch,
                session,
                ..History::default()
            };
        }
        if cursor < history.cursor {
            return Err("运动日志 cursor 回退".into());
        }
        if response["motion_log_truncated"] == true {
            history.gap_until = history.gap_until.max(
                validated
                    .first()
                    .map_or(cursor, |entry| entry.0.saturating_sub(1)),
            );
        }
        for (seq, value, size) in validated {
            if seq <= history.cursor {
                continue;
            }
            history.bytes += size;
            history.entries.push_back((seq, value, size));
            while history.bytes > 2 * 1024 * 1024 || history.entries.len() > 5000 {
                let (seq, _, size) = history.entries.pop_front().unwrap();
                history.bytes -= size;
                history.gap_until = history.gap_until.max(seq);
            }
        }
        history.cursor = cursor;
        // Frequent status snapshots must not copy the full log history to every
        // window. Each caller reads a bounded page using its own cursor.
        response["motion_logs"] = json!([]);
        Ok(())
    }
    pub fn page(&self, epoch: u64, request: &Value, response: &mut Value) -> Result<(), String> {
        let history = self.0.lock().unwrap();
        if history.epoch != epoch || response["motion_log_session"] != history.session {
            return Err("运动日志会话已改变".into());
        }
        let session = match request.get("motion_log_session") {
            Some(value) => value.as_str().ok_or("motion_log_session 必须为字符串")?,
            None => "",
        };
        let requested = match request.get("motion_log_after") {
            Some(value) => value.as_u64().ok_or("motion_log_after 必须为非负整数")?,
            None => 0,
        };
        let after = if session == history.session {
            requested.min(history.cursor)
        } else {
            0
        };
        let entries: Vec<_> = history
            .entries
            .iter()
            .filter(|(seq, _, _)| *seq > after)
            .take(256)
            .collect();
        response["motion_log_cursor"] = json!(if entries.len() == 256 {
            entries.last().unwrap().0
        } else {
            history.cursor
        });
        response["motion_log_truncated"] = json!(after < history.gap_until);
        response["motion_logs"] = Value::Array(
            entries
                .into_iter()
                .map(|(_, value, _)| value.clone())
                .collect(),
        );
        Ok(())
    }
}

pub fn reader(
    base: Reader,
    transport: Arc<Transport>,
    logs: Arc<MotionLogs>,
    epoch: u64,
) -> Reader {
    Arc::new(move |source, force| {
        if !matches!(source, Source::Motion | Source::Pick) {
            return base(source, force);
        }
        let transport = transport.clone();
        let logs = logs.clone();
        Box::pin(async move {
            if transport.hello.metadata["motion_observation_supported"] != true {
                return Err("unsupported: 请更新 Bridge 以支持只读运动观察".into());
            }
            let request = if source == Source::Motion {
                let (session, after) = logs.cursor(epoch)?;
                json!({"op":"position_motion_observe", "motion_log_session":session, "motion_log_after":after})
            } else {
                json!({"op":"visual_pick_observe"})
            };
            let response = transport.request(request, Duration::from_secs(3)).await?;
            let expected = if source == Source::Motion {
                "position_motion_info"
            } else {
                "visual_pick_state"
            };
            if response.op() != expected {
                return Err(response.metadata["message"]
                    .as_str()
                    .unwrap_or("只读运动响应无效")
                    .into());
            }
            let mut value = response.metadata;
            if source == Source::Motion {
                logs.ingest(epoch, &mut value)?;
            }
            Ok(value)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn batch(first: u64, count: u64, text: &str) -> Value {
        json!({"op":"position_motion_info", "motion_log_session":"a", "motion_log_cursor":first + count - 1,
            "motion_log_truncated":false, "motion_logs":(first..first + count).map(|seq| json!({"seq":seq,"message":text})).collect::<Vec<_>>()})
    }
    #[test]
    fn windows_get_independent_pages_from_a_shared_history_and_replays_do_not_duplicate() {
        let logs = MotionLogs::default();
        logs.reset(1);
        let mut first = batch(1, 256, "x");
        logs.ingest(1, &mut first).unwrap();
        assert_eq!(first["motion_logs"], json!([]));
        let mut second = batch(257, 256, "y");
        logs.ingest(1, &mut second).unwrap();
        logs.ingest(1, &mut batch(257, 256, "y")).unwrap();
        for _ in 0..9 {
            let mut page = second.clone();
            logs.page(1, &json!({}), &mut page).unwrap();
            assert_eq!(page["motion_logs"].as_array().unwrap().len(), 256);
            assert_eq!(page["motion_log_cursor"], 256);
        }
        let mut page = second;
        logs.page(
            1,
            &json!({"motion_log_session":"a","motion_log_after":256}),
            &mut page,
        )
        .unwrap();
        assert_eq!(page["motion_logs"][0]["seq"], 257);
        assert_eq!(page["motion_log_cursor"], 512);
        assert_eq!(logs.0.lock().unwrap().entries.len(), 512);
    }
    #[test]
    fn count_and_byte_limits_report_truncation_and_never_grow_with_windows() {
        let logs = MotionLogs::default();
        logs.reset(1);
        for page in 0..21 {
            logs.ingest(1, &mut batch(page * 256 + 1, 256, "x"))
                .unwrap();
        }
        assert_eq!(logs.0.lock().unwrap().entries.len(), 5000);
        for page in 21..25 {
            logs.ingest(1, &mut batch(page * 256 + 1, 256, &"x".repeat(8192)))
                .unwrap();
        }
        assert!(logs.0.lock().unwrap().bytes <= 2 * 1024 * 1024);
        let mut page = json!({"motion_log_session":"a"});
        logs.page(1, &json!({}), &mut page).unwrap();
        assert_eq!(page["motion_log_truncated"], true);
        assert!(page["motion_logs"].as_array().unwrap().len() <= 256);
    }
    #[test]
    fn malformed_or_old_session_pages_cannot_advance_the_cursor_or_repopulate_after_disconnect() {
        let logs = MotionLogs::default();
        logs.reset(1);
        logs.ingest(1, &mut batch(1, 2, "x")).unwrap();
        let mut invalid = batch(3, 2, "x");
        invalid["motion_logs"][1]["seq"] = json!(3);
        assert!(logs.ingest(1, &mut invalid).is_err());
        assert_eq!(logs.cursor(1).unwrap().1, 2);
        assert!(logs
            .ingest(1, &mut batch(3, 1, &"x".repeat(65537)))
            .is_err());
        logs.reset(2);
        assert!(logs.ingest(1, &mut batch(3, 1, "x")).is_err());
        assert_eq!(logs.cursor(2).unwrap(), (String::new(), 0));
        logs.ingest(2, &mut batch(1, 1, "new")).unwrap();
        let mut page = json!({"motion_log_session":"a"});
        assert!(logs
            .page(2, &json!({"motion_log_after":-1}), &mut page)
            .is_err());
        assert!(logs
            .page(2, &json!({"motion_log_session":{}}), &mut page)
            .is_err());
    }

    #[test]
    fn bounded_bridge_text_is_accepted_even_when_json_escaping_expands_it() {
        let logs = MotionLogs::default();
        logs.reset(1);
        let mut response = batch(1, 1, &"\u{0001}".repeat(8192));
        logs.ingest(1, &mut response).unwrap();
        assert_eq!(logs.cursor(1).unwrap().1, 1);
        assert!(logs.0.lock().unwrap().bytes < 64 * 1024);
    }
    #[test]
    fn bridge_restart_clears_history_and_upstream_gaps_remain_visible_to_late_windows() {
        let logs = MotionLogs::default();
        logs.reset(1);
        logs.ingest(1, &mut batch(1, 2, "old")).unwrap();
        let mut next = batch(20, 2, "new");
        next["motion_log_session"] = json!("b");
        next["motion_log_truncated"] = json!(true);
        logs.ingest(1, &mut next).unwrap();
        let mut page = next.clone();
        logs.page(
            1,
            &json!({"motion_log_session":"a","motion_log_after":100}),
            &mut page,
        )
        .unwrap();
        assert_eq!(page["motion_logs"][0]["message"], "new");
        assert_eq!(page["motion_log_truncated"], true);
        logs.page(
            1,
            &json!({"motion_log_session":"b","motion_log_after":21}),
            &mut page,
        )
        .unwrap();
        assert_eq!(page["motion_logs"], json!([]));
        assert_eq!(page["motion_log_truncated"], false);
    }
}
