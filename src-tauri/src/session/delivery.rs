use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

/// The existing Bridge wire frame, shared by reference until a window consumes it.
#[derive(Clone, Debug)]
pub struct Frame {
    pub epoch: u64,
    pub received_ms: u64,
    pub bytes: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub reliable_messages: usize,
    pub latest_streams: usize,
    pub bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            reliable_messages: 128,
            latest_streams: 64,
            bytes: 80 * 1024 * 1024,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeliveryError {
    StaleEpoch,
    FrameTooLarge,
    ReliableOverflow,
    StreamLimit,
}

/// Per-window queue. Reliable responses/terminal states are never overwritten.
/// Image/telemetry previews have one latest frame per stream. A consumer pulls
/// at most one batch at a time, so Tauri's internal IPC queue cannot grow at the
/// producer's frame rate. Overflow disconnects that consumer explicitly.
pub struct Mailbox {
    epoch: u64,
    limits: Limits,
    reliable: VecDeque<Frame>,
    latest: BTreeMap<String, Frame>,
    stream_order: VecDeque<String>,
    bytes: usize,
    pub replaced_frames: u64,
}

impl Mailbox {
    pub fn new(epoch: u64, limits: Limits) -> Self {
        Self {
            epoch,
            limits,
            reliable: VecDeque::new(),
            latest: BTreeMap::new(),
            stream_order: VecDeque::new(),
            bytes: 0,
            replaced_frames: 0,
        }
    }

    fn check(&self, frame: &Frame) -> Result<(), DeliveryError> {
        if frame.epoch != self.epoch {
            return Err(DeliveryError::StaleEpoch);
        }
        if frame.bytes.len() > self.limits.bytes {
            return Err(DeliveryError::FrameTooLarge);
        }
        Ok(())
    }

    fn evict_oldest_preview(&mut self) -> bool {
        let Some(key) = self.stream_order.pop_front() else {
            return false;
        };
        if let Some(frame) = self.latest.remove(&key) {
            self.bytes -= frame.bytes.len();
            self.replaced_frames += 1;
        }
        true
    }

    pub fn reliable(&mut self, frame: Frame) -> Result<(), DeliveryError> {
        self.check(&frame)?;
        if self.reliable.len() >= self.limits.reliable_messages {
            return Err(DeliveryError::ReliableOverflow);
        }
        // Critical messages may reclaim preview space, never another ACK/result.
        while self.bytes + frame.bytes.len() > self.limits.bytes {
            if !self.evict_oldest_preview() {
                return Err(DeliveryError::ReliableOverflow);
            }
        }
        self.bytes += frame.bytes.len();
        self.reliable.push_back(frame);
        Ok(())
    }

    pub fn latest(&mut self, stream: String, frame: Frame) -> Result<(), DeliveryError> {
        self.check(&frame)?;
        if !self.latest.contains_key(&stream) && self.latest.len() >= self.limits.latest_streams {
            return Err(DeliveryError::StreamLimit);
        }
        if let Some(old) = self.latest.remove(&stream) {
            self.bytes -= old.bytes.len();
            self.replaced_frames += 1;
            self.stream_order.retain(|key| key != &stream);
        }
        while self.bytes + frame.bytes.len() > self.limits.bytes {
            if !self.evict_oldest_preview() {
                // A busy reliable queue wins over a display-only frame.
                self.replaced_frames += 1;
                return Ok(());
            }
        }
        self.bytes += frame.bytes.len();
        self.stream_order.push_back(stream.clone());
        self.latest.insert(stream, frame);
        Ok(())
    }

    pub fn pop(&mut self, now_ms: u64, preview_max_age_ms: u64) -> Option<Frame> {
        if let Some(frame) = self.reliable.pop_front() {
            self.bytes -= frame.bytes.len();
            return Some(frame);
        }
        while let Some(key) = self.stream_order.pop_front() {
            if let Some(frame) = self.latest.remove(&key) {
                self.bytes -= frame.bytes.len();
                if frame.received_ms <= now_ms && now_ms - frame.received_ms <= preview_max_age_ms {
                    return Some(frame);
                }
                self.replaced_frames += 1;
            }
        }
        None
    }

