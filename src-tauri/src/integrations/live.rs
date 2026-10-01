//! Keep-alive supervisor: reconnect with backoff, persist leases, expose live status.
use super::{actions, endpoint, lease, read, Snapshot, Source};
use crate::data::DataStore;
use crate::error::{AppError, AppResult};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
};

#[derive(Clone, Serialize, Debug, Default)]
pub struct LiveStatus {
    pub source: String,
    pub endpoint: String,
    pub web_ui: String,
    pub status: String,
    pub keep_alive: bool,
    pub stale: bool,
    pub last_ok_at: Option<u64>,
    pub last_error: Option<String>,
    pub reconnect_attempts: u32,
    pub web_ui_reachable: bool,
    pub snapshot: Option<Snapshot>,
    pub banner: Option<serde_json::Value>,
    pub health: Option<String>,
    pub model_count: Option<usize>,
    pub owned_process: bool,
    pub credential_needed: bool,
}

#[derive(Default)]
struct Slot {
    lease: lease::IntegrationLease,
    credential: String,
    snapshot: Option<Snapshot>,
    web_ui_reachable: bool,
    generation: u64,
    health: Option<String>,
    model_count: Option<usize>,
    next_poll: Option<std::time::Instant>,
    stable_since: Option<std::time::Instant>,
    last_persist: Option<std::time::Instant>,
    credential_needed: bool,
}

#[derive(Default)]
struct Hub {
    paseo: Slot,
    anneal: Slot,
    legacy_commandcode: Slot,
}

impl Hub {
    fn slot(&mut self, key: &str) -> &mut Slot {
        match key {
            "paseo" => &mut self.paseo,
            "anneal" => &mut self.anneal,
            _ => &mut self.legacy_commandcode,
        }
    }
}

static HUB: LazyLock<Mutex<Hub>> = LazyLock::new(|| Mutex::new(Hub::default()));
static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn start() {
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(restore_leases());
}

async fn restore_leases() {
    let Ok(stored) = DataStore::read_file(|d| Ok(d.integration_leases.clone())) else {
        return;
    };
    let mut hub = HUB.lock().await;
    hub.legacy_commandcode.lease = stored.commandcode;
    retire_lease(&mut hub.legacy_commandcode.lease, "CommandCode Proxy");
    hub.legacy_commandcode.credential.clear();
    for (key, lease) in [("paseo", stored.paseo), ("anneal", stored.anneal)] {
        let slot = hub.slot(key);
        slot.lease = lease;
        retire_lease(
            &mut slot.lease,
            if key == "paseo" { "Paseo" } else { "Anneal" },
        );
        slot.generation += 1;
        slot.credential.clear();
        slot.credential_needed = false;
        slot.next_poll = None;
    }
    drop(hub);
    persist().await;
}

// Only the restore test still exercises the retired Paseo lease path.
#[cfg(test)]
fn retire_paseo_lease(lease: &mut lease::IntegrationLease) {
    retire_lease(lease, "Paseo");
}

fn retire_lease(lease: &mut lease::IntegrationLease, name: &str) {
    lease.keep_alive = false;
    lease.status = lease::LivePhase::Error.as_str().into();
    lease.last_error = Some(format!("{name} integration is retired"));
}

async fn persist() {
    let snapshot = {
        let hub = HUB.lock().await;
        lease::IntegrationLeases {
            paseo: hub.paseo.lease.clone(),
            anneal: hub.anneal.lease.clone(),
            commandcode: hub.legacy_commandcode.lease.clone(),
        }
    };
    let _ = DataStore::update_file(|data| {
        data.integration_leases = snapshot;
        Ok(())
    });
}

