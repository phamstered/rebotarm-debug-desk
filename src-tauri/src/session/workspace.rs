//! Each page owns one persistent WebView. Detach/dock reparent that view; React,
//! image samples, editor drafts and GPU state are not cloned or reconstructed.
use super::{
    layout::{Display, Geometry, LayoutStore, PageLayout},
    windows::{Page, Rect},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewBuilder,
    WebviewUrl, Window, WindowBuilder, WindowEvent,
};
use tokio::sync::Mutex as AsyncMutex;
#[path = "workspace_migration.rs"]
mod movement;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageState {
    pub detached: bool,
    pub visible: bool,
    pub ready: bool,
    pub busy_reason: String,
    #[serde(default)]
    pub recovery_required: bool,
    #[serde(default)]
    pub restore_pending: String,
}

impl PageState {
    fn migration_allowed(&self) -> Result<(), String> {
        if !self.ready {
            return Err("页面仍在加载，请稍后再移动".into());
        }
        if !self.busy_reason.is_empty() {
            return Err(self.busy_reason.clone());
        }
        if self.recovery_required {
            return Err("请先恢复窗口，再继续拆出或收回".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub selected: Page,
    pub motion_navigation: Option<MotionNavigation>,
    pub pages: BTreeMap<Page, PageState>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MotionTab { Robot, Positions, Groups }
#[derive(Clone, Debug, Serialize)]
pub struct MotionNavigation { pub revision: u64, pub tab: MotionTab, pub profile_key: String }
impl Snapshot {
    fn navigate_motion(&mut self, tab: MotionTab, profile_key: String) -> Result<(), String> {
        if profile_key.trim().is_empty() || profile_key.len() > 512 || profile_key.chars().any(|c| c.is_control()) {
            return Err("连接标识无效".into());
        }
        let revision = self.motion_navigation.as_ref().map_or(0, |n| n.revision).checked_add(1).ok_or("导航版本已耗尽")?;
        self.selected = Page::Motion;
        self.motion_navigation = Some(MotionNavigation { revision, tab, profile_key });
        Ok(())
    }
}

pub struct Workspace {
    gate: AsyncMutex<()>,
    state: Mutex<Snapshot>,
    bounds: Mutex<Rect>,
    covered: Mutex<bool>,
    main_hidden: AtomicBool,
    layout: LayoutStore,
    restoring: Mutex<BTreeSet<Page>>,
    restore_started: Mutex<BTreeSet<Page>>,
    moving: Mutex<BTreeSet<Page>>,
    recoveries: Mutex<BTreeMap<Page, movement::Recovery>>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            gate: AsyncMutex::new(()),
            covered: Mutex::new(true),
            main_hidden: AtomicBool::new(false),
            layout: LayoutStore::default(),
            restoring: Mutex::new(BTreeSet::new()),
            restore_started: Mutex::new(BTreeSet::new()),
            moving: Mutex::new(BTreeSet::new()),
            recoveries: Mutex::new(BTreeMap::new()),
            state: Mutex::new(Snapshot {
                selected: Page::Status,
                motion_navigation: None,
                pages: BTreeMap::new(),
            }),
            bounds: Mutex::new(Rect {
                x: 210.0,
                y: 96.0,
                width: 1100.0,
                height: 750.0,
            }),
        }
    }
}

fn authorize(view: &Webview, page: Option<Page>) -> Result<(), String> {
    if view.label() == "main" || page.is_some_and(|page| page.label() == view.label()) {
        Ok(())
    } else {
        Err("当前页面无权操作此窗口".into())
    }
}

fn authorize_motion_navigation(label: &str, tab: MotionTab) -> Result<(), String> {
    if label == "main" || label == Page::Handeye.label() && matches!(tab, MotionTab::Robot) {
        Ok(())
    } else {
        Err("当前页面无权请求此 Motion 导航".into())
    }
}

fn native_bounds(bounds: Rect) -> tauri::Rect {
    tauri::Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    }
}

#[derive(Clone, Copy, Deserialize)]
pub struct Viewport {
    width: f64,
    height: f64,
}

fn embedded_bounds(content: Rect, root: Rect, viewport: Viewport) -> Result<Rect, String> {
    if ![
        content.x,
        content.y,
        content.width,
        content.height,
        root.x,
        root.y,
        root.width,
        root.height,
        viewport.width,
        viewport.height,
    ]
    .iter()
    .all(|v| v.is_finite())
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || root.width <= 0.0
    {
        return Err("页面坐标无效".into());
    }
    // WebKit's CSS viewport excludes the macOS titlebar inset. The native
    // WebView frame includes it. Scale CSS pixels and retain that top inset;
    // do not hard-code a decoration height (fullscreen and zoom differ).
    let css_scale = root.width / viewport.width;
    let top_inset = (root.height - viewport.height * css_scale).max(0.0);
    Ok(Rect {
        x: root.x + content.x * css_scale,
        y: root.y + top_inset + content.y * css_scale,
        width: content.width * css_scale,
        height: content.height * css_scale,
    })
}

fn detached_label(page: Page) -> String {
    format!("detached-{}", page.label())
}

fn display(monitor: &tauri::Monitor) -> Display {
    let area = monitor.work_area();
    let position = area.position.to_logical::<f64>(monitor.scale_factor());
    let size = area.size.to_logical::<f64>(monitor.scale_factor());
    Display {
        name: monitor.name().cloned(),
        area: Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
    }
}

fn displays(app: &AppHandle) -> Result<Vec<Display>, String> {
    let primary = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .map(|m| display(&m));
    let mut displays: Vec<_> = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(display)
        .collect();
    displays.sort_by_key(|m| Some(m) != primary.as_ref());
    Ok(displays)
}

fn geometry(window: &Window) -> Result<Geometry, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let position = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let outer = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let inner = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok(Geometry {
        outer: Rect {
            x: position.x,
            y: position.y,
            width: outer.width,
            height: outer.height,
        },
        decoration: (
            (outer.width - inner.width).max(0.0),
            (outer.height - inner.height).max(0.0),
        ),
        monitor: window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .and_then(|m| m.name().cloned()),
    })
}

