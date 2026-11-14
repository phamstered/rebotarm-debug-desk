//! Read-only Monitor capture, before per-window latest-frame coalescing.
//! Retention is owned by the connection, not a WebView or its draw loop.
use super::{subscriptions::valid_topic, wire::WireFrame};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

const MAX_TOPICS: usize = 64;
const MAX_FRAME: usize = 64 * 1024;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_FRAMES: usize = 8192;
const WINDOW_MS: u64 = 30_000;
const PAGE_BYTES: usize = 512 * 1024;
const PAGE_FRAMES: usize = 256;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub topics: BTreeMap<String, String>,
    pub paused: bool,
    pub bag_playing: bool,
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if self.topics.len() > MAX_TOPICS {
            return Err("Monitor 最多采集 64 个 Topic".into());
        }
        for (topic, kind) in &self.topics {
            if !valid_topic(topic) || kind.is_empty() || kind.len() > 256 {
                return Err("Monitor 订阅参数无效".into());
            }
            if matches!(
                kind.as_str(),
                "sensor_msgs/msg/Image"
                    | "sensor_msgs/msg/CompressedImage"
                    | "sensor_msgs/msg/PointCloud2"
            ) {
                return Err("Monitor 数值历史不接受图像或点云 Topic".into());
            }
        }
        Ok(())
    }
}

struct Sample {
    sequence: u64,
    received_ms: u64,
    segment: u64,
    bytes: Arc<[u8]>,
}

#[derive(Serialize)]
pub struct Row {
    pub sequence: u64,
    pub received_ms: u64,
    pub segment: u64,
    pub topic: String,
    pub data: Value,
}

#[derive(Serialize)]
pub struct Page {
    pub epoch: u64,
    pub reset: u64,
    pub now_ms: u64,
    pub cursor: u64,
    pub tail: u64,
    pub lost: u64,
    pub skipped: u64,
    pub config: Config,
    pub rows: Vec<Row>,
}