pub async fn connect(
    source: &str,
    endpoint_raw: &str,
    web_ui: &str,
    credential: &str,
    keep_alive: bool,
    remember: bool,
) -> AppResult<LiveStatus> {
    if source == "paseo" {
        return Err(AppError::Message("Paseo integration is retired".into()));
    }
    if source == "anneal" {
        return Err(AppError::Message("Anneal integration is retired".into()));
    }
    if source == "commandcode" {
        return Err(AppError::Message(
            "CommandCode Proxy integration is retired".into(),
        ));
    }
    match source {
        "anneal" => {
            endpoint(Source::Anneal, endpoint_raw)?;
        }
        _ => return Err(AppError::Message("Unknown integration source".into())),
    }
    let web = if web_ui.trim().is_empty() {
        default_web_ui(source).to_string()
    } else {
        lease::parse_web_ui(web_ui)?.to_string()
    };
    if remember && !credential.is_empty() {
        let key = source.to_string();
        let secret = credential.to_string();
        DataStore::update_file(move |data| {
            data.app_secrets
                .entry("integration".into())
                .or_default()
                .insert(key, secret);
            Ok(())
        })?;
    }
    let mut hub = HUB.lock().await;
    let slot = hub.slot(source);
    slot.generation += 1;
    let gen = slot.generation;
    slot.credential = credential.to_string();
    slot.credential_needed = false;
    slot.lease.endpoint = endpoint_raw.to_string();
    slot.lease.web_ui = web;
    slot.lease.keep_alive = keep_alive;
    slot.lease.status = lease::LivePhase::Connecting.as_str().into();
    slot.lease.last_error = None;
    slot.lease.reconnect_attempts = 0;
    if source == "paseo" {
        slot.lease.client_id = Some(lease::observer_client_id(slot.lease.client_id.as_deref()));
    }
    let client_id = slot.lease.client_id.clone();
    let cred = slot.credential.clone();
    let ep = slot.lease.endpoint.clone();
    drop(hub);
    persist().await;
    if source == "paseo" && keep_alive {
        tauri::async_runtime::spawn(paseo_loop(gen, ep, cred, client_id));
    } else {
        refresh_once(source).await;
    }
    Ok(status_of(source).await)
}

pub async fn disconnect(source: &str) -> AppResult<LiveStatus> {
    if source == "paseo" {
        return Err(AppError::Message("Paseo integration is retired".into()));
    }
    if source == "anneal" {
        return Err(AppError::Message("Anneal integration is retired".into()));
    }
    if source == "commandcode" {
        return Err(AppError::Message(
            "CommandCode Proxy integration is retired".into(),
        ));
    }
    if source != "paseo" && source != "anneal" {
        return Err(AppError::Message("Unknown integration source".into()));
    }
    let mut hub = HUB.lock().await;
    let slot = hub.slot(source);
    slot.generation += 1;
    slot.lease.keep_alive = false;
    slot.lease.status = lease::LivePhase::Disconnected.as_str().into();
    slot.credential.clear();
    slot.credential_needed = false;
    slot.next_poll = None;
    drop(hub);
    persist().await;
    Ok(status_of(source).await)
}

pub async fn all_status() -> Vec<LiveStatus> {
    vec![status_of("paseo").await, status_of("anneal").await]
}

pub async fn credential(source: &str) -> String {
    if source != "paseo" && source != "anneal" {
        return String::new();
    }
    HUB.lock().await.slot(source).credential.clone()
}

pub async fn status_of(source: &str) -> LiveStatus {
    let hub = HUB.lock().await;
    let slot = match source {
        "paseo" => &hub.paseo,
        "anneal" => &hub.anneal,
        _ => &hub.legacy_commandcode,
    };
    let stale_after = if source == "paseo" {
        lease::PASEO_STALE_SECS
    } else {
        lease::HTTP_STALE_SECS
    };
    let phase = lease::classify(
        slot.lease.last_ok_at,
        stale_after,
        slot.lease.last_error.is_some(),
        slot.lease.keep_alive,
    );
    LiveStatus {
        source: source.into(),
        endpoint: slot.lease.endpoint.clone(),
        web_ui: slot.lease.web_ui.clone(),
        status: if slot.lease.status == lease::LivePhase::Disconnected.as_str() {
            slot.lease.status.clone()
        } else {
            phase.as_str().into()
        },
        keep_alive: slot.lease.keep_alive,
        stale: phase == lease::LivePhase::Stale,
        last_ok_at: slot.lease.last_ok_at,
        last_error: slot.lease.last_error.clone(),
        reconnect_attempts: slot.lease.reconnect_attempts,
        web_ui_reachable: slot.web_ui_reachable,
        snapshot: slot.snapshot.clone(),
        banner: None,
        health: slot.health.clone(),
        model_count: slot.model_count,
        owned_process: false,
        credential_needed: slot.credential_needed,
    }
}

fn default_web_ui(source: &str) -> &'static str {
    match source {
        "paseo" => "http://127.0.0.1:6768/sessions",
        "anneal" => "http://127.0.0.1:3000/#/tasks",
        _ => "",
    }
}

