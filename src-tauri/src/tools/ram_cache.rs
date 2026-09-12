//! Disposable output payloads only: RAM, hard age expiry, oldest-first eviction.
//! This module has no process handles, permission grants, paths or file writes.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const TTL_SECONDS: u64 = 90 * 60;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub const STREAM_BYTES: usize = 1024 * 1024;
const MAX_SPANS: usize = 1024;
const TTL: Duration = Duration::from_secs(TTL_SECONDS);

struct Span {
    born: Instant,
    len: usize,
}
#[derive(Default)]
struct Stream {
    bytes: VecDeque<u8>,
    spans: VecDeque<Span>,
    total: usize,
}
impl Stream {
    fn discard(&mut self, count: usize) -> usize {
        let count = count.min(self.bytes.len());
        self.bytes.drain(..count);
        let mut remaining = count;
        while remaining > 0 {
            let span = self.spans.front_mut().expect("output span accounting");
            let take = span.len.min(remaining);
            span.len -= take;
            remaining -= take;
            if span.len == 0 {
                self.spans.pop_front();
            }
        }
        if self.bytes.is_empty() {
            // Release allocations, not merely logical length.
            self.bytes = VecDeque::new();
            self.spans = VecDeque::new();
        }
        count
    }
    fn expire(&mut self, now: Instant) -> usize {
        let mut discarded = 0;
        while let Some(span) = self.spans.front() {
            if now.saturating_duration_since(span.born) < TTL {
                break;
            }
            discarded += self.discard(span.len);
        }
        if discarded > 0 {
            self.bytes.shrink_to_fit();
            self.spans.shrink_to_fit();
        }
        discarded
    }
    fn append(&mut self, chunk: &[u8], now: Instant, limit: usize) {
        self.total = self.total.saturating_add(chunk.len());
        let chunk = &chunk[chunk.len().saturating_sub(limit)..];
        self.discard(
            self.bytes
                .len()
                .saturating_add(chunk.len())
                .saturating_sub(limit),
        );
        if chunk.is_empty() {
            return;
        }
        self.bytes.extend(chunk);
        // Bounded timestamp metadata. A coalesced span uses its oldest timestamp,
        // so recent activity never extends the lifetime of older cached bytes.
        if let Some(last) = self
            .spans
            .back_mut()
            .filter(|span| now.saturating_duration_since(span.born) < Duration::from_secs(1))
        {
            last.len += chunk.len();
        } else {
            self.spans.push_back(Span {
                born: now,
                len: chunk.len(),
            });
        }
        while self.spans.len() > MAX_SPANS {
            self.discard(self.spans.front().expect("span exists").len);
        }
    }
}

struct CacheState {
    streams: HashMap<String, Stream>,
    bytes: usize,
    budget: usize,
    stream_limit: usize,
    expired_bytes: u64,
    pressure_bytes: u64,
}
impl CacheState {
    fn new(budget: usize, stream_limit: usize) -> Self {
        Self {
            streams: HashMap::new(),
            bytes: 0,
            budget,
            stream_limit,
            expired_bytes: 0,
            pressure_bytes: 0,
        }
    }
    fn expire(&mut self, now: Instant) {
        for stream in self.streams.values_mut() {
            let discarded = stream.expire(now);
            self.bytes -= discarded;
            self.expired_bytes = self.expired_bytes.saturating_add(discarded as u64);
        }
    }
    fn append(&mut self, key: &str, chunk: &[u8], now: Instant) {
        let stream = self.streams.entry(key.to_owned()).or_default();
        let before = stream.bytes.len();
        let expired = stream.expire(now);
        self.expired_bytes = self.expired_bytes.saturating_add(expired as u64);
        stream.append(chunk, now, self.stream_limit.min(self.budget));
        self.bytes = self.bytes - before + stream.bytes.len();
        // Evict the oldest payload span, not the oldest command. A multi-day
        // command producing fresh data keeps that data and keeps its handle.
        while self.bytes > self.budget {
            let Some(oldest) = self
                .streams
                .iter()
                .filter_map(|(key, value)| value.spans.front().map(|span| (key, span.born)))
                .min_by(|(ak, at), (bk, bt)| at.cmp(bt).then_with(|| ak.cmp(bk)))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            let stream = self.streams.get_mut(&oldest).expect("oldest cached stream");
            let discarded = stream.discard(stream.spans.front().expect("cached span").len);
            stream.bytes.shrink_to_fit();
            stream.spans.shrink_to_fit();
            self.bytes -= discarded;
            self.pressure_bytes = self.pressure_bytes.saturating_add(discarded as u64);
        }
    }
    fn tail(&mut self, key: &str, limit: usize, now: Instant) -> (Vec<u8>, usize) {
        let Some(stream) = self.streams.get_mut(key) else {
            return (Vec::new(), 0);
        };
        let discarded = stream.expire(now);
        self.bytes -= discarded;
        self.expired_bytes = self.expired_bytes.saturating_add(discarded as u64);
        (
            stream
                .bytes
                .iter()
                .skip(stream.bytes.len().saturating_sub(limit))
                .copied()
                .collect(),
            stream.total,
        )
    }
    fn next_expiry(&self) -> Option<Instant> {
        self.streams
            .values()
            .filter_map(|stream| stream.spans.front())
            .map(|span| span.born + TTL)
            .min()
    }
}

