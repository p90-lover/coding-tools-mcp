use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::*;

const SECRET: &str = "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD";
const OTHER_SECRET: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

#[derive(Clone, Copy, PartialEq)]
enum Verify {
    Echo,
    WrongChallenge,
    Status(u16),
}

struct Received {
    webhook_id: String,
    subscription_id: String,
    body: Value,
    signature_valid: bool,
}

struct Receiver {
    secret: String,
    verify: Verify,
    statuses: VecDeque<u16>,
    verifications: usize,
    deliveries: Vec<Received>,
}

type Shared = Arc<Mutex<Receiver>>;

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

async fn callback(
    State(shared): State<Shared>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    let mut receiver = shared.lock().unwrap();
    let secret = WebhookSecret::parse(&receiver.secret).unwrap();
    let id = header(&headers, "webhook-id");
    let timestamp: i64 = header(&headers, "webhook-timestamp").parse().unwrap_or(0);
    let signature_valid = header(&headers, "webhook-signature")
        == secret.sign(&id, timestamp, &body)
        && header(&headers, "content-type") == "application/json"
        && (now_ms() as i64 / 1000 - timestamp).abs() < 300;
    let parsed: Value = serde_json::from_str(&body).unwrap();
    if parsed["type"] == "verification" {
        receiver.verifications += 1;
        assert!(
            signature_valid,
            "verification must be signed with the subscription secret"
        );
        assert!(!header(&headers, "x-mcp-subscription-id").is_empty());
        return match receiver.verify {
            Verify::Echo => Json(json!({"challenge": parsed["challenge"]})).into_response(),
            Verify::WrongChallenge => Json(json!({"challenge": "something-else"})).into_response(),
            Verify::Status(code) => StatusCode::from_u16(code).unwrap().into_response(),
        };
    }
    receiver.deliveries.push(Received {
        webhook_id: id,
        subscription_id: header(&headers, "x-mcp-subscription-id"),
        body: parsed,
        signature_valid,
    });
    let status = receiver.statuses.pop_front().unwrap_or(200);
    StatusCode::from_u16(status).unwrap().into_response()
}

async fn receiver(verify: Verify) -> (String, Shared) {
    let shared = Arc::new(Mutex::new(Receiver {
        secret: SECRET.into(),
        verify,
        statuses: VecDeque::new(),
        verifications: 0,
        deliveries: Vec::new(),
    }));
    let app = Router::new()
        .route("/hook", post(callback))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://127.0.0.1:{port}/hook"), shared)
}

fn options() -> HubOptions {
    HubOptions {
        allow_insecure_loopback: true,
        direct: true,
        retry_base: Duration::from_millis(20),
        max_attempts: 4,
    }
}

fn open_hub(dir: &std::path::Path) -> Arc<EventHub> {
    Arc::new(EventHub::open(dir.to_path_buf(), options()).unwrap())
}

fn subscribe_params(name: &str, arguments: Value, url: &str, secret: &str) -> Value {
    json!({
        "name": name,
        "arguments": arguments,
        "delivery": {"mode": "webhook", "url": url, "secret": secret},
        "cursor": null
    })
}

fn bridge_incident(incident: &str) -> EmittedEvent {
    EmittedEvent {
        name: catalog::BRIDGE_DOWN.into(),
        workspace_id: None,
        data: json!({
            "incident_id": incident, "occurred_at": "2026-09-30T00:00:00Z",
            "reason_code": "ECONNREFUSED", "reason": "Codex bridge health check failed",
            "next_step": "Restart the Codex bridge from Coding Tools",
            "recovery_tools": ["harness_status"],
            "component": "codex_bridge", "target": "127.0.0.1:17841",
            "down_since": "2026-09-30T00:00:00Z", "net_error": null
        }),
    }
}

fn mission_incident(workspace: &str, incident: &str) -> EmittedEvent {
    EmittedEvent {
        name: catalog::MISSION_NEEDS_ATTENTION.into(),
        workspace_id: Some(workspace.into()),
        data: json!({
            "incident_id": incident, "occurred_at": "2026-09-30T00:00:00Z",
            "reason_code": "pending_approval", "next_step": "Approve the tool call",
            "workspace_id": workspace, "run_id": "run-1", "status": "running",
            "attention": "pending_approval"
        }),
    }
}

async fn wait_for(shared: &Shared, count: usize) {
    for _ in 0..250 {
        if shared.lock().unwrap().deliveries.len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "expected {count} deliveries, got {}",
        shared.lock().unwrap().deliveries.len()
    );
}