async fn paseo_still_current(generation: u64) -> bool {
    let hub = HUB.lock().await;
    hub.paseo.generation == generation && hub.paseo.lease.keep_alive
}

async fn refresh_once(source: &str) {
    match source {
        "anneal" => {
            let (ep, cred, web) = {
                let hub = HUB.lock().await;
                (
                    hub.anneal.lease.endpoint.clone(),
                    hub.anneal.credential.clone(),
                    hub.anneal.lease.web_ui.clone(),
                )
            };
            if ep.is_empty() {
                return;
            }
            let web_ok = if web.is_empty() {
                false
            } else {
                actions::probe_web_ui(&web).await
            };
            match read(Source::Anneal, &ep, &cred).await {
                Ok(mut snap) => {
                    snap.read_only = false;
                    if let Ok(inbox) = actions::anneal_inbox(&ep, &cred).await {
                        merge_inbox(&mut snap, inbox);
                    }
                    mark_ok("anneal", Some(snap), web_ok, None, None).await;
                }
                Err(error) => mark_err("anneal", error.to_string()).await,
            }
        }
        "paseo" => {
            let (ep, cred) = {
                let hub = HUB.lock().await;
                (
                    hub.paseo.lease.endpoint.clone(),
                    hub.paseo.credential.clone(),
                )
            };
            if ep.is_empty() {
                return;
            }
            match read(Source::Paseo, &ep, &cred).await {
                Ok(mut snap) => {
                    snap.read_only = false;
                    let web = HUB.lock().await.paseo.lease.web_ui.clone();
                    let web_ok = if web.is_empty() {
                        false
                    } else {
                        actions::probe_web_ui(&web).await
                    };
                    mark_ok("paseo", Some(snap), web_ok, None, None).await;
                }
                Err(error) => mark_err("paseo", error.to_string()).await,
            }
        }
        _ => {}
    }
}

fn merge_inbox(snap: &mut Snapshot, inbox: serde_json::Value) {
    let Some(rows) = inbox.as_array() else {
        return;
    };
    for row in rows.iter().take(50) {
        let id = row["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() || snap.items.iter().any(|item| item.id == id) {
            continue;
        }
        snap.items.push(super::Item {
            id,
            title: row["body"]
                .as_str()
                .or(row["title"].as_str())
                .unwrap_or("Inbox")
                .chars()
                .take(300)
                .collect(),
            status: row["status"].as_str().unwrap_or("OPEN").into(),
            provider: "inbox".into(),
            workspace: String::new(),
            updated_at: row["createdAt"].as_str().unwrap_or("").into(),
            pending_permissions: 0,
            requires_attention: row["status"] == "OPEN",
            chain_id: None,
            chain_index: None,
            chain_layer: None,
            chain_name: Some("inbox".into()),
            attention_reason: Some("permission".into()),
            persistence_provider: None,
            persistence_session: None,
            pending_permission_id: None,
        });
    }
}

async fn mark_ok(
    source: &str,
    snapshot: Option<Snapshot>,
    web_ok: bool,
    health: Option<String>,
    models: Option<usize>,
) {
    let mut hub = HUB.lock().await;
    let slot = hub.slot(source);
    slot.lease.last_ok_at = Some(super::now());
    slot.lease.last_error = None;
    slot.lease.status = lease::LivePhase::Connected.as_str().into();
    slot.web_ui_reachable = web_ok;
    slot.health = health;
    slot.model_count = models;
    if let Some(s) = snapshot {
        slot.snapshot = Some(s);
    }
    if slot.stable_since.is_none() {
        slot.stable_since = Some(std::time::Instant::now());
    } else if slot
        .stable_since
        .is_some_and(|t| t.elapsed() >= Duration::from_secs(lease::STABLE_RESET_SECS))
    {
        slot.lease.reconnect_attempts = 0;
    }
    slot.next_poll = Some(std::time::Instant::now() + Duration::from_secs(lease::POLL_SECS));
    let persist_now = slot
        .last_persist
        .map(|t| t.elapsed() >= Duration::from_secs(300))
        .unwrap_or(true);
    if persist_now {
        slot.last_persist = Some(std::time::Instant::now());
        drop(hub);
        persist().await;
    }
}