pub struct OutputCache {
    state: Mutex<CacheState>,
    wake: Condvar,
}
impl OutputCache {
    pub fn append(&self, key: &str, chunk: &[u8]) {
        let mut state = self.state.lock().expect("RAM output cache lock");
        let was_empty = state.bytes == 0;
        state.append(key, chunk, Instant::now());
        drop(state);
        if was_empty {
            self.wake.notify_one();
        }
    }
    pub fn tail(&self, key: &str, limit: usize) -> (Vec<u8>, usize) {
        self.state.lock().expect("RAM output cache lock").tail(
            key,
            limit.min(STREAM_BYTES),
            Instant::now(),
        )
    }
    pub fn forget(&self, key: &str) {
        let mut state = self.state.lock().expect("RAM output cache lock");
        if let Some(stream) = state.streams.remove(key) {
            state.bytes -= stream.bytes.len();
        }
    }
    pub fn policy(&self) -> serde_json::Value {
        let mut state = self.state.lock().expect("RAM output cache lock");
        state.expire(Instant::now());
        serde_json::json!({"storage":"ram_only","disk_spill":false,
            "max_age_seconds":TTL_SECONDS,"max_payload_bytes":state.budget,
            "per_stream_payload_bytes":STREAM_BYTES,"retained_payload_bytes":state.bytes,
            "eviction":"oldest_payload_first","expiry_extends_on_read":false,
            "expired_bytes":state.expired_bytes,"pressure_evicted_bytes":state.pressure_bytes,
            "active_command_ownership_expires":false,"idle_expiry_worker":state.budget > 0})
    }
}
pub fn output_cache() -> Arc<OutputCache> {
    static CACHE: OnceLock<Arc<OutputCache>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let cache = Arc::new(OutputCache {
                state: Mutex::new(CacheState::new(MAX_BYTES, STREAM_BYTES)),
                wake: Condvar::new(),
            });
            let weak = Arc::downgrade(&cache);
            let started = std::thread::Builder::new()
                .name("mcp-ram-cache-expiry".into())
                .spawn(move || {
                    while let Some(cache) = weak.upgrade() {
                        let mut state = cache.state.lock().expect("RAM output cache lock");
                        state.expire(Instant::now());
                        let wait = state
                            .next_expiry()
                            .map(|at| at.saturating_duration_since(Instant::now()))
                            .unwrap_or(Duration::from_secs(30))
                            .min(Duration::from_secs(30))
                            .max(Duration::from_millis(1));
                        let _wait = cache
                            .wake
                            .wait_timeout(state, wait)
                            .expect("RAM cache expiry wait");
                    }
                });
            if started.is_err() {
                // Execution can continue without output caching; never silently keep
                // payloads forever when the expiry worker could not be created.
                cache.state.lock().expect("RAM output cache lock").budget = 0;
            }
            cache
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expiry_removes_old_bytes_not_new_bytes_or_absolute_cursors() {
        let t = Instant::now();
        let mut cache = CacheState::new(100, 100);
        cache.append("running", b"old", t);
        cache.append("running", b"new", t + Duration::from_secs(TTL_SECONDS - 10));
        cache.expire(t + TTL);
        assert_eq!(cache.tail("running", 100, t + TTL), (b"new".to_vec(), 6));
        assert_eq!(cache.bytes, 3);
        cache.expire(t + Duration::from_secs(14 * 24 * 60 * 60));
        assert_eq!(
            cache.tail("running", 100, t + Duration::from_secs(14 * 24 * 60 * 60)),
            (Vec::new(), 6)
        );
        assert_eq!(cache.bytes, 0);
        assert_eq!(cache.streams["running"].bytes.capacity(), 0);
        cache.append(
            "running",
            b"fresh",
            t + Duration::from_secs(14 * 24 * 60 * 60),
        );
        assert_eq!(
            cache.tail("running", 100, t + Duration::from_secs(14 * 24 * 60 * 60)),
            (b"fresh".to_vec(), 11)
        );
    }
    #[test]
    fn memory_pressure_discards_oldest_payload_and_retains_newest() {
        let t = Instant::now();
        let mut cache = CacheState::new(6, 100);
        cache.append("long-lived", b"old", t);
        cache.append("other", b"mid", t + Duration::from_secs(2));
        cache.append("long-lived", b"new", t + Duration::from_secs(4));
        assert_eq!(
            cache.tail("long-lived", 100, t + Duration::from_secs(4)),
            (b"new".to_vec(), 6)
        );
        assert_eq!(
            cache.tail("other", 100, t + Duration::from_secs(4)),
            (b"mid".to_vec(), 3)
        );
        assert_eq!(cache.bytes, 6);
        assert_eq!(cache.pressure_bytes, 3);
    }
}