    /// Hidden windows stop consuming previews, but must still receive task results.
    pub fn discard_previews(&mut self) {
        while self.evict_oldest_preview() {}
    }

    pub fn queued_bytes(&self) -> usize {
        self.bytes
    }
    pub fn queued_frames(&self) -> usize {
        self.latest.len() + self.reliable.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(epoch: u64, at: u64, value: u8, size: usize) -> Frame {
        Frame {
            epoch,
            received_ms: at,
            bytes: vec![value; size].into(),
        }
    }
    fn limits() -> Limits {
        Limits {
            reliable_messages: 2,
            latest_streams: 2,
            bytes: 16,
        }
    }

    #[test]
    fn slow_window_retains_only_latest_without_blocking_other_windows() {
        let mut slow = Mailbox::new(1, limits());
        let mut fast = Mailbox::new(1, limits());
        for n in 0..10_000_u64 {
            let image = frame(1, n, (n % 256) as u8, 8);
            slow.latest("rgb".into(), image.clone()).unwrap();
            fast.latest("rgb".into(), image).unwrap();
            assert_eq!(fast.pop(n, 500).unwrap().bytes[0], (n % 256) as u8);
            assert_eq!(slow.queued_bytes(), 8);
            assert_eq!(slow.queued_frames(), 1);
        }
        assert_eq!(slow.replaced_frames, 9999);
        assert_eq!(slow.pop(9999, 500).unwrap().bytes[0], (9999 % 256) as u8);
    }

    #[test]
    fn shared_payload_is_not_copied_when_fanning_out() {
        let data = frame(1, 0, 1, 8);
        let mut a = Mailbox::new(1, limits());
        let mut b = Mailbox::new(1, limits());
        a.latest("rgb".into(), data.clone()).unwrap();
        b.latest("rgb".into(), data.clone()).unwrap();
        assert!(Arc::ptr_eq(&a.pop(0, 500).unwrap().bytes, &data.bytes));
        assert!(Arc::ptr_eq(&b.pop(0, 500).unwrap().bytes, &data.bytes));
    }

    #[test]
    fn terminal_and_ack_take_priority_and_overflow_is_explicit() {
        let mut q = Mailbox::new(1, limits());
        q.latest("rgb".into(), frame(1, 0, 1, 12)).unwrap();
        q.reliable(frame(1, 0, 2, 8)).unwrap();
        q.reliable(frame(1, 0, 3, 8)).unwrap();
        assert_eq!(
            q.reliable(frame(1, 0, 4, 1)),
            Err(DeliveryError::ReliableOverflow)
        );
        assert_eq!(q.pop(9000, 500).unwrap().bytes[0], 2);
        assert_eq!(q.pop(9000, 500).unwrap().bytes[0], 3);
        assert!(q.pop(9000, 500).is_none());
    }

    #[test]
    fn stale_sessions_and_aged_previews_never_reappear() {
        let mut q = Mailbox::new(2, limits());
        assert_eq!(
            q.latest("rgb".into(), frame(1, 0, 1, 8)),
            Err(DeliveryError::StaleEpoch)
        );
        q.latest("rgb".into(), frame(2, 0, 1, 8)).unwrap();
        assert!(q.pop(501, 500).is_none());
        q.latest("rgb".into(), frame(2, 900, 1, 8)).unwrap();
        assert!(q.pop(899, 500).is_none());
        assert_eq!(q.queued_bytes(), 0);
    }

    #[test]
    fn byte_stream_and_message_limits_bound_memory() {
        let mut q = Mailbox::new(1, limits());
        assert_eq!(
            q.reliable(frame(1, 0, 1, 17)),
            Err(DeliveryError::FrameTooLarge)
        );
        q.latest("a".into(), frame(1, 0, 1, 4)).unwrap();
        q.latest("b".into(), frame(1, 0, 2, 4)).unwrap();
        assert_eq!(
            q.latest("c".into(), frame(1, 0, 3, 4)),
            Err(DeliveryError::StreamLimit)
        );
        q.latest("a".into(), frame(1, 0, 4, 14)).unwrap();
        assert_eq!(q.queued_frames(), 1);
        assert_eq!(q.queued_bytes(), 14);
        q.discard_previews();
        assert_eq!(q.queued_bytes(), 0);
    }
}
