use coding_tools_headless::{HeadlessService, ServiceConfig};
use serde_json::Value;
use std::{fs, path::PathBuf, sync::Arc, time::Duration};

#[tokio::test]
async fn loopback_control_requires_token_and_stops_cleanly() {
    let fixture = std::env::current_dir()
        .expect("current directory")
        .join("aiTemp/headless-service-contract")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&fixture).expect("fixture directory");
    let app_data_dir = fixture.join("app-data");
    let descriptor_path = fixture.join("runtime/headless.json");
    let config = ServiceConfig {
        app_data_dir: app_data_dir.clone(),
        descriptor_path: descriptor_path.clone(),
        max_active_requests: 4,
        drain_timeout: Duration::from_secs(2),
    };

    let service = HeadlessService::start(config)
        .await
        .expect("headless service starts");
    let endpoint = service.endpoint().to_string();
    let parsed = url::Url::parse(&endpoint).expect("valid endpoint");
    assert_eq!(parsed.scheme(), "http");
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert!(parsed.port().is_some());

    let descriptor: Value =
        serde_json::from_slice(&fs::read(&descriptor_path).expect("descriptor"))
            .expect("descriptor json");
    assert_eq!(descriptor["schema"], 1);
    assert_eq!(descriptor["protocol_version"], 1);
    assert_eq!(descriptor["endpoint"], endpoint);
    assert_eq!(descriptor["status"], "ready");
    assert_eq!(descriptor["pid"], std::process::id());
    assert_eq!(
        descriptor["app_data_dir"],
        app_data_dir.to_string_lossy().as_ref()
    );
    assert!(descriptor.get("token").is_none());
    let token_file = PathBuf::from(descriptor["token_file"].as_str().expect("token file path"));
    let token = fs::read_to_string(&token_file).expect("token file");
    assert!(token.len() >= 40);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&token_file).unwrap().permissions().mode() & 0o077,
            0
        );
        assert_eq!(
            fs::metadata(&descriptor_path).unwrap().permissions().mode() & 0o077,
            0
        );
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let unauthorized = client
        .get(format!("{endpoint}/control/v1/health"))
        .send()
        .await
        .expect("unauthorized response");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let health: Value = client
        .get(format!("{endpoint}/control/v1/health"))
        .bearer_auth(token.trim())
        .send()
        .await
        .expect("health response")
        .error_for_status()
        .expect("health status")
        .json()
        .await
        .expect("health json");
    assert_eq!(health["ready"], true);
    assert_eq!(health["accepting"], true);
    assert_eq!(health["active_requests"], 1);
    assert_eq!(health["automatic_replay"], false);

    let drained: Value = client
        .post(format!("{endpoint}/control/v1/drain"))
        .bearer_auth(token.trim())
        .json(&serde_json::json!({"reason":"fixture-upgrade"}))
        .send()
        .await
        .expect("drain response")
        .error_for_status()
        .expect("drain status")
        .json()
        .await
        .expect("drain json");
    assert_eq!(drained["accepting"], false);
    assert_eq!(drained["idle"], true);

    let blocked = client
        .get(format!("{endpoint}/control/v1/health"))
        .bearer_auth(token.trim())
        .send()
        .await
        .expect("drained health response");
    assert_eq!(blocked.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);

    let resumed: Value = client
        .post(format!("{endpoint}/control/v1/resume"))
        .bearer_auth(token.trim())
        .send()
        .await
        .expect("resume response")
        .error_for_status()
        .expect("resume status")
        .json()
        .await
        .expect("resume json");
    assert_eq!(resumed["accepting"], true);

    service
        .shutdown("fixture-complete")
        .await
        .expect("clean shutdown");
    let stopped: Value =
        serde_json::from_slice(&fs::read(&descriptor_path).expect("retained descriptor"))
            .expect("stopped descriptor json");
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["shutdown_reason"], "fixture-complete");
    assert!(token_file.exists());
}

