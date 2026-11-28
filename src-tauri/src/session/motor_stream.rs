//! Bounded native renewal. Only page commands refresh the owner deadline;
//! native publications/ACKs cannot keep a departed or stalled page alive.
use super::tasks::{Owner, Phase, Snapshot};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const PERIOD: Duration = Duration::from_millis(20);
pub const CLIENT_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_IN_FLIGHT: usize = 8;

#[derive(Clone)]
pub struct Frame {
    pub owner: Owner,
    pub ticket: u64,
    pub payload: Value,
    generation: u64,
}
struct Slot {
    frame: Frame,
    client_at: Instant,
    published_at: Instant,
    in_flight: usize,
}
#[derive(Default)]
struct State {
    generation: u64,
    slot: Option<Slot>,
}
#[derive(Default)]
pub struct Stream(Mutex<State>);
pub enum Poll {
    Idle,
    Send(Frame),
    Expired(Owner, u128),
}

pub fn command(value: &Value) -> bool {
    matches!(
        value["op"].as_str(),
        Some("joint_command" | "motor_command_v2")
    ) && matches!(value["mode"].as_u64(), Some(0..=2))
}
fn running(task: Option<&Snapshot>, frame: &Frame) -> bool {
    task.is_some_and(|t| {
        t.id == frame.ticket
            && t.epoch == frame.owner.epoch
            && t.window == frame.owner.window.label
            && t.phase == Phase::Running
    })
}
impl Stream {
    pub fn clear(&self) {
        let mut s = self.0.lock().unwrap();
        s.generation += 1;
        s.slot = None;
    }
    /// A repeated page snapshot is a liveness renewal, not a fabricated publish ACK.
    pub fn renew(
        &self,
        owner: &Owner,
        ticket: u64,
        payload: &Value,
        now: Instant,
    ) -> Result<bool, String> {
        let mut s = self.0.lock().unwrap();
        let Some(slot) = s
            .slot
            .as_mut()
            .filter(|s| s.frame.owner == *owner && s.frame.ticket == ticket)
        else {
            return Ok(false);
        };
        let age = now.saturating_duration_since(slot.client_at);
        if age >= CLIENT_TIMEOUT {
            return Err(format!(
                "Motor 页面续期超时：{} ms ≥ 250 ms；禁止迟到续期恢复控制",
                age.as_millis()
            ));
        }
        if slot.frame.payload != *payload {
            return Ok(false);
        }
        slot.client_at = now;
        Ok(true)
    }
    /// Install only after admission; replacing an existing target fences queued old frames.
    pub fn replace(&self, owner: Owner, ticket: u64, payload: Value, now: Instant) -> u64 {
        let mut s = self.0.lock().unwrap();
        s.generation += 1;
        let generation = s.generation;
        s.slot = Some(Slot {
            frame: Frame {
                owner,
                ticket,
                payload,
                generation,
            },
            client_at: now,
            published_at: now,
            in_flight: 0,
        });
        generation
    }
    pub fn generation(&self) -> u64 {
        self.0.lock().unwrap().generation
    }
    pub fn has(&self, owner: &Owner, ticket: u64) -> bool {
        self.0
            .lock()
            .unwrap()
            .slot
            .as_ref()
            .is_some_and(|s| s.frame.owner == *owner && s.frame.ticket == ticket)
    }
    pub fn poll(&self, task: Option<&Snapshot>, now: Instant) -> Poll {
        let mut s = self.0.lock().unwrap();
        let Some(slot) = s.slot.as_mut() else {
            return Poll::Idle;
        };
        if !running(task, &slot.frame) {
            s.generation += 1;
            s.slot = None;
            return Poll::Idle;
        }
        let age = now.saturating_duration_since(slot.client_at);
        if age >= CLIENT_TIMEOUT {
            let owner = slot.frame.owner.clone();
            s.generation += 1;
            s.slot = None;
            return Poll::Expired(owner, age.as_millis());
        }
        if slot.in_flight >= MAX_IN_FLIGHT
            || now.saturating_duration_since(slot.published_at) < PERIOD
        {
            return Poll::Idle;
        }
        slot.published_at = now;
        slot.in_flight += 1;
        Poll::Send(slot.frame.clone())
    }
    pub fn current(&self, frame: &Frame, now: Instant) -> bool {
        self.0.lock().unwrap().slot.as_ref().is_some_and(|s| {
            s.frame.generation == frame.generation
                && now.saturating_duration_since(s.client_at) < CLIENT_TIMEOUT
        })
    }
    pub fn complete(&self, frame: &Frame) -> bool {
        let mut s = self.0.lock().unwrap();
        let Some(slot) = s
            .slot
            .as_mut()
            .filter(|s| s.frame.generation == frame.generation)
        else {
            return false;
        };
        slot.in_flight = slot.in_flight.saturating_sub(1);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::{tasks::Kind, windows::WindowToken};
    use super::*;
    use serde_json::json;
    fn owner() -> Owner {
        Owner {
            epoch: 1,
            window: WindowToken {
                label: "page-motor".into(),
                incarnation: 1,
            },
        }
    }
    fn task() -> Snapshot {
        Snapshot {
            id: 1,
            epoch: 1,
            window: "page-motor".into(),
            command_id: "motor-1".into(),
            kind: Kind::Motor,
            phase: Phase::Running,
            message: String::new(),
            recovery_error: false,
        }
    }
    fn payload() -> Value {
        json!({"op":"motor_command_v2","mode":1,"lease_id":12,"position":[0.1]})
    }
    #[test]
    fn native_50hz_bridges_page_jitter_without_extending_page_lifetime() {
        let stream = Stream::default();
        let start = Instant::now();
        let p = payload();
        let t = task();
        stream.replace(owner(), 1, p.clone(), start);
        let mut frames = 0;
        for ms in (20..=60_000).step_by(20) {
            let now = start + Duration::from_millis(ms);
            if ms % 180 == 0 {
                assert!(stream.renew(&owner(), 1, &p, now).unwrap());
            }
            let Poll::Send(frame) = stream.poll(Some(&t), now) else {
                panic!("missed native frame at {ms}")
            };
            assert!(stream.current(&frame, now));
            stream.complete(&frame);
            frames += 1;
        }
        assert_eq!(frames, 3000);
        let expired = start + Duration::from_millis(60_190);
        assert!(matches!(
            stream.poll(Some(&t), expired),
            Poll::Expired(_, 250)
        ));
        assert!(matches!(
            stream.poll(Some(&t), expired + PERIOD),
            Poll::Idle
        ));
    }
    #[test]
    fn retarget_and_stop_fence_old_queued_frames_and_late_acks() {
        let stream = Stream::default();
        let now = Instant::now();
        let t = task();
        stream.replace(owner(), 1, payload(), now);
        let Poll::Send(old) = stream.poll(Some(&t), now + PERIOD) else {
            panic!()
        };
        let mut next = payload();
        next["position"] = json!([0.2]);
        stream.replace(owner(), 1, next.clone(), now + PERIOD);
        assert!(!stream.current(&old, now + PERIOD));
        assert!(!stream.complete(&old));
        let Poll::Send(new) = stream.poll(Some(&t), now + PERIOD * 2) else {
            panic!()
        };
        assert_eq!(new.payload, next);
        stream.clear();
        assert!(!stream.current(&new, now + PERIOD * 2));
        assert!(!stream.complete(&new));
    }
    #[test]
    fn late_page_cannot_renew_and_pending_acks_do_not_extend_deadline() {
        let s = Stream::default();
        let now = Instant::now();
        let t = task();
        s.replace(owner(), 1, payload(), now);
        let mut frames = Vec::new();
        for i in 1..=8 {
            let Poll::Send(f) = s.poll(Some(&t), now + PERIOD * i) else {
                panic!()
            };
            frames.push(f);
        }
        assert!(matches!(s.poll(Some(&t), now + PERIOD * 9), Poll::Idle));
        s.complete(&frames[0]);
        assert!(s
            .renew(&owner(), 1, &payload(), now + CLIENT_TIMEOUT)
            .is_err());
        assert!(matches!(
            s.poll(Some(&t), now + CLIENT_TIMEOUT),
            Poll::Expired(_, 250)
        ));
    }
    #[test]
    fn other_owner_and_replaced_task_cannot_keep_stream_alive() {
        let s = Stream::default();
        let now = Instant::now();
        s.replace(owner(), 1, payload(), now);
        let mut other = owner();
        other.epoch = 2;
        assert!(!s.renew(&other, 1, &payload(), now).unwrap());
        let mut t = task();
        t.id = 2;
        assert!(matches!(s.poll(Some(&t), now + PERIOD), Poll::Idle));
        assert!(!s.has(&owner(), 1));
    }
}
