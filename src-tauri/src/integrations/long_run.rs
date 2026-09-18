//! Multi-day keep-alive for the five managed stacks.
//! Mirrors Electron `five-stack-long-run.cjs`, tunnel Recovery backoff, and
//! turn-suspension sleep/wake handling. Persist file never stores secrets.
use super::five_stack::{data_root, ToolId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const TARGET_UPTIME_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const HEARTBEAT_MS: u64 = 30_000;
pub const BACKOFF_SECONDS: [u64; 6] = [5, 15, 30, 60, 120, 300];
pub const MAX_ATTEMPTS: usize = 8;
pub const STABLE_RESET_MS: u64 = 120_000;
pub const PERSIST_IDLE_MS: u64 = 5 * 60 * 1000;
const MAX_PERSIST_BYTES: usize = 64 * 1024;

static HEALTH_LOOP_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Desired {
    Running,
    #[default]
    Stopped,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRun {
    pub desired: Desired,
    pub selected_section: String,
    pub last_healthy_at: u64,
    pub last_heartbeat_at: u64,
    pub reconnect_attempts: usize,
    pub next_retry_at: u64,
    #[serde(default)]
    pub blocked_reason: Option<String>,
    pub stable_since: u64,
}

impl ComponentRun {
    fn new(id: ToolId) -> Self {
        Self {
            desired: Desired::Stopped,
            selected_section: default_section(id).into(),
            last_healthy_at: 0,
            last_heartbeat_at: 0,
            reconnect_attempts: 0,
            next_retry_at: 0,
            blocked_reason: None,
            stable_since: 0,
        }
    }

    pub fn due(&self, now_ms: u64) -> bool {
        self.blocked_reason.is_none()
            && self.reconnect_attempts < MAX_ATTEMPTS
            && (self.next_retry_at == 0 || now_ms >= self.next_retry_at)
    }

    pub fn note_attempt(&mut self, now_ms: u64) {
        self.stable_since = 0;
        self.reconnect_attempts = self.reconnect_attempts.saturating_add(1).min(MAX_ATTEMPTS);
        let index = self
            .reconnect_attempts
            .saturating_sub(1)
            .min(BACKOFF_SECONDS.len() - 1);
        self.next_retry_at = now_ms + BACKOFF_SECONDS[index] * 1000;
        if self.reconnect_attempts >= MAX_ATTEMPTS {
            self.blocked_reason = Some("reconnect_budget_exhausted".into());
        }
    }

    pub fn note_healthy(&mut self, now_ms: u64) -> bool {
        self.last_healthy_at = now_ms;
        self.last_heartbeat_at = now_ms;
        if self.stable_since == 0 {
            self.stable_since = now_ms;
        }
        if now_ms.saturating_sub(self.stable_since) >= STABLE_RESET_MS
            && self.reconnect_attempts > 0
        {
            self.reconnect_attempts = 0;
            self.next_retry_at = 0;
            self.blocked_reason = None;
            self.stable_since = now_ms;
            return true;
        }
        false
    }

    pub fn rebaseline(&mut self, now_ms: u64) {
        self.last_heartbeat_at = now_ms;
        if self.last_healthy_at > 0 {
            self.last_healthy_at = now_ms;
        }
    }

    pub fn ui_status(&self, live_status: &str) -> &'static str {
        if self.desired != Desired::Running {
            return if live_status == "ready" {
                "ready"
            } else {
                "stopped"
            };
        }
        if live_status == "ready" {
            return "ready";
        }
        if self.blocked_reason.is_some() || self.reconnect_attempts >= MAX_ATTEMPTS {
            return "blocked";
        }
        if self.reconnect_attempts > 0 {
            return "reconnecting";
        }
        "starting"
    }

    pub fn summary(&self, now_ms: u64, live_status: &str) -> Value {
        let retry_after_seconds = if self.next_retry_at > now_ms {
            (self.next_retry_at - now_ms).div_ceil(1000)
        } else {
            0
        };
        json!({
            "desired": match self.desired {
                Desired::Running => "running",
                Desired::Stopped => "stopped",
            },
            "selected_section": self.selected_section,
            "uiStatus": self.ui_status(live_status),
            "ui_status": self.ui_status(live_status),
            "reconnect_attempts": self.reconnect_attempts,
            "max_attempts": MAX_ATTEMPTS,
            "retry_after_seconds": retry_after_seconds,
            "last_healthy_at": if self.last_healthy_at == 0 { Value::Null } else { json!(self.last_healthy_at) },
            "blocked_reason": self.blocked_reason,
            "target_uptime_ms": TARGET_UPTIME_MS,
            "heartbeat_ms": HEARTBEAT_MS,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistFile {
    version: u32,
    target_uptime_ms: u64,
    heartbeat_ms: u64,
    updated_at: u64,
    last_sweep_at: u64,
    components: HashMap<String, ComponentRun>,
}

struct Store {
    components: HashMap<ToolId, ComponentRun>,
    last_sweep_at: u64,
    last_persist_at: u64,
    dirty: bool,
    suspended: bool,
}

impl Store {
    fn new() -> Self {
        let mut components = HashMap::new();
        for id in ToolId::all() {
            components.insert(id, ComponentRun::new(id));
        }
        Self {
            components,
            last_sweep_at: 0,
            last_persist_at: 0,
            dirty: false,
            suspended: false,
        }
    }
}

fn default_section(id: ToolId) -> &'static str {
    match id {
        ToolId::Cpa | ToolId::CodexRouter => "dashboard",
        ToolId::CommandCodeProxy => "banner",
        ToolId::Paseo => "agents",
        ToolId::Anneal => "tasks",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn persist_path() -> PathBuf {
    data_root().join("long-run.json")
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut store = Store::new();
        load_into(&mut store);
        Mutex::new(store)
    })
}

fn lock_store() -> std::sync::MutexGuard<'static, Store> {
    store().lock().unwrap_or_else(|poison| poison.into_inner())
}

fn load_into(store: &mut Store) {
    let Ok(raw) = fs::read_to_string(persist_path()) else {
        return;
    };
    if raw.len() > MAX_PERSIST_BYTES {
        return;
    }
    let Ok(parsed) = serde_json::from_str::<PersistFile>(&raw) else {
        return;
    };
    if parsed.version != 1 {
        return;
    }
    store.last_sweep_at = parsed.last_sweep_at;
    for id in ToolId::all() {
        if let Some(incoming) = parsed.components.get(id.as_str()) {
            store.components.insert(id, incoming.clone());
        }
    }
}

fn persist(store: &mut Store, now: u64, force: bool) {
    if !force && !store.dirty && now.saturating_sub(store.last_persist_at) < PERSIST_IDLE_MS {
        return;
    }
    let mut components = HashMap::new();
    for id in ToolId::all() {
        if let Some(component) = store.components.get(&id) {
            components.insert(id.as_str().to_string(), component.clone());
        }
    }
    let payload = PersistFile {
        version: 1,
        target_uptime_ms: TARGET_UPTIME_MS,
        heartbeat_ms: HEARTBEAT_MS,
        updated_at: now,
        last_sweep_at: store.last_sweep_at,
        components,
    };
    let Ok(raw) = serde_json::to_string_pretty(&payload) else {
        return;
    };
    if raw.len() > MAX_PERSIST_BYTES {
        return;
    }
    if let Some(parent) = persist_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::write(persist_path(), raw).is_ok() {
        store.dirty = false;
        store.last_persist_at = now;
    }
}

pub fn set_desired(id: ToolId, desired: Desired) {
    let now = now_ms();
    let mut store = lock_store();
    if let Some(component) = store.components.get_mut(&id) {
        component.desired = desired;
        component.blocked_reason = None;
        component.reconnect_attempts = 0;
        component.next_retry_at = 0;
        component.stable_since = 0;
        store.dirty = true;
        persist(&mut store, now, true);
    }
}

pub fn set_selected_section(id: ToolId, section: &str) {
    let now = now_ms();
    let mut store = lock_store();
    if let Some(component) = store.components.get_mut(&id) {
        let next = section.trim();
        if next.is_empty() || next == component.selected_section {
            return;
        }
        component.selected_section = next.chars().take(64).collect();
        store.dirty = true;
        persist(&mut store, now, true);
    }
}

pub fn note_healthy(id: ToolId) {
    let now = now_ms();
    let mut store = lock_store();
    let reset = store
        .components
        .get_mut(&id)
        .map(|component| component.note_healthy(now))
        .unwrap_or(false);
    if reset || now.saturating_sub(store.last_persist_at) >= PERSIST_IDLE_MS {
        store.dirty = true;
    }
    persist(&mut store, now, false);
}

pub fn desired(id: ToolId) -> Desired {
    lock_store()
        .components
        .get(&id)
        .map(|component| component.desired)
        .unwrap_or(Desired::Stopped)
}

pub fn selected_section(id: ToolId) -> String {
    lock_store()
        .components
        .get(&id)
        .map(|component| component.selected_section.clone())
        .unwrap_or_else(|| default_section(id).into())
}

pub fn should_auto_start(id: ToolId) -> bool {
    desired(id) != Desired::Stopped
}

pub fn mark_suspended() {
    lock_store().suspended = true;
}

pub fn summary(id: ToolId, live_status: &str) -> Value {
    let now = now_ms();
    lock_store()
        .components
        .get(&id)
        .map(|component| component.summary(now, live_status))
        .unwrap_or_else(|| ComponentRun::new(id).summary(now, live_status))
}

fn has_pending_backoff(store: &Store, now: u64) -> bool {
    store.components.values().any(|component| {
        component.desired == Desired::Running
            && component.next_retry_at > store.last_sweep_at
            && (now < component.next_retry_at
                || now.saturating_sub(component.next_retry_at) < HEARTBEAT_MS * 6)
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TickAction {
    Reconnect(ToolId),
    Suspend(ToolId),
    Block(ToolId),
}

#[derive(Clone, Debug)]
pub struct LiveView {
    pub status: String,
    pub install_state: String,
}

pub fn plan_tick(live: &HashMap<ToolId, LiveView>) -> Vec<TickAction> {
    let now = now_ms();
    let mut store = lock_store();
    let slept = store.suspended
        || (store.last_sweep_at > 0
            && now.saturating_sub(store.last_sweep_at) >= HEARTBEAT_MS * 6
            && !has_pending_backoff(&store, now));
    store.suspended = false;
    store.last_sweep_at = now;
    let mut actions = Vec::new();
    if slept {
        for component in store.components.values_mut() {
            if component.desired == Desired::Running {
                component.rebaseline(now);
            }
        }
        store.dirty = true;
        persist(&mut store, now, false);
        for id in ToolId::all() {
            if store
                .components
                .get(&id)
                .is_some_and(|component| component.desired == Desired::Running)
            {
                actions.push(TickAction::Suspend(id));
            }
        }
        return actions;
    }
    for id in ToolId::all() {
        let view = live.get(&id);
        let live_status = view.map(|value| value.status.as_str()).unwrap_or("offline");
        if view.is_some_and(|value| value.install_state == "not-installed") {
            continue;
        }
        let Some(component) = store.components.get_mut(&id) else {
            continue;
        };
        if component.desired != Desired::Running {
            continue;
        }
        if live_status == "ready" {
            if component.note_healthy(now) {
                store.dirty = true;
            }
            continue;
        }
        if live_status == "starting" {
            continue;
        }
        if !component.due(now) {
            if component.blocked_reason.is_some() || component.reconnect_attempts >= MAX_ATTEMPTS {
                actions.push(TickAction::Block(id));
            }
            continue;
        }
        component.note_attempt(now);
        store.dirty = true;
        actions.push(TickAction::Reconnect(id));
    }
    persist(&mut store, now, false);
    actions
}

/// Background heartbeat: reconnect desired-running stacks after crash/blip/wake.
pub fn ensure_five_stack_health_loop() {
    if HEALTH_LOOP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        loop {
            let mut live = HashMap::new();
            for id in ToolId::all() {
                let snapshot = super::five_stack::inspect_live(id).await;
                live.insert(
                    id,
                    LiveView {
                        status: snapshot.status.clone(),
                        install_state: snapshot.install_state.clone(),
                    },
                );
            }
            let actions = plan_tick(&live);
            for action in actions {
                if let TickAction::Reconnect(id) = action {
                    let _ = super::five_stack::start_supervised(id).await;
                }
            }
            tokio::time::sleep(Duration::from_millis(HEARTBEAT_MS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> ComponentRun {
        ComponentRun::new(ToolId::Cpa)
    }

    #[test]
    fn backoff_caps_at_eight_attempts_and_resets_after_stable_health() {
        let mut run = fresh();
        run.desired = Desired::Running;
        let mut now = 1_000u64;
        assert!(run.due(now));
        run.note_attempt(now);
        assert!(!run.due(now + 4_000));
        assert!(run.due(now + 5_000));
        for _ in 1..MAX_ATTEMPTS {
            now += 400_000;
            run.note_attempt(now);
        }
        assert!(!run.due(now + 1_000_000));
        assert_eq!(run.ui_status("offline"), "blocked");
        now += 1_000;
        run.note_healthy(now);
        run.note_healthy(now + STABLE_RESET_MS - 1);
        assert_eq!(run.ui_status("offline"), "blocked");
        run.note_healthy(now + STABLE_RESET_MS);
        assert_eq!(run.reconnect_attempts, 0);
        assert!(run.due(now + STABLE_RESET_MS + 1));
    }

    #[test]
    fn seven_day_healthy_window_never_blocks() {
        let mut run = fresh();
        run.desired = Desired::Running;
        let mut now = 1_000u64;
        let ticks = TARGET_UPTIME_MS / HEARTBEAT_MS;
        for _ in 0..ticks {
            now += HEARTBEAT_MS;
            run.note_healthy(now);
            assert_eq!(run.ui_status("ready"), "ready");
            assert_eq!(run.reconnect_attempts, 0);
        }
        assert!(now >= TARGET_UPTIME_MS);
    }

    #[test]
    fn sleep_gap_is_six_heartbeats() {
        const {
            assert!(HEARTBEAT_MS * 6 >= 90_000);
        }
        let mut run = fresh();
        run.desired = Desired::Running;
        run.note_healthy(1_000);
        run.rebaseline(1_000 + 8 * 60 * 60 * 1000);
        assert_eq!(run.reconnect_attempts, 0);
        assert_eq!(run.blocked_reason, None);
        assert_eq!(run.ui_status("offline"), "starting");
    }

    #[test]
    fn persist_shape_has_no_secret_fields() {
        let payload = serde_json::to_string(&PersistFile {
            version: 1,
            target_uptime_ms: TARGET_UPTIME_MS,
            heartbeat_ms: HEARTBEAT_MS,
            updated_at: 1,
            last_sweep_at: 1,
            components: HashMap::new(),
        })
        .unwrap();
        assert!(!payload.contains("key"));
        assert!(!payload.contains("secret"));
        assert!(!payload.contains("token"));
        assert!(payload.contains("targetUptimeMs") || payload.contains("target_uptime_ms"));
    }
}
