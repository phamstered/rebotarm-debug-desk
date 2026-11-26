//! Application-owned diagnostic history. No control authority is derived from logs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Listener, Manager};
const MAX_ROWS: usize = 20_000;
const MAX_BYTES: usize = 20 * 1024 * 1024;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: u64,
    pub time: u64,
    pub session: String,
    pub host: String,
    pub source: String,
    pub level: String,
    pub task: String,
    pub message: String,
}
#[derive(Clone, Deserialize)]
pub struct Input {
    #[serde(default)]
    pub key: Option<String>,
    pub source: String,
    pub level: String,
    #[serde(default)]
    pub task: String,
    pub message: String,
}
#[derive(Default)]
struct History {
    seq: u64,
    bytes: usize,
    rows: VecDeque<Entry>,
    sessions: HashMap<String, String>,
    seen: HashMap<String, [u8; 32]>,
    archive: Vec<Entry>,
    archive_bytes: usize,
    archive_error: String,
    task_sessions: HashMap<String, String>,
    dropped: u64,
}
#[derive(Default)]
pub struct Terminal(Mutex<History>);
pub(crate) fn clean(text: &str, limit: usize) -> String {
    // Strip escape sequences and control characters; do not render terminal commands.
    let mut output = String::new();
    let mut escape = 0;
    for c in text.chars() {
        if escape == 1 {
            escape = if c == '[' {
                2
            } else if c == ']' {
                3
            } else {
                0
            };
            continue;
        }
        if escape == 2 {
            if ('@'..='~').contains(&c) {
                escape = 0;
            }
            continue;
        }
        if escape == 3 {
            if c == '\u{7}' {
                escape = 0;
            } else if c == '\u{1b}' {
                escape = 4;
            }
            continue;
        }
        if escape == 4 {
            escape = if c == '\\' { 0 } else { 3 };
            continue;
        }
        if c == '\u{1b}' {
            escape = 1;
            continue;
        }
        if !c.is_control() || c == '\n' || c == '\t' {
            if output.len() + c.len_utf8() > limit {
                output.push_str("…[截断]");
                break;
            }
            output.push(c);
        }
    }
    // ASCII-only case folding preserves UTF-8 byte offsets. Cover assignments,
    // JSON fields and Authorization headers without interpreting output as code.
    for key in [
        "password",
        "token",
        "secret",
        "api_key",
        "authorization",
        "bearer",
    ] {
        let mut start = 0;
        while let Some(index) = output[start..].to_ascii_lowercase().find(key) {
            let at = start + index;
            let mut value = at + key.len();
            start = value;
            if at > 0 && output.as_bytes()[at - 1].is_ascii_alphanumeric() {
                continue;
            }
            let bytes = output.as_bytes();
            if key == "bearer" {
                if bytes.get(value) != Some(&b' ') {
                    continue;
                }
            } else {
                if matches!(bytes.get(value), Some(b'"' | b'\'')) {
                    value += 1;
                }
                while bytes.get(value).is_some_and(u8::is_ascii_whitespace) {
                    value += 1;
                }
                if !matches!(bytes.get(value), Some(b'=' | b':')) {
                    continue;
                }
                value += 1;
            }
            while output
                .as_bytes()
                .get(value)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value += 1;
            }
            let quoted = matches!(output.as_bytes().get(value), Some(b'"' | b'\''));
            if quoted {
                value += 1;
            }
            let end = output[value..]
                .find(|c: char| {
                    if quoted {
                        c == '"' || c == '\''
                    } else if key == "authorization" {
                        c == '\n' || c == '\r' || c == ','
                    } else {
                        c.is_whitespace() || c == '&' || c == ',' || c == '"' || c == '\''
                    }
                })
                .map_or(output.len(), |n| value + n);
            output.replace_range(value..end, "[REDACTED]");
            start = value + 10;
        }
    }
    if output.contains("PRIVATE KEY") {
        return "[REDACTED private key material]".into();
    }
    if output.len() > limit {
        let marker = "…[截断]";
        while output.len() + marker.len() > limit {
            if output.pop().is_none() {
                break;
            }
        }
        output.push_str(marker);
    }
    output
}
impl Terminal {
    pub fn context(&self, context: &Value) -> (String, String) {
        let session = format!(
            "{}:{}:{}",
            context["epoch"], context["profile_revision"], context["connected"]
        );
        let host = context["profile"]["host"]
            .as_str()
            .unwrap_or("本地")
            .to_string();
        let mut h = self.0.lock().unwrap();
        h.sessions.insert(session.clone(), host.clone());
        h.sessions.entry("local".into()).or_insert("本地".into());
        (session, host)
    }
    fn task_session(&self, current: &str, source: &str, value: &Value) -> String {
        let key = format!("{source}:{}", value["id"]);
        let mut h = self.0.lock().unwrap();
        if let Some(session) = h.task_sessions.get(&key) {
            return session.clone();
        }
        let session = value["epoch"]
            .as_u64()
            .and_then(|epoch| {
                h.sessions
                    .keys()
                    .find(|s| s.starts_with(&format!("{epoch}:")) && s.ends_with(":true"))
                    .cloned()
            })
            .unwrap_or_else(|| current.into());
        if h.task_sessions.len() > 4096 {
            h.task_sessions.clear();
        }
        h.task_sessions.insert(key, session.clone());
        session
    }
    fn append(&self, session: &str, input: Input, key: Option<&str>) -> Result<Option<Entry>, String> {
        if input.key.as_ref().is_some_and(|s| s.len() > 512)
            || input.message.len() > 128 * 1024
            || input.source.len() > 80
            || input.task.len() > 200
        {
            return Err("日志记录超出上限".into());
        }
        if !["debug", "info", "warn", "error"].contains(&input.level.as_str()) {
            return Err("无效日志级别".into());
        }
        let mut h = self.0.lock().unwrap();
        let host = h.sessions.get(session).cloned().ok_or("日志会话已失效")?;
        let message = clean(&input.message, 16384);
        if message.is_empty() {
            return Ok(None);
        }
        if let Some(key) = key {
            let key = format!("{session}:{key}");
            let signature: [u8; 32] =
                Sha256::digest(format!("{}:{}", input.level, message).as_bytes()).into();
            if h.seen.get(&key) == Some(&signature) {
                return Ok(None);
            }
            if h.seen.len() > 4096 {
                h.seen.clear();
            }
            h.seen.insert(key, signature);
        }
        h.seq += 1;
        let entry = Entry {
            id: h.seq,
            time: now(),
            session: session.into(),
            host,
            source: clean(&input.source, 80),
            level: input.level,
            task: clean(&input.task, 200),
            message,
        };
        let size = serde_json::to_vec(&entry).unwrap().len();
        h.bytes += size;
        // Bounded asynchronous archive queue: disk never holds a control mutex.
        if h.archive.len() < MAX_ROWS && h.archive_bytes + size <= MAX_BYTES {
            h.archive_bytes += size;
            h.archive.push(entry.clone());
        } else {
            h.dropped += 1;
        }
        h.rows.push_back(entry.clone());
        while h.rows.len() > MAX_ROWS || h.bytes > MAX_BYTES {
            if let Some(old) = h.rows.pop_front() {
                h.bytes = h
                    .bytes
                    .saturating_sub(serde_json::to_vec(&old).unwrap().len());
            }
        }
        Ok(Some(entry))
    }
    pub fn entry(&self, id: u64) -> Option<Entry> {
        self.0.lock().unwrap().rows.iter().find(|row| row.id == id).cloned()
    }
    fn page(&self, after: u64) -> Value {
        let h = self.0.lock().unwrap();
        let rows: Vec<_> = h
            .rows
            .iter()
            .filter(|r| r.id > after)
            .take(256)
            .cloned()
            .collect();
        json!({"entries":rows,"cursor":rows.last().map_or(after,|r|r.id),"latest":h.seq,"truncated":h.rows.front().is_some_and(|r|after.saturating_add(1)<r.id),"sessions":h.sessions,"archive_dropped":h.dropped,"archive_error":h.archive_error})
    }
}
fn allowed(window: &tauri::Webview) -> Result<(), String> {
    if window.label() == "main"
        || crate::session::windows::Page::from_label(window.label()).is_some()
    {
        Ok(())
    } else {
        Err("未授权的日志窗口".into())
    }
}
#[tauri::command]
pub fn terminal_read(
    window: tauri::Webview,
    terminal: tauri::State<Terminal>,
    runtime: tauri::State<crate::session::runtime::Runtime>,
    after: u64,
) -> Result<Value, String> {
    allowed(&window)?;
    let (session, host) = terminal.context(&runtime.context());
    let mut page = terminal.page(after);
    page["session"] = json!(session);
    page["host"] = json!(host);
    Ok(page)
}
#[tauri::command]
pub fn terminal_append(
    window: tauri::Webview,
    terminal: tauri::State<Terminal>,
    runtime: tauri::State<crate::session::runtime::Runtime>,
    session: Option<String>,
    entries: Vec<Input>,
) -> Result<Vec<Option<Entry>>, String> {
    allowed(&window)?;
    let (current, _) = terminal.context(&runtime.context());
    let session = session.unwrap_or(current);
    if entries.len() > 256 {
        return Err("日志批次过大".into());
    }
    let mut written = Vec::new();
    for input in entries {
        let key = input.key.clone();
        written.push(terminal.append(&session, input, key.as_deref())?);
    }
    Ok(written)
}
#[tauri::command]
pub fn terminal_export(
    window: tauri::Webview,
    terminal: tauri::State<Terminal>,
    path: String,
    session: Option<String>,
    source: Option<String>,
    level: Option<String>,
    task: Option<String>,
    search: Option<String>,
    after: u64,
) -> Result<(), String> {
    allowed(&window)?;
    let path = std::path::Path::new(&path);
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some("log") {
        return Err("请选择 .log 绝对路径".into());
    }
    let content = {
        let h = terminal.0.lock().unwrap();
        h.rows
            .iter()
            .filter(|r| {
                r.id > after
                    && session.as_ref().is_none_or(|v| v == &r.session)
                    && source.as_ref().is_none_or(|v| v == &r.source)
                    && level.as_ref().is_none_or(|v| {
                        if v == "info+" {
                            r.level != "debug"
                        } else {
                            v == &r.level
                        }
                    })
                    && task.as_ref().is_none_or(|v| v == &r.task)
                    && search
                        .as_ref()
                        .is_none_or(|v| format_entry(r).to_lowercase().contains(&v.to_lowercase()))
            })
            .map(|r| format!("{}\n", format_entry(r)))
            .collect::<String>()
    };
    std::fs::write(path, content).map_err(|e| e.to_string())
}
fn format_entry(r: &Entry) -> String {
    format!(
        "{} [{}] [{}] [{}] [{}] {}",
        r.time,
        r.level.to_uppercase(),
        r.host,
        r.source,
        r.task,
        r.message
    )
}

