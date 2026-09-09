// Three real loopback tests; no models, host input, screenshots or deletion.
use super::super::{serve, ListenerState};
use super::*;
use crate::auth::OAuthRuntime;
use crate::tools::{live_policy::commit_updates, ToolContext};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

struct Fixture {
    endpoint: String,
    root: PathBuf,
    token: String,
    expired: String,
    client: reqwest::Client,
    context: crate::mcp::server::SharedState,
    _stop: oneshot::Sender<()>,
    worker: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new(oauth_mode: bool) -> Self {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/connection-http")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let mut ctx = ToolContext::for_test(root.clone(), root.join("harness")).unwrap();
        ctx.auth.auth_type = if oauth_mode { "oauth" } else { "bearer" }.into();
        let context = Arc::new(ctx);
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let wid = format!("connection-test-{}:mcp", uuid::Uuid::new_v4());
        let key = "isolated-fixture-signing-key-32-bytes-not-real";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let jwt = |exp: u64| {
            jsonwebtoken::encode(
                &jsonwebtoken::Header::default(),
                &json!({"iss":format!("urn:coding-tools-mcp:{wid}"),"aud":wid,"wid":wid,
                "iat":now - 3600,"exp":exp,"scope":"mcp"}),
                &jsonwebtoken::EncodingKey::from_secret(key.as_bytes()),
            )
            .unwrap()
        };
        let token = if oauth_mode {
            jwt(now + 3600)
        } else {
            "isolated-http-test-token-not-real".into()
        };
        let expired = jwt(now - 60);
        let oauth = oauth_mode.then(|| {
            Arc::new(OAuthRuntime::new(
                wid,
                "fixture-client".into(),
                None,
                "fixture-password-not-real".into(),
                key.into(),
            ))
        });
        let state = ListenerState {
            mcp: context.clone(),
            auth: context.auth.clone(),
            // An absolute test log directory keeps all transient logs inside aiTemp.
            workspace_id: root.join("transport-logs").to_string_lossy().into_owned(),
            bind_port: port,
            configured_public_url: "https://repair.example".into(),
            bearer_token: (!oauth_mode).then(|| token.clone()),
            oauth,
            oauth_client_secret: None,
        };
        let (stop, shutdown) = oneshot::channel();
        let worker = tokio::spawn(async move {
            serve(socket, port, state, shutdown).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap();
        Self {
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            root,
            token,
            expired,
            client,
            context,
            _stop: stop,
            worker,
        }
    }
    async fn rpc(&self, body: Value) -> reqwest::Response {
        self.client
            .post(&self.endpoint)
            .bearer_auth(&self.token)
            .header("Accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_repair_oauth_challenge_and_token_recovery() {
    let f = Fixture::new(true).await;
    for token in [None, Some(f.expired.as_str()), Some("invalid-token")] {
        let mut r = f
            .client
            .post(&f.endpoint)
            .header("x-forwarded-host", "attacker.invalid")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
        if let Some(token) = token {
            r = r.bearer_auth(token);
        }
        let response = r.send().await.unwrap();
        assert_eq!(response.status().as_u16(), 401);
        assert_eq!(response.headers()["www-authenticate"],
            "Bearer resource_metadata=\"https://repair.example/.well-known/oauth-protected-resource\", scope=\"mcp\"");
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    let tools: Value = f
        .rpc(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await
        .json()
        .await
        .unwrap();
    assert!(!tools["result"]["tools"].as_array().unwrap().is_empty());
    let origin = f.endpoint.trim_end_matches("/mcp");
    let mut docs = Vec::new();
    for path in [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
    ] {
        docs.push(
            f.client
                .get(format!("{origin}{path}"))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap(),
        );
    }
    assert_eq!(docs[0], docs[1]);
    assert_eq!(
        docs[0]["authorization_servers"],
        json!(["https://repair.example"])
    );
    let log = std::fs::read_to_string(f.root.join("transport-logs/mcp-requests.log")).unwrap();
    assert!(
        log.contains("authentication_rejected status=401")
            && log.contains("catalog_served tools_count=")
    );
    assert!(!log.contains(&f.token) && !log.contains(&f.expired) && !log.contains("invalid-token"));
    assert!(!f.worker.is_finished());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_repair_handshake_notifications_catalog_and_live_policy() {
    let f = Fixture::new(false).await;
    let init: Value = f.rpc(json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"local-fixture","version":"1"}}})).await.json().await.unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let ack = f
        .rpc(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .await;
    assert_eq!(ack.status().as_u16(), 202);
    assert!(ack.bytes().await.unwrap().is_empty());
    let before: Value = f
        .rpc(json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}))
        .await
        .json()
        .await
        .unwrap();
    assert!(before["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "history_session_bootstrap"));
    let mut policy = f.context.for_request().unwrap().policy;
    policy.permission_mode = "read-only".into();
    commit_updates(vec![(f.context.clone(), policy, "core".into())], || Ok(())).unwrap();
    let after: Value = f
        .rpc(json!({"jsonrpc":"2.0","id":4,"method":"tools/list"}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(before["result"]["tools"], after["result"]["tools"]);
    let patch = json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"apply_patch","arguments":{
        "patch":"*** Begin Patch\n*** Add File: rejected.txt\n+must not appear\n*** End Patch\n"}}});
    let denied: Value = f.rpc(patch.clone()).await.json().await.unwrap();
    assert_eq!(denied["result"]["isError"], true);
    let mut idless = patch;
    idless.as_object_mut().unwrap().remove("id");
    assert_eq!(f.rpc(idless).await.status().as_u16(), 400);
    assert!(!f.root.join("rejected.txt").exists());
    assert!(
        !f.worker.is_finished(),
        "same listener; no relink or restart"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_repair_sse_get_and_legacy_probe_are_distinct() {
    let f = Fixture::new(true).await;
    let denied = f
        .client
        .get(&f.endpoint)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status().as_u16(), 401);
    assert!(denied.headers().contains_key("www-authenticate"));
    for accept in [
        "text/event-stream",
        "application/json, text/event-stream; q=1",
    ] {
        let stream = f
            .client
            .get(&f.endpoint)
            .header("Accept", accept)
            .bearer_auth(&f.token)
            .send()
            .await
            .unwrap();
        assert_eq!(stream.status().as_u16(), 405);
        assert_eq!(stream.headers()["allow"], "POST");
    }
    let discovery = f
        .client
        .get(&f.endpoint)
        .header("Accept", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(discovery.status().as_u16(), 200);
    assert_eq!(discovery.headers()["cache-control"], "no-store");
    let body: Value = discovery.json().await.unwrap();
    assert_eq!(body["name"], "coding-tools-mcp");
    assert!(
        body.get("tools").is_none(),
        "public health does not expose the tool catalog"
    );
}