#[test]
fn iso8601_formats_utc_seconds() {
    assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
    assert_eq!(iso8601(1_649_367_553_000), "2022-04-07T21:39:13Z");
    assert_eq!(iso8601(4_107_542_400_000), "2100-03-01T00:00:00Z");
}

#[test]
fn subscription_ids_are_deterministic_and_argument_order_independent() {
    let a: Map<String, Value> = serde_json::from_value(json!({"a":"1","b":"2"})).unwrap();
    let mut b = Map::new();
    b.insert("b".into(), json!("2"));
    b.insert("a".into(), json!("1"));
    let id = subscription_id("ws", "https://x.test/h", catalog::RUN_STALLED, &a);
    assert_eq!(
        id,
        subscription_id("ws", "https://x.test/h", catalog::RUN_STALLED, &b)
    );
    assert_ne!(
        id,
        subscription_id("other", "https://x.test/h", catalog::RUN_STALLED, &a)
    );
    assert!(id.starts_with("sub_") && id.len() == 36);
    assert_eq!(event_id(&id, "inc"), event_id(&id, "inc"));
    assert_ne!(event_id(&id, "inc"), event_id(&id, "inc2"));
}

#[test]
fn list_describes_every_event() {
    let dir = tempfile::tempdir().unwrap();
    let listed = open_hub(dir.path()).list();
    let names: Vec<_> = listed["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].clone())
        .collect();
    assert_eq!(
        names,
        catalog::EVENT_NAMES
            .iter()
            .map(|n| json!(n))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn subscribe_verifies_the_callback_persists_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (url, shared) = receiver(Verify::Echo).await;
    let first = open_hub(dir.path());
    let result = first
        .subscribe(
            "ws-a",
            &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, SECRET),
        )
        .await
        .unwrap();
    assert!(result["id"].as_str().unwrap().starts_with("sub_"));
    assert_eq!(result["cursor"], Value::Null);
    assert_eq!(result["truncated"], false);
    let refresh_before = result["refreshBefore"].as_str().unwrap();
    assert!(refresh_before.ends_with('Z') && refresh_before.len() == 20);
    assert_eq!(shared.lock().unwrap().verifications, 1);

    // Same identity and secret: a refresh, not a second subscription or verification.
    let again = first
        .subscribe(
            "ws-a",
            &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, SECRET),
        )
        .await
        .unwrap();
    assert_eq!(again["id"], result["id"]);
    assert_eq!(shared.lock().unwrap().verifications, 1);
    assert_eq!(first.status()["subscriptions"].as_array().unwrap().len(), 1);
    assert!(!first.status().to_string().contains("whsec_"));

    let restarted = open_hub(dir.path());
    assert_eq!(restarted.status()["subscriptions"][0]["id"], result["id"]);
    let outcome = restarted.emit(bridge_incident("bridge:1")).unwrap();
    assert_eq!(
        outcome,
        EmitOutcome {
            deduplicated: false,
            deliveries: 1
        }
    );
    wait_for(&shared, 1).await;
    let receiver = shared.lock().unwrap();
    let delivered = &receiver.deliveries[0];
    assert!(delivered.signature_valid);
    assert_eq!(delivered.subscription_id, result["id"].as_str().unwrap());
    assert_eq!(
        delivered.webhook_id,
        delivered.body["eventId"].as_str().unwrap()
    );
    assert_eq!(delivered.body["name"], catalog::BRIDGE_DOWN);
    assert_eq!(delivered.body["cursor"], Value::Null);
    assert_eq!(delivered.body["data"]["component"], "codex_bridge");
}

