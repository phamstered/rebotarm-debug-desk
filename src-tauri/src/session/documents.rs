//! Application-owned editor documents. A single native writer commits a
//! revision only after the validated file has been atomically replaced.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Key {
    Monitor,
    Positions,
    MotionGroups,
}
impl Key {
    fn file(self) -> &'static str {
        match self {
            Self::Monitor => "monitor-workspace.v2.json",
            Self::Positions => "positions.v1.json",
            Self::MotionGroups => "motion-groups.v1.json",
        }
    }
    fn limit(self) -> usize {
        if self == Self::Monitor {
            512 * 1024
        } else {
            4 * 1024 * 1024
        }
    }
    fn validate(self, text: &str) -> Result<(), String> {
        if text.len() > self.limit() {
            return Err("编辑文档超过大小上限".into());
        }
        match self {
            Self::Monitor => validate_monitor(text),
            Self::Positions => crate::positions::validate_positions_json(text),
            Self::MotionGroups => crate::motion_groups::validate_motion_groups_json(text),
        }
    }
    fn authorizes(self, label: &str, write: bool) -> bool {
        if !write {
            return label == "main" || super::windows::Page::from_label(label).is_some();
        }
        match self {
            Self::Monitor => matches!(label, "page-monitor" | "page-dashboard"),
            Self::Positions => matches!(label, "main" | "page-motion" | "page-status"),
            Self::MotionGroups => matches!(label, "main" | "page-motion"),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub content: Option<String>,
}
#[derive(Serialize)]
pub struct Commit {
    pub accepted: bool,
    pub snapshot: Snapshot,
}
#[derive(Default)]
pub struct Documents {
    state: Mutex<BTreeMap<Key, Snapshot>>,
}

impl Documents {
    fn refresh<'a>(
        state: &'a mut BTreeMap<Key, Snapshot>,
        dir: &Path,
        key: Key,
    ) -> Result<&'a mut Snapshot, String> {
        let content = match fs::File::open(dir.join(key.file())) {
            Ok(file) => {
                let mut text = String::new();
                file.take(key.limit() as u64 + 1)
                    .read_to_string(&mut text)
                    .map_err(|e| format!("读取编辑文档失败：{e}"))?;
                key.validate(&text)?;
                Some(text)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读取编辑文档失败：{e}")),
        };
        let snapshot = state.entry(key).or_default();
        if snapshot.content != content {
            snapshot.revision += 1;
            snapshot.content = content;
        }
        Ok(snapshot)
    }
    pub fn read(&self, dir: &Path, key: Key) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "编辑文档锁异常")?;
        Ok(Self::refresh(&mut state, dir, key)?.clone())
    }
    pub fn commit(
        &self,
        dir: &Path,
        key: Key,
        expected: u64,
        content: String,
    ) -> Result<Commit, String> {
        key.validate(&content)?;
        let mut state = self.state.lock().map_err(|_| "编辑文档锁异常")?;
        // Also notice external edits and never silently replace a corrupt file.
        let current = Self::refresh(&mut state, dir, key)?;
        if current.revision != expected {
            return Ok(Commit {
                accepted: false,
                snapshot: current.clone(),
            });
        }
        if current.content.as_deref() != Some(&content) {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let temporary = dir.join(format!(
                ".{}-{}-{stamp}.tmp",
                key.file(),
                std::process::id()
            ));
            let result = (|| {
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temporary)
                    .map_err(|e| e.to_string())?;
                let result = (|| {
                    file.write_all(content.as_bytes())
                        .map_err(|e| e.to_string())?;
                    file.sync_all().map_err(|e| e.to_string())?;
                    fs::rename(&temporary, dir.join(key.file())).map_err(|e| e.to_string())
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temporary);
                }
                result
            })();
            result?;
            current.content = Some(content);
            current.revision += 1;
        }
        Ok(Commit {
            accepted: true,
            snapshot: current.clone(),
        })
    }
}

