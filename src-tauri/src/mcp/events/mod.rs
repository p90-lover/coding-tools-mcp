//! OpenAI MCP Events (MCP 2026-07-28) for Coding Tools failure incidents.
//!
//! One hub per process holds every webhook subscription created through any workspace
//! MCP listener, persists them across restarts, and delivers incidents that the desktop
//! reports through the authenticated headless control API. Incidents that belong to a
//! workspace reach only subscriptions created through that workspace's listener.
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub mod catalog;
pub mod store;
pub mod webhook;

use store::{StoredSubscription, SubscriptionFile};
use webhook::{signed_headers, WebhookSecret};

pub const CALLBACK_ENDPOINT_ERROR: i64 = -32015;
const DEFAULT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS: u64 = 60 * 60 * 1000;
const MAX_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS_PER_PRINCIPAL: usize = 32;
const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_VERIFY_RESPONSE_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_INCIDENTS: usize = 64;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// RFC 3339 UTC timestamp with second precision, e.g. `2026-09-30T12:00:00Z`.
pub fn iso8601(ms: u64) -> String {
    let seconds = (ms / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn hex_digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical_arguments(arguments: &Map<String, Value>) -> String {
    let sorted: BTreeMap<&String, &Value> = arguments.iter().collect();
    serde_json::to_string(&sorted).unwrap_or_default()
}

/// Deterministic id from the authenticated principal, callback URL, event name and arguments.
pub fn subscription_id(
    principal: &str,
    url: &str,
    name: &str,
    arguments: &Map<String, Value>,
) -> String {
    let digest = hex_digest(&[principal, url, name, &canonical_arguments(arguments)]);
    format!("sub_{}", &digest[..32])
}

/// Stable per (subscription, incident): a retried or re-reported incident keeps its id,
/// so a receiver can deduplicate on `webhook-id`.
pub fn event_id(subscription_id: &str, incident_id: &str) -> String {
    format!("evt_{}", &hex_digest(&[subscription_id, incident_id])[..32])
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn rpc_error(code: i64, message: impl Into<String>) -> Value {
    json!({"code":code,"message":message.into()})
}

fn invalid_params(message: impl Into<String>) -> Value {
    rpc_error(-32602, message)
}

fn callback_error(reason: &str, message: impl Into<String>) -> Value {
    json!({"code":CALLBACK_ENDPOINT_ERROR,"message":message.into(),"data":{"reason":reason}})
}

#[derive(Clone, Debug)]
pub struct HubOptions {
    /// Accept `http://127.0.0.1` callbacks. Only local tests enable this.
    pub allow_insecure_loopback: bool,
    /// Ignore every proxy. Only local tests enable this.
    pub direct: bool,
    pub retry_base: Duration,
    pub max_attempts: u32,
}

impl Default for HubOptions {
    fn default() -> Self {
        Self {
            allow_insecure_loopback: false,
            direct: false,
            retry_base: Duration::from_secs(2),
            max_attempts: 6,
        }
    }
}

#[derive(Clone, Debug)]
pub struct EmittedEvent {
    pub name: String,
    /// Workspace the incident belongs to; `None` for app-wide incidents.
    pub workspace_id: Option<String>,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EmitOutcome {
    pub deduplicated: bool,
    pub deliveries: usize,
}

#[derive(Clone, Debug)]
struct IncidentRecord {
    name: String,
    workspace_id: Option<String>,
    data: Value,
    recorded_at_ms: u64,
    resolved_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default)]
struct DeliveryStatus {
    at_ms: u64,
    outcome: String,
}

#[derive(Default)]
struct HubState {
    subscriptions: Vec<StoredSubscription>,
    incidents: VecDeque<IncidentRecord>,
    deliveries: HashMap<String, DeliveryStatus>,
    proxy: Option<String>,
    client: Option<(Option<String>, reqwest::Client)>,
}

pub struct EventHub {
    file: SubscriptionFile,
    options: HubOptions,
    state: Mutex<HubState>,
}

static GLOBAL: OnceLock<Arc<EventHub>> = OnceLock::new();

/// Root the process-wide hub in a service's private data directory. The first call wins;
/// later calls (and listeners that already used `global`) keep the existing hub.
pub fn init_global(directory: PathBuf) -> Result<Arc<EventHub>, String> {
    let _ = GLOBAL_ROOT.set(directory);
    global()
}

static GLOBAL_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// The process-wide hub, rooted in the Coding Tools configuration directory unless a
/// host service chose its own directory with `init_global`. A store that fails to open
/// keeps failing here rather than silently splitting into a second directory.
pub fn global() -> Result<Arc<EventHub>, String> {
    if let Some(hub) = GLOBAL.get() {
        return Ok(hub.clone());
    }
    // Unit tests never touch the user's real subscription store.
    let directory = if let Some(root) = GLOBAL_ROOT.get() {
        root.clone()
    } else if cfg!(test) {
        std::env::temp_dir().join(format!(
            "coding-tools-mcp-events-test-{}",
            std::process::id()
        ))
    } else {
        crate::platform::platform()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("mcp-events")
    };
    let hub = Arc::new(EventHub::open(directory, HubOptions::default())?);
    Ok(GLOBAL.get_or_init(|| hub).clone())
}

impl EventHub {
    pub fn open(directory: PathBuf, options: HubOptions) -> Result<Self, String> {
        let file = SubscriptionFile::new(&directory);
        let now = now_ms();
        let subscriptions: Vec<_> = file
            .load()?
            .into_iter()
            .filter(|subscription| subscription.expires_at_ms > now)
            .collect();
        Ok(Self {
            file,
            options,
            state: Mutex::new(HubState {
                subscriptions,
                ..HubState::default()
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, state: &HubState) -> Result<(), String> {
        self.file.save(&state.subscriptions)
    }

    fn prune_expired(&self, state: &mut HubState) {
        let now = now_ms();
        let before = state.subscriptions.len();
        state
            .subscriptions
            .retain(|subscription| subscription.expires_at_ms > now);
        if state.subscriptions.len() != before {
            let _ = self.persist(state);
        }
    }

    /// Route webhook traffic through this proxy (the desktop's global route). `None`
    /// falls back to the process environment (HTTP(S)_PROXY) and system settings.
    pub fn set_proxy(&self, proxy: Option<String>) -> Result<(), String> {
        let proxy = proxy
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(value) = proxy.as_deref() {
            let parsed = url::Url::parse(value).map_err(|_| "proxy must be a URL".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
                return Err("proxy must be an http:// or https:// URL".into());
            }
        }
        let mut state = self.lock();
        if state.proxy != proxy {
            state.proxy = proxy;
            state.client = None;
        }
        Ok(())
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        let mut state = self.lock();
        if let Some((proxy, client)) = state.client.as_ref() {
            if *proxy == state.proxy {
                return Ok(client.clone());
            }
        }
        let mut builder = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!(
                "coding-tools-mcp-events/",
                env!("CARGO_PKG_VERSION")
            ));
        if self.options.direct {
            builder = builder.no_proxy();
        } else if let Some(proxy) = state.proxy.as_deref() {
            builder = builder
                .proxy(reqwest::Proxy::all(proxy).map_err(|_| "proxy is invalid".to_string())?);
        }
        let client = builder.build().map_err(|error| error.to_string())?;
        state.client = Some((state.proxy.clone(), client.clone()));
        Ok(client)
    }

    fn validate_callback_url(&self, raw: &str) -> Result<String, Value> {
        let url = url::Url::parse(raw)
            .map_err(|_| invalid_params("delivery.url must be an absolute URL"))?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(invalid_params(
                "delivery.url must not carry credentials or a fragment",
            ));
        }
        let loopback = matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("[::1]")
        );
        let allowed = match url.scheme() {
            "https" => url.host_str().is_some(),
            "http" => self.options.allow_insecure_loopback && loopback,
            _ => false,
        };
        if !allowed {
            return Err(invalid_params("delivery.url must be an https:// URL"));
        }
        Ok(url.to_string())
    }

    /// `events/list`
    pub fn list(&self) -> Value {
        json!({"events": catalog::definitions()})
    }

    /// `events/subscribe`: create or refresh, verifying the callback when it is new
    /// or its secret changed.
    pub async fn subscribe(&self, principal: &str, params: &Value) -> Result<Value, Value> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("name is required"))?;
        let arguments =
            catalog::validate_arguments(name, params.get("arguments").unwrap_or(&Value::Null))
                .map_err(invalid_params)?;
        let delivery = params
            .get("delivery")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid_params("delivery is required"))?;
        if delivery.get("mode").and_then(Value::as_str) != Some("webhook") {
            return Err(invalid_params("delivery.mode must be webhook"));
        }
        let url =
            self.validate_callback_url(delivery.get("url").and_then(Value::as_str).unwrap_or(""))?;
        let secret_text = delivery
            .get("secret")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("delivery.secret is required"))?;
        let secret = WebhookSecret::parse(secret_text).map_err(invalid_params)?;
        let ttl_ms = match params.get("ttlMs") {
            None => DEFAULT_TTL_MS,
            // No-expiry is not granted; the longest lifetime is returned instead.
            Some(Value::Null) => MAX_TTL_MS,
            Some(value) => value
                .as_u64()
                .ok_or_else(|| invalid_params("ttlMs must be a positive integer or null"))?
                .clamp(MIN_TTL_MS, MAX_TTL_MS),
        };
        let id = subscription_id(principal, &url, name, &arguments);
        let now = now_ms();
        let needs_verification = {
            let mut state = self.lock();
            self.prune_expired(&mut state);
            let existing = state.subscriptions.iter().find(|entry| entry.id == id);
            if existing.is_none()
                && state
                    .subscriptions
                    .iter()
                    .filter(|entry| entry.principal == principal)
                    .count()
                    >= MAX_SUBSCRIPTIONS_PER_PRINCIPAL
            {
                return Err(invalid_params(
                    "Subscription limit reached for this connector",
                ));
            }
            existing.is_none_or(|entry| {
                WebhookSecret::parse(&entry.secret)
                    .map(|saved| saved.fingerprint() != secret.fingerprint())
                    .unwrap_or(true)
            })
        };
        if needs_verification {
            self.verify_callback(&id, &url, &secret).await?;
        }
        let expires_at_ms = now + ttl_ms;
        let mut state = self.lock();
        let verified_at_ms = if needs_verification {
            now
        } else {
            state
                .subscriptions
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.verified_at_ms)
                .unwrap_or(now)
        };
        let created_at_ms = state
            .subscriptions
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.created_at_ms)
            .unwrap_or(now);
        state.subscriptions.retain(|entry| entry.id != id);
        state.subscriptions.push(StoredSubscription {
            id: id.clone(),
            principal: principal.to_string(),
            name: name.to_string(),
            arguments,
            url,
            secret: secret_text.to_string(),
            created_at_ms,
            refreshed_at_ms: now,
            expires_at_ms,
            verified_at_ms,
        });
        self.persist(&state)
            .map_err(|error| rpc_error(-32603, error))?;
        Ok(json!({
            "id": id,
            "refreshBefore": iso8601(expires_at_ms),
            "cursor": null,
            "truncated": false
        }))
    }

    /// `events/unsubscribe`: idempotent; identifies the subscription by name, arguments
    /// and callback URL exactly as `events/subscribe` did.
    pub fn unsubscribe(&self, principal: &str, params: &Value) -> Result<Value, Value> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("name is required"))?;
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(map)) => map.clone(),
            Some(_) => return Err(invalid_params("arguments must be an object")),
        };
        let raw_url = params
            .pointer("/delivery/url")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("delivery.url is required"))?;
        // Normalize exactly like subscribe; an unparsable URL can never match anything.
        let Ok(url) = url::Url::parse(raw_url).map(|url| url.to_string()) else {
            return Ok(json!({}));
        };
        let id = subscription_id(principal, &url, name, &arguments);
        let mut state = self.lock();
        let before = state.subscriptions.len();
        state
            .subscriptions
            .retain(|entry| !(entry.id == id && entry.principal == principal));
        if state.subscriptions.len() != before {
            state.deliveries.remove(&id);
            self.persist(&state)
                .map_err(|error| rpc_error(-32603, error))?;
        }
        Ok(json!({}))
    }

    async fn verify_callback(
        &self,
        id: &str,
        url: &str,
        secret: &WebhookSecret,
    ) -> Result<(), Value> {
        let challenge = format!(
            "chl_{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let body = json!({"type":"verification","challenge":challenge}).to_string();
        let message_id = format!("vrf_{}", uuid::Uuid::new_v4().simple());
        let client = self
            .client()
            .map_err(|error| callback_error("client_unavailable", error))?;
        let mut request = client.post(url).body(body.clone());
        for (name, value) in
            signed_headers(secret, &message_id, id, (now_ms() / 1000) as i64, &body)
        {
            request = request.header(name, value);
        }
        let mut response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                callback_error("timeout", "Callback verification timed out")
            } else {
                callback_error("unreachable", "Callback endpoint could not be reached")
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(callback_error(
                "http_status",
                format!("Callback verification returned HTTP {}", status.as_u16()),
            ));
        }
        let mut received = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    received.extend_from_slice(&chunk);
                    if received.len() > MAX_VERIFY_RESPONSE_BYTES {
                        return Err(callback_error(
                            "invalid_response",
                            "Callback verification response is too large",
                        ));
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    return Err(callback_error(
                        "invalid_response",
                        "Callback verification response was interrupted",
                    ))
                }
            }
        }
        let echoed = serde_json::from_slice::<Value>(&received)
            .ok()
            .and_then(|value| {
                value
                    .get("challenge")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .ok_or_else(|| {
                callback_error(
                    "invalid_response",
                    "Callback did not echo the verification challenge",
                )
            })?;
        if !constant_time_eq(echoed.as_bytes(), challenge.as_bytes()) {
            return Err(callback_error(
                "challenge_mismatch",
                "Callback echoed a different challenge",
            ));
        }
        Ok(())
    }

    /// Record an incident and deliver it to every matching subscription. Re-reporting an
    /// incident id that is already recorded is a no-op, so detectors may retry freely.
    pub fn emit(self: &Arc<Self>, event: EmittedEvent) -> Result<EmitOutcome, String> {
        let data = catalog::sanitize_payload(&event.name, &event.data)?;
        let incident_id = data["incident_id"].as_str().unwrap_or_default().to_string();
        let targets = {
            let mut state = self.lock();
            if state.incidents.iter().any(|record| {
                record.name == event.name && record.data["incident_id"] == incident_id
            }) {
                return Ok(EmitOutcome {
                    deduplicated: true,
                    deliveries: 0,
                });
            }
            self.prune_expired(&mut state);
            state.incidents.push_back(IncidentRecord {
                name: event.name.clone(),
                workspace_id: event.workspace_id.clone(),
                data: data.clone(),
                recorded_at_ms: now_ms(),
                resolved_at_ms: None,
            });
            while state.incidents.len() > MAX_INCIDENTS {
                state.incidents.pop_front();
            }
            state
                .subscriptions
                .iter()
                .filter(|entry| entry.name == event.name)
                .filter(|entry| {
                    event
                        .workspace_id
                        .as_deref()
                        .is_none_or(|workspace| workspace == entry.principal)
                })
                .filter(|entry| catalog::matches_filters(&entry.arguments, &data))
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut deliveries = 0;
        for subscription in targets {
            let body = json!({
                "eventId": event_id(&subscription.id, &incident_id),
                "name": event.name,
                "timestamp": iso8601(now_ms()),
                "data": data,
                "cursor": null
            })
            .to_string();
            if body.len() > MAX_BODY_BYTES {
                continue;
            }
            deliveries += 1;
            let hub = Arc::clone(self);
            let event_id = event_id(&subscription.id, &incident_id);
            spawn(async move { hub.deliver(subscription, event_id, body).await });
        }
        Ok(EmitOutcome {
            deduplicated: false,
            deliveries,
        })
    }

    /// Mark an incident recovered so the read tool and status report it as resolved.
    pub fn resolve(&self, name: &str, incident_id: &str) -> bool {
        let mut state = self.lock();
        let mut found = false;
        for record in state.incidents.iter_mut() {
            if record.name == name
                && record.data["incident_id"] == incident_id
                && record.resolved_at_ms.is_none()
            {
                record.resolved_at_ms = Some(now_ms());
                found = true;
            }
        }
        found
    }

    fn record_delivery(&self, id: &str, outcome: &str) {
        self.lock().deliveries.insert(
            id.to_string(),
            DeliveryStatus {
                at_ms: now_ms(),
                outcome: outcome.to_string(),
            },
        );
    }

    fn current_subscription(&self, subscription: &StoredSubscription) -> bool {
        self.lock().subscriptions.iter().any(|entry| {
            entry.id == subscription.id
                && entry.secret == subscription.secret
                && entry.expires_at_ms > now_ms()
        })
    }

    async fn deliver(
        self: Arc<Self>,
        subscription: StoredSubscription,
        event_id: String,
        body: String,
    ) {
        let Ok(secret) = WebhookSecret::parse(&subscription.secret) else {
            self.record_delivery(&subscription.id, "invalid_secret");
            return;
        };
        for attempt in 0..self.options.max_attempts.max(1) {
            if attempt > 0 {
                let factor = 1u32 << (attempt - 1).min(8);
                tokio::time::sleep(
                    (self.options.retry_base * factor).min(Duration::from_secs(300)),
                )
                .await;
            }
            // Stop when the subscription was removed, re-keyed or expired meanwhile.
            if !self.current_subscription(&subscription) {
                return;
            }
            let client = match self.client() {
                Ok(client) => client,
                Err(_) => {
                    self.record_delivery(&subscription.id, "client_unavailable");
                    continue;
                }
            };
            let mut request = client.post(&subscription.url).body(body.clone());
            // Fresh timestamp and signature per attempt; the event id never changes.
            for (name, value) in signed_headers(
                &secret,
                &event_id,
                &subscription.id,
                (now_ms() / 1000) as i64,
                &body,
            ) {
                request = request.header(name, value);
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    self.record_delivery(&subscription.id, "delivered");
                    return;
                }
                Ok(response) if response.status().as_u16() == 410 => {
                    // The receiver no longer wants this subscription.
                    let mut state = self.lock();
                    state
                        .subscriptions
                        .retain(|entry| entry.id != subscription.id);
                    state.deliveries.remove(&subscription.id);
                    let _ = self.persist(&state);
                    return;
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    self.record_delivery(&subscription.id, &format!("http_{status}"));
                    let transient = status == 408 || status == 429 || status >= 500;
                    if !transient {
                        return;
                    }
                }
                Err(error) => {
                    self.record_delivery(
                        &subscription.id,
                        if error.is_timeout() {
                            "timeout"
                        } else {
                            "unreachable"
                        },
                    );
                }
            }
        }
    }

    /// Secret-free view for the desktop status endpoint.
    pub fn status(&self) -> Value {
        let state = self.lock();
        let subscriptions: Vec<Value> = state
            .subscriptions
            .iter()
            .map(|entry| {
                let delivery = state.deliveries.get(&entry.id);
                json!({
                    "id": entry.id,
                    "name": entry.name,
                    "workspace_id": entry.principal,
                    "arguments": entry.arguments,
                    "callback_host": url::Url::parse(&entry.url).ok().and_then(|url| url.host_str().map(str::to_string)),
                    "refresh_before": iso8601(entry.expires_at_ms),
                    "last_delivery": delivery.map(|status| json!({"at": iso8601(status.at_ms), "outcome": status.outcome})),
                })
            })
            .collect();
        json!({
            "subscriptions": subscriptions,
            "proxy_configured": state.proxy.is_some(),
            "open_incidents": state.incidents.iter().filter(|record| record.resolved_at_ms.is_none()).count(),
        })
    }

    /// Recent incidents visible to one workspace listener, newest first.
    pub fn recent_incidents(
        &self,
        principal: Option<&str>,
        include_resolved: bool,
        limit: usize,
    ) -> Vec<Value> {
        let state = self.lock();
        state
            .incidents
            .iter()
            .rev()
            .filter(|record| {
                record
                    .workspace_id
                    .as_deref()
                    .is_none_or(|workspace| principal == Some(workspace))
            })
            .filter(|record| include_resolved || record.resolved_at_ms.is_none())
            .take(limit)
            .map(|record| {
                json!({
                    "event": record.name,
                    "recorded_at": iso8601(record.recorded_at_ms),
                    "resolved_at": record.resolved_at_ms.map(iso8601),
                    "data": record.data,
                })
            })
            .collect()
    }

    /// JSON-RPC dispatch for `events/*`.
    pub async fn dispatch(
        &self,
        principal: &str,
        method: &str,
        params: &Value,
    ) -> Result<Value, Value> {
        match method {
            "events/list" => Ok(self.list()),
            "events/subscribe" => self.subscribe(principal, params).await,
            "events/unsubscribe" => self.unsubscribe(principal, params),
            _ => Err(rpc_error(-32601, format!("Method not found: {method}"))),
        }
    }
}

fn spawn<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(future);
        }
        Err(_) => {
            tauri::async_runtime::spawn(future);
        }
    }
}

#[cfg(test)]
mod tests;
