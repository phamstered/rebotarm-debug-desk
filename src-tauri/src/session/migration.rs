//! Window migration is a transaction over one persistent page, never a reload.
use super::windows::Rect;

#[derive(Clone, Debug)]
pub struct Placement {
    pub parent: String,
    pub bounds: Rect,
}

pub trait Backend {
    fn reparent(&mut self, target: &str, restoring: bool) -> Result<(), String>;
    fn bounds(&mut self, bounds: Rect, restoring: bool) -> Result<(), String>;
    fn layout(&mut self, restoring: bool) -> Result<(), String>;
    fn focus(&mut self, restoring: bool) -> Result<(), String>;
    fn reveal_current(&mut self) -> Result<(), String>;
}

#[derive(Debug)]
pub struct Failure {
    pub cause: String,
    pub rollback: Option<String>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.rollback {
            None => write!(f, "窗口移动失败，已恢复原页面：{}", self.cause),
            Some(error) => write!(
                f,
                "窗口移动失败：{}；恢复尚未完成：{}。页面窗口已保留，请点击“恢复窗口”重试",
                self.cause, error
            ),
        }
    }
}

fn apply(backend: &mut impl Backend, placement: &Placement, restoring: bool) -> Result<(), String> {
    // Always call reparent, even if Tauri's metadata already names the target:
    // its metadata can have changed before a failed native dispatch. The pinned
    // runtime makes same-parent repair a no-op without losing the WebView.
    backend.reparent(&placement.parent, restoring)?;
    backend.bounds(placement.bounds, restoring)?;
    backend.layout(restoring)?;
    backend.focus(restoring)
}

pub fn restore(backend: &mut impl Backend, source: &Placement) -> Result<(), String> {
    apply(backend, source, true).map_err(|reason| match backend.reveal_current() {
        Ok(()) => reason,
        Err(error) => format!("{reason}；显示保留页面失败：{error}"),
    })
}

pub fn transfer(
    backend: &mut impl Backend,
    source: &Placement,
    target: &Placement,
) -> Result<(), Failure> {
    apply(backend, target, false).map_err(|cause| Failure {
        cause,
        rollback: restore(backend, source).err(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    struct Mock {
        failures: BTreeSet<String>,
        parent: String,
        bounds: Rect,
        layout_restored: bool,
        calls: Vec<String>,
        payload: String,
    }
    impl Mock {
        fn step(&mut self, name: &str, restoring: bool) -> Result<(), String> {
            let key = format!("{}:{name}", if restoring { "rollback" } else { "move" });
            self.calls.push(key.clone());
            if self.failures.remove(&key) {
                Err(key)
            } else {
                Ok(())
            }
        }
    }
    impl Backend for Mock {
        fn reparent(&mut self, target: &str, r: bool) -> Result<(), String> {
            self.step("reparent", r)?;
            self.parent = target.into();
            Ok(())
        }
        fn bounds(&mut self, b: Rect, r: bool) -> Result<(), String> {
            self.step("bounds", r)?;
            self.bounds = b;
            Ok(())
        }
        fn layout(&mut self, r: bool) -> Result<(), String> {
            self.step("layout", r)?;
            self.layout_restored = r;
            Ok(())
        }
        fn focus(&mut self, r: bool) -> Result<(), String> {
            self.step("focus", r)
        }
        fn reveal_current(&mut self) -> Result<(), String> {
            self.calls.push(format!("reveal:{}", self.parent));
            Ok(())
        }
    }
    fn fixture(failures: &[&str]) -> (Mock, Placement, Placement) {
        let source = Placement {
            parent: "main".into(),
            bounds: Rect {
                x: 10.,
                y: 20.,
                width: 900.,
                height: 600.,
            },
        };
        let target = Placement {
            parent: "detached".into(),
            bounds: Rect {
                x: 0.,
                y: 0.,
                width: 1200.,
                height: 800.,
            },
        };
        (
            Mock {
                failures: failures.iter().map(|s| s.to_string()).collect(),
                parent: source.parent.clone(),
                bounds: source.bounds,
                layout_restored: true,
                calls: vec![],
                payload: "sample-17 / zoom-125%".into(),
            },
            source,
            target,
        )
    }
    #[test]
    fn every_forward_failure_restores_parent_bounds_layout_and_retains_payload() {
        for step in ["move:reparent", "move:bounds", "move:layout", "move:focus"] {
            let (mut backend, source, target) = fixture(&[step]);
            let failure = transfer(&mut backend, &source, &target).unwrap_err();
            assert!(failure.rollback.is_none());
            assert_eq!(backend.parent, source.parent);
            assert_eq!(backend.bounds, source.bounds);
            assert!(backend.layout_restored);
            assert_eq!(backend.payload, "sample-17 / zoom-125%");
            assert_eq!(backend.calls.last().unwrap(), "rollback:focus");
        }
    }
    #[test]
    fn failed_rollback_is_not_reported_as_restored_and_can_be_retried_without_new_page() {
        for step in [
            "rollback:reparent",
            "rollback:bounds",
            "rollback:layout",
            "rollback:focus",
        ] {
            let (mut backend, source, target) = fixture(&["move:focus", step]);
            let failure = transfer(&mut backend, &source, &target).unwrap_err();
            assert_eq!(failure.rollback.as_deref(), Some(step));
            let current = if step == "rollback:reparent" {
                "detached"
            } else {
                "main"
            };
            assert_eq!(backend.calls.last().unwrap(), &format!("reveal:{current}"));
            restore(&mut backend, &source).unwrap();
            assert_eq!(backend.parent, source.parent);
            assert_eq!(backend.bounds, source.bounds);
            assert!(backend.layout_restored);
            assert_eq!(backend.payload, "sample-17 / zoom-125%");
        }
    }
    #[test]
    fn success_commits_target_without_rollback_or_page_recreation() {
        let (mut backend, source, target) = fixture(&[]);
        transfer(&mut backend, &source, &target).unwrap();
        assert_eq!(backend.parent, target.parent);
        assert_eq!(backend.bounds, target.bounds);
        assert!(!backend.layout_restored);
        assert_eq!(backend.calls.len(), 4);
        assert_eq!(backend.payload, "sample-17 / zoom-125%");
    }
}
