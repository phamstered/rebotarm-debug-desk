//! Each page owns one persistent WebView. Detach/dock reparent that view; React,
//! image samples, editor drafts and GPU state are not cloned or reconstructed.
use super::windows::{Page, Rect};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewBuilder,
    WebviewUrl, Window, WindowBuilder, WindowEvent,
};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageState {
    pub detached: bool,
    pub visible: bool,
    pub ready: bool,
    pub busy_reason: String,
}

impl PageState {
    fn migration_allowed(&self) -> Result<(), String> {
        if !self.ready {
            return Err("页面仍在加载，请稍后再移动".into());
        }
        if !self.busy_reason.is_empty() {
            return Err(self.busy_reason.clone());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub selected: Page,
    pub pages: BTreeMap<Page, PageState>,
}

pub struct Workspace {
    gate: AsyncMutex<()>,
    state: Mutex<Snapshot>,
    bounds: Mutex<Rect>,
    covered: Mutex<bool>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            gate: AsyncMutex::new(()),
            covered: Mutex::new(true),
            state: Mutex::new(Snapshot {
                selected: Page::Status,
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

impl Workspace {
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
            let mut snapshot = self.snapshot();
            snapshot.selected = page;
            for (other, state) in &mut snapshot.pages {
                if state.detached {
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
        self.emit(app);
        Ok(self.snapshot())
    }

    pub async fn detach(&self, app: &AppHandle, page: Page) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().await;
        self.migration_allowed(page)?;
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
        let window = WindowBuilder::new(app, &label)
            .title(format!("{} · Robot Console", page.title()))
            .inner_size(1200.0, 800.0)
            .min_inner_size(640.0, 480.0)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
        // tauri-runtime-wry 2.11 on macOS reports the first WebView frame as
        // inner_size after reparenting into an otherwise empty Window. Capture
        // the actual empty Window size before the view can influence that query.
        let target_size = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        let old_window = view.window();
        let old_bounds = view.bounds().map_err(|e| e.to_string())?;
        let moved = (|| {
            view.reparent(&window)?;
            let size = target_size;
            view.set_bounds(native_bounds(Rect {
                x: 0.0,
                y: 0.0,
                width: size.width,
                height: size.height,
            }))?;
            view.set_auto_resize(false)?;
            view.show()?;
            window.show()?;
            window.set_focus()?;
            Ok::<_, tauri::Error>(())
        })();
        if let Err(error) = moved {
            let _ = view.reparent(&old_window);
            let _ = view.set_bounds(old_bounds);
            let _ = view.show();
            let _ = window.destroy();
            return Err(format!("拆出失败，已尝试恢复原页面：{error}"));
        }
        if let Some(state) = self.state.lock().unwrap().pages.get_mut(&page) {
            state.detached = true;
            state.visible = true;
        }
        self.emit(app);
        Ok(self.snapshot())
    }

    pub async fn dock(
        &self,
        app: &AppHandle,
        page: Page,
        reveal: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().await;
        self.migration_allowed(page)?;
        let view = app.get_webview(page.label()).ok_or("页面不存在")?;
        let window = view.window();
        let main = app.get_window("main").ok_or("主窗口不可用")?;
        if window.label() != "main" {
            view.set_auto_resize(false).map_err(|e| e.to_string())?;
            view.reparent(&main).map_err(|e| e.to_string())?;
            view.set_bounds(native_bounds(*self.bounds.lock().unwrap()))
                .map_err(|e| e.to_string())?;
        }
        let mut snapshot = self.snapshot();
        if reveal {
            snapshot.selected = page;
        }
        let selected = snapshot.selected;
        for (other, state) in &mut snapshot.pages {
            if *other == page {
                state.detached = false;
            }
            if !state.detached {
                state.visible = !*self.covered.lock().unwrap()
                    && (reveal && *other == page || !reveal && *other == selected);
                if let Some(view) = app.get_webview(other.label()) {
                    if state.visible {
                        let _ = view.show();
                    } else {
                        let _ = view.hide();
                    }
                }
            }
        }
        self.commit_layout(&snapshot);
        if window.label() != "main" {
            window.destroy().map_err(|e| e.to_string())?;
        }
        if reveal {
            main.show().map_err(|e| e.to_string())?;
            main.unminimize().map_err(|e| e.to_string())?;
            main.set_focus().map_err(|e| e.to_string())?;
        }
        self.emit(app);
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
            if !state.detached {
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
            if state.detached {
                continue;
            }
            state.visible = !covered && *page == selected;
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
    }
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
    fn only_ready_idle_pages_can_move_even_when_hidden() {
        let mut page = PageState {
            detached: false,
            visible: false,
            ready: false,
            busy_reason: String::new(),
        };
        assert!(page.migration_allowed().unwrap_err().contains("加载"));
        page.ready = true;
        page.busy_reason = "采样进行中".into();
        assert_eq!(page.migration_allowed().unwrap_err(), "采样进行中");
        page.detached = true;
        assert!(page.migration_allowed().is_err());
        page.busy_reason.clear();
        assert!(page.migration_allowed().is_ok());
    }
    #[test]
    fn layout_commit_preserves_concurrent_readiness_and_busy_updates() {
        let workspace = Workspace::default();
        let mut loading = PageState {
            detached: false,
            visible: false,
            ready: false,
            busy_reason: String::new(),
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
