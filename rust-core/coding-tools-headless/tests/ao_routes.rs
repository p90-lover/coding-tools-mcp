use coding_tools_headless::{HeadlessService, ServiceConfig};
use serde_json::{json, Value};
use std::{fs, sync::Arc, time::Duration};

#[tokio::test]
async fn ao_routes_require_auth_workspace_scope_and_local_update_consent() {
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let root = project_root
        .join("aiTemp/ao-route-contract")
        .join(uuid::Uuid::new_v4().to_string());
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    let data = serde_json::from_value(json!({
        "profiles": [{
            "id":"qa","name":"AO QA","path":workspace.to_string_lossy(),
            "tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}
        }],
        "control_board":{"revision":2,"tasks":[]},
        "ao_runs":[{
            "id":"run-1","workspace_id":"qa","project_id":"project",
            "revision":1,"cancelled":false,"nodes":[]
        }]
    }))
    .unwrap();
    let core = Arc::new(coding_tools_core::CoreState::from_data(data).unwrap());
    let service = HeadlessService::start_with_core(
        ServiceConfig {
            app_data_dir: root.join("app-data"),
            descriptor_path: root.join("runtime/headless.json"),
            max_active_requests: 4,
            drain_timeout: Duration::from_secs(2),
        },
        core,
    )
    .await
    .unwrap();
    let descriptor: Value =
        serde_json::from_slice(&fs::read(root.join("runtime/headless.json")).unwrap()).unwrap();
    let token = fs::read_to_string(descriptor["token_file"].as_str().unwrap()).unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{}/api/v1/ao/read", service.endpoint());
    let unauthorized = client
        .post(&endpoint)
        .json(&json!({"workspace_id":"qa"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    let read = client
        .post(&endpoint)
        .bearer_auth(token.trim())
        .json(&json!({"workspace_id":"qa","run_id":"run-1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), reqwest::StatusCode::OK);
    let body: Value = read.json().await.unwrap();
    assert_eq!(body["runs"][0]["id"], "run-1");
    assert_eq!(body["board_revision"], 2);
    let foreign = client
        .post(&endpoint)
        .bearer_auth(token.trim())
        .json(&json!({"workspace_id":"other","run_id":"run-1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), reqwest::StatusCode::BAD_REQUEST);
    let update = client
        .post(format!("{}/api/v1/ao/update", service.endpoint()))
        .bearer_auth(token.trim())
        .json(&json!({"workspace_id":"qa","confirm":true,"change":{
            "operation":"cancel","run_id":"run-1","expected_revision":1
        }}))
        .send()
        .await
        .unwrap();
    assert_eq!(update.status(), reqwest::StatusCode::FORBIDDEN);
    let denied: Value = update.json().await.unwrap();
    assert_eq!(denied["error"]["code"], "AO_LOCAL_CONFIRMATION_REQUIRED");
    service
        .shutdown("ao-route-contract-complete")
        .await
        .unwrap();
}