#[tauri::command]
pub async fn editor_document_read(
    app: AppHandle,
    view: Webview,
    documents: State<'_, Documents>,
    key: Key,
) -> Result<Snapshot, String> {
    if !key.authorizes(view.label(), false) {
        return Err("此页面不能读取编辑文档".into());
    }
    documents.read(&app.path().app_data_dir().map_err(|e| e.to_string())?, key)
}
#[tauri::command]
pub async fn editor_document_commit(
    app: AppHandle,
    view: Webview,
    documents: State<'_, Documents>,
    key: Key,
    expected: u64,
    content: String,
) -> Result<Commit, String> {
    if !key.authorizes(view.label(), true) {
        return Err("此页面不能修改该编辑文档".into());
    }
    let result = documents.commit(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        key,
        expected,
        content,
    )?;
    // Invalidation only: history/samples are never copied into broadcasts.
    let _ = app.emit(
        "editor-document-changed",
        serde_json::json!({"key":key,"revision":result.snapshot.revision}),
    );
    Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MonitorDocument {
    version: u8,
    dashboards: Vec<Dashboard>,
    selected_dashboard_id: String,
    layout_locked: bool,
    compact_type: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Dashboard {
    id: String,
    name: String,
    panels: Vec<Panel>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Panel {
    id: String,
    title: String,
    layout: Grid,
    series: Series,
    additional_series: Vec<Series>,
    chart: Chart,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grid {
    i: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Series {
    topic: String,
    field_path: String,
    color: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Chart {
    r#type: String,
    time_style: String,
    bar_orientation: String,
    gauge_min: f64,
    gauge_max: f64,
    gauge_threshold: f64,
}
fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn validate_monitor(text: &str) -> Result<(), String> {
    let config: MonitorDocument =
        serde_json::from_str(text).map_err(|e| format!("Monitor 配置无效：{e}"))?;
    if config.version != 2
        || config.dashboards.is_empty()
        || config.dashboards.len() > 32
        || !matches!(
            config.compact_type.as_deref(),
            None | Some("vertical" | "horizontal")
        )
    {
        return Err("Monitor 配置版本或布局无效".into());
    }
    let _ = config.layout_locked;
    let mut ids = BTreeSet::new();
    let mut count = 0;
    for d in &config.dashboards {
        if !valid_text(&d.id, 128)
            || !valid_text(&d.name, 512)
            || !ids.insert(&d.id)
            || d.panels.len() > 128
        {
            return Err("Monitor 仪表盘标识或面板数量无效".into());
        }
        let mut panels = BTreeSet::new();
        for p in &d.panels {
            let g = &p.layout;
            let c = &p.chart;
            if !valid_text(&p.id, 128)
                || !valid_text(&p.title, 512)
                || !panels.insert(&p.id)
                || g.i != p.id
                || ![
                    g.x,
                    g.y,
                    g.w,
                    g.h,
                    c.gauge_min,
                    c.gauge_max,
                    c.gauge_threshold,
                ]
                .iter()
                .all(|v| v.is_finite())
                || g.x < 0.
                || g.y < 0.
                || g.w <= 0.
                || g.w > 12.
                || g.h <= 0.
                || g.h > 10000.
                || g.x + g.w > 12.
                || g.y > 100000.
                || !matches!(c.r#type.as_str(), "time-series" | "bar" | "pie" | "gauge")
                || !matches!(c.time_style.as_str(), "line" | "points" | "bars")
                || !matches!(c.bar_orientation.as_str(), "vertical" | "horizontal")
                || c.gauge_max <= c.gauge_min
                || p.additional_series.len() > 63
            {
                return Err("Monitor 面板配置无效".into());
            }
            for series in std::iter::once(&p.series).chain(&p.additional_series) {
                count += 1;
                if !valid_text(&series.topic, 512)
                    || !valid_text(&series.field_path, 512)
                    || !valid_text(&series.color, 128)
                    || count > 2048
                {
                    return Err("Monitor 曲线字段或数量无效".into());
                }
            }
        }
    }
    if !ids.contains(&config.selected_dashboard_id) {
        return Err("Monitor 当前仪表盘不存在".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Barrier};
    fn config(name: &str) -> String {
        json!({"version":2,"dashboards":[{"id":"d1","name":name,"panels":[]}],"selectedDashboardId":"d1","layoutLocked":false,"compactType":"vertical"}).to_string()
    }
    fn dir() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "editor-documents-{}-{suffix}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn concurrent_windows_have_one_writer_and_conflict_never_overwrites() {
        let path = dir();
        let documents = Arc::new(Documents::default());
        let first = documents
            .commit(&path, Key::Monitor, 0, config("initial"))
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let threads: Vec<_> = ["Topics", "Monitor"]
            .into_iter()
            .map(|name| {
                let docs = documents.clone();
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    docs.commit(&path, Key::Monitor, first.snapshot.revision, config(name))
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.accepted).count(), 1);
        let current = documents.read(&path, Key::Monitor).unwrap();
        assert_eq!(current.revision, 2);
        assert_eq!(
            current.content,
            results
                .iter()
                .find(|r| r.accepted)
                .unwrap()
                .snapshot
                .content
        );
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn notices_external_edits_and_keeps_corrupt_or_oversize_files_intact() {
        let path = dir();
        let documents = Documents::default();
        documents
            .commit(&path, Key::Monitor, 0, config("initial"))
            .unwrap();
        fs::write(path.join(Key::Monitor.file()), config("external")).unwrap();
        let stale = documents
            .commit(&path, Key::Monitor, 1, config("stale"))
            .unwrap();
        assert!(!stale.accepted);
        assert_eq!(stale.snapshot.content, Some(config("external")));
        for content in ["broken".to_owned(), "x".repeat(Key::Monitor.limit() + 1)] {
            fs::write(path.join(Key::Monitor.file()), &content).unwrap();
            assert!(documents.read(&path, Key::Monitor).is_err());
            assert!(documents
                .commit(&path, Key::Monitor, 2, config("replacement"))
                .is_err());
            assert_eq!(
                fs::read_to_string(path.join(Key::Monitor.file())).unwrap(),
                content
            );
        }
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn validates_metadata_and_forbids_history_payloads_and_wrong_editors() {
        let mut value: serde_json::Value = serde_json::from_str(&config("valid")).unwrap();
        assert!(validate_monitor(&value.to_string()).is_ok());
        value["dashboards"][0]["panels"] = json!([{"id":"p","title":"effort[0]","layout":{"i":"p","x":0,"y":0,"w":4,"h":2},"series":{"topic":"/js","fieldPath":"effort[0]","color":"#fff"},"additionalSeries":[],"chart":{"type":"time-series","timeStyle":"line","barOrientation":"vertical","gaugeMin":0,"gaugeMax":100,"gaugeThreshold":80}}]);
        assert!(validate_monitor(&value.to_string()).is_ok());
        value["dashboards"][0]["panels"][0]["series"]["points"] = json!([{"t":10,"value":1}]);
        assert!(validate_monitor(&value.to_string()).is_err());
        assert!(!Key::Monitor.authorizes("main", true));
        assert!(!Key::Positions.authorizes("page-monitor", true));
        assert!(!Key::Monitor.authorizes("forged-page", false));
        assert!(Key::Monitor.authorizes("page-dashboard", true));
        assert!(Key::Monitor.authorizes("page-monitor", true));
    }
    #[test]
    fn legacy_stores_keep_paths_and_each_document_has_its_own_revision() {
        let path = dir();
        let documents = Documents::default();
        let positions = r#"{"schemaVersion":1,"profiles":{}}"#;
        fs::write(crate::positions::positions_file(&path), positions).unwrap();
        assert_eq!(
            documents
                .read(&path, Key::Positions)
                .unwrap()
                .content
                .as_deref(),
            Some(positions)
        );
        assert!(
            documents
                .commit(
                    &path,
                    Key::MotionGroups,
                    0,
                    r#"{"schemaVersion":1,"profiles":{}}"#.into()
                )
                .unwrap()
                .accepted
        );
        assert!(crate::motion_groups::motion_groups_file(&path).exists());
        assert_eq!(documents.read(&path, Key::Monitor).unwrap().revision, 0);
        let same = documents
            .commit(&path, Key::Positions, 1, positions.into())
            .unwrap();
        assert!(same.accepted);
        assert_eq!(same.snapshot.revision, 1);
        fs::remove_dir_all(path).unwrap();
    }
}