fn normal_window(window: &Window) -> bool {
    !window.is_minimized().unwrap_or(true)
        && !window.is_maximized().unwrap_or(true)
        && !window.is_fullscreen().unwrap_or(true)
}

fn apply_geometry(window: &Window, geometry: &Geometry, minimum: (f64, f64)) -> Result<(), String> {
    let (width, height) = geometry.inner_size();
    // Small displays must still be able to show the titlebar and controls.
    window
        .set_min_size(Some(LogicalSize::new(
            minimum.0.min(width),
            minimum.1.min(height),
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(LogicalPosition::new(geometry.outer.x, geometry.outer.y))
        .map_err(|e| e.to_string())
}

impl Workspace {
    pub fn initialize(app: &AppHandle) {
        let workspace = app.state::<Self>();
        let loaded = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())
            .and_then(|path| workspace.layout.load(path.join("window-layout-v1.json")));
        if let Err(error) = loaded {
            eprintln!("{error}");
        }
        let saved = workspace.layout.snapshot();
        workspace.state.lock().unwrap().selected = saved.selected;
        *workspace.restoring.lock().unwrap() = saved
            .pages
            .iter()
            .filter_map(|(page, state)| state.detached.then_some(*page))
            .collect();
        if let (Some(main), Ok(areas), Some(saved)) =
            (app.get_window("main"), displays(app), saved.main)
        {
            if let Some(geometry) = saved.restore(&areas, (900., 620.)) {
                if let Err(error) = apply_geometry(&main, &geometry, (900., 620.)) {
                    eprintln!("恢复主窗口失败：{error}");
                }
            }
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let workspace = app.state::<Self>();
            let pages: Vec<_> = workspace
                .restoring
                .lock()
                .unwrap()
                .iter()
                .copied()
                .collect();
            for page in pages {
                let _gate = workspace.gate.lock().await;
                if let Err(error) = workspace.ensure(&app, page).await {
                    let _ = app.emit(
                        "workspace-error",
                        format!("恢复 {} 窗口失败：{error}", page.title()),
                    );
                }
            }
            let mut previous_displays = displays(&app).unwrap_or_default();
            let mut last_error = String::new();
            loop {
                tokio::time::sleep(Duration::from_millis(750)).await;
                let pending: Vec<_> = workspace.restoring.lock().unwrap().iter().copied().collect();
                for page in pending {
                    workspace.restore_window(&app, page).await;
                }
                if let Ok(current) = displays(&app) {
                    if !current.is_empty() && current != previous_displays {
                        let _gate = workspace.gate.lock().await;
                        for window in app.windows().values() {
                            if normal_window(window) {
                                let minimum = if window.label() == "main" {
                                    (900., 620.)
                                } else {
                                    (640., 480.)
                                };
                                if let Ok(g) = geometry(window) {
                                    if let Some(restored) = g.restore(&current, minimum) {
                                        if let Err(error) =
                                            apply_geometry(window, &restored, minimum)
                                        {
                                            let _ = app.emit(
                                                "workspace-error",
                                                format!("恢复可见窗口失败：{error}"),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        previous_displays = current;
                    }
                }
                let result = workspace.layout.flush();
                match result {
                    Err(error) if last_error != error => {
                        let _ = app.emit("workspace-error", &error);
                        last_error = error;
                    }
                    Ok(()) => last_error.clear(),
                    _ => {}
                }
            }
        });
    }

    pub fn flush(&self) {
        if let Err(error) = self.layout.flush() {
            eprintln!("{error}");
        }
    }

    fn save_layout(&self, app: &AppHandle) {
        let snapshot = self.snapshot();
        // Native queries can invoke window callbacks. Never hold the store lock
        // while calling them, or a resize callback could deadlock the UI thread.
        let geometries: BTreeMap<_, _> = snapshot
            .pages
            .iter()
            .filter_map(|(page, state)| {
                if !state.detached {
                    return None;
                }
                let window = app
                    .get_window(&detached_label(*page))
                    .filter(normal_window)?;
                geometry(&window).ok().map(|g| (*page, g))
            })
            .collect();
        self.record_layout(&snapshot, &geometries);
    }

    fn record_layout(&self, snapshot: &Snapshot, geometries: &BTreeMap<Page, Geometry>) {
        let restoring = self.restoring.lock().unwrap().clone();
        self.layout.update(|saved| {
            saved.selected = snapshot.selected;
            for (page, state) in &snapshot.pages {
                // Startup creates hidden views before their first ready event.
                // Do not erase the intended detached layout during that interval.
                if restoring.contains(page) || state.recovery_required {
                    continue;
                }
                let entry = saved.pages.entry(*page).or_insert(PageLayout {
                    detached: state.detached,
                    geometry: None,
                });
                entry.detached = state.detached;
                if let Some(value) = geometries.get(page) {
                    entry.geometry = Some(value.clone());
                }
            }
        });
    }

    fn remember_geometry(&self, window: &Window) {
        if !normal_window(window) {
            return;
        }
        let Ok(value) = geometry(window) else {
            return;
        };
        if window.label() == "main" {
            self.layout.update(|layout| layout.main = Some(value));
        } else if let Some(page) = window
            .label()
            .strip_prefix("detached-")
            .and_then(Page::from_label)
        {
            if !self
                .snapshot()
                .pages
                .get(&page)
                .is_some_and(|state| state.detached)
            {
                return;
            }
            self.layout.update(|layout| {
                layout
                    .pages
                    .entry(page)
                    .or_insert(PageLayout {
                        detached: true,
                        geometry: None,
                    })
                    .geometry = Some(value);
            });
        }
    }

    fn main_shown(&self, app: &AppHandle) -> bool {
        !self.main_hidden.load(Ordering::Acquire)
            && app.get_window("main").is_some_and(|w| {
                w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)
            })
    }

    fn refresh_main_visibility(&self, app: &AppHandle) -> Result<(), String> {
        let shown = self.main_shown(app) && !*self.covered.lock().unwrap();
        let mut snapshot = self.snapshot();
        let selected = snapshot.selected;
        for (page, state) in &mut snapshot.pages {
            if state.detached || state.recovery_required {
                continue;
            }
            state.visible = shown && *page == selected;
            if let Some(view) = app.get_webview(page.label()) {
                if state.visible {
                    view.show()
                } else {
                    view.hide()
                }
                .map_err(|e| e.to_string())?;
            }
        }
        self.commit_layout(&snapshot);
        self.emit(app);
        Ok(())
    }

    fn reveal_main(&self, app: &AppHandle) -> Result<(), String> {
        let main = app.get_window("main").ok_or("主窗口不可用")?;
        if normal_window(&main) {
            if let (Ok(g), Ok(areas)) = (geometry(&main), displays(app)) {
                if let Some(restored) = g.restore(&areas, (900., 620.)) {
                    apply_geometry(&main, &restored, (900., 620.))?;
                }
            }
        }
        main.unminimize().map_err(|e| e.to_string())?;
        main.show().map_err(|e| e.to_string())?;
        self.main_hidden.store(false, Ordering::Release);
        self.refresh_main_visibility(app)?;
        main.set_focus().map_err(|e| e.to_string())
    }

    pub async fn show_main(&self, app: &AppHandle) -> Result<(), String> {
        let _gate = self.gate.lock().await;
        self.reveal_main(app)
    }

    async fn hide_main(&self, app: &AppHandle) -> Result<(), String> {
        let _gate = self.gate.lock().await;
        let main = app.get_window("main").ok_or("主窗口不可用")?;
        self.remember_geometry(&main);
        main.hide().map_err(|e| e.to_string())?;
        self.main_hidden.store(true, Ordering::Release);
        self.refresh_main_visibility(app)
    }

    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap().clone()
    }

    fn commit_layout(&self, layout: &Snapshot) {
        let mut state = self.state.lock().unwrap();
        state.selected = layout.selected;
        for (page, layout) in &layout.pages {
            if let Some(current) = state.pages.get_mut(page) {
                current.detached = layout.detached;
                current.visible = layout.visible;
            }
        }
    }

    fn emit(&self, app: &AppHandle) {
        let snapshot = self.snapshot();
        let _ = app.emit("workspace-state", &snapshot);
        for (page, state) in snapshot.pages {
            if let Some(view) = app.get_webview(page.label()) {
                let _ = app.emit_to(
                    tauri::EventTarget::webview(view.label()),
                    "workspace-page-state",
                    state,
                );
            }
        }
    }

    fn migration_allowed(&self, page: Page) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .pages
            .get(&page)
            .ok_or_else(|| "请先打开页面，加载完成后再移动".to_string())?
            .migration_allowed()
    }

    // The caller holds the workspace gate. A deferred admission is not a failed
    // native move: retain the saved layout and try again after the task ends.
    fn restore_permit(&self, page: Page, tasks: &std::sync::Arc<super::tasks::Tasks>)
        -> Result<Option<super::tasks::Migration>, String>
    {
        if !self.restoring.lock().unwrap().contains(&page)
            || self.restore_started.lock().unwrap().contains(&page)
            || !self.snapshot().pages.get(&page).is_some_and(|p| p.ready)
        {
            return Ok(None);
        }
        self.migration_allowed(page)?;
        let permit = tasks.migration(page.label())?;
        self.restore_started.lock().unwrap().insert(page);
        Ok(Some(permit))
    }

    fn restore_message(&self, page: Page, message: String) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(page) = state.pages.get_mut(&page) else { return false; };
        if page.restore_pending == message { return false; }
        page.restore_pending = message;
        true
    }

    async fn restore_window(&self, app: &AppHandle, page: Page) {
        let _gate = self.gate.lock().await;
        let hub = app.state::<super::runtime::Runtime>();
        let permit = match self.restore_permit(page, &hub.tasks) {
            Ok(Some(permit)) => permit,
            Ok(None) => return,
            Err(reason) => {
                if self.restore_message(page, format!("等待恢复独立窗口：{reason}")) {
                    self.emit(app);
                }
                return;
            }
        };
        // Keep both native and task migration guards through the whole move.
        let _permit = permit;
        if let Err(error) = self.detach_ready(app, page).await {
            self.restore_message(page, format!("恢复独立窗口失败，可手动重试：{error}"));
            self.emit(app);
            let _ = app.emit("workspace-error", format!("恢复 {} 窗口失败：{error}", page.title()));
        }
    }

    async fn ensure(&self, app: &AppHandle, page: Page) -> Result<Webview, String> {
        if let Some(view) = app.get_webview(page.label()) {
            return Ok(view);
        }
        let main = app.get_window("main").ok_or("主窗口不可用")?;
        let rect = *self.bounds.lock().unwrap();
        self.state
            .lock()
            .unwrap()
            .pages
            .entry(page)
            .or_insert(PageState {
                detached: false,
                visible: false,
                ready: false,
                busy_reason: String::new(),
                recovery_required: false,
                restore_pending: String::new(),
            });
        let result = main
            .add_child(
                WebviewBuilder::new(
                    page.label(),
                    WebviewUrl::App(
                        format!(
                            "index.html?page={}",
                            page.label().trim_start_matches("page-")
                        )
                        .into(),
                    ),
                )
                .focused(false),
                LogicalPosition::new(rect.x, rect.y),
                LogicalSize::new(rect.width, rect.height),
            )
            .map_err(|error| error.to_string());
        let view = match result {
            Ok(view) => view,
            Err(error) => {
                self.state.lock().unwrap().pages.remove(&page);
                return Err(error);
            }
        };
        view.set_auto_resize(false)
            .map_err(|error| error.to_string())?;
        view.hide().map_err(|error| error.to_string())?;
        Ok(view)
    }

    pub async fn select(&self, app: &AppHandle, page: Page) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().await;
        if self
            .snapshot()
            .pages
            .get(&page)
            .is_some_and(|state| state.recovery_required)
        {
            return Err("请先点击“恢复窗口”完成上次移动".into());
        }
        let view = self.ensure(app, page).await?;
        if self
            .snapshot()
            .pages
            .get(&page)
            .is_some_and(|state| state.detached)
        {
            let window = view.window();
            window.unminimize().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        } else {
            if !self.main_shown(app) {
                self.reveal_main(app)?;
            }
            let mut snapshot = self.snapshot();
            snapshot.selected = page;
            for (other, state) in &mut snapshot.pages {
                if state.detached || state.recovery_required {
                    continue;
                }
                state.visible = *other == page && !*self.covered.lock().unwrap();
                if let Some(view) = app.get_webview(other.label()) {
                    if state.visible {
                        view.set_bounds(native_bounds(*self.bounds.lock().unwrap()))
                            .map_err(|e| e.to_string())?;
                        view.show().map_err(|e| e.to_string())?;
                    } else {
                        view.hide().map_err(|e| e.to_string())?;
                    }
                }
            }
            self.commit_layout(&snapshot);
            if !*self.covered.lock().unwrap() {
                view.set_focus().map_err(|e| e.to_string())?;
            }
        }
        self.save_layout(app);
        self.emit(app);
        Ok(self.snapshot())
    }

    pub async fn detach(&self, app: &AppHandle, page: Page) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().await;
        let _migration = app
            .state::<super::runtime::Runtime>()
            .tasks
            .migration(page.label())?;
        self.migration_allowed(page)?;
        self.detach_ready(app, page).await
    }

    // Callers hold Workspace::gate and the ordinary Tasks migration permit.
    async fn detach_ready(&self, app: &AppHandle, page: Page) -> Result<Snapshot, String> {
        let view = self.ensure(app, page).await?;
        if self
            .snapshot()
            .pages
            .get(&page)
            .is_some_and(|state| state.detached)
        {
            view.window().show().map_err(|e| e.to_string())?;
            view.window().set_focus().map_err(|e| e.to_string())?;
            return Ok(self.snapshot());
        }
        let label = detached_label(page);
        self.clear_empty_window(app, &label)?;
        let saved = self
            .layout
            .snapshot()
            .pages
            .get(&page)
            .and_then(|state| state.geometry.clone());
        let restored =
            saved.and_then(|g| g.restore(&displays(app).unwrap_or_default(), (640., 480.)));
        let (width, height) = restored
            .as_ref()
            .map(Geometry::inner_size)
            .unwrap_or((1200., 800.));
        let mut builder = WindowBuilder::new(app, &label)
            .title(format!("{} · Robot Console", page.title()))
            .inner_size(width, height)
            .min_inner_size(640.0_f64.min(width), 480.0_f64.min(height))
            .visible(false);
        if let Some(geometry) = restored {
            builder = builder.position(geometry.outer.x, geometry.outer.y);
        }
        let window = builder.build().map_err(|e| e.to_string())?;
        // Read the target geometry before moving anything. A failed preparation
        // must clean up the new empty window without touching the source page.
        let target_size = (|| {
            Ok::<_, tauri::Error>(
                window
                    .inner_size()?
                    .to_logical::<f64>(window.scale_factor()?),
            )
        })();
        let target_size = match target_size {
            Ok(size) => size,
            Err(error) => {
                return Err(match self.clear_empty_window(app, &label) {
                    Ok(()) => format!("无法读取独立窗口尺寸，原页面保持不变：{error}"),
                    Err(cleanup) => {
                        format!("无法读取独立窗口尺寸：{error}；空窗口清理失败：{cleanup}")
                    }
                });
            }
        };
        let result = self.transfer_page(
            app,
            page,
            &view,
            super::migration::Placement {
                parent: label.clone(),
                bounds: Rect {
                    x: 0.,
                    y: 0.,
                    width: target_size.width,
                    height: target_size.height,
                },
            },
            true,
            true,
        );
        if let Err(error) = result {
            if !self.recoveries.lock().unwrap().contains_key(&page)
                && !self
                    .snapshot()
                    .pages
                    .get(&page)
                    .is_some_and(|state| state.detached)
            {
                if let Err(cleanup) = self.clear_empty_window(app, &label) {
                    return Err(format!("{error}；空窗口清理失败：{cleanup}"));
                }
            }
            return Err(error);
        }
        Ok(self.snapshot())
    }

    pub async fn dock(
        &self,
        app: &AppHandle,
        page: Page,
        reveal: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().await;
        let _migration = app
            .state::<super::runtime::Runtime>()
            .tasks
            .migration(page.label())?;
        self.migration_allowed(page)?;
        let view = app.get_webview(page.label()).ok_or("页面不存在")?;
        let window = view.window();
        self.remember_geometry(&window);
        let bounds = *self.bounds.lock().unwrap();
        self.transfer_page(
            app,
            page,
            &view,
            super::migration::Placement {
                parent: "main".into(),
                bounds,
            },
            false,
            reveal,
        )?;
        Ok(self.snapshot())
    }

    async fn set_bounds(&self, app: &AppHandle, bounds: Rect) -> Result<(), String> {
        let _gate = self.gate.lock().await;
        if ![bounds.x, bounds.y, bounds.width, bounds.height]
            .iter()
            .all(|v| v.is_finite())
            || bounds.width < 1.0
            || bounds.height < 1.0
        {
            return Err("页面区域无效".into());
        }
        *self.bounds.lock().unwrap() = bounds;
        let snapshot = self.snapshot();
        for (page, state) in snapshot.pages {
            if !state.detached && !state.recovery_required {
                if let Some(view) = app.get_webview(page.label()) {
                    view.set_bounds(native_bounds(bounds))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    async fn cover(&self, app: &AppHandle, covered: bool) -> Result<(), String> {
        let _gate = self.gate.lock().await;
        *self.covered.lock().unwrap() = covered;
        let mut snapshot = self.snapshot();
        let selected = snapshot.selected;
        for (page, state) in &mut snapshot.pages {
            if state.detached || state.recovery_required {
                continue;
            }
            state.visible = self.main_shown(app) && !covered && *page == selected;
            if let Some(view) = app.get_webview(page.label()) {
                if state.visible {
                    view.show()
                } else {
                    view.hide()
                }
                .map_err(|e| e.to_string())?;
            }
        }
        self.commit_layout(&snapshot);
        self.emit(app);
        Ok(())
    }

    pub fn window_event(app: &AppHandle, window: &Window, event: &WindowEvent) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if window.label() == "main" {
                api.prevent_close();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = app.state::<Workspace>().hide_main(&app).await {
                        let _ = app.emit("workspace-error", error);
                    }
                });
            }
            if let Some(page) = window
                .label()
                .strip_prefix("detached-")
                .and_then(Page::from_label)
            {
                api.prevent_close();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = app.state::<Workspace>().dock(&app, page, false).await {
                        let _ = app.emit("workspace-error", error);
                    }
                });
            }
        }
        if let Some(page) = window
            .label()
            .strip_prefix("detached-")
            .and_then(Page::from_label)
        {
            let workspace = app.state::<Workspace>();
            if workspace.moving.lock().unwrap().contains(&page)
                || workspace
                    .snapshot()
                    .pages
                    .get(&page)
                    .is_some_and(|state| state.recovery_required)
            {
                return;
            }
        }
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            // Use the actual Cocoa resize event, not inner_size()'s first-WebView
            // fallback (which can retain the source window's dimensions).
            if let Some(page) = window
                .label()
                .strip_prefix("detached-")
                .and_then(Page::from_label)
            {
                let geometry = match event {
                    WindowEvent::Resized(size) => {
                        window.scale_factor().ok().map(|scale| (*size, scale))
                    }
                    WindowEvent::ScaleFactorChanged {
                        new_inner_size,
                        scale_factor,
                        ..
                    } => Some((*new_inner_size, *scale_factor)),
                    _ => None,
                };
                if let (Some(view), Some((size, scale))) = (app.get_webview(page.label()), geometry)
                {
                    if view.window().label() != window.label() {
                        return;
                    }
                    let size = size.to_logical::<f64>(scale);
                    let _ = view.set_bounds(native_bounds(Rect {
                        x: 0.0,
                        y: 0.0,
                        width: size.width,
                        height: size.height,
                    }));
                }
            }
            let workspace = app.state::<Workspace>();
            let shown =
                window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
            {
                let mut snapshot = workspace.state.lock().unwrap();
                let selected = snapshot.selected;
                for (page, state) in &mut snapshot.pages {
                    if state.recovery_required || workspace.moving.lock().unwrap().contains(page) {
                        continue;
                    }
                    if window.label() == "main" && !state.detached {
                        state.visible =
                            shown && *page == selected && !*workspace.covered.lock().unwrap();
                    } else if window.label() == detached_label(*page) {
                        state.visible = shown;
                    }
                }
            }
            workspace.emit(app);
        }
        if matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        ) {
            app.state::<Workspace>().remember_geometry(window);
        }
    }
}