#[tokio::test]
async fn execution_read_uses_the_validated_workspace_binding() {
    let fixture = std::env::current_dir()
        .expect("current directory")
        .join("aiTemp/headless-workspace-binding")
        .join(uuid::Uuid::new_v4().to_string());
    let workspace = fixture.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace directory");
    let workspace = workspace.canonicalize().expect("canonical workspace");
    let workspace_id = "workspace-binding-fixture";
    let data = serde_json::from_value(serde_json::json!({
        "profiles": [{
            "id": workspace_id,
            "name": "Workspace binding fixture",
            "path": workspace.to_string_lossy(),
            "tunnel": {},
            "auth": {"type": "bearer"},
            "runtime": {},
            "actions": {}
        }]
    }))
    .expect("fixture app data");
    let core = Arc::new(coding_tools_core::CoreState::from_data(data).expect("fixture core"));
    let before = core
        .with_data(|store| Ok(serde_json::to_value(store.data()).unwrap()))
        .expect("before data");
    let app_data_dir = fixture.join("app-data");
    let profile_file = app_data_dir.join("data/profiles.json");
    fs::create_dir_all(profile_file.parent().unwrap()).expect("profile directory");
    fs::write(&profile_file, serde_json::to_vec_pretty(&before).unwrap()).expect("profile fixture");
    let before_file = fs::read(&profile_file).expect("profile bytes before");
    let descriptor_path = fixture.join("runtime/headless.json");
    let service = HeadlessService::start_with_core(
        ServiceConfig {
            app_data_dir,
            descriptor_path: descriptor_path.clone(),
            max_active_requests: 4,
            drain_timeout: Duration::from_secs(2),
        },
        Arc::clone(&core),
    )
    .await
    .expect("headless service starts");
    let descriptor: Value = serde_json::from_slice(&fs::read(descriptor_path).expect("descriptor"))
        .expect("descriptor json");
    let token =
        fs::read_to_string(descriptor["token_file"].as_str().expect("token file")).expect("token");
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client")
        .post(format!("{}/api/v1/execution/read", service.endpoint()))
        .bearer_auth(token.trim())
        .json(&serde_json::json!({
            "workspace_id": workspace_id,
            "mission_id": null,
            "refresh_source": true
        }))
        .send()
        .await
        .expect("execution response");
    let status = response.status();
    let body: Value = response.json().await.expect("execution json");
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body.pointer("/error/message").and_then(Value::as_str),
        Some("Workspace no longer exists"),
        "the request must pass the workspace-bound-listener gate before the isolated fixture reaches the process-global store check"
    );
    let after = core
        .with_data(|store| Ok(serde_json::to_value(store.data()).unwrap()))
        .expect("after data");
    assert_eq!(after, before, "refresh_source must remain read-only");
    assert_eq!(
        fs::read(&profile_file).expect("profile bytes after"),
        before_file,
        "refresh_source must preserve profile file bytes"
    );
    service
        .shutdown("workspace-binding-complete")
        .await
        .expect("clean shutdown");
}

#[tokio::test]
async fn retired_execution_http_mutations_stop_after_auth_without_touching_data() {
    let fixture = std::env::current_dir()
        .expect("current directory")
        .join("aiTemp/headless-retired-execution")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&fixture).expect("fixture directory");
    let data =
        serde_json::from_value(serde_json::json!({"profiles": []})).expect("fixture app data");
    let core = Arc::new(coding_tools_core::CoreState::from_data(data).expect("fixture core"));
    let before = core
        .with_data(|store| Ok(serde_json::to_value(store.data()).unwrap()))
        .expect("before data");
    let app_data_dir = fixture.join("app-data");
    let profile_file = app_data_dir.join("data/profiles.json");
    fs::create_dir_all(profile_file.parent().unwrap()).expect("profile directory");
    fs::write(&profile_file, serde_json::to_vec_pretty(&before).unwrap()).expect("profile fixture");
    let before_file = fs::read(&profile_file).expect("profile bytes before");
    let service = HeadlessService::start_with_core(
        ServiceConfig {
            app_data_dir,
            descriptor_path: fixture.join("runtime/headless.json"),
            max_active_requests: 4,
            drain_timeout: Duration::from_secs(2),
        },
        Arc::clone(&core),
    )
    .await
    .expect("headless service starts");
    let descriptor: Value = serde_json::from_slice(
        &fs::read(fixture.join("runtime/headless.json")).expect("descriptor"),
    )
    .expect("descriptor json");
    let token =
        fs::read_to_string(descriptor["token_file"].as_str().expect("token file")).expect("token");
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client");

    for route in [
        "/api/v1/execution/provider",
        "/api/v1/execution/update",
        "/api/v1/execution/orchestration/reserve",
        "/api/v1/execution/orchestration/status",
    ] {
        let url = format!("{}{route}", service.endpoint());
        let unauthorized = client
            .post(&url)
            .body("not-json")
            .send()
            .await
            .expect("response");
        assert_eq!(
            unauthorized.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "{route}"
        );

        let response = client
            .post(&url)
            .bearer_auth(token.trim())
            .body("not-json")
            .send()
            .await
            .expect("retired response");
        assert_eq!(response.status(), reqwest::StatusCode::GONE, "{route}");
        let body: Value = response.json().await.expect("retired json");
        assert_eq!(
            body["error"]["code"], "APP_MODULE_RETIRED",
            "{route}: {body}"
        );
    }

    let after = core
        .with_data(|store| Ok(serde_json::to_value(store.data()).unwrap()))
        .expect("after data");
    assert_eq!(after, before, "retired routes must preserve AppData");
    assert_eq!(
        fs::read(&profile_file).expect("profile bytes after"),
        before_file,
        "retired routes must preserve profile file bytes"
    );

    service
        .shutdown("retired-execution-complete")
        .await
        .expect("clean shutdown");
}
