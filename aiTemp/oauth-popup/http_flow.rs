//! Actual loopback listener, OAuth consent/PKCE/token flow, and catalog; no ChatGPT account.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};

#[test]
fn oauth_popup_http_consent_pkce_and_tools_survive_trusted_rotation() {
    let root = std::env::current_dir().unwrap().join("aiTemp/oauth-popup-fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    // Current-thread runtime keeps the existing thread-local datastore override
    // active in OAuth handlers; no real application settings or tokens are touched.
    crate::data::with_test_file(root.join("app/data/profiles.json"), || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
            .block_on(run_flow(root));
    });
}

async fn run_flow(root: PathBuf) {
    let mut ctx = crate::tools::ToolContext::for_test(root.join("workspace"), root.join("harness")).unwrap();
    ctx.auth.auth_type = "oauth".into();
    ctx.tool_profile = "advanced".into();
    let context = Arc::new(ctx);
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let local = format!("http://127.0.0.1:{port}");
    let workspace_id = root.join("transport-logs").to_string_lossy().into_owned();
    let client_id = "popup-fixture-client";
    let callback = "https://chatgpt.com/connector/oauth/popup_fixture_id";
    let oauth = Arc::new(OAuthRuntime::new(format!("{workspace_id}:mcp"), client_id.into(), None,
        "fixture-password-not-real".into(), "fixture-signing-key-at-least-32-bytes-not-real".into()));
    let state = ListenerState {mcp: context, auth: AuthConfig {auth_type:"oauth".into(), ..AuthConfig::default()},
        workspace_id:workspace_id.clone(), bind_port:port, configured_public_url:"https://old-popup.example".into(),
        bearer_token:None, oauth:Some(oauth), oauth_client_secret:None};
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let worker = tokio::spawn(async move {serve(socket, port, state, shutdown_rx).await.unwrap();});
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8)).build().unwrap();
    let verifier = "dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state_value = "popup-state-unchanged";
    let query = [("response_type","code"),("client_id",client_id),("redirect_uri",callback),
        ("code_challenge",challenge.as_str()),("code_challenge_method","S256"),("state",state_value)];

    // Raw Host/Forwarded input must not become a trusted origin or issuer.
    let attack = client.get(format!("{local}/oauth/authorize")).query(&query)
        .header("Origin","https://attacker.invalid").header("Host","attacker.invalid")
        .header("X-Forwarded-Host","attacker.invalid").send().await.unwrap();
    assert_eq!(attack.status().as_u16(),403);
    let metadata:Value = client.get(format!("{local}/.well-known/oauth-authorization-server"))
        .header("Host","attacker.invalid").header("X-Forwarded-Host","attacker.invalid")
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(metadata["issuer"],"https://old-popup.example");

    for round in 0..2 {
        let page = client.get(format!("{local}/oauth/authorize")).query(&query)
            .header("Origin","https://chatgpt.com").send().await.unwrap();
        assert_eq!(page.status().as_u16(),200,"OAuth entry was rejected before consent");
        assert_eq!(page.headers()["cache-control"],"no-store");
        let cookie = page.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
        let nonce = cookie.split_once('=').unwrap().1.to_owned();
        let html = page.text().await.unwrap();
        assert!(html.contains("<form method='POST' action='/oauth/authorize'>"));
        assert!(html.contains("name='state' value='popup-state-unchanged'"));
        assert!(html.contains(callback) && html.contains(&challenge) && html.contains(&nonce));
        let mut form = vec![("client_id",client_id.to_string()),("redirect_uri",callback.to_string()),
            ("code_challenge",challenge.clone()),("code_challenge_method","S256".into()),
            ("state",state_value.into()),("password","fixture-password-not-real".into()),("consent_nonce",nonce)];
        let missing = client.post(format!("{local}/oauth/authorize")).header("Origin","https://chatgpt.com")
            .form(&form).send().await.unwrap();
        assert_eq!(missing.status().as_u16(),403,"Origin allowance cannot replace the browser consent cookie");
        if round == 0 {
            form.iter_mut().find(|(key,_)|*key=="state").unwrap().1 = "tampered-state".into();
            let tampered = client.post(format!("{local}/oauth/authorize")).header("Origin","https://old-popup.example")
                .header("Cookie",&cookie).form(&form).send().await.unwrap();
            assert_eq!(tampered.status().as_u16(),403,"Consent must stay bound to the original request");
            continue;
        }
        let redirect = client.post(format!("{local}/oauth/authorize")).header("Origin","https://old-popup.example")
            .header("Cookie",&cookie).form(&form).send().await.unwrap();
        assert_eq!(redirect.status().as_u16(),303);
        let url = url::Url::parse(redirect.headers()["location"].to_str().unwrap()).unwrap();
        assert_eq!(url.origin().ascii_serialization(),"https://chatgpt.com");
        assert_eq!(url.path(),"/connector/oauth/popup_fixture_id");
        let returned:HashMap<String,String> = url.query_pairs().into_owned().collect();
        assert_eq!(returned["state"],state_value);
        let token_form = [("grant_type","authorization_code"),("client_id",client_id),
            ("redirect_uri",callback),("code_verifier",verifier),("code",returned["code"].as_str())];
        let token_response = client.post(format!("{local}/oauth/token")).form(&token_form).send().await.unwrap();
        assert_eq!(token_response.status().as_u16(),200);
        let token:Value = token_response.json().await.unwrap();
        let access = token["access_token"].as_str().unwrap();
        let replay = client.post(format!("{local}/oauth/token")).form(&token_form).send().await.unwrap();
        assert_ne!(replay.status().as_u16(),200,"Authorization codes must be one-use");
        let mcp = format!("{local}/mcp");
        let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let unauthenticated = client.post(&mcp).json(&body).send().await.unwrap();
        assert_eq!(unauthenticated.status().as_u16(),401);
        let cross_origin = client.post(&mcp).bearer_auth(access).header("Origin","https://chatgpt.com")
            .json(&body).send().await.unwrap();
        assert_eq!(cross_origin.status().as_u16(),403,"Popup exception must not leak to MCP");
        let tools:Value = client.post(&mcp).bearer_auth(access).json(&body).send().await.unwrap().json().await.unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(),70);

        // Trust changes come from the same persisted desktop data path as tunnels,
        // not Host headers. The listener and OAuth runtime are not restarted.
        let mut profile = crate::workspace::WorkspaceProfile::new(root.join("workspace").to_string_lossy().into_owned(),None);
        profile.id = workspace_id.clone();
        profile.tunnel.tunnel_type = "cloudflare".into();
        profile.tunnel.public_url = "https://new-popup.example".into();
        crate::data::DataStore::update_file(|data|{data.profiles.push(profile);Ok(())}).unwrap();
        let stale = client.post(&mcp).bearer_auth(access).header("Origin","https://old-popup.example").json(&body).send().await.unwrap();
        assert_eq!(stale.status().as_u16(),403);
        let new = client.post(&mcp).bearer_auth(access).header("Origin","https://new-popup.example").json(&body).send().await.unwrap();
        assert_eq!(new.status().as_u16(),200);
        let fresh:Value = client.get(format!("{local}/.well-known/oauth-authorization-server"))
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(fresh["issuer"],"https://new-popup.example");
        assert!(!worker.is_finished());
        let log = std::fs::read_to_string(root.join("transport-logs/mcp-requests.log")).unwrap();
        assert!(!log.contains(access) && !log.contains(&returned["code"]) && !log.contains("fixture-password-not-real"));
    }
    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4),worker).await.unwrap().unwrap();
    println!("PASS: actual OAuth entry, consent cookie/state, PKCE token exchange, one-use code, authenticated 70-tool catalog and trusted origin rotation without restart");
}