#[tauri::command]
pub async fn workspace_show_main(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
) -> Result<(), String> {
    authorize(&view, Page::from_label(view.label()))?;
    workspace.show_main(&app).await
}

#[tauri::command]
pub fn workspace_snapshot(
    view: Webview,
    workspace: State<'_, Workspace>,
) -> Result<Snapshot, String> {
    authorize(&view, Page::from_label(view.label()))?;
    Ok(workspace.snapshot())
}

#[tauri::command]
pub async fn workspace_select(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    page: Page,
) -> Result<Snapshot, String> {
    authorize(&view, Page::from_label(view.label()))?;
    workspace.select(&app, page).await
}

#[tauri::command]
pub async fn workspace_open_motion(
    app: AppHandle, view: Webview, workspace: State<'_, Workspace>, tab: MotionTab, profile_key: String,
) -> Result<(), String> {
    authorize_motion_navigation(view.label(), tab)?;
    workspace.state.lock().unwrap().navigate_motion(tab, profile_key)?;
    // Retain intent in the snapshot: a lazily created page may not be listening yet.
    workspace.emit(&app);
    workspace.select(&app, Page::Motion).await?;
    Ok(())
}

#[tauri::command]
pub async fn workspace_detach(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    page: Page,
) -> Result<Snapshot, String> {
    authorize(&view, Some(page))?;
    workspace.detach(&app, page).await
}