pub fn publish(app: &tauri::AppHandle, source: &str, level: &str, message: &str) {
    let terminal = app.state::<Terminal>();
    let (session, _) = terminal.context(&app.state::<crate::session::runtime::Runtime>().context());
    let _ = terminal.append(
        &session,
        Input {
            key: None,
            source: source.into(),
            level: level.into(),
            task: String::new(),
            message: message.into(),
        },
        None,
    );
}

fn level_from_text(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("[debug]") {
        "debug"
    } else if lower.contains("[info]") {
        "info"
    } else if lower.contains("error")
        || lower.contains("fatal")
        || lower.contains("exception")
        || lower.contains("失败")
    {
        "error"
    } else if lower.contains("warn") || lower.contains("未确认") {
        "warn"
    } else {
        "info"
    }
}
fn record(app: &tauri::AppHandle, source: &str, value: Value) {
    let runtime = app.state::<crate::session::runtime::Runtime>();
    let terminal = app.state::<Terminal>();
    let (session, _) = terminal.context(&runtime.context());
    if value.is_null() {
        return;
    }
    let session = terminal.task_session(&session, source, &value);
    let phase = value["phase"].as_str().unwrap_or("");
    let level = if phase == "failed" || value["recovery_error"] == true {
        "error"
    } else if matches!(phase, "uncertain" | "stopping") {
        "warn"
    } else {
        "info"
    };
    let task = format!("{}:{}", source, value["id"]);
    let message = format!(
        "{} · {}",
        phase,
        value["message"].as_str().unwrap_or("状态已更新")
    );
    let _ = terminal.append(
        &session,
        Input {
            key: None,
            source: source.into(),
            level: level.into(),
            task: task.clone(),
            message,
        },
        Some(&task),
    );
}
pub fn initialize(app: &tauri::AppHandle) {
    // Listen in native code even when no WebView is visible.
    for (event, source) in [
        ("native-tasks-changed", "Task"),
        ("native-local-tasks-changed", "Handeye"),
        ("native-collection-operation-changed", "Collection"),
        ("native-bag-operations-changed", "Rosbag"),
    ] {
        let app = app.clone();
        let handle = app.clone();
        let previous = Mutex::new(false);
        handle.listen(event, move |_| {
            let runtime = app.state::<crate::session::runtime::Runtime>();
            let value = match source {
                "Task" => serde_json::to_value(
                    runtime
                        .finite_recovery
                        .error_snapshot()
                        .or_else(|| runtime.motor_recovery.error_snapshot())
                        .or_else(|| runtime.leased_recovery.error_snapshot())
                        .or_else(|| runtime.tasks.snapshot()),
                ),
                "Handeye" => serde_json::to_value(runtime.local_tasks.snapshot()),
                "Collection" => serde_json::to_value(runtime.collection_operations.snapshot()),
                _ => serde_json::to_value(runtime.bag_operations.snapshot()),
            };
            if let Ok(value) = value {
                let present = !value.is_null() && value.as_array().is_none_or(|a| !a.is_empty());
                let was = std::mem::replace(&mut *previous.lock().unwrap(), present);
                if was && !present {
                    publish(
                        &app,
                        source,
                        "info",
                        "原生任务占用已释放；执行结果请查看该任务记录",
                    );
                }
                if let Some(rows) = value.as_array() {
                    for row in rows {
                        record(&app, source, row.clone());
                    }
                } else {
                    record(&app, source, value);
                }
            }
        });
    }
    let motion = app.clone();
    app.state::<crate::session::runtime::Runtime>()
        .motion_logs
        .set_sink(std::sync::Arc::new(move |epoch, rows, gap| {
            let terminal = motion.state::<Terminal>();
            let context = motion.state::<crate::session::runtime::Runtime>().context();
            let (current, _) = terminal.context(&context);
            let session = if context["epoch"].as_u64() == Some(epoch) {
                current
            } else {
                let h = terminal.0.lock().unwrap();
                match h
                    .sessions
                    .keys()
                    .find(|s| s.starts_with(&format!("{epoch}:")) && s.ends_with(":true"))
                    .cloned()
                {
                    Some(s) => s,
                    None => return,
                }
            };
            if gap {
                let _ = terminal.append(
                    &session,
                    Input {
                        key: None,
                        source: "Motion".into(),
                        task: String::new(),
                        level: "warn".into(),
                        message: "运动日志同步窗口已截断，请查阅 Bridge 源日志".into(),
                    },
                    None,
                );
            }
            for row in rows {
                let level = row["level"]
                    .as_str()
                    .filter(|s| ["debug", "info", "warn", "error"].contains(s))
                    .unwrap_or("info");
                let _ = terminal.append(
                    &session,
                    Input {
                        key: None,
                        source: "Motion".into(),
                        task: row["command_id"].as_str().unwrap_or("").into(),
                        level: level.into(),
                        message: format!(
                            "{} · {}",
                            row["phase"].as_str().unwrap_or(""),
                            row["message"].as_str().unwrap_or("")
                        ),
                    },
                    None,
                );
            }
        }));
    let observed = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut session = String::new();
        let mut previous = String::new();
        let mut sequence = 0;
        loop {
            let runtime = observed.state::<crate::session::runtime::Runtime>();
            let context = runtime.context();
            let snapshot = runtime.observations.activity_snapshot();
            let terminal = observed.state::<Terminal>();
            let (current, _) = terminal.context(&context);
            if current != session {
                session = current;
                previous.clear();
                sequence = 0;
            }
            if snapshot.connected && context["epoch"].as_u64() == Some(snapshot.epoch) {
                if let Some(entry) = snapshot
                    .entries
                    .get(&crate::session::observations::Source::Collection)
                {
                    if entry.sequence != sequence {
                        sequence = entry.sequence;
                        if let Some(value) = &entry.value {
                            let text = value["log"].as_str().unwrap_or("");
                            for message in new_lines(&previous, text) {
                                let _ = terminal.append(
                                    &session,
                                    Input {
                                        key: None,
                                        source: "Collection".into(),
                                        level: level_from_text(&message).into(),
                                        task: String::new(),
                                        message,
                                    },
                                    None,
                                );
                            }
                            previous = text
                                .chars()
                                .rev()
                                .take(128 * 1024)
                                .collect::<String>()
                                .chars()
                                .rev()
                                .collect();
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    let deploy = app.clone();
    app.listen("bridge-deploy-progress", move |event| {
        if let Ok(message) = serde_json::from_str::<String>(event.payload()) {
            publish(&deploy, "Deploy", level_from_text(&message), &message);
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut session = String::new();
        let mut cursors_by_host = HashMap::<String, Value>::new();
        loop {
            let context = handle.state::<crate::session::runtime::Runtime>().context();
            let (current, host) = handle.state::<Terminal>().context(&context);
            if session != current {
                session = current.clone();
                let _ = handle.state::<Terminal>().append(
                    &session,
                    Input {
                        key: None,
                        source: "System".into(),
                        level: "info".into(),
                        task: String::new(),
                        message: format!(
                            "会话状态 · {host} · {}",
                            if context["connected"] == true {
                                "已连接"
                            } else {
                                "未连接"
                            }
                        ),
                    },
                    None,
                );
            }
            if context["connected"] == true {
                if let Ok(profile) =
                    serde_json::from_value::<crate::ConnectionProfile>(context["profile"].clone())
                {
                    let key = json!([
                        profile.host,
                        profile.ssh_port,
                        profile.username,
                        profile.identity_file,
                        profile.ros_domain_id
                    ])
                    .to_string();
                    let cursors = cursors_by_host.get(&key).cloned().unwrap_or(Value::Null);
                    match crate::control_logs::terminal_batch(
                        &profile,
                        cursors,
                        &handle.state::<crate::control_logs::LogSessions>(),
                    )
                    .await
                    {
                        Ok(batch) => {
                            cursors_by_host.insert(key, batch["cursors"].clone());
                            if let Some(rows) = batch["entries"].as_array() {
                                for row in rows {
                                    let message = row["message"].as_str().unwrap_or("");
                                    let level = level_from_text(message);
                                    let _ = handle.state::<Terminal>().append(
                                        &current,
                                        Input {
                                            key: None,
                                            source: row["source"].as_str().unwrap_or("ROS").into(),
                                            level: level.into(),
                                            task: String::new(),
                                            message: message.into(),
                                        },
                                        None,
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            let _ = handle.state::<Terminal>().append(
                                &current,
                                Input {
                                    key: None,
                                    source: "System".into(),
                                    level: "warn".into(),
                                    task: String::new(),
                                    message: error,
                                },
                                Some("remote-reader"),
                            );
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        let path = app.path().app_log_dir().map(|p| p.join("terminal"));
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let rows = {
                let terminal = app.state::<Terminal>();
                let mut h = terminal.0.lock().unwrap();
                h.archive_bytes = 0;
                std::mem::take(&mut h.archive)
            };
            if rows.is_empty() {
                continue;
            }
            let count = rows.len() as u64;
            let result = path
                .as_ref()
                .map_err(|e| e.to_string())
                .and_then(|dir| write_archive(dir, &rows));
            let terminal = app.state::<Terminal>();
            let mut h = terminal.0.lock().unwrap();
            if let Err(error) = result {
                h.dropped += count;
                if h.archive_error != error {
                    h.archive_error = error.clone();
                    drop(h);
                    let _ = app.emit("terminal-storage-error", error);
                }
            } else {
                h.archive_error.clear();
            }
        }
    });
}
fn new_lines(previous: &str, current: &str) -> Vec<String> {
    let before: Vec<_> = previous.lines().collect();
    let after: Vec<_> = current.lines().collect();
    let mut overlap = before.len().min(after.len());
    while overlap > 0 && before[before.len() - overlap..] != after[..overlap] {
        overlap -= 1;
    }
    after[overlap..].iter().map(|s| s.to_string()).collect()
}
fn write_archive(dir: &std::path::Path, rows: &[Entry]) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut content = Vec::new();
    for row in rows {
        serde_json::to_writer(&mut content, row).map_err(|e| e.to_string())?;
        content.push(b'\n');
    }
    let mut files = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|f| f.file_name().to_string_lossy().starts_with("terminal-"))
        .collect::<Vec<_>>();
    files.sort_by_key(|f| f.file_name());
    let mut total: u64 = files
        .iter()
        .filter_map(|f| f.metadata().ok())
        .map(|m| m.len())
        .sum();
    for f in files {
        let meta = f.metadata().map_err(|e| e.to_string())?;
        if total + content.len() as u64 > 100 * 1024 * 1024
            || meta
                .modified()
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|d| d.as_secs() > 7 * 86400)
        {
            std::fs::remove_file(f.path()).map_err(|e| e.to_string())?;
            total = total.saturating_sub(meta.len());
        }
    }
    let name = dir.join(format!("terminal-{:020}.jsonl", now() / 60_000));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(name)
        .and_then(|mut file| file.write_all(&content))
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Terminal {
        let t = Terminal::default();
        t.context(
            &json!({"epoch":1,"profile_revision":0,"connected":true,"profile":{"host":"robot"}}),
        );
        t
    }
    fn input(message: &str) -> Input {
        Input {
            key: None,
            source: "Controller".into(),
            level: "info".into(),
            task: "one".into(),
            message: message.into(),
        }
    }
    #[test]
    fn duplicate_states_are_coalesced_but_task_events_are_not() {
        let t = setup();
        for _ in 0..3 {
            t.append("1:0:true", input("pending"), Some("task1"))
                .unwrap();
        }
        t.append("1:0:true", input("pending"), Some("task2"))
            .unwrap();
        assert_eq!(t.page(0)["entries"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn session_fencing_and_independent_cursors() {
        let t = setup();
        t.append("1:0:true", input("old"), None).unwrap();
        t.context(&json!({"epoch":2,"profile_revision":0,"connected":true}));
        t.append("1:0:true", input("late old"), None).unwrap();
        assert_eq!(t.page(1)["entries"][0]["session"], "1:0:true");
        assert!(t.append("unknown", input("bad"), None).is_err());
        assert_eq!(t.page(0)["entries"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn bounds_and_export_control_sequences() {
        let t = setup();
        for _ in 0..MAX_ROWS + 3 {
            t.append("1:0:true", input("line"), None).unwrap();
        }
        assert_eq!(t.0.lock().unwrap().rows.len(), MAX_ROWS);
        assert_eq!(t.page(1)["truncated"], true);
        assert_eq!(
            clean("\x1b[31mred\x1b[0m token=abc", 100),
            "red token=[REDACTED]"
        );
    }
    #[test]
    fn memory_and_archive_queues_have_byte_limits() {
        let t = setup();
        for _ in 0..2000 {
            t.append("1:0:true", input(&"中".repeat(8000)), None)
                .unwrap();
        }
        let h = t.0.lock().unwrap();
        assert!(h.bytes <= MAX_BYTES);
        assert!(h.archive_bytes <= MAX_BYTES);
        assert!(h.dropped > 0);
        assert!(h.rows.len() < 2000);
    }
    #[test]
    fn redacts_json_and_handles_unicode_without_invalid_byte_offsets() {
        assert_eq!(
            clean("İ password=secret token=abc", 100),
            "İ password=[REDACTED] token=[REDACTED]"
        );
        assert_eq!(
            clean(r#"{"password": "hello world", "token":"value"}"#, 100),
            r#"{"password": "[REDACTED]", "token":"[REDACTED]"}"#
        );
        assert_eq!(
            clean("Authorization: Bearer secret", 100),
            "Authorization: [REDACTED]"
        );
        assert_eq!(
            clean("\x1b]8;;https://evil\x07visible\x1b]8;;\x07", 100),
            "visible"
        );
    }
    #[test]
    fn truncation_including_redaction_expansion_respects_utf8_byte_limit() {
        let text = clean(&"中 password=a ".repeat(100), 80);
        assert!(text.len() <= 80);
        assert!(text.ends_with("…[截断]"));
        let t = setup();
        t.append("1:0:true", input("x"), None).unwrap();
        assert_eq!(t.page(u64::MAX)["entries"], json!([]));
    }
    #[test]
    fn collector_tails_only_emit_new_lines_and_survive_rotation() {
        assert_eq!(new_lines("a\nb\n", "b\nc\n"), vec!["c"]);
        assert!(new_lines("a\nb\n", "a\nb\n").is_empty());
        assert_eq!(new_lines("old\n", "new\n"), vec!["new"]);
    }
    #[test]
    fn task_updates_keep_the_original_session_after_reconnect() {
        let t = setup();
        let value = json!({"id":7,"epoch":1});
        assert_eq!(t.task_session("1:0:true", "Task", &value), "1:0:true");
        t.context(&json!({"epoch":2,"profile_revision":0,"connected":true}));
        assert_eq!(t.task_session("2:0:true", "Task", &value), "1:0:true");
    }
    #[test]
    fn archive_is_private_rotates_at_the_global_limit_and_keeps_valid_json() {
        let dir =
            std::env::temp_dir().join(format!("terminal-test-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("terminal-000.jsonl");
        std::fs::File::create(&old)
            .unwrap()
            .set_len(100 * 1024 * 1024)
            .unwrap();
        let t = setup();
        t.append("1:0:true", input("token=abc"), None).unwrap();
        let rows = t.0.lock().unwrap().archive.clone();
        write_archive(&dir, &rows).unwrap();
        assert!(!old.exists());
        let path = std::fs::read_dir(&dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let content = std::fs::read_to_string(&path).unwrap();
        let row: Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(row["message"], "token=[REDACTED]");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
