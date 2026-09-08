//! Bounded crash-recovery state; only owned, explicitly started tunnels get a budget.
use serde_json::{json, Value};
use tokio::time::{Duration, Instant};
#[derive(Default)]
pub(super) struct Recovery {
    attempts: usize,
    next: Option<Instant>,
    stable_since: Option<Instant>,
    blocked: Option<&'static str>,
}
impl Recovery {
    pub fn due(&self, now: Instant) -> bool {
        self.blocked.is_none() && self.attempts < 5 && self.next.is_none_or(|t| now >= t)
    }
    pub fn attempt(&mut self, now: Instant) {
        const DELAYS: [u64; 5] = [5, 15, 30, 60, 120];
        self.stable_since = None;
        self.attempts = self.attempts.saturating_add(1);
        self.next = Some(now + Duration::from_secs(DELAYS[self.attempts.saturating_sub(1).min(4)]));
    }
    pub fn running(&mut self, now: Instant) {
        let start = *self.stable_since.get_or_insert(now);
        if now.saturating_duration_since(start) >= Duration::from_secs(120) {
            *self = Self::default();
        }
    }
    pub fn exited(&mut self) {
        self.stable_since = None;
    }
    pub fn block(&mut self, reason: &'static str) {
        self.blocked = Some(reason);
    }
    pub fn summary(&self, now: Instant, running: bool) -> Value {
        json!({"enabled":true,"state":if running{"running"}else if self.blocked.is_some() || self.attempts>=5{"blocked"}else{"retrying"},
            "attempts":self.attempts,"max_attempts":5,"reason":self.blocked,
            "retry_after_seconds":self.next.map(|t|t.saturating_duration_since(now).as_secs()).unwrap_or(0),
            "requires_manual_start":!running&&(self.blocked.is_some()||self.attempts>=5)})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_recovery_has_backoff_cap_and_stability_reset() {
        let now = Instant::now();
        let mut r = Recovery::default();
        assert!(r.due(now));
        r.attempt(now);
        assert!(!r.due(now + Duration::from_secs(4)));
        assert!(r.due(now + Duration::from_secs(5)));
        for i in 1..5 {
            r.attempt(now + Duration::from_secs(i * 200));
        }
        assert!(!r.due(now + Duration::from_secs(2000)));
        assert_eq!(r.summary(now, false)["state"], "blocked");
        r.running(now);
        r.running(now + Duration::from_secs(119));
        assert!(!r.due(now + Duration::from_secs(2000)));
        r.running(now + Duration::from_secs(120));
        assert!(r.due(now + Duration::from_secs(2000)));
        r.block("configuration_changed");
        assert!(!r.due(now + Duration::from_secs(9999)));
    }
}