#[derive(Default)]
pub struct History {
    config: Config,
    reset: u64,
    segment: u64,
    sequence: u64,
    floor: u64,
    skipped: u64,
    bytes: usize,
    samples: VecDeque<Sample>,
}
impl History {
    pub fn config(&self) -> &Config {
        &self.config
    }
    pub fn configure(&mut self, config: Config) {
        if config == self.config {
            return;
        }
        if config.bag_playing != self.config.bag_playing {
            // Do not combine wall-time and bag-time samples in one chart history.
            self.samples.clear();
            self.bytes = 0;
            self.floor = self.sequence;
            self.reset += 1;
        }
        self.segment += 1;
        self.config = config;
    }
    pub fn accept(&mut self, frame: &WireFrame, now: u64) {
        if self.config.paused || frame.binary || frame.op() != "topic_message" {
            return;
        }
        let topic = frame.metadata["topic"].as_str().unwrap_or("");
        if !self.config.topics.contains_key(topic) {
            return;
        }
        self.sequence += 1;
        if frame.bytes.len() > MAX_FRAME {
            self.skipped += 1;
            // A hole must be visible to every reader, including one already at tail.
            self.samples.clear();
            self.bytes = 0;
            self.floor = self.sequence;
            return;
        }
        self.bytes += frame.bytes.len();
        self.samples.push_back(Sample {
            sequence: self.sequence,
            received_ms: now,
            segment: self.segment,
            bytes: frame.bytes.clone(),
        });
        while self.bytes > MAX_BYTES
            || self.samples.len() > MAX_FRAMES
            || self
                .samples
                .front()
                .is_some_and(|s| now.saturating_sub(s.received_ms) > WINDOW_MS)
        {
            let old = self.samples.pop_front().unwrap();
            self.bytes -= old.bytes.len();
            self.floor = old.sequence;
        }
    }
    pub fn page(&self, epoch: u64, after: u64, now: u64) -> Result<Page, String> {
        if after > self.sequence {
            return Err("Monitor 历史游标超出当前会话".into());
        }
        let mut cursor = after.max(self.floor);
        let mut bytes = 0;
        let mut rows = Vec::new();
        for sample in self.samples.iter().filter(|sample| sample.sequence > after) {
            if rows.len() >= PAGE_FRAMES || bytes + sample.bytes.len() > PAGE_BYTES {
                break;
            }
            let value: Value = serde_json::from_slice(&sample.bytes).map_err(|e| e.to_string())?;
            rows.push(Row {
                sequence: sample.sequence,
                received_ms: sample.received_ms,
                segment: sample.segment,
                topic: value["topic"].as_str().unwrap_or("").into(),
                data: value["data"].clone(),
            });
            bytes += sample.bytes.len();
            cursor = sample.sequence;
        }
        Ok(Page {
            epoch,
            reset: self.reset,
            now_ms: now,
            cursor,
            tail: self.sequence,
            lost: self.floor.saturating_sub(after),
            skipped: self.skipped,
            config: self.config.clone(),
            rows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn config() -> Config {
        Config {
            topics: BTreeMap::from([("/joint_states".into(), "sensor_msgs/msg/JointState".into())]),
            ..Config::default()
        }
    }
    fn frame(n: usize) -> WireFrame {
        WireFrame::parse(
            serde_json::to_vec(
                &json!({"op":"topic_message","topic":"/joint_states","data":{"position":[n]}}),
            )
            .unwrap()
            .into(),
            false,
        )
        .unwrap()
    }
    #[test]
    fn slow_or_absent_readers_recover_every_sample_with_independent_cursors() {
        let mut history = History::default();
        history.configure(config());
        for n in 0..600 {
            history.accept(&frame(n), n as u64);
        }
        let first = history.page(7, 0, 900).unwrap();
        assert_eq!(first.rows.len(), 256);
        assert_eq!(first.tail, 600);
        assert_eq!(first.lost, 0);
        let second = history.page(7, first.cursor, 910).unwrap();
        let third = history.page(7, second.cursor, 920).unwrap();
        assert_eq!(third.rows.len(), 88);
        assert_eq!(third.rows.last().unwrap().data["position"][0], 599);
        assert_eq!(
            history.page(7, 0, 930).unwrap().rows[0].data["position"][0],
            0
        );
        assert!(history.page(7, 601, 930).is_err());
    }
    #[test]
    fn pause_retains_history_resume_marks_boundary_and_timeline_change_resets() {
        let mut history = History::default();
        let mut cfg = config();
        history.configure(cfg.clone());
        history.accept(&frame(1), 10);
        cfg.paused = true;
        history.configure(cfg.clone());
        history.accept(&frame(2), 20);
        assert_eq!(history.page(1, 0, 20).unwrap().rows.len(), 1);
        cfg.paused = false;
        history.configure(cfg.clone());
        history.accept(&frame(3), 30);
        let page = history.page(1, 0, 30).unwrap();
        assert_ne!(page.rows[0].segment, page.rows[1].segment);
        cfg.bag_playing = true;
        history.configure(cfg);
        history.accept(&frame(4), 40);
        let page = history.page(1, 0, 40).unwrap();
        assert_eq!(page.reset, 1);
        assert_eq!(page.lost, 2);
        assert_eq!(page.rows.len(), 1);
    }
    #[test]
    fn pressure_expiration_and_oversize_are_bounded_and_reported() {
        let mut history = History::default();
        history.configure(config());
        for n in 0..9000 {
            history.accept(&frame(n), 0);
        }
        assert_eq!(history.samples.len(), MAX_FRAMES);
        assert_eq!(history.page(1, 0, 1).unwrap().lost, 808);
        history.accept(&frame(9000), WINDOW_MS + 1);
        assert_eq!(history.samples.len(), 1);
        let large = WireFrame::parse(
            serde_json::to_vec(
                &json!({"op":"topic_message","topic":"/joint_states","data":"a".repeat(MAX_FRAME)}),
            )
            .unwrap()
            .into(),
            false,
        )
        .unwrap();
        history.accept(&large, WINDOW_MS + 2);
        let page = history.page(1, 9001, WINDOW_MS + 2).unwrap();
        assert!(page.rows.is_empty());
        assert_eq!(page.lost, 1);
        assert_eq!(page.skipped, 1);
        assert_eq!(history.bytes, 0);
        let medium = WireFrame::parse(
            serde_json::to_vec(
                &json!({"op":"topic_message","topic":"/joint_states","data":"a".repeat(32000)}),
            )
            .unwrap()
            .into(),
            false,
        )
        .unwrap();
        for _ in 0..400 {
            history.accept(&medium, WINDOW_MS + 3);
        }
        assert!(history.bytes <= MAX_BYTES);
        assert!(history.page(1, 0, WINDOW_MS + 4).unwrap().rows.len() < PAGE_FRAMES);
    }
    #[test]
    fn rejects_non_numeric_stream_types_and_invalid_config_without_accepting_unrequested_data() {
        let mut cfg = config();
        cfg.topics
            .insert("/camera".into(), "sensor_msgs/msg/Image".into());
        assert!(cfg.validate().is_err());
        cfg = config();
        cfg.topics.insert("bad topic".into(), "custom".into());
        assert!(cfg.validate().is_err());
        let mut history = History::default();
        history.accept(&frame(1), 0);
        assert_eq!(history.page(1, 0, 0).unwrap().tail, 0);
    }
}