async fn mark_err(source: &str, error: String) {
    let mut hub = HUB.lock().await;
    let slot = hub.slot(source);
    slot.lease.last_error = Some(lease::clip_error(&error));
    slot.lease.reconnect_attempts = slot.lease.reconnect_attempts.saturating_add(1);
    slot.lease.status = if slot.lease.keep_alive {
        lease::LivePhase::Reconnecting.as_str().into()
    } else {
        lease::LivePhase::Error.as_str().into()
    };
    slot.stable_since = None;
    let delay = lease::backoff_delay(slot.lease.reconnect_attempts.saturating_sub(1));
    slot.next_poll = Some(std::time::Instant::now() + delay);
    drop(hub);
    persist().await;
}

async fn paseo_loop(
    generation: u64,
    endpoint_raw: String,
    credential: String,
    client_id: Option<String>,
) {
    loop {
        {
            let hub = HUB.lock().await;
            if hub.paseo.generation != generation || !hub.paseo.lease.keep_alive {
                return;
            }
        }
        match paseo_session(generation, &endpoint_raw, &credential, client_id.as_deref()).await {
            Ok(()) => return,
            Err(error) => mark_err("paseo", error.to_string()).await,
        }
        let delay = {
            let hub = HUB.lock().await;
            if hub.paseo.generation != generation || !hub.paseo.lease.keep_alive {
                return;
            }
            lease::backoff_delay(hub.paseo.lease.reconnect_attempts)
        };
        tokio::time::sleep(delay).await;
    }
}