#[tauri::command]
pub async fn workspace_recover(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    page: Page,
) -> Result<Snapshot, String> {
    authorize(&view, Some(page))?;
    workspace.recover(&app, page).await
}

#[tauri::command]
pub async fn workspace_dock(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    page: Page,
) -> Result<Snapshot, String> {
    authorize(&view, Some(page))?;
    workspace.dock(&app, page, true).await
}

#[tauri::command]
pub async fn workspace_bounds(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    bounds: Rect,
    viewport: Viewport,
) -> Result<(), String> {
    authorize(&view, None)?;
    let scale = view.window().scale_factor().map_err(|e| e.to_string())?;
    let root = view.bounds().map_err(|e| e.to_string())?;
    let origin = root.position.to_logical::<f64>(scale);
    let size = root.size.to_logical::<f64>(scale);
    let bounds = embedded_bounds(
        bounds,
        Rect {
            x: origin.x,
            y: origin.y,
            width: size.width,
            height: size.height,
        },
        viewport,
    )?;
    workspace.set_bounds(&app, bounds).await
}

#[tauri::command]
pub fn workspace_page_ready(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    busy_reason: String,
) -> Result<(), String> {
    let page = Page::from_label(view.label()).ok_or("不是功能页面")?;
    if busy_reason.len() > 1024 {
        return Err("状态说明过长".into());
    }
    if let Some(state) = workspace.state.lock().unwrap().pages.get_mut(&page) {
        state.ready = true;
        state.busy_reason = busy_reason;
    }
    workspace.emit(&app);
    // Startup restoration runs on the app worker. Ready/busy updates must not
    // consume the one native attempt while task admission is still blocked.
    Ok(())
}

