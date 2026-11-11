//! Native adapter for the tested migration transaction. Only empty windows may
//! be destroyed, and a failed rollback retains both windows for explicit retry.
use super::*;
use crate::session::migration::{self, Backend, Placement};
use std::collections::VecDeque;

#[derive(Clone)]
struct Layout {
    snapshot: Snapshot,
    main_visible: bool,
    main_minimized: bool,
    focus: Option<String>,
}

#[derive(Clone)]
pub(super) struct Recovery {
    source: Placement,
    cleanup: Option<String>,
}

struct Moving<'a>(&'a Workspace, Page);
impl Drop for Moving<'_> {
    fn drop(&mut self) {
        self.0.moving.lock().unwrap().remove(&self.1);
    }
}

fn recovered_snapshot(
    mut current: Snapshot,
    page: Page,
    embedded: bool,
    covered: bool,
) -> Snapshot {
    // A retry may happen after other pages moved. Restore only this page; never
    // overwrite the other pages with the snapshot taken before the failure.
    if let Some(state) = current.pages.get_mut(&page) {
        state.detached = !embedded;
        state.visible = !embedded || !covered;
        state.recovery_required = false;
    }
    if embedded {
        current.selected = page;
        for (item, state) in &mut current.pages {
            if !state.detached && !state.recovery_required {
                state.visible = *item == page && !covered;
            }
        }
    }
    current
}

struct Native<'a> {
    app: &'a AppHandle,
    workspace: &'a Workspace,
    view: &'a Webview,
    page: Page,
    before: Layout,
    after: Layout,
    operation: &'static str,
    faults: VecDeque<String>,
}

impl Native<'_> {
    fn fault(&mut self, step: &str, restoring: bool) -> bool {
        let direction = if restoring && self.operation != "recover" {
            "rollback"
        } else {
            self.operation
        };
        let key = format!("{direction}:{step}");
        if self.faults.front() == Some(&key) {
            self.faults.pop_front();
            true
        } else {
            false
        }
    }
    fn checked(&mut self, step: &str, restoring: bool) -> Result<(), String> {
        if self.fault(step, restoring) {
            Err(format!("隔离测试注入：{step}"))
        } else {
            Ok(())
        }
    }
}

