use coding_tools_headless::{HeadlessService, ServiceConfig};
use serde_json::{json, Value};
use std::{fs, sync::Arc, time::Duration};

fn bridge_incident(incident: &str) -> Value {
    json!({
        "event": "coding_tools.bridge.down",
        "data": {
            "incident_id": incident,
            "occurred_at": "2026-09-30T00:00:00Z",
            "reason_code": "ECONNREFUSED",
            "reason": "health check failed with Bearer should-not-leak",
            "next_step": "Restart the Codex bridge from Coding Tools",
            "component": "codex_bridge",
            "target": "127.0.0.1:17841",
            "down_since": "2026-09-30T00:00:00Z",
            "prompt": "undeclared fields are dropped"
        }
    })
}

#[tokio::test]
async fn desktop_incidents_reach_the_event_hub_only_with_the_control_token() {
    let fixture = tempfile::tempdir().expect("fixture");
    let data = serde_json::from_value(json!({"profiles": []})).expect("fixture app data");
    let core = Arc::new(coding_tools_core::CoreState::from_data(data).expect("fixture core"));
    let app_data_dir = fixture.path().join("app-data");
    let descriptor_path = fixture.path().join("runtime/headless.json");
    let service = HeadlessService::start_with_core(
        ServiceConfig {
            app_data_dir,
            descriptor_path: descriptor_path.clone(),
            max_active_requests: 4,
            drain_timeout: Duration::from_secs(2),
        },
        core,
    )
    .await
    .expect("headless service starts");
    let descriptor: Value =
        serde_json::from_slice(&fs::read(descriptor_path).expect("descriptor")).expect("json");
    let token = fs::read_to_string(descriptor["token_file"].as_str().expect("token file"))
        .expect("token");
    let token = token.trim();
    let client = reqwest::Client::builder().no_proxy().build().expect("client");
    let url = |path: &str| format!("{}{path}", service.endpoint());

    let unauthorized = client
        .post(url("/api/v1/events/emit"))
        .json(&bridge_incident("bridge:1"))
        .send()
        .await
        .expect("response");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let emit = |body: Value| client.post(url("/api/v1/events/emit")).bearer_auth(token).json(&body).send();
    let first: Value = emit(bridge_incident("bridge:1")).await.unwrap().json().await.unwrap();
    assert_eq!(first, json!({"ok": true, "deduplicated": false, "deliveries": 0}));
    let again: Value = emit(bridge_incident("bridge:1")).await.unwrap().json().await.unwrap();
    assert_eq!(again["deduplicated"], true);

    let invalid = emit(json!({"event": "coding_tools.unknown", "data": {}})).await.unwrap();
    assert_eq!(invalid.status(), reqwest::StatusCode::BAD_REQUEST);
    let incomplete = emit(json!({"event": "coding_tools.bridge.down", "data": {"incident_id": "x"}}))
        .await
        .unwrap();
    assert_eq!(incomplete.status(), reqwest::StatusCode::BAD_REQUEST);

    let config = |proxy: Value| {
        client
            .post(url("/api/v1/events/config"))
            .bearer_auth(token)
            .json(&json!({"proxy": proxy}))
            .send()
    };
    assert!(config(json!("http://127.0.0.1:17891")).await.unwrap().status().is_success());
    assert_eq!(
        config(json!("socks5://127.0.0.1:1")).await.unwrap().status(),
        reqwest::StatusCode::BAD_REQUEST
    );

    let status: Value = client
        .get(url("/api/v1/events/status"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["events"]["open_incidents"], 1, "{status}");
    assert_eq!(status["events"]["proxy_configured"], true);

    let resolved: Value = emit(json!({
        "event": "coding_tools.bridge.down", "resolve": true, "data": {"incident_id": "bridge:1"}
    }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(resolved["resolved"], true);

    service.shutdown("events-complete").await.expect("clean shutdown");
}
