//! Connection-owned raw resource bytes. Sharing a model across WebViews never
//! creates another upstream read for a cached or already pending URI.
use super::wire::WireFrame;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::{sync::watch, task::AbortHandle};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Key {
    pub uri: String,
    pub encoding: String,
}
impl Key {
    pub fn new(uri: &str, encoding: &str) -> Result<Self, String> {
        if uri.is_empty() || uri.len() > 4096 || uri.chars().any(char::is_control) {
            return Err("资源 URI 无效".into());
        }
        if !matches!(encoding, "binary" | "base64") {
            return Err("不支持的资源编码".into());
        }
        Ok(Self {
            uri: uri.into(),
            encoding: encoding.into(),
        })
    }
}
type Reply = Result<WireFrame, String>;
struct Cached {
    frame: WireFrame,
    used: u64,
}
struct Pending {
    reply: watch::Sender<Option<Reply>>,
    abort: AbortHandle,
}
struct Core {
    epoch: u64,
    generation: u64,
    values: BTreeMap<Key, Cached>,
    pending: BTreeMap<Key, Pending>,
    bytes: usize,
    clock: u64,
}
pub struct Resources {
    core: Arc<Mutex<Core>>,
    budget: usize,
    max_entries: usize,
    max_pending: usize,
}
impl Default for Resources {
    fn default() -> Self {
        Self::new(128 * 1024 * 1024, 512, 64)
    }
}
impl Resources {
    fn new(budget: usize, max_entries: usize, max_pending: usize) -> Self {
        Self {
            core: Arc::new(Mutex::new(Core {
                epoch: 0,
                generation: 0,
                values: BTreeMap::new(),
                pending: BTreeMap::new(),
                bytes: 0,
                clock: 0,
            })),
            budget,
            max_entries,
            max_pending,
        }
    }
    pub fn reset(&self, epoch: u64) {
        let mut core = self.core.lock().unwrap();
        if epoch < core.epoch {
            return;
        }
        core.epoch = epoch;
        core.generation += 1;
        for (_, pending) in std::mem::take(&mut core.pending) {
            pending
                .reply
                .send_replace(Some(Err("资源连接已失效".into())));
            pending.abort.abort();
        }
        core.values.clear();
        core.bytes = 0;
    }
    pub async fn get<F>(&self, epoch: u64, key: Key, load: F) -> Reply
    where
        F: Future<Output = Reply> + Send + 'static,
    {
        let mut receiver = {
            let mut core = self.core.lock().unwrap();
            if epoch != core.epoch {
                return Err("资源连接代次已失效".into());
            }
            core.clock += 1;
            let used = core.clock;
            if let Some(cached) = core.values.get_mut(&key) {
                cached.used = used;
                return Ok(cached.frame.clone());
            }
            if let Some(pending) = core.pending.get(&key) {
                pending.reply.subscribe()
            } else {
                if core.pending.len() >= self.max_pending {
                    return Err("资源读取队列已满，请稍后重试".into());
                }
                let (reply, receiver) = watch::channel(None);
                let owner = self.core.clone();
                let task_key = key.clone();
                let generation = core.generation;
                let budget = self.budget;
                let max_entries = self.max_entries;
                let task = tokio::spawn(async move {
                    let result = load.await.and_then(|frame| {
                        if frame.op() != "resource" {
                            return Err(frame.metadata["message"]
                                .as_str()
                                .unwrap_or("资源响应无效")
                                .into());
                        }
                        if frame.metadata["uri"].as_str() != Some(task_key.uri.as_str()) {
                            return Err("资源响应 URI 不匹配".into());
                        }
                        Ok(frame)
                    });
                    let mut core = owner.lock().unwrap();
                    if core.epoch != epoch || core.generation != generation {
                        return;
                    }
                    let Some(pending) = core.pending.remove(&task_key) else {
                        return;
                    };
                    if let Ok(frame) = &result {
                        if frame.bytes.len() <= budget && max_entries > 0 {
                            while core.bytes + frame.bytes.len() > budget
                                || core.values.len() >= max_entries
                            {
                                let oldest = core
                                    .values
                                    .iter()
                                    .min_by_key(|(_, value)| value.used)
                                    .map(|(key, _)| key.clone());
                                let Some(oldest) = oldest else {
                                    break;
                                };
                                core.bytes -=
                                    core.values.remove(&oldest).unwrap().frame.bytes.len();
                            }
                            core.clock += 1;
                            let used = core.clock;
                            core.bytes += frame.bytes.len();
                            core.values.insert(
                                task_key,
                                Cached {
                                    frame: frame.clone(),
                                    used,
                                },
                            );
                        }
                    }
                    pending.reply.send_replace(Some(result));
                });
                core.pending.insert(
                    key,
                    Pending {
                        reply,
                        abort: task.abort_handle(),
                    },
                );
                receiver
            }
        };
        loop {
            if let Some(reply) = receiver.borrow().clone() {
                return reply;
            }
            if receiver.changed().await.is_err() {
                return Err("资源读取已中断".into());
            }
        }
    }
}
impl Drop for Resources {
    fn drop(&mut self) {
        let epoch = self.core.lock().unwrap().epoch;
        self.reset(epoch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::oneshot;
    fn key(uri: &str) -> Key {
        Key::new(uri, "binary").unwrap()
    }
    fn frame(uri: &str) -> WireFrame {
        let data = [1u8, 2, 3, 4];
        let meta = serde_json::to_vec(&json!({"op":"resource", "uri":uri, "request_id":"test", "data_length":data.len(), "mime":"application/octet-stream"})).unwrap();
        let mut bytes = b"RCR1".to_vec();
        bytes.extend((meta.len() as u32).to_be_bytes());
        bytes.extend(meta);
        bytes.extend(data);
        WireFrame::parse(bytes.into(), true).unwrap()
    }
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn all_windows_share_one_inflight_read_and_the_same_binary_allocation() {
        let cache = Arc::new(Resources::default());
        cache.reset(1);
        let (send, receive) = oneshot::channel();
        let first = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .get(1, key("package://robot/a.stl"), async {
                        receive.await.unwrap()
                    })
                    .await
                    .unwrap()
            })
        };
        settle().await;
        let others: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                tokio::spawn(async move {
                    cache
                        .get(1, key("package://robot/a.stl"), async {
                            panic!("duplicate upstream read")
                        })
                        .await
                        .unwrap()
                })
            })
            .collect();
        settle().await;
        let expected = frame("package://robot/a.stl");
        send.send(Ok(expected.clone())).unwrap();
        assert!(Arc::ptr_eq(&first.await.unwrap().bytes, &expected.bytes));
        for other in others {
            assert!(Arc::ptr_eq(&other.await.unwrap().bytes, &expected.bytes));
        }
        let later = cache
            .get(1, key("package://robot/a.stl"), async {
                panic!("cached URI fetched again")
            })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&later.bytes, &expected.bytes));
        assert_eq!(cache.core.lock().unwrap().bytes, expected.bytes.len());
    }

    #[tokio::test]
    async fn cache_eviction_is_bounded_by_bytes_and_entry_count_and_touches_are_lru() {
        let size = frame("a").bytes.len();
        let cache = Resources::new(size * 2, 2, 1);
        cache.reset(1);
        for uri in ["a", "b"] {
            cache
                .get(1, key(uri), async move { Ok(frame(uri)) })
                .await
                .unwrap();
        }
        cache
            .get(1, key("a"), async { panic!("cache miss") })
            .await
            .unwrap();
        cache
            .get(1, key("c"), async { Ok(frame("c")) })
            .await
            .unwrap();
        {
            let core = cache.core.lock().unwrap();
            assert!(core.values.contains_key(&key("a")));
            assert!(!core.values.contains_key(&key("b")));
            assert_eq!(core.bytes, size * 2);
        }
        let tiny = Resources::new(1, 1, 1);
        tiny.reset(1);
        tiny.get(1, key("a"), async { Ok(frame("a")) })
            .await
            .unwrap();
        assert!(tiny.core.lock().unwrap().values.is_empty());
        assert_eq!(tiny.core.lock().unwrap().bytes, 0);
    }

    #[tokio::test]
    async fn disconnect_cancels_waiters_and_old_result_cannot_repopulate_new_cache() {
        let cache = Arc::new(Resources::default());
        cache.reset(1);
        let (send, receive) = oneshot::channel();
        let read = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .get(1, key("a"), async { receive.await.unwrap() })
                    .await
            })
        };
        settle().await;
        cache.reset(2);
        assert!(read.await.unwrap().unwrap_err().contains("失效"));
        settle().await;
        assert!(send.send(Ok(frame("a"))).is_err());
        cache
            .get(2, key("a"), async { Ok(frame("a")) })
            .await
            .unwrap();
        assert_eq!(cache.core.lock().unwrap().values.len(), 1);
        assert!(cache
            .get(1, key("a"), async { panic!("stale session fetched") })
            .await
            .is_err());
        cache.reset(1);
        assert_eq!(cache.core.lock().unwrap().values.len(), 1);
    }

    #[tokio::test]
    async fn errors_wrong_uri_and_queue_pressure_are_explicit_and_not_cached() {
        let cache = Arc::new(Resources::new(1024, 2, 1));
        cache.reset(1);
        let (send, receive) = oneshot::channel();
        let pending = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .get(1, key("a"), async { receive.await.unwrap() })
                    .await
            })
        };
        settle().await;
        assert!(cache
            .get(1, key("b"), async { panic!("full queue fetched") })
            .await
            .unwrap_err()
            .contains("队列已满"));
        send.send(Err("remote denied".into())).unwrap();
        assert_eq!(pending.await.unwrap().unwrap_err(), "remote denied");
        assert!(cache
            .get(1, key("a"), async { Ok(frame("different")) })
            .await
            .unwrap_err()
            .contains("不匹配"));
        assert!(cache.core.lock().unwrap().values.is_empty());
        cache
            .get(1, key("a"), async { Ok(frame("a")) })
            .await
            .unwrap();
        assert_eq!(cache.core.lock().unwrap().values.len(), 1);
        assert!(Key::new("a\n", "binary").is_err());
        assert!(Key::new("a", "unbounded").is_err());
    }
}
