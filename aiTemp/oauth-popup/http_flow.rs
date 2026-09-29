//! Actual loopback listener, OAuth consent/PKCE/token flow, and catalog; no ChatGPT account.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};

#[test]
fn oauth_popup_http_consent_pkce_and_tools_survive_trusted_rotation() {
    let root = std::env::current_dir()
        .unwrap()
        .join("aiTemp/oauth-popup-fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(root.join("workspace")).unwrap();
    // Current-thread runtime keeps the existing thread-local datastore override
    // active in OAuth handlers; no real application settings or tokens are touched.
    crate::data::with_test_file(root.join("app/data/profiles.json"), || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_flow(root));
    });
}

async fn run_flow(root: PathBuf) {
    let mut ctx =
        crate::tools::ToolContext::for_test(root.join("workspace"), root.join("harness")).unwrap();
    ctx.auth.auth_type = "oauth".into();
    ctx.tool_profile = "advanced".into();
    let context = Arc::new(ctx);
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let local = format!("http://127.0.0.1:{port}");
    let workspace_id = root.join("transport-logs").to_string_lossy().into_owned();
    let client_id = "popup-fixture-client";
    let callback = "https://chatgpt.com/connector/oauth/popup_fixture_id";
    let oauth = Arc::new(OAuthRuntime::new(
        format!("{workspace_id}:mcp"),
        client_id.into(),
        None,
        "fixture-password-not-real".into(),
        "fixture-signing-key-at-least-32-bytes-not-real".into(),
    ));
    let state = ListenerState {
        mcp: context,
        auth: AuthConfig {
            auth_type: "oauth".into(),
            ..AuthConfig::default()
        },
        workspace_id: workspace_id.clone(),
        bind_port: port,
        configured_public_url: "https://old-popup.example".into(),
        bearer_token: None,
        oauth: Some(oauth),
        oauth_client_secret: None,
    };
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let worker = tokio::spawn(async move {
        serve(socket, port, state, shutdown_rx).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let verifier = "dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state_value = "popup-state-unchanged";
    let query = [
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", callback),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state_value),
    ];

    // The browser receives every production response header and submits through
    // this live Rust listener. The old replay omitted Referrer-Policy and missed
    // the real Origin:null rejection. No real account or external traffic is used.
    if let Ok(script) = std::env::var("OAUTH_BROWSER_PROBE") {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut command = tokio::process::Command::new("python");
        command
            .arg(script)
            .arg(&local)
            .current_dir(repo)
            .kill_on_drop(true);
        let result = tokio::time::timeout(Duration::from_secs(120), command.output())
            .await
            .expect("Browser probe timed out")
            .expect("Python browser probe could not start");
        println!("{}", String::from_utf8_lossy(&result.stdout));
        eprintln!("{}", String::from_utf8_lossy(&result.stderr));
        assert!(result.status.success(), "REAL_BROWSER_ORIGIN_FLOW_FAILED");
    }

    // Raw Host/Forwarded input must not become a trusted origin or issuer.
    let attack = client
        .get(format!("{local}/oauth/authorize"))
        .query(&query)
        .header("Origin", "https://attacker.invalid")
        .header("Host", "attacker.invalid")
        .header("X-Forwarded-Host", "attacker.invalid")
        .send()
        .await
        .unwrap();
    assert_eq!(attack.status().as_u16(), 403);
    let metadata: Value = client
        .get(format!("{local}/.well-known/oauth-authorization-server"))
        .header("Host", "attacker.invalid")
        .header("X-Forwarded-Host", "attacker.invalid")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(metadata["issuer"], "https://old-popup.example");

    let mut bad_query = query;
    bad_query
        .iter_mut()
        .find(|(key, _)| *key == "redirect_uri")
        .unwrap()
        .1 = "https://attacker.invalid/callback";
    let rejected = client
        .get(format!("{local}/oauth/authorize"))
        .query(&bad_query)
        .header("Origin", "https://chatgpt.com")
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status().as_u16(), 400);
    assert!(!rejected.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("attacker.invalid"));
    let mut browser_snapshot = Value::Null;
    for round in 0..2 {
        let page = client
            .get(format!("{local}/oauth/authorize"))
            .query(&query)
            .header("Origin", "https://chatgpt.com")
            .send()
            .await
            .unwrap();
        assert_eq!(
            page.status().as_u16(),
            200,
            "OAuth entry was rejected before consent"
        );
        assert_eq!(page.headers()["cache-control"], "no-store");
        let csp = page.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            csp.split(';')
                .map(str::trim)
                .find(|value| value.starts_with("form-action ")),
            Some("form-action 'self' https://chatgpt.com"),
            "CSP_MUST_ALLOW_VALIDATED_CALLBACK_ONLY"
        );
        assert!(csp.contains("default-src 'none'") && csp.contains("frame-ancestors 'none'"));
        let browser_cookie = page.headers()["set-cookie"].to_str().unwrap().to_owned();
        let cookie = page.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let nonce = cookie.split_once('=').unwrap().1.to_owned();
        let browser_headers: HashMap<String, String> = page
            .headers()
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_str().unwrap().to_owned()))
            .collect();
        assert_eq!(browser_headers["referrer-policy"], "strict-origin");
        let html = page.text().await.unwrap();
        assert!(html.contains("<form method='POST' action='/oauth/authorize'>"));
        assert!(html.contains("name='state' value='popup-state-unchanged'"));
        assert!(html.contains(callback) && html.contains(&challenge) && html.contains(&nonce));
        let mut form = vec![
            ("client_id", client_id.to_string()),
            ("redirect_uri", callback.to_string()),
            ("code_challenge", challenge.clone()),
            ("code_challenge_method", "S256".into()),
            ("state", state_value.into()),
            ("password", "fixture-password-not-real".into()),
            ("consent_nonce", nonce),
        ];
        let missing = client
            .post(format!("{local}/oauth/authorize"))
            .header("Origin", "https://chatgpt.com")
            .form(&form)
            .send()
            .await
            .unwrap();
        assert_eq!(
            missing.status().as_u16(),
            403,
            "Origin allowance cannot replace the browser consent cookie"
        );
        if round == 0 {
            form.iter_mut().find(|(key, _)| *key == "state").unwrap().1 = "tampered-state".into();
            let tampered = client
                .post(format!("{local}/oauth/authorize"))
                .header("Origin", "https://old-popup.example")
                .header("Cookie", &cookie)
                .form(&form)
                .send()
                .await
                .unwrap();
            assert_eq!(
                tampered.status().as_u16(),
                403,
                "Consent must stay bound to the original request"
            );
            continue;
        }
        let redirect = client
            .post(format!("{local}/oauth/authorize"))
            .header("Origin", "https://old-popup.example")
            .header("Cookie", &cookie)
            .form(&form)
            .send()
            .await
            .unwrap();
        assert_eq!(redirect.status().as_u16(), 303);
        let url = url::Url::parse(redirect.headers()["location"].to_str().unwrap()).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://chatgpt.com");
        assert_eq!(url.path(), "/connector/oauth/popup_fixture_id");
        let returned: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(returned["state"], state_value);
        let mut authorize_url =
            url::Url::parse("https://old-popup.example/oauth/authorize").unwrap();
        authorize_url.query_pairs_mut().extend_pairs(query);
        browser_snapshot = json!({"source":std::env::var("SOURCE").unwrap_or_else(|_| "local-test".into()),
            "authorize_url":authorize_url.as_str(),"html":html,"csp":csp,"set_cookie":browser_cookie,"response_headers":browser_headers,
            "callback_url":format!("{callback}?code=synthetic_browser_fixture&state={state_value}"),
            "redirect_status":redirect.status().as_u16(),"password":"fixture-password-not-real",
            "transport":"recorded production HTTP responses; the browser replay does not contact ChatGPT"});
        let token_form = [
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("redirect_uri", callback),
            ("code_verifier", verifier),
            ("code", returned["code"].as_str()),
        ];
        let token_response = client
            .post(format!("{local}/oauth/token"))
            .form(&token_form)
            .send()
            .await
            .unwrap();
        assert_eq!(token_response.status().as_u16(), 200);
        let token: Value = token_response.json().await.unwrap();
        let access = token["access_token"].as_str().unwrap();
        let replay = client
            .post(format!("{local}/oauth/token"))
            .form(&token_form)
            .send()
            .await
            .unwrap();
        assert_ne!(
            replay.status().as_u16(),
            200,
            "Authorization codes must be one-use"
        );
        let mcp = format!("{local}/mcp");
        let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let unauthenticated = client.post(&mcp).json(&body).send().await.unwrap();
        assert_eq!(unauthenticated.status().as_u16(), 401);
        let cross_origin = client
            .post(&mcp)
            .bearer_auth(access)
            .header("Origin", "https://chatgpt.com")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            cross_origin.status().as_u16(),
            403,
            "Popup exception must not leak to MCP"
        );
        let tools: Value = client
            .post(&mcp)
            .bearer_auth(access)
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 71);

        // Trust changes come from the same persisted desktop data path as tunnels,
        // not Host headers. The listener and OAuth runtime are not restarted.
        let mut profile = crate::workspace::WorkspaceProfile::new(
            root.join("workspace").to_string_lossy().into_owned(),
            None,
        );
        profile.id = workspace_id.clone();
        profile.tunnel.tunnel_type = "cloudflare".into();
        profile.tunnel.public_url = "https://new-popup.example".into();
        crate::data::DataStore::update_file(|data| {
            data.profiles.push(profile);
            Ok(())
        })
        .unwrap();
        let stale = client
            .post(&mcp)
            .bearer_auth(access)
            .header("Origin", "https://old-popup.example")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(stale.status().as_u16(), 403);
        let new = client
            .post(&mcp)
            .bearer_auth(access)
            .header("Origin", "https://new-popup.example")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(new.status().as_u16(), 200);
        let fresh: Value = client
            .get(format!("{local}/.well-known/oauth-authorization-server"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(fresh["issuer"], "https://new-popup.example");
        assert!(!worker.is_finished());
        let log = std::fs::read_to_string(root.join("transport-logs/mcp-requests.log")).unwrap();
        assert!(
            !log.contains(access)
                && !log.contains(&returned["code"])
                && !log.contains("fixture-password-not-real")
        );
    }
    assert!(!browser_snapshot.is_null());
    // Serialize the real Desktop settings types using synthetic values only.
    // The extension contract check consumes this JSON, not a hand-invented schema.
    let mut data = crate::data::AppData::default();
    let mut profile = crate::workspace::WorkspaceProfile::new("fixture-workspace".into(), None);
    profile.id = "extension-fixture".into();
    profile.auth.auth_type = "oauth".into();
    profile.auth.oauth_client_id = client_id.into();
    profile.auth.use_shared_secrets = false;
    profile.tunnel.public_url = "https://old-popup.example".into();
    data.last_workspace_id = profile.id.clone();
    data.workspace_secrets.insert(
        profile.id.clone(),
        HashMap::from([
            ("oauth_password".into(), "fixture-password-not-real".into()),
            (
                "oauth_client_secret".into(),
                "fixture-secret-not-real".into(),
            ),
        ]),
    );
    data.profiles.push(profile);
    browser_snapshot["profiles_fixture"] = serde_json::to_value(&data).unwrap();
    data.profiles[0].auth.use_shared_secrets = true;
    data.shared_secrets = HashMap::from([
        ("oauth_client_id".into(), "fixture-shared-client".into()),
        ("oauth_password".into(), "fixture-shared-password".into()),
        ("oauth_client_secret".into(), "fixture-shared-secret".into()),
    ]);
    browser_snapshot["shared_profiles_fixture"] = serde_json::to_value(&data).unwrap();
    // Cargo tests run in src-tauri; packaging runs at repository root.
    let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("desktop crate must have a repository parent")
        .join("aiTemp/oauth-popup");
    std::fs::create_dir_all(&fixture_dir).unwrap();
    std::fs::write(
        fixture_dir.join("browser-fixture.json"),
        serde_json::to_vec_pretty(&browser_snapshot).unwrap(),
    )
    .unwrap();
    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), worker)
        .await
        .unwrap()
        .unwrap();
    println!("PASS: actual OAuth entry, consent cookie/state, PKCE token exchange, one-use code, authenticated 71-tool catalog and trusted origin rotation without restart");
}
