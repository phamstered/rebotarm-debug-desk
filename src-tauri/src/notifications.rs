//! Transient, non-activating child windows. No task or control authority.
use crate::{
    session::windows::Page,
    terminal::{Entry, Terminal},
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl, WindowBuilder,
};

#[derive(Clone, Serialize)]
pub struct Notice {
    pub entry: Entry,
    pub title: String,
    pub summary: String,
}
struct Pending {
    notice: Notice,
    owner: String,
    parent: String,
    created: Instant,
    shown: Option<Instant>,
}
#[derive(Default)]
pub struct Notifications {
    gate: tokio::sync::Mutex<()>,
    pending: Mutex<VecDeque<Pending>>,
    seen: Mutex<HashMap<String, Instant>>,
}
fn label(id: u64) -> String {
    format!("notice-{id}")
}
fn authorized(view: &tauri::Webview) -> Result<(), String> {
    if view.label() == "main" || Page::from_label(view.label()).is_some() {
        Ok(())
    } else {
        Err("未授权的通知来源".into())
    }
}
fn own_id(view: &tauri::Webview) -> Result<u64, String> {
    view.label()
        .strip_prefix("notice-")
        .and_then(|s| s.parse().ok())
        .ok_or("未授权的通知窗口".into())
}
fn title(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).take(60).collect()
}
fn remember(seen: &mut HashMap<String, Instant>, key: String, now: Instant) -> bool {
    seen.retain(|_, at| now.duration_since(*at) < Duration::from_secs(3600));
    if seen.contains_key(&key) {
        return false;
    }
    if seen.len() >= 4096 {
        if let Some(old) = seen
            .iter()
            .min_by_key(|(_, at)| **at)
            .map(|(k, _)| k.clone())
        {
            seen.remove(&old);
        }
    }
    seen.insert(key, now);
    true
}
fn expired(p: &Pending, now: Instant) -> bool {
    now.duration_since(p.shown.unwrap_or(p.created))
        >= Duration::from_secs(if p.shown.is_some() { 3 } else { 10 })
}
fn placement(width: f64, index: usize) -> (f64, f64, f64) {
    let w = 480.0_f64.min((width - 32.0).max(240.0));
    ((width - w) / 2.0, 44.0 + index as f64 * 110.0, w)
}
pub(crate) fn remove(app: &tauri::AppHandle, id: u64) {
    app.state::<Notifications>()
        .pending
        .lock()
        .unwrap()
        .retain(|p| p.notice.entry.id != id);
    if let Some(w) = app.get_window(&label(id)) {
        let _ = w.destroy();
    }
}
fn layout(app: &tauri::AppHandle) {
    let items: Vec<_> = app
        .state::<Notifications>()
        .pending
        .lock()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p.notice.entry.id,
                p.owner.clone(),
                p.parent.clone(),
                expired(p, Instant::now()),
            )
        })
        .collect();
    let mut counts = HashMap::<String, usize>::new();
    for (id, owner, parent, expired) in items {
        let Some(view) = app.get_webview(&owner) else {
            remove(app, id);
            continue;
        };
        let host = view.window();
        if expired
            || host.label() != parent
            || !host.is_visible().unwrap_or(false)
            || host.is_minimized().unwrap_or(false)
        {
            remove(app, id);
            continue;
        }
        let index = counts.entry(parent).or_default();
        if let (Some(w), Ok(size), Ok(position), Ok(scale)) = (
            app.get_window(&label(id)),
            host.inner_size(),
            host.inner_position(),
            host.scale_factor(),
        ) {
            let size = size.to_logical::<f64>(scale);
            let position = position.to_logical::<f64>(scale);
            let (x, y, width) = placement(size.width, *index);
            let _ = w.set_size(LogicalSize::new(width, 102.0));
            let _ = w.set_position(LogicalPosition::new(position.x + x, position.y + y));
        }
        *index += 1;
    }
}
#[tauri::command]
pub async fn notification_show(
    app: tauri::AppHandle,
    view: tauri::Webview,
    id: u64,
    key: String,
    heading: String,
    summary: Option<String>,
) -> Result<(), String> {
    authorized(&view)?;
    let state = app.state::<Notifications>();
    let _gate = state.gate.lock().await;
    if key.is_empty() || key.len() > 512 {
        return Err("通知标识无效".into());
    }
    let terminal = app.state::<Terminal>();
    let entry = terminal.entry(id).ok_or("日志记录已过期")?;
    let current = terminal
        .context(&app.state::<crate::session::runtime::Runtime>().context())
        .0;
    if entry.session != current || entry.level != "error" {
        return Ok(());
    }
    if !remember(
        &mut state.seen.lock().unwrap(),
        format!("{}:{}:{key}", entry.session, view.label()),
        Instant::now(),
    ) {
        return Ok(());
    }
    let parent = view.window();
    let parent_label = parent.label().to_owned();
    let evict = {
        let rows = state.pending.lock().unwrap();
        let matching: Vec<_> = rows.iter().filter(|p| p.parent == parent_label).collect();
        if matching.len() >= 3 {
            Some(matching[0].notice.entry.id)
        } else {
            None
        }
    };
    if let Some(id) = evict {
        remove(&app, id);
    }
    let window_label = label(id);
    // Owned OS windows sit above all child WebViews without hiding them, changing
    // workspace visibility, moving focus or taking control leases.
    let window = WindowBuilder::new(&app, &window_label)
        .title("Robot Console · 错误")
        .parent(&parent)
        .map_err(|e| e.to_string())?
        .decorations(false)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .inner_size(480., 102.)
        .build()
        .map_err(|e| e.to_string())?;
    state.pending.lock().unwrap().push_back(Pending {
        notice: Notice {
            entry,
            title: title(&heading),
            summary: crate::terminal::clean(&summary.unwrap_or_default(), 512),
        },
        owner: view.label().into(),
        parent: parent_label,
        created: Instant::now(),
        shown: None,
    });
    if let Err(e) = window.add_child(
        WebviewBuilder::new(
            &window_label,
            WebviewUrl::App("index.html?notification=1".into()),
        )
        .focused(false)
        .accept_first_mouse(true)
        .auto_resize(),
        LogicalPosition::new(0., 0.),
        LogicalSize::new(480., 102.),
    ) {
        remove(&app, id);
        return Err(e.to_string());
    }
    layout(&app);
    Ok(())
}
#[tauri::command]
pub fn notification_read(
    app: tauri::AppHandle,
    view: tauri::Webview,
) -> Result<Option<Notice>, String> {
    let id = own_id(&view)?;
    Ok(app
        .state::<Notifications>()
        .pending
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.notice.entry.id == id)
        .map(|p| p.notice.clone()))
}
#[tauri::command]
pub fn notification_presented(app: tauri::AppHandle, view: tauri::Webview) -> Result<(), String> {
    let id = own_id(&view)?;
    let found = {
        let state = app.state::<Notifications>();
        let mut rows = state.pending.lock().unwrap();
        if let Some(p) = rows.iter_mut().find(|p| p.notice.entry.id == id) {
            p.shown.get_or_insert_with(Instant::now);
            true
        } else {
            false
        }
    };
    if found {
        view.window().show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn notification_close(
    app: tauri::AppHandle,
    view: tauri::Webview,
    open_log: bool,
) -> Result<(), String> {
    let id = own_id(&view)?;
    let item = app
        .state::<Notifications>()
        .pending
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.notice.entry.id == id)
        .map(|p| (p.owner.clone(), p.notice.entry.clone()));
    if open_log {
        if let Some((owner, entry)) = item {
            if let Some(origin) = app.get_webview(&owner) {
                let main = origin.window().label() == "main";
                let target = if main {
                    "main"
                } else {
                    owner.strip_prefix("page-").unwrap_or("main")
                };
                app.emit_to(
                    tauri::EventTarget::webview(if main { "main" } else { &owner }),
                    "terminal-open",
                    serde_json::json!({"target":target,"entry":entry}),
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    remove(&app, id);
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            layout(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending() -> Pending {
        Pending {
            notice: Notice {
                entry: Entry {
                    id: 1,
                    time: 0,
                    session: "s".into(),
                    host: "h".into(),
                    source: "Motor".into(),
                    level: "error".into(),
                    task: "t".into(),
                    message: "error".into(),
                },
                title: "title".into(),
                summary: String::new(),
            },
            owner: "page-motor".into(),
            parent: "main".into(),
            created: Instant::now(),
            shown: None,
        }
    }
    #[test]
    fn lifetime_starts_when_presented_and_duplicates_do_not_refresh_it() {
        let mut p = pending();
        assert!(!expired(&p, p.created + Duration::from_secs(3)));
        p.shown = Some(p.created + Duration::from_secs(1));
        assert!(!expired(&p, p.created + Duration::from_millis(3999)));
        assert!(expired(&p, p.created + Duration::from_secs(4)));
    }
    #[test]
    fn retries_and_sessions_have_distinct_keys() {
        let mut seen = HashMap::new();
        let now = Instant::now();
        assert!(remember(&mut seen, "s:operation-1".into(), now));
        assert!(!remember(&mut seen, "s:operation-1".into(), now));
        assert!(remember(&mut seen, "s:operation-2".into(), now));
        assert!(remember(&mut seen, "new:operation-1".into(), now));
    }
    #[test]
    fn bounded_layout_leaves_window_edges_clear() {
        for width in [640., 900., 1440.] {
            for i in 0..3 {
                let (x, y, w) = placement(width, i);
                assert!(x >= 16. && x + w <= width - 16. && y + 102. < 480.);
            }
        }
    }
}
