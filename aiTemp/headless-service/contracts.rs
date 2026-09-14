use crate::headless::{HeadlessService, Lifecycle, ServiceConfig};
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};

#[tokio::test]
async fn headless_lifecycle_drains_without_replaying_or_killing_owned_work() {
    let lifecycle = Lifecycle::new(2);
    let first = lifecycle.admit("fixture-read").expect("first request admitted");
    let second = lifecycle.admit("fixture-command").expect("second request admitted");
    assert_eq!(lifecycle.snapshot().active_requests, 2);
    assert!(lifecycle.admit("overflow").is_err());

    lifecycle.drain("fixture-upgrade").expect("drain begins");
    let draining = lifecycle.snapshot();
    assert!(!draining.accepting);
    assert_eq!(draining.active_requests, 2);
    assert_eq!(draining.drain_reason.as_deref(), Some("fixture-upgrade"));
    assert!(lifecycle.admit("new-work").is_err());

    drop(first);
    assert!(!lifecycle.wait_idle(Duration::from_millis(20)).await);
    drop(second);
    assert!(lifecycle.wait_idle(Duration::from_secs(1)).await);

    lifecycle.resume().expect("explicit resume");
    assert!(lifecycle.snapshot().accepting);
    let resumed = lifecycle.admit("resumed-read").expect("work admitted after resume");
    drop(resumed);
    assert_eq!(lifecycle.snapshot().active_requests, 0);
    println!("HEADLESS_LIFECYCLE_PASS: bounded admission, explicit drain/resume and no synthetic replay");
}

#[tokio::test]
async fn headless_control_is_loopback_token_file_authenticated_and_stops_cleanly() {
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

    let service = HeadlessService::start(config).await.expect("headless service starts");
    let endpoint = service.endpoint().to_string();
    let parsed = url::Url::parse(&endpoint).expect("valid endpoint");
    assert_eq!(parsed.scheme(), "http");
    assert!(matches!(parsed.host_str(), Some("127.0.0.1") | Some("::1")));
    assert!(parsed.port().is_some());

    let descriptor: Value = serde_json::from_slice(&fs::read(&descriptor_path).expect("descriptor"))
        .expect("descriptor json");
    assert_eq!(descriptor["schema"], 1);
    assert_eq!(descriptor["endpoint"], endpoint);
    assert_eq!(descriptor["status"], "ready");
    assert_eq!(descriptor["pid"], std::process::id());
    assert_eq!(descriptor["app_data_dir"], app_data_dir.to_string_lossy().as_ref());
    assert!(descriptor.get("token").is_none(), "secret must not be stored in descriptor");
    let token_file = PathBuf::from(descriptor["token_file"].as_str().expect("token file path"));
    let token = fs::read_to_string(&token_file).expect("token file");
    assert!(token.len() >= 48 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&token_file).unwrap().permissions().mode() & 0o077, 0);
        assert_eq!(fs::metadata(&descriptor_path).unwrap().permissions().mode() & 0o077, 0);
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let unauthorized = client
        .get(format!("{endpoint}/health"))
        .send()
        .await
        .expect("unauthorized response");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let health: Value = client
        .get(format!("{endpoint}/health"))
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
    assert_eq!(health["active_requests"], 1, "health itself owns one bounded lease");
    assert_eq!(health["automatic_replay"], false);

    let drained: Value = client
        .post(format!("{endpoint}/admin/drain"))
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
        .get(format!("{endpoint}/health"))
        .bearer_auth(token.trim())
        .send()
        .await
        .expect("drained health response");
    assert_eq!(blocked.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);

    let resumed: Value = client
        .post(format!("{endpoint}/admin/resume"))
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

    service.shutdown("fixture-complete").await.expect("clean shutdown");
    let stopped: Value = serde_json::from_slice(&fs::read(&descriptor_path).expect("retained descriptor"))
        .expect("stopped descriptor json");
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["shutdown_reason"], "fixture-complete");
    assert!(token_file.exists(), "shutdown retains token evidence; product migration later rotates it");
    println!("HEADLESS_CONTROL_PASS: private token file, authenticated loopback lifecycle and retained stopped descriptor; no model or tool invoked");
}