#[tauri::command]
pub async fn workspace_cover(
    app: AppHandle,
    view: Webview,
    workspace: State<'_, Workspace>,
    covered: bool,
) -> Result<(), String> {
    authorize(&view, None)?;
    workspace.cover(&app, covered).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restored_task_defers_window_without_overwriting_saved_layout() {
        use super::super::{tasks::{Kind, Tasks}, controller_journal::new_id};
        use std::sync::Arc;
        let workspace = Workspace::default();
        let tasks = Arc::new(Tasks::default());
        let profile = serde_json::json!({"host":"offline.invalid", "sshPort":22,
            "username":"", "identityFile":"", "remotePort":8765, "rosDomainId":197,
            "rosSetupScript":"test/install/setup.bash", "commandTopic":"/cmd",
            "statusTopic":"/status", "jointStateTopic":"/joints"});
        tasks.restore_finite(Kind::Controller, Page::Motion.label().into(), new_id().unwrap(), &profile).unwrap();
        let path = std::env::temp_dir().join(format!("{}-layout.json", new_id().unwrap()));
        workspace.layout.load(path.clone()).unwrap();
        workspace.layout.update(|layout| {
            layout.pages.insert(Page::Motion, PageLayout { detached: true, geometry: None });
            layout.pages.insert(Page::Handeye, PageLayout { detached: true, geometry: None });
        });
        workspace.restoring.lock().unwrap().insert(Page::Motion);
        let state = PageState { detached:false, visible:false, ready:true, busy_reason:String::new(),
            recovery_required:false, restore_pending:String::new() };
        workspace.state.lock().unwrap().pages.insert(Page::Motion, state.clone());
        workspace.state.lock().unwrap().pages.insert(Page::Handeye, state);
        for _ in 0..4 {
            assert!(workspace.restore_permit(Page::Motion, &tasks).is_err());
            assert!(!workspace.restore_started.lock().unwrap().contains(&Page::Motion));
            // Selecting/resizing another page must save its change without
            // persisting the temporary embedded location of the blocked page.
            workspace.record_layout(&workspace.snapshot(), &BTreeMap::new());
            workspace.layout.flush().unwrap();
            let disk = LayoutStore::default(); disk.load(path.clone()).unwrap();
            assert!(disk.snapshot().pages[&Page::Motion].detached);
            assert!(!disk.snapshot().pages[&Page::Handeye].detached);
        }
        assert!(tasks.snapshot().is_some());
        assert!(tasks.migration(Page::Motion.label()).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn startup_retries_admission_but_not_native_failures_and_keeps_atomic_permit() {
        use super::super::{tasks::{Tasks, Owner}, windows::WindowToken};
        use std::sync::Arc;
        let workspace = Workspace::default();
        let tasks = Arc::new(Tasks::default());
        workspace.restoring.lock().unwrap().insert(Page::Motion);
        workspace.state.lock().unwrap().pages.insert(Page::Motion, PageState {
            detached:false, visible:false, ready:false, busy_reason:String::new(),
            recovery_required:false, restore_pending:String::new(),
        });
        assert!(workspace.restore_permit(Page::Motion, &tasks).unwrap().is_none());
        let owner = Owner {epoch:1, window:WindowToken {label:Page::Motion.label().into(), incarnation:1}};
        let id = tasks.begin_controller(owner.clone()).unwrap();
        workspace.state.lock().unwrap().pages.get_mut(&Page::Motion).unwrap().ready = true;
        assert!(workspace.restore_permit(Page::Motion, &tasks).is_err());
        assert!(tasks.controller_finish(id, true, "not submitted"));
        workspace.state.lock().unwrap().pages.get_mut(&Page::Motion).unwrap().busy_reason = "sampling".into();
        assert!(workspace.restore_permit(Page::Motion, &tasks).is_err());
        workspace.state.lock().unwrap().pages.get_mut(&Page::Motion).unwrap().busy_reason.clear();
        let permit = workspace.restore_permit(Page::Motion, &tasks).unwrap().unwrap();
        assert!(tasks.begin_controller(owner.clone()).is_err());
        assert!(tasks.migration(Page::Motion.label()).is_err());
        // A failed native move keeps saved intent but is not retried in a loop.
        drop(permit);
        assert!(workspace.restoring.lock().unwrap().contains(&Page::Motion));
        assert!(workspace.restore_permit(Page::Motion, &tasks).unwrap().is_none());
        assert!(workspace.restore_message(Page::Motion, "retry manually".into()));
        assert!(!workspace.restore_message(Page::Motion, "retry manually".into()));
        // Manual retry uses the same ordinary migration gate and remains possible.
        assert!(tasks.migration(Page::Motion.label()).is_ok());
    }

    #[test]
    fn only_ready_idle_pages_can_move_even_when_hidden() {
        let mut page = PageState {
            detached: false,
            visible: false,
            ready: false,
            busy_reason: String::new(),
            recovery_required: false,
            restore_pending: String::new(),
        };
        assert!(page.migration_allowed().unwrap_err().contains("加载"));
        page.ready = true;
        page.busy_reason = "采样进行中".into();
        assert_eq!(page.migration_allowed().unwrap_err(), "采样进行中");
        page.detached = true;
        assert!(page.migration_allowed().is_err());
        page.busy_reason.clear();
        assert!(page.migration_allowed().is_ok());
        page.recovery_required = true;
        assert!(page.migration_allowed().unwrap_err().contains("恢复窗口"));
    }
    #[test]
    fn layout_commit_preserves_concurrent_readiness_and_busy_updates() {
        let workspace = Workspace::default();
        let mut loading = PageState {
            detached: false,
            visible: false,
            ready: false,
            busy_reason: String::new(),
            recovery_required: false,
            restore_pending: String::new(),
        };
        workspace
            .state
            .lock()
            .unwrap()
            .pages
            .insert(Page::Handeye, loading.clone());
        let mut next = workspace.snapshot();
        next.pages.get_mut(&Page::Handeye).unwrap().detached = true;
        loading.ready = true;
        loading.busy_reason = "正在采样".into();
        workspace
            .state
            .lock()
            .unwrap()
            .pages
            .insert(Page::Handeye, loading);
        workspace.commit_layout(&next);
        let actual = workspace.snapshot().pages.remove(&Page::Handeye).unwrap();
        assert!(actual.ready && actual.detached);
        assert_eq!(actual.busy_reason, "正在采样");
    }
    #[test]
    fn embedded_css_bounds_account_for_titlebar_and_page_zoom() {
        let host = Rect {
            x: 0.0,
            y: 58.0,
            width: 1440.0,
            height: 769.0,
        };
        let root = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 859.0,
        };
        let converted = embedded_bounds(
            host,
            root,
            Viewport {
                width: 1440.0,
                height: 827.0,
            },
        )
        .unwrap();
        assert_eq!(converted.y, 90.0);
        assert_eq!(converted.height, 769.0);
        assert_eq!(converted.y + converted.height, root.height);
        let zoomed = embedded_bounds(
            Rect {
                x: 10.0,
                y: 29.0,
                width: 710.0,
                height: 384.5,
            },
            root,
            Viewport {
                width: 720.0,
                height: 413.5,
            },
        )
        .unwrap();
        assert_eq!(zoomed.x, 20.0);
        assert_eq!(zoomed.y, 90.0);
        assert_eq!(zoomed.width, 1420.0);
        assert!(embedded_bounds(
            host,
            root,
            Viewport {
                width: 0.0,
                height: 0.0
            }
        )
        .is_err());
    }
    #[test]
    fn unopened_pages_cannot_bypass_readiness() {
        assert!(Workspace::default()
            .migration_allowed(Page::Handeye)
            .is_err());
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;
    #[test]
    fn handeye_may_only_navigate_to_robot_view_using_its_actual_webview_label() {
        for tab in [MotionTab::Robot,MotionTab::Positions,MotionTab::Groups] {
            assert!(authorize_motion_navigation("main",tab).is_ok());
        }
        assert!(authorize_motion_navigation("page-handeye",MotionTab::Robot).is_ok());
        for tab in [MotionTab::Positions,MotionTab::Groups] {
            assert!(authorize_motion_navigation("page-handeye",tab).is_err());
        }
        for label in ["page-motor","page-motion","detached-page-handeye","unknown"] {
            assert!(authorize_motion_navigation(label,MotionTab::Robot).is_err());
        }
        let workspace=Workspace::default();let mut state=workspace.state.lock().unwrap();
        state.navigate_motion(MotionTab::Groups,"robot".into()).unwrap();
        state.navigate_motion(MotionTab::Robot,"robot".into()).unwrap();
        assert_eq!(state.motion_navigation.as_ref().unwrap().revision,2);
        assert_eq!(serde_json::to_value(&state.motion_navigation).unwrap()["tab"],"robot");
    }

    #[test]
    fn motion_intent_is_retained_versioned_and_rejects_bad_profiles() {
        let workspace = Workspace::default();
        let mut snapshot = workspace.snapshot();
        snapshot.navigate_motion(MotionTab::Positions, "jetson||22".into()).unwrap();
        snapshot.navigate_motion(MotionTab::Groups, "jetson||22".into()).unwrap();
        assert_eq!(snapshot.motion_navigation.as_ref().unwrap().revision, 2);
        assert!(snapshot.navigate_motion(MotionTab::Groups, "".into()).is_err());
        assert!(snapshot.navigate_motion(MotionTab::Groups, "bad\nkey".into()).is_err());
        assert_eq!(snapshot.motion_navigation.unwrap().revision, 2);
        assert!(serde_json::from_str::<MotionTab>("\"execute\"").is_err());
    }
}
