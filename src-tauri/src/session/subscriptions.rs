use super::windows::WindowToken;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Consumer {
    pub window: WindowToken,
    /// Different widgets in the same window must not unsubscribe each other.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transition {
    pub epoch: u64,
    pub id: u64,
    pub topic: String,
    pub message_type: String,
    pub subscribe: bool,
}

#[derive(Default)]
struct Topic {
    message_type: String,
    consumers: BTreeSet<Consumer>,
    subscribed: bool,
    pending: Option<Transition>,
    failed: bool,
}

/// Serializes subscribe/unsubscribe changes per upstream topic. Desired ownership
/// is separate from acknowledged state, including when a window closes while a
/// subscription request is in flight. No consumer can remove another's interest.
pub struct SubscriptionRegistry {
    epoch: u64,
    sequence: u64,
    topics: BTreeMap<String, Topic>,
    limit: usize,
}

impl SubscriptionRegistry {
    pub fn new(epoch: u64, limit: usize) -> Self {
        Self {
            epoch,
            sequence: 0,
            topics: BTreeMap::new(),
            limit,
        }
    }

    pub fn acquire(
        &mut self,
        topic: &str,
        message_type: &str,
        consumer: Consumer,
    ) -> Result<Vec<Transition>, &'static str> {
        if !valid_topic(topic)
            || message_type.is_empty()
            || message_type.len() > 256
            || consumer.name.is_empty()
            || consumer.name.len() > 128
        {
            return Err("订阅参数无效");
        }
        if !self.topics.contains_key(topic) && self.topics.len() >= self.limit {
            return Err("订阅数量超限");
        }
        let entry = self.topics.entry(topic.into()).or_insert_with(|| Topic {
            message_type: message_type.into(),
            ..Topic::default()
        });
        if entry.message_type != message_type {
            return Err("同一 Topic 的消息类型不一致");
        }
        if !entry.consumers.contains(&consumer) && entry.consumers.len() >= 128 {
            return Err("订阅消费者超限");
        }
        entry.consumers.insert(consumer);
        entry.failed = false;
        Ok(self.reconcile())
    }

    pub fn release(&mut self, topic: &str, consumer: &Consumer) -> Vec<Transition> {
        if let Some(entry) = self.topics.get_mut(topic) {
            if entry.consumers.remove(consumer) {
                entry.failed = false;
            }
        }
        self.reconcile()
    }

    pub fn release_window(&mut self, window: &WindowToken) -> Vec<Transition> {
        for entry in self.topics.values_mut() {
            let before = entry.consumers.len();
            entry
                .consumers
                .retain(|consumer| &consumer.window != window);
            if before != entry.consumers.len() {
                entry.failed = false;
            }
        }
        self.reconcile()
    }

    pub fn acknowledge(
        &mut self,
        transition: &Transition,
        success: bool,
    ) -> Result<Vec<Transition>, &'static str> {
        if transition.epoch != self.epoch {
            return Err("旧会话订阅响应");
        }
        let entry = self.topics.get_mut(&transition.topic).ok_or("订阅已失效")?;
        if entry.pending.as_ref() != Some(transition) {
            return Err("订阅响应顺序无效");
        }
        entry.pending = None;
        if success {
            entry.subscribed = transition.subscribe;
        }
        entry.failed = !success;
        Ok(self.reconcile())
    }

    pub fn recipients(&self, topic: &str) -> BTreeSet<WindowToken> {
        self.topics
            .get(topic)
            .filter(|entry| entry.subscribed)
            .map(|entry| {
                entry
                    .consumers
                    .iter()
                    .map(|consumer| consumer.window.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn message_type(&self, topic: &str) -> Option<&str> {
        self.topics
            .get(topic)
            .map(|entry| entry.message_type.as_str())
    }

    fn reconcile(&mut self) -> Vec<Transition> {
        let mut changes = Vec::new();
        for (topic, entry) in &mut self.topics {
            let desired = !entry.consumers.is_empty();
            // Current Bridge only supports unsubscribe for Image. Keep other
            // upstream subscriptions dormant until disconnect; stop fan-out now.
            if !desired && entry.subscribed && entry.message_type != "sensor_msgs/msg/Image" {
                continue;
            }
            if entry.pending.is_none() && !entry.failed && desired != entry.subscribed {
                self.sequence += 1;
                let change = Transition {
                    epoch: self.epoch,
                    id: self.sequence,
                    topic: topic.clone(),
                    message_type: entry.message_type.clone(),
                    subscribe: desired,
                };
                entry.pending = Some(change.clone());
                changes.push(change);
            }
        }
        self.topics.retain(|_, entry| {
            entry.subscribed || entry.pending.is_some() || !entry.consumers.is_empty()
        });
        changes
    }
}

fn valid_topic(value: &str) -> bool {
    value.starts_with('/')
        && value.len() > 1
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'/' || c == b'_')
        && !value.contains("//")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn consumer(label: &str, name: &str) -> Consumer {
        Consumer {
            window: WindowToken {
                label: label.into(),
                incarnation: 1,
            },
            name: name.into(),
        }
    }
    #[test]
    fn shared_topic_has_one_upstream_subscription_until_last_widget_releases() {
        let mut registry = SubscriptionRegistry::new(1, 16);
        let a = consumer("main", "inspector");
        let b = consumer("main", "handeye");
        let c = consumer("page-motion", "rgb");
        let subscribe = registry
            .acquire("/rgb", "sensor_msgs/msg/Image", a.clone())
            .unwrap();
        assert_eq!(subscribe.len(), 1);
        assert!(registry
            .acquire("/rgb", "sensor_msgs/msg/Image", b.clone())
            .unwrap()
            .is_empty());
        assert!(registry
            .acquire("/rgb", "sensor_msgs/msg/Image", c.clone())
            .unwrap()
            .is_empty());
        assert!(registry.recipients("/rgb").is_empty()); // not confirmed yet
        assert!(registry
            .acknowledge(&subscribe[0], true)
            .unwrap()
            .is_empty());
        assert_eq!(registry.recipients("/rgb").len(), 2);
        assert!(registry.release("/rgb", &a).is_empty());
        assert!(registry.release("/rgb", &b).is_empty());
        assert_eq!(registry.recipients("/rgb").len(), 1);
        let unsubscribe = registry.release_window(&c.window);
        assert_eq!(unsubscribe.len(), 1);
        assert!(!unsubscribe[0].subscribe);
        assert!(registry.recipients("/rgb").is_empty());
        registry.acknowledge(&unsubscribe[0], true).unwrap();
    }
    #[test]
    fn closing_then_reopening_while_ack_pending_serializes_transitions() {
        let mut registry = SubscriptionRegistry::new(7, 2);
        let old = consumer("page-handeye", "rgb");
        let mut new = old.clone();
        new.window.incarnation = 2;
        let sub = registry
            .acquire("/rgb", "sensor_msgs/msg/Image", old.clone())
            .unwrap()
            .remove(0);
        assert!(registry.release_window(&old.window).is_empty());
        let unsub = registry.acknowledge(&sub, true).unwrap().remove(0);
        assert!(!unsub.subscribe);
        assert!(registry
            .acquire("/rgb", "sensor_msgs/msg/Image", new.clone())
            .unwrap()
            .is_empty());
        assert!(registry.release_window(&old.window).is_empty());
        let resub = registry.acknowledge(&unsub, true).unwrap().remove(0);
        assert!(resub.subscribe);
        assert!(registry.acknowledge(&sub, true).is_err());
        registry.acknowledge(&resub, true).unwrap();
        assert_eq!(registry.recipients("/rgb"), BTreeSet::from([new.window]));
    }
    #[test]
    fn failure_is_not_reported_as_subscribed_or_retried_in_a_busy_loop() {
        let mut registry = SubscriptionRegistry::new(7, 2);
        let a = consumer("main", "rgb");
        let sub = registry
            .acquire("/rgb", "sensor_msgs/msg/Image", a.clone())
            .unwrap()
            .remove(0);
        assert!(registry.acknowledge(&sub, false).unwrap().is_empty());
        assert!(registry.recipients("/rgb").is_empty());
        let retry = registry
            .acquire("/rgb", "sensor_msgs/msg/Image", a.clone())
            .unwrap()
            .remove(0);
        assert_ne!(retry.id, sub.id);
        registry.acknowledge(&retry, true).unwrap();
        assert!(registry.acquire("/rgb", "OtherType", a.clone()).is_err());
        let unsub = registry.release("/rgb", &a).remove(0);
        assert!(registry.acknowledge(&unsub, false).unwrap().is_empty());
        // No consumer receives data after a failed unsubscribe.
        assert!(registry.recipients("/rgb").is_empty());
    }
    #[test]
    fn new_connection_rejects_old_acks_and_limits_stream_count() {
        let a = consumer("main", "rgb");
        let old = SubscriptionRegistry::new(1, 1)
            .acquire("/rgb", "sensor_msgs/msg/Image", a.clone())
            .unwrap()
            .remove(0);
        let mut fresh = SubscriptionRegistry::new(2, 1);
        fresh
            .acquire("/rgb", "sensor_msgs/msg/Image", a.clone())
            .unwrap();
        assert!(fresh.acknowledge(&old, true).is_err());
        assert!(fresh
            .acquire("/second", "sensor_msgs/msg/Image", a)
            .is_err());
    }

    #[test]
    fn non_image_topics_remain_dormant_without_unsupported_unsubscribe() {
        let mut registry = SubscriptionRegistry::new(1, 2);
        let a = consumer("main", "joints");
        let sub = registry
            .acquire("/joints", "sensor_msgs/msg/JointState", a.clone())
            .unwrap()
            .remove(0);
        registry.acknowledge(&sub, true).unwrap();
        assert!(registry.release("/joints", &a).is_empty());
        assert!(registry.recipients("/joints").is_empty());
        assert!(registry
            .acquire("/joints", "sensor_msgs/msg/JointState", a)
            .unwrap()
            .is_empty());
    }
}