impl Backend for Native<'_> {
    fn reparent(&mut self, target: &str, restoring: bool) -> Result<(), String> {
        if self.fault("reparent", restoring) {
            // Exercise the real patched dispatcher with a destroyed destination,
            // not merely a mocked error before the native call. No JS is created.
            let dead = WindowBuilder::new(self.app, "migration-closed-target")
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?;
            dead.destroy().map_err(|e| e.to_string())?;
            return self
                .view
                .reparent(&dead)
                .map_err(|e| format!("已关闭目标窗口：{e}"));
        }
        let window = self.app.get_window(target).ok_or("迁移目标窗口不存在")?;
        self.view.reparent(&window).map_err(|e| e.to_string())
    }
    fn bounds(&mut self, bounds: Rect, restoring: bool) -> Result<(), String> {
        self.checked("bounds", restoring)?;
        self.view
            .set_auto_resize(false)
            .map_err(|e| e.to_string())?;
        self.view
            .set_bounds(native_bounds(bounds))
            .map_err(|e| e.to_string())
    }
    fn layout(&mut self, restoring: bool) -> Result<(), String> {
        self.checked("layout", restoring)?;
        let layout = if restoring { &self.before } else { &self.after };
        let main = self.app.get_window("main").ok_or("主窗口不可用")?;
        if main.is_visible().map_err(|e| e.to_string())? != layout.main_visible {
            if layout.main_visible {
                main.show()
            } else {
                main.hide()
            }
            .map_err(|e| e.to_string())?;
        }
        if main.is_minimized().map_err(|e| e.to_string())? != layout.main_minimized {
            if layout.main_minimized {
                main.minimize()
            } else {
                main.unminimize()
            }
            .map_err(|e| e.to_string())?;
        }
        self.workspace
            .main_hidden
            .store(!layout.main_visible, Ordering::Release);
        for (page, state) in &layout.snapshot.pages {
            if state.recovery_required && *page != self.page {
                continue;
            }
            if let Some(view) = self.app.get_webview(page.label()) {
                if state.visible {
                    view.show()
                } else {
                    view.hide()
                }
                .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    fn focus(&mut self, restoring: bool) -> Result<(), String> {
        self.checked("focus", restoring)?;
        let layout = if restoring { &self.before } else { &self.after };
        if let Some(label) = &layout.focus {
            let window = self.app.get_window(label).ok_or("待聚焦窗口不存在")?;
            window.show().map_err(|e| e.to_string())?;
            window.unminimize().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn reveal_current(&mut self) -> Result<(), String> {
        // The pinned Tauri patch commits this parent only on native success.
        // A failed recovery can have moved the view before bounds/layout fails;
        // keep its error and retry button visible instead of focusing an empty host.
        let window = self.view.window();
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        self.view.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        if window.label() == "main" {
            self.workspace.main_hidden.store(false, Ordering::Release);
        }
        Ok(())
    }
}

// Only the separately identified debug app can consume this one-shot test file.
// No production IPC, environment flag or release build can enable injection.
fn faults(app: &AppHandle) -> Result<VecDeque<String>, String> {
    #[cfg(debug_assertions)]
    if app.config().identifier == "dev.easydebug.multiwindowtest" {
        use std::io::Read;
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("migration-faults.json");
        match std::fs::File::open(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(2049)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                let points: VecDeque<String> =
                    serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                if bytes.len() > 2048 || points.len() > 10 || points.iter().any(|p| p.len() > 64) {
                    return Err("隔离测试故障配置无效".into());
                }
                std::fs::rename(&path, path.with_extension("consumed.json"))
                    .map_err(|e| e.to_string())?;
                return Ok(points);
            }
        }
    }
    let _ = app;
    Ok(VecDeque::new())
}

impl Workspace {
    pub(super) fn clear_empty_window(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        if label == "main" {
            return Err("不能清理主窗口".into());
        }
        if self
            .recoveries
            .lock()
            .unwrap()
            .values()
            .any(|r| r.source.parent == label || r.cleanup.as_deref() == Some(label))
        {
            return Err("窗口仍用于恢复页面，不能关闭".into());
        }
        if app
            .webviews()
            .values()
            .any(|view| view.window().label() == label)
        {
            return Err("窗口仍承载页面，不能关闭".into());
        }
        if let Some(window) = app.get_window(label) {
            window.destroy().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub(super) fn transfer_page(
        &self,
        app: &AppHandle,
        page: Page,
        view: &Webview,
        target: Placement,
        detach: bool,
        reveal: bool,
    ) -> Result<(), String> {
        let window = view.window();
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let bounds = view.bounds().map_err(|e| e.to_string())?;
        let position = bounds.position.to_logical::<f64>(scale);
        let size = bounds.size.to_logical::<f64>(scale);
        let source = Placement {
            parent: window.label().into(),
            bounds: Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            },
        };
        let snapshot = self.snapshot();
        let main = app.get_window("main").ok_or("主窗口不可用")?;
        let before = Layout {
            focus: snapshot
                .pages
                .get(&page)
                .filter(|p| p.visible)
                .map(|_| source.parent.clone()),
            snapshot,
            main_visible: main.is_visible().map_err(|e| e.to_string())?,
            main_minimized: main.is_minimized().map_err(|e| e.to_string())?,
        };
        let mut after = before.clone();
        after.focus = if detach || reveal {
            Some(target.parent.clone())
        } else {
            None
        };
        if !detach && reveal {
            after.main_visible = true;
            after.main_minimized = false;
            after.snapshot.selected = page;
        }
        if let Some(state) = after.snapshot.pages.get_mut(&page) {
            state.detached = detach;
            state.visible = detach;
        }
        let shown = after.main_visible && !after.main_minimized && !*self.covered.lock().unwrap();
        for (item, state) in &mut after.snapshot.pages {
            if !state.detached {
                state.visible = shown && *item == after.snapshot.selected;
            }
        }
        let cleanup = Some(detached_label(page));
        let recovery = Recovery {
            source: source.clone(),
            cleanup: if detach { cleanup.clone() } else { None },
        };
        let mut native = Native {
            app,
            workspace: self,
            view,
            page,
            before,
            after: after.clone(),
            operation: if detach { "detach" } else { "dock" },
            faults: faults(app)?,
        };
        self.moving.lock().unwrap().insert(page);
        let _moving = Moving(self, page);
        match migration::transfer(&mut native, &source, &target) {
            Ok(()) => {
                self.commit_layout(&after.snapshot);
                self.restoring.lock().unwrap().remove(&page);
                self.save_layout(app);
                self.emit(app);
                if !detach {
                    native
                        .checked("cleanup", false)
                        .and_then(|_| self.clear_empty_window(app, cleanup.as_deref().unwrap()))
                        .map_err(|e| {
                            format!("页面已收回；空窗口清理失败，可关闭残留空窗口重试：{e}")
                        })?;
                }
                Ok(())
            }
            Err(failure) => {
                let message = failure.to_string();
                if failure.rollback.is_some() {
                    self.recoveries.lock().unwrap().insert(page, recovery);
                    if let Some(state) = self.state.lock().unwrap().pages.get_mut(&page) {
                        state.recovery_required = true;
                    }
                    // Keep both potential hosts visible. Metadata alone is not
                    // proof of placement after a rejected Tauri reparent call.
                    for label in [&source.parent, &target.parent] {
                        if let Some(window) = app.get_window(label) {
                            let _ = window.show();
                        }
                    }
                    let _ = view.show();
                } else {
                    self.commit_layout(&native.before.snapshot);
                    if detach {
                        if let Err(error) =
                            self.clear_empty_window(app, cleanup.as_deref().unwrap())
                        {
                            self.emit(app);
                            return Err(format!("{message}；空窗口清理失败：{error}"));
                        }
                    }
                }
                self.emit(app);
                Err(message)
            }
        }
    }

    pub async fn recover(&self, app: &AppHandle, page: Page) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().await;
        let _migration = app
            .state::<super::super::runtime::Runtime>()
            .tasks
            .migration(page.label())?;
        let state = self
            .snapshot()
            .pages
            .get(&page)
            .cloned()
            .ok_or("页面不存在")?;
        if !state.ready || !state.busy_reason.is_empty() {
            return Err(if state.busy_reason.is_empty() {
                "页面仍在加载".into()
            } else {
                state.busy_reason
            });
        }
        let recovery = self
            .recoveries
            .lock()
            .unwrap()
            .get(&page)
            .cloned()
            .ok_or("没有待恢复的窗口")?;
        let view = app.get_webview(page.label()).ok_or("页面不可用")?;
        let mut source = recovery.source.clone();
        let embedded = source.parent == "main";
        if embedded {
            source.bounds = *self.bounds.lock().unwrap();
        } else {
            let window = app.get_window(&source.parent).ok_or("待恢复窗口不可用")?;
            let size = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
            source.bounds = Rect {
                x: 0.,
                y: 0.,
                width: size.width,
                height: size.height,
            };
        }
        let main = app.get_window("main").ok_or("主窗口不可用")?;
        let restored_layout = Layout {
            snapshot: recovered_snapshot(
                self.snapshot(),
                page,
                embedded,
                *self.covered.lock().unwrap(),
            ),
            main_visible: embedded || main.is_visible().map_err(|e| e.to_string())?,
            main_minimized: !embedded && main.is_minimized().map_err(|e| e.to_string())?,
            focus: Some(source.parent.clone()),
        };
        let mut native = Native {
            app,
            workspace: self,
            view: &view,
            page,
            before: restored_layout.clone(),
            after: restored_layout.clone(),
            operation: "recover",
            faults: faults(app)?,
        };
        self.moving.lock().unwrap().insert(page);
        let _moving = Moving(self, page);
        migration::restore(&mut native, &source)
            .map_err(|e| format!("恢复失败，页面窗口继续保留：{e}"))?;
        self.commit_layout(&restored_layout.snapshot);
        self.recoveries.lock().unwrap().remove(&page);
        if let Some(state) = self.state.lock().unwrap().pages.get_mut(&page) {
            state.recovery_required = false;
        }
        self.save_layout(app);
        self.emit(app);
        if let Some(label) = recovery.cleanup {
            self.clear_empty_window(app, &label)?;
        }
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_registration_survives_rejected_target_destruction_and_retry() {
        use tauri::{Manager, WebviewBuilder, WebviewUrl, WindowBuilder};
        let app = tauri::test::mock_app();
        let source = WindowBuilder::new(&app, "source").build().unwrap();
        let view = source
            .add_child(
                WebviewBuilder::new("persistent-page", WebviewUrl::default()),
                tauri::LogicalPosition::new(0, 0),
                tauri::LogicalSize::new(800, 600),
            )
            .unwrap();
        let dead = WindowBuilder::new(&app, "closed-target").build().unwrap();
        dead.destroy().unwrap();
        assert!(view.reparent(&dead).is_err());
        assert_eq!(view.window().label(), "source");
        // Tauri manager cleanup unregisters every entry in window.webviews().
        // The failed destination must never claim ownership of this live page.
        assert!(dead.webviews().is_empty());
        assert!(app.get_webview("persistent-page").is_some());
        assert_eq!(source.webviews().len(), 1);
        let destination = WindowBuilder::new(&app, "destination").build().unwrap();
        view.reparent(&destination).unwrap();
        assert_eq!(view.window().label(), "destination");
        assert!(source.webviews().is_empty());
        assert_eq!(destination.webviews().len(), 1);
        assert!(source.webviews().is_empty());
        assert!(app.get_webview("persistent-page").is_some());
    }

    #[test]
    fn deferred_recovery_preserves_other_window_moves_and_busy_state() {
        let state = PageState {
            detached: false,
            visible: false,
            ready: true,
            busy_reason: String::new(),
            recovery_required: true,
        };
        let mut current = Snapshot {
            selected: Page::Motion,
            motion_navigation: None,
            pages: BTreeMap::from([
                (Page::Handeye, state.clone()),
                (
                    Page::Motion,
                    PageState {
                        detached: true,
                        visible: true,
                        busy_reason: "正在运动".into(),
                        recovery_required: false,
                        ..state.clone()
                    },
                ),
                (
                    Page::Monitor,
                    PageState {
                        detached: false,
                        visible: false,
                        ..state
                    },
                ),
            ]),
        };
        current = recovered_snapshot(current, Page::Handeye, true, false);
        assert_eq!(current.selected, Page::Handeye);
        assert!(!current.pages[&Page::Handeye].recovery_required);
        assert!(current.pages[&Page::Handeye].visible);
        assert!(current.pages[&Page::Motion].detached && current.pages[&Page::Motion].visible);
        assert_eq!(current.pages[&Page::Motion].busy_reason, "正在运动");
        assert!(current.pages[&Page::Monitor].recovery_required);
        current = recovered_snapshot(current, Page::Handeye, false, true);
        assert!(current.pages[&Page::Handeye].detached && current.pages[&Page::Handeye].visible);
    }
}
