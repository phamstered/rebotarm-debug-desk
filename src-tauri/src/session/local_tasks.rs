//! Bounded ownership for read-only handeye subprocesses, including offline work.
//! Results/images stay with the caller; shared snapshots contain metadata only.
use super::tasks::Tasks;
use serde::Serialize;
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const OWNER_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Running,
    Stopping,
    Succeeded,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub id: u64,
    pub window: String,
    pub kind: String,
    pub phase: Phase,
    pub message: String,
}
struct Entry {
    snapshot: Snapshot,
    operation_id: String,
    seen: Instant,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    entry: Option<Entry>,
}
#[derive(Default)]
pub struct LocalTasks {
    inner: Mutex<Inner>,
    changed: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
fn running(phase: Phase) -> bool {
    matches!(phase, Phase::Running | Phase::Stopping)
}
pub fn authorize(label: &str) -> Result<(), String> {
    if label == "page-handeye" {
        Ok(())
    } else {
        Err("只有手眼标定页面可以提交或续租此任务".into())
    }
}
impl LocalTasks {
    pub fn set_changed(&self, changed: Arc<dyn Fn() + Send + Sync>) {
        *self.changed.lock().unwrap() = Some(changed);
    }
    fn emit(&self) {
        let changed = self.changed.lock().unwrap().clone();
        if let Some(changed) = changed {
            changed();
        }
    }
    pub fn snapshot(&self) -> Option<Snapshot> {
        self.inner
            .lock()
            .unwrap()
            .entry
            .as_ref()
            .map(|e| e.snapshot.clone())
    }
    fn begin(
        self: &Arc<Self>,
        label: &str,
        operation_id: &str,
        kind: &str,
    ) -> Result<Lease, String> {
        authorize(label)?;
        if operation_id.is_empty()
            || operation_id.len() > 128
            || !operation_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("本地任务标识无效".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner
            .entry
            .as_ref()
            .is_some_and(|e| running(e.snapshot.phase))
        {
            return Err("已有手眼任务正在进行".into());
        }
        inner.sequence = inner.sequence.checked_add(1).ok_or("本地任务编号耗尽")?;
        let id = inner.sequence;
        inner.entry = Some(Entry {
            snapshot: Snapshot {
                id,
                window: label.into(),
                kind: kind.into(),
                phase: Phase::Running,
                message: "处理中".into(),
            },
            operation_id: operation_id.into(),
            seen: Instant::now(),
        });
        drop(inner);
        self.emit();
        Ok(Lease {
            tasks: self.clone(),
            id,
            finished: false,
        })
    }
    pub fn touch(&self, label: &str, operation_id: &str) -> Result<(), String> {
        self.touch_at(label, operation_id, Instant::now())
    }
    fn touch_at(&self, label: &str, operation_id: &str, now: Instant) -> Result<(), String> {
        authorize(label)?;
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .entry
            .as_mut()
            .filter(|e| e.snapshot.window == label && e.operation_id == operation_id)
            .ok_or("本地任务已失效")?;
        if entry.snapshot.phase != Phase::Running
            || now.saturating_duration_since(entry.seen) >= OWNER_TIMEOUT
        {
            return Err("本地任务租约已失效".into());
        }
        entry.seen = now;
        Ok(())
    }
    pub fn cancel(&self, label: &str, operation_id: &str) -> Result<(), String> {
        authorize(label)?;
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .entry
            .as_mut()
            .filter(|e| e.snapshot.window == label && e.operation_id == operation_id)
            .ok_or("本地任务已失效")?;
        if running(entry.snapshot.phase) {
            entry.snapshot.phase = Phase::Stopping;
            entry.snapshot.message = "所属页面已取消，等待子进程结束".into();
        }
        drop(inner);
        self.emit();
        Ok(())
    }
    fn lost(&self, id: u64, now: Instant) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.entry.as_ref().is_none_or(|e| {
            e.snapshot.id != id
                || e.snapshot.phase == Phase::Stopping
                || now.saturating_duration_since(e.seen) >= OWNER_TIMEOUT
        })
    }
    pub async fn run<T, F>(
        self: &Arc<Self>,
        tasks: &Arc<Tasks>,
        label: &str,
        operation_id: &str,
        kind: &str,
        work: F,
    ) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        authorize(label)?;
        // The same lock arbitrates migration and operation admission, before work is polled.
        let _page = if kind == "capture" { tasks.sampling_operation(label)? } else { tasks.local_operation(label)? };
        let mut lease = self.begin(label, operation_id, kind)?;
        let mut result = tokio::select! {
            biased;
            _ = async {
                loop {
                    if self.lost(lease.id, Instant::now()) { break; }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => Err("所属页面已退出、取消或失联，手眼任务已终止".into()),
            result = work => result,
        };
        // `work` has been dropped here: kill_on_drop releases its child on cancellation.
        let phase = if self.lost(lease.id, Instant::now()) {
            result = Err("所属页面已退出、取消或失联，手眼任务已终止".into());
            Phase::Cancelled
        } else if result.is_ok() {
            Phase::Succeeded
        } else {
            Phase::Failed
        };
        lease.finish(
            phase,
            result
                .as_ref()
                .err()
                .map(String::as_str)
                .unwrap_or("已完成"),
        );
        result
    }
}
struct Lease {
    tasks: Arc<LocalTasks>,
    id: u64,
    finished: bool,
}
impl Lease {
    fn finish(&mut self, phase: Phase, message: &str) {
        let mut inner = self.tasks.inner.lock().unwrap();
        if let Some(entry) = inner.entry.as_mut().filter(|e| e.snapshot.id == self.id) {
            entry.snapshot.phase = phase;
            entry.snapshot.message = message.chars().take(512).collect();
        }
        self.finished = true;
        drop(inner);
        self.tasks.emit();
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(Phase::Cancelled, "原生任务已取消");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[test]
    fn caller_identity_expired_and_old_heartbeats_cannot_renew() {
        let local = Arc::new(LocalTasks::default());
        for label in [
            "main",
            "page-motion",
            "page-monitor",
            "detached-page-handeye",
        ] {
            assert!(local.begin(label, "id", "compute").is_err());
        }
        assert!(local.begin("page-handeye", "bad\nid", "compute").is_err());
        let mut first = local.begin("page-handeye", "first", "compute").unwrap();
        assert!(local.touch("page-motion", "first").is_err());
        assert!(local.touch("page-handeye", "other").is_err());
        assert!(local
            .touch_at("page-handeye", "first", Instant::now() + OWNER_TIMEOUT)
            .is_err());
        first.finish(Phase::Succeeded, "done");
        assert!(local.touch("page-handeye", "first").is_err());
        let _next = local.begin("page-handeye", "second", "capture").unwrap();
        assert!(local.cancel("page-handeye", "first").is_err());
        assert_eq!(local.snapshot().unwrap().phase, Phase::Running);
        assert!(local.cancel("main", "second").is_err());
    }
    #[test]
    fn concurrent_migration_and_operation_admission_have_exactly_one_winner() {
        let tasks = Arc::new(Tasks::default());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|index| {
                let tasks = tasks.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let accepted = if index == 0 {
                        let guard = tasks.migration("page-handeye");
                        barrier.wait();
                        guard.is_ok()
                    } else {
                        let guard = tasks.local_operation("page-handeye");
                        barrier.wait();
                        guard.is_ok()
                    };
                    accepted
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count(),
            1
        );
        assert!(tasks.migration("page-handeye").is_ok());
    }
    #[tokio::test]
    async fn migration_and_work_admission_are_mutually_exclusive_and_release_on_failure() {
        let tasks = Arc::new(Tasks::default());
        let local = Arc::new(LocalTasks::default());
        let migration = tasks.migration("page-handeye").unwrap();
        let polled = AtomicBool::new(false);
        assert!(local
            .run(&tasks, "page-handeye", "one", "compute", async {
                polled.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!polled.load(Ordering::SeqCst));
        drop(migration);
        let result: Result<(), String> = local
            .run(&tasks, "page-handeye", "two", "capture", async {
                assert!(tasks.migration("page-handeye").is_err());
                assert!(tasks.migration("page-monitor").is_ok());
                assert!(tasks.local_operation("page-handeye").is_err());
                Err("test failure".into())
            })
            .await;
        assert!(result.is_err());
        assert_eq!(local.snapshot().unwrap().phase, Phase::Failed);
        assert!(tasks.migration("page-handeye").is_ok());
    }
    #[tokio::test]
    async fn cancellation_drops_work_before_releasing_migration_guard_and_preserves_terminal() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let tasks = Arc::new(Tasks::default());
        let local = Arc::new(LocalTasks::default());
        let dropped = Arc::new(AtomicBool::new(false));
        let work = async {
            let _drop = Dropped(dropped.clone());
            local.cancel("page-handeye", "cancel").unwrap();
            std::future::pending::<Result<(), String>>().await
        };
        assert!(local
            .run(&tasks, "page-handeye", "cancel", "compute", work)
            .await
            .is_err());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(tasks.migration("page-handeye").is_ok());
        assert_eq!(local.snapshot().unwrap().phase, Phase::Cancelled);
        assert!(local.touch("page-handeye", "cancel").is_err());
        let serialized = serde_json::to_string(&local.snapshot()).unwrap();
        assert!(serialized.len() < 1024);
        assert!(!serialized.contains("operation_id"));
    }
    #[tokio::test]
    async fn owner_loss_and_dropped_native_future_release_read_only_work() {
        let tasks = Arc::new(Tasks::default());
        let local = Arc::new(LocalTasks::default());
        let future = local.run(&tasks, "page-handeye", "lost", "compute", async {
            local.inner.lock().unwrap().entry.as_mut().unwrap().seen =
                Instant::now() - OWNER_TIMEOUT;
            std::future::pending::<Result<(), String>>().await
        });
        assert!(tokio::time::timeout(Duration::from_secs(1), future)
            .await
            .unwrap()
            .is_err());
        assert_eq!(local.snapshot().unwrap().phase, Phase::Cancelled);
        assert!(tasks.migration("page-handeye").is_ok());
        let future = local.run(
            &tasks,
            "page-handeye",
            "dropped",
            "compute",
            std::future::pending::<Result<(), String>>(),
        );
        assert!(tokio::time::timeout(Duration::from_millis(5), future)
            .await
            .is_err());
        assert_eq!(local.snapshot().unwrap().phase, Phase::Cancelled);
        assert!(tasks.migration("page-handeye").is_ok());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_actual_local_child() {
        let tasks = Arc::new(Tasks::default());
        let local = Arc::new(LocalTasks::default());
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let canceller = local.clone();
        let work = async move {
            let mut child = child;
            canceller.cancel("page-handeye", "child").unwrap();
            child.wait().await.map(|_| ()).map_err(|e| e.to_string())
        };
        assert!(local
            .run(&tasks, "page-handeye", "child", "compute", work)
            .await
            .is_err());
        for _ in 0..100 {
            let alive = std::process::Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success();
            if !alive {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("cancelled subprocess still exists");
    }
}
