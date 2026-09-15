use coding_tools_headless::{HeadlessService, ServiceConfig};
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};

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

    let descriptor: Value = serde_json::from_slice(
        &fs::read(&descriptor_path).expect("descriptor"),
    )
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
        assert_eq!(fs::metadata(&token_file).unwrap().permissions().mode() & 0o077, 0);
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
    let stopped: Value = serde_json::from_slice(
        &fs::read(&descriptor_path).expect("retained descriptor"),
    )
    .expect("stopped descriptor json");
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["shutdown_reason"], "fixture-complete");
    assert!(token_file.exists());
}