#[tokio::test]
async fn a_rotated_secret_is_verified_again() {
    let dir = tempfile::tempdir().unwrap();
    let (url, shared) = receiver(Verify::Echo).await;
    let hub = open_hub(dir.path());
    hub.subscribe(
        "ws",
        &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, SECRET),
    )
    .await
    .unwrap();
    shared.lock().unwrap().secret = OTHER_SECRET.into();
    hub.subscribe(
        "ws",
        &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, OTHER_SECRET),
    )
    .await
    .unwrap();
    assert_eq!(shared.lock().unwrap().verifications, 2);
    assert_eq!(hub.status()["subscriptions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_verification_returns_callback_endpoint_error_and_saves_nothing() {
    for (mode, reason) in [
        (Verify::WrongChallenge, "challenge_mismatch"),
        (Verify::Status(500), "http_status"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (url, _shared) = receiver(mode).await;
        let hub = open_hub(dir.path());
        let error = hub
            .subscribe(
                "ws",
                &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, SECRET),
            )
            .await
            .unwrap_err();
        assert_eq!(error["code"], CALLBACK_ENDPOINT_ERROR);
        assert_eq!(error["data"]["reason"], reason);
        assert!(hub.status()["subscriptions"].as_array().unwrap().is_empty());
        assert!(!dir.path().join("subscriptions.json").exists());
    }
    let dir = tempfile::tempdir().unwrap();
    let error = open_hub(dir.path())
        .subscribe(
            "ws",
            &subscribe_params(
                catalog::BRIDGE_DOWN,
                json!({}),
                "http://127.0.0.1:9/none",
                SECRET,
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error["data"]["reason"], "unreachable");
}

#[tokio::test]
async fn subscribe_rejects_invalid_requests() {
    let dir = tempfile::tempdir().unwrap();
    let strict = Arc::new(EventHub::open(dir.path().to_path_buf(), HubOptions::default()).unwrap());
    let cases = [
        subscribe_params(
            "coding_tools.unknown",
            json!({}),
            "https://x.test/h",
            SECRET,
        ),
        subscribe_params(
            catalog::BRIDGE_DOWN,
            json!({"component":"db"}),
            "https://x.test/h",
            SECRET,
        ),
        subscribe_params(
            catalog::BRIDGE_DOWN,
            json!({}),
            "http://127.0.0.1:1/h",
            SECRET,
        ),
        subscribe_params(
            catalog::BRIDGE_DOWN,
            json!({}),
            "https://user:pw@x.test/h",
            SECRET,
        ),
        subscribe_params(
            catalog::BRIDGE_DOWN,
            json!({}),
            "https://x.test/h",
            "whsec_c2hvcnQ=",
        ),
        json!({"name": catalog::BRIDGE_DOWN, "delivery": {"mode":"poll","url":"https://x.test/h","secret":SECRET}}),
    ];
    for params in cases {
        let error = strict.subscribe("ws", &params).await.unwrap_err();
        assert_eq!(error["code"], -32602, "{params}");
    }
}

#[tokio::test]
async fn unsubscribe_is_idempotent_and_scoped_to_the_principal() {
    let dir = tempfile::tempdir().unwrap();
    let (url, _shared) = receiver(Verify::Echo).await;
    let hub = open_hub(dir.path());
    let args = json!({"workspace_id":"ws","run_id":"run-1"});
    hub.subscribe(
        "ws",
        &subscribe_params(catalog::MISSION_NEEDS_ATTENTION, args.clone(), &url, SECRET),
    )
    .await
    .unwrap();
    let unsubscribe = json!({"name": catalog::MISSION_NEEDS_ATTENTION, "arguments": args,
        "delivery": {"mode":"webhook","url": url}});
    assert_eq!(
        hub.unsubscribe("other-ws", &unsubscribe).unwrap(),
        json!({})
    );
    assert_eq!(hub.status()["subscriptions"].as_array().unwrap().len(), 1);
    assert_eq!(hub.unsubscribe("ws", &unsubscribe).unwrap(), json!({}));
    assert!(hub.status()["subscriptions"].as_array().unwrap().is_empty());
    assert_eq!(hub.unsubscribe("ws", &unsubscribe).unwrap(), json!({}));
    assert!(open_hub(dir.path()).status()["subscriptions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn delivery_honours_filters_workspace_scope_and_incident_dedupe() {
    let dir = tempfile::tempdir().unwrap();
    let (url, shared) = receiver(Verify::Echo).await;
    let hub = open_hub(dir.path());
    hub.subscribe(
        "ws-a",
        &subscribe_params(
            catalog::MISSION_NEEDS_ATTENTION,
            json!({"attention":"pending_approval"}),
            &url,
            SECRET,
        ),
    )
    .await
    .unwrap();
    hub.subscribe(
        "ws-a",
        &subscribe_params(
            catalog::MISSION_NEEDS_ATTENTION,
            json!({"attention":"error"}),
            &url,
            SECRET,
        ),
    )
    .await
    .unwrap();
    // Another workspace's incident never reaches ws-a's connector.
    assert_eq!(
        hub.emit(mission_incident("ws-b", "m:1"))
            .unwrap()
            .deliveries,
        0
    );
    assert_eq!(
        hub.emit(mission_incident("ws-a", "m:2"))
            .unwrap()
            .deliveries,
        1
    );
    let duplicate = hub.emit(mission_incident("ws-a", "m:2")).unwrap();
    assert!(duplicate.deduplicated);
    wait_for(&shared, 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(shared.lock().unwrap().deliveries.len(), 1);
    assert_eq!(hub.recent_incidents(Some("ws-a"), false, 10).len(), 1);
    assert!(hub.resolve(catalog::MISSION_NEEDS_ATTENTION, "m:2"));
    assert!(hub.recent_incidents(Some("ws-a"), false, 10).is_empty());
    assert_eq!(hub.recent_incidents(Some("ws-a"), true, 10).len(), 1);
}

#[tokio::test]
async fn transient_failures_retry_with_the_same_event_id_and_fresh_signature() {
    let dir = tempfile::tempdir().unwrap();
    let (url, shared) = receiver(Verify::Echo).await;
    shared.lock().unwrap().statuses = VecDeque::from([503, 429, 200]);
    let hub = open_hub(dir.path());
    hub.subscribe(
        "ws",
        &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, SECRET),
    )
    .await
    .unwrap();
    hub.emit(bridge_incident("bridge:retry")).unwrap();
    wait_for(&shared, 3).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let receiver = shared.lock().unwrap();
    assert_eq!(receiver.deliveries.len(), 3);
    let ids: Vec<_> = receiver
        .deliveries
        .iter()
        .map(|d| d.webhook_id.clone())
        .collect();
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert!(receiver.deliveries.iter().all(|d| d.signature_valid));
    drop(receiver);
    assert_eq!(
        hub.status()["subscriptions"][0]["last_delivery"]["outcome"],
        "delivered"
    );
}

#[tokio::test]
async fn gone_removes_the_subscription_and_too_large_is_not_retried() {
    let dir = tempfile::tempdir().unwrap();
    let (url, shared) = receiver(Verify::Echo).await;
    shared.lock().unwrap().statuses = VecDeque::from([413]);
    let hub = open_hub(dir.path());
    hub.subscribe(
        "ws",
        &subscribe_params(catalog::BRIDGE_DOWN, json!({}), &url, SECRET),
    )
    .await
    .unwrap();
    hub.emit(bridge_incident("bridge:413")).unwrap();
    wait_for(&shared, 1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(shared.lock().unwrap().deliveries.len(), 1);
    assert_eq!(hub.status()["subscriptions"].as_array().unwrap().len(), 1);

    shared.lock().unwrap().statuses = VecDeque::from([410]);
    hub.emit(bridge_incident("bridge:410")).unwrap();
    wait_for(&shared, 2).await;
    for _ in 0..50 {
        if hub.status()["subscriptions"].as_array().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(hub.status()["subscriptions"].as_array().unwrap().is_empty());
    assert!(open_hub(dir.path()).status()["subscriptions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn expired_subscriptions_are_dropped_on_load() {
    let dir = tempfile::tempdir().unwrap();
    let file = SubscriptionFile::new(dir.path());
    let entry = |id: &str, expires_at_ms| StoredSubscription {
        id: id.into(),
        principal: "ws".into(),
        name: catalog::BRIDGE_DOWN.into(),
        arguments: Map::new(),
        url: "https://x.test/h".into(),
        secret: SECRET.into(),
        created_at_ms: 1,
        refreshed_at_ms: 1,
        expires_at_ms,
        verified_at_ms: 1,
    };
    file.save(&[entry("sub_old", 1), entry("sub_live", now_ms() + 60_000)])
        .unwrap();
    let hub = open_hub(dir.path());
    let ids: Vec<_> = hub.status()["subscriptions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("sub_live")]);
}

#[test]
fn proxy_override_accepts_only_http_urls() {
    let dir = tempfile::tempdir().unwrap();
    let hub = open_hub(dir.path());
    assert!(hub.set_proxy(Some("http://127.0.0.1:17891".into())).is_ok());
    assert_eq!(hub.status()["proxy_configured"], true);
    assert!(hub
        .set_proxy(Some("socks5://127.0.0.1:1080".into()))
        .is_err());
    assert!(hub.set_proxy(Some("not a url".into())).is_err());
    assert!(hub.set_proxy(None).is_ok());
    assert_eq!(hub.status()["proxy_configured"], false);
}