async fn paseo_session(
    generation: u64,
    raw: &str,
    credential: &str,
    client_id: Option<&str>,
) -> AppResult<()> {
    let u = endpoint(Source::Paseo, raw)?;
    let origin = u.to_string();
    let mut request = origin
        .clone()
        .into_client_request()
        .map_err(|_| AppError::Message("Invalid Paseo connection".into()))?;
    if !credential.is_empty() {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            format!("paseo.bearer.{credential}")
                .parse()
                .map_err(|_| AppError::Message("Invalid Paseo credential encoding".into()))?,
        );
    }
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(2 * 1024 * 1024);
    config.max_frame_size = Some(2 * 1024 * 1024);
    let (mut ws, _) = connect_async_with_config(request, Some(config), true)
        .await
        .map_err(|_| AppError::Message("Paseo is not reachable".into()))?;
    let id = lease::observer_client_id(client_id);
    ws.send(Message::Text(json!({"type":"hello","clientId":id,"clientType":"cli","protocolVersion":1,"capabilities":{"voice":false,"pushNotifications":false,"explicit_event_subscriptions":true,"selective_agent_timeline":true,"all_providers":true}}).to_string().into()))
        .await
        .map_err(|_| AppError::Message("Paseo handshake failed".into()))?;
    let mut ping = tokio::time::interval(Duration::from_secs(lease::PING_SECS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_fetch = std::time::Instant::now();
    let mut request_id = String::new();
    let mut version = None;
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if !paseo_still_current(generation).await {
                    return Ok(());
                }
                ws.send(Message::Ping(Vec::new().into())).await.map_err(|_| AppError::Message("Paseo ping failed".into()))?;
                if last_fetch.elapsed() >= Duration::from_secs(lease::POLL_SECS) {
                    request_id = uuid::Uuid::new_v4().to_string();
                    ws.send(Message::Text(json!({"type":"session","message":{"type":"fetch_agents_request","requestId":request_id,"scope":"active","page":{"limit":200}}}).to_string().into()))
                        .await
                        .map_err(|_| AppError::Message("Paseo live directory request failed".into()))?;
                    last_fetch = std::time::Instant::now();
                }
            }
            frame = ws.next() => {
                let frame = frame.ok_or_else(|| AppError::Message("Paseo closed the live connection".into()))?
                    .map_err(|_| AppError::Message("Paseo live frame rejected".into()))?;
                match frame {
                    Message::Pong(_) => {}
                    Message::Ping(p) => {
                        ws.send(Message::Pong(p)).await.map_err(|_| AppError::Message("Paseo pong failed".into()))?;
                    }
                    Message::Close(_) => return Err(AppError::Message("Paseo closed the live connection".into())),
                    Message::Text(raw) => {
                        let v: serde_json::Value = serde_json::from_str(&raw).map_err(|_| AppError::Message("Paseo returned invalid JSON".into()))?;
                        if v["type"] != "session" { continue; }
                        let m = &v["message"];
                        if m["payload"]["status"] == "server_info" {
                            version = m["payload"]["version"].as_str().map(|s| s.chars().take(80).collect());
                            if request_id.is_empty() {
                                request_id = uuid::Uuid::new_v4().to_string();
                                ws.send(Message::Text(json!({"type":"session","message":{"type":"fetch_agents_request","requestId":request_id,"scope":"active","page":{"limit":200}}}).to_string().into()))
                                    .await
                                    .map_err(|_| AppError::Message("Paseo live directory request failed".into()))?;
                                last_fetch = std::time::Instant::now();
                            }
                        }
                        if m["type"] == "fetch_agents_response" && m["payload"]["requestId"] == request_id {
                            if let Ok(mut snap) = super::snapshot_from_paseo_payload(origin.clone(), version.clone(), &m["payload"]) {
                                snap.read_only = false;
                                let web = HUB.lock().await.paseo.lease.web_ui.clone();
                                let web_ok = if web.is_empty() { false } else { actions::probe_web_ui(&web).await };
                                mark_ok("paseo", Some(snap), web_ok, None, None).await;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod retirement_tests {
    use super::*;

    #[test]
    fn restored_paseo_keep_alive_is_held_without_losing_endpoint_or_client() {
        let mut lease = lease::IntegrationLease {
            endpoint: "ws://127.0.0.1:6768/ws".into(),
            client_id: Some("old-client".into()),
            keep_alive: true,
            ..Default::default()
        };
        retire_paseo_lease(&mut lease);
        assert!(!lease.keep_alive);
        assert_eq!(lease.endpoint, "ws://127.0.0.1:6768/ws");
        assert_eq!(lease.client_id.as_deref(), Some("old-client"));
        assert_eq!(
            lease.last_error.as_deref(),
            Some("Paseo integration is retired")
        );
    }

    #[test]
    fn saved_paseo_keep_alive_does_not_reconnect_on_restore() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let anneal_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        anneal_listener.set_nonblocking(true).unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("aiTemp/paseo-rust-retirement")
            .join(uuid::Uuid::new_v4().to_string());
        let path = root.join("data/profiles.json");
        crate::data::with_test_file(path, || {
            let endpoint = format!("ws://{}/ws", listener.local_addr().unwrap());
            DataStore::update_file(|data| {
                data.integration_leases.paseo.endpoint = endpoint.clone();
                data.integration_leases.paseo.client_id = Some("old-client".into());
                data.integration_leases.paseo.keep_alive = true;
                data.integration_leases.anneal.endpoint =
                    format!("http://{}", anneal_listener.local_addr().unwrap());
                data.integration_leases.anneal.keep_alive = true;
                data.integration_leases.commandcode.keep_alive = true;
                data.app_secrets
                    .entry("integration".into())
                    .or_default()
                    .insert("paseo".into(), "fixture-token".into());
                data.app_secrets
                    .entry("integration".into())
                    .or_default()
                    .insert("anneal".into(), "fixture-token".into());
                Ok(())
            })
            .unwrap();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(restore_leases());
            runtime.block_on(async { tokio::time::sleep(Duration::from_millis(100)).await });
            let status = runtime.block_on(status_of("paseo"));
            assert!(!status.keep_alive);
            assert_eq!(status.endpoint, endpoint);
            let anneal = runtime.block_on(status_of("anneal"));
            assert!(!anneal.keep_alive);
            assert!(anneal
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("retired"));
            let legacy = runtime.block_on(status_of("commandcode"));
            assert!(!legacy.keep_alive);
            assert!(legacy
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("retired"));
            let before = DataStore::read_file(|d| Ok(serde_json::to_value(d).unwrap())).unwrap();
            let error = runtime
                .block_on(connect(
                    "anneal",
                    &anneal.endpoint,
                    "",
                    "new-credential",
                    true,
                    true,
                ))
                .unwrap_err();
            assert!(error.to_string().contains("retired"), "{error}");
            let after = DataStore::read_file(|d| Ok(serde_json::to_value(d).unwrap())).unwrap();
            assert_eq!(after, before);
            assert!(matches!(
                anneal_listener.accept(),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
            ));
            assert!(matches!(
                listener.accept(),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
            ));
        });
    }
}
