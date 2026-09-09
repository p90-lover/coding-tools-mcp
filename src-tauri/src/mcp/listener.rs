use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Form, FromRequest, Query, Request, State};
use axum::http::{header::CACHE_CONTROL, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::auth::{
    authorization_server_metadata, authorize_get, authorize_post_browser,
    protected_resource_metadata, token_exchange, trusted_external_base_url, verify_bearer_header,
    verify_oauth_bearer_header, AuthorizeForm, AuthorizeParams, OAuthRuntime, TokenForm,
};
use crate::mcp::server::{handle_request, new_state, SharedState};
use crate::secret::SecretStore;
use crate::tools::policy::PolicySettings;
use crate::tools::Workspace;
use crate::tunnel::append_profile_log;
use crate::workspace::{AuthConfig, RuntimeConfig};

#[path = "transport.rs"]
mod transport;

pub type ShutdownSender = oneshot::Sender<()>;

#[derive(Clone)]
struct ListenerState {
    mcp: SharedState,
    auth: AuthConfig,
    workspace_id: String,
    bind_port: u16,
    configured_public_url: String,
    bearer_token: Option<String>,
    oauth: Option<Arc<OAuthRuntime>>,
    oauth_client_secret: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_listener(
    port: u16,
    workspace_path: PathBuf,
    workspace_id: String,
    auth: AuthConfig,
    public_base_url: String,
    oauth_client_secret: Option<String>,
    oauth_password: Option<String>,
    oauth_token_secret: Option<String>,
    runtime: RuntimeConfig,
) -> Result<
    (
        ShutdownSender,
        tauri::async_runtime::JoinHandle<()>,
        SharedState,
    ),
    String,
> {
    if !matches!(auth.auth_type.as_str(), "noauth" | "bearer" | "oauth") {
        return Err("Unsupported MCP authentication type; refusing to start".into());
    }
    let workspace = Workspace::new(workspace_path).map_err(|e| e.message())?;
    let policy = PolicySettings::from_runtime(&runtime);
    let mut mcp = new_state(
        workspace,
        auth.clone(),
        policy,
        runtime.tool_profile.clone(),
        runtime.permission_mode.clone(),
    );
    Arc::get_mut(&mut mcp)
        .ok_or("Workspace context is unexpectedly shared")?
        .workspace_id = Some(workspace_id.clone());
    let bearer_token = if auth.bearer_enabled() {
        let key = "bearer_token";
        if auth.use_shared_secrets {
            SecretStore::get_shared(key).map_err(|e| e.to_string())?
        } else {
            SecretStore::get(&workspace_id, key).map_err(|e| e.to_string())?
        }
    } else {
        None
    };
    if auth.bearer_enabled()
        && bearer_token
            .as_deref()
            .is_none_or(|token| token.trim().is_empty())
    {
        return Err("MCP Bearer token is not configured".into());
    }
    if auth.oauth_enabled() && auth.oauth_client_id.trim().is_empty() {
        return Err("MCP OAuth client ID is not configured".into());
    }
    let configured_public_url = public_base_url.trim().to_string();
    let oauth = if auth.oauth_enabled() {
        let password = oauth_password.unwrap_or_default();
        let token_secret = oauth_token_secret.unwrap_or_default();
        let oauth = OAuthRuntime::new(
            format!("{}:mcp", workspace_id),
            auth.oauth_client_id.clone(),
            oauth_client_secret.clone(),
            password,
            token_secret,
        )
        .with_redirect_uris(auth.oauth_redirect_uris.clone())?;
        oauth.validate_configuration()?;
        Some(Arc::new(oauth))
    } else {
        None
    };
    let context = mcp.clone();
    let state = ListenerState {
        mcp,
        auth,
        workspace_id,
        bind_port: port,
        configured_public_url,
        bearer_token,
        oauth,
        oauth_client_secret,
    };
    // 在返回 Running 之前完成 bind，避免后台任务里的端口冲突被伪装成启动成功。
    let listener = bind_listener(port)?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let profile_id = state.workspace_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = serve(listener, port, state, shutdown_rx).await;
        if let Err(err) = &result {
            append_profile_log(
                &profile_id,
                "stderr.log",
                &format!("[mcp] listener stopped: {err}"),
            );
            eprintln!("mcp listener stopped: {err}");
        } else {
            append_profile_log(&profile_id, "stderr.log", "[mcp] listener stopped");
        }
    });
    Ok((shutdown_tx, handle, context))
}

async fn serve(
    listener: tokio::net::TcpListener,
    port: u16,
    state: ListenerState,
    shutdown: oneshot::Receiver<()>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let profile_id = state.workspace_id.clone();
    let security = crate::auth::http_security::HttpSecurity::new(
        state.workspace_id.clone(),
        false,
        state.bind_port,
        state.configured_public_url.clone(),
        64,
    );
    let app = Router::new()
        .route("/mcp", get(transport::get_handler).post(mcp_post))
        .route(
            "/.well-known/oauth-authorization-server",
            get(oauth_authorization_server_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth_protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(oauth_protected_resource_metadata),
        )
        .route(
            "/oauth/authorize",
            get(oauth_authorize_get)
                .post(oauth_authorize_post)
                .layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/oauth/token",
            post(oauth_token_post).layer(DefaultBodyLimit::max(8192)),
        )
        .with_state(state)
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            security,
            crate::auth::http_security::guard,
        ));

    append_profile_log(
        &profile_id,
        "stdout.log",
        &format!("[mcp] listening on http://127.0.0.1:{port}/mcp"),
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown.await;
        })
        .await?;
    Ok(())
}

fn bind_listener(port: u16) -> Result<tokio::net::TcpListener, String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|err| format!("MCP 本地端口 {port} 绑定失败: {err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("MCP 本地端口 {port} 设置非阻塞失败: {err}"))?;
    tokio::net::TcpListener::from_std(listener)
        .map_err(|err| format!("MCP 本地监听器初始化失败: {err}"))
}

async fn mcp_discovery() -> Response {
    ([(CACHE_CONTROL, "no-store")], Json(mcp_discovery_payload())).into_response()
}

fn mcp_discovery_payload() -> Value {
    json!({
        "name": "coding-tools-mcp",
        "version": env!("CARGO_PKG_VERSION"),
        "protocolVersion": "2026-07-28",
        "supportedVersions": ["2026-07-28", "2025-11-25", "2025-06-18"]
    })
}

fn resolve_oauth_base(state: &ListenerState, _headers: &HeaderMap) -> String {
    trusted_external_base_url(
        &state.workspace_id,
        false,
        state.bind_port,
        &state.configured_public_url,
    )
}

async fn mcp_post(State(state): State<ListenerState>, request: Request) -> Response {
    if let Some(response) = require_mcp_auth(&state, request.headers()) {
        append_profile_log(
            &state.workspace_id,
            "mcp-requests.log",
            &format!(
                "[transport] authentication_rejected status={}",
                response.status().as_u16()
            ),
        );
        return response;
    }
    let protocol_headers = request.headers().clone();
    let Json(body) = match Json::<Value>::from_request(request, &state).await {
        Ok(body) => body,
        Err(error) => return error.into_response(),
    };
    if let Some(response) = transport::validate_protocol_headers(&protocol_headers, &body) {
        return response;
    }
    if let Some(response) = transport::early_response(&body) {
        append_profile_log(
            &state.workspace_id,
            "mcp-requests.log",
            &format!(
                "[transport] envelope_handled status={}",
                response.status().as_u16()
            ),
        );
        return response;
    }
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let request_id = body.get("id").cloned().unwrap_or(Value::Null);
    let tool_name = body
        .get("params")
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    append_profile_log(
        &state.workspace_id,
        "mcp-requests.log",
        &format!(
            "[rpc] request id={} method={} tool={}",
            request_id, method, tool_name
        ),
    );

    let mcp = state.mcp.clone();
    let profile_id = state.workspace_id.clone();
    let permit = match crate::auth::http_security::acquire_tool_worker() {
        Ok(permit) => permit,
        Err(response) => return *response,
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        handle_request(&mcp, &body)
    })
    .await;
    match result {
        Ok(response) => {
            append_profile_log(
                &profile_id,
                "mcp-requests.log",
                &format!(
                    "[rpc] completed id={} method={} tool={}",
                    request_id, method, tool_name
                ),
            );
            if tool_name == "exec_command" || tool_name == "exec_health_check" {
                let structured = response
                    .get("result")
                    .and_then(|result| result.get("structuredContent"));
                let status = structured
                    .and_then(|value| value.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let termination_reason = structured
                    .and_then(|value| value.get("termination_reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let exit_code = structured
                    .and_then(|value| value.get("exit_code"))
                    .map(Value::to_string)
                    .unwrap_or_default();
                let is_error = response
                    .get("result")
                    .and_then(|result| result.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                append_profile_log(
                    &profile_id,
                    "mcp-requests.log",
                    &format!(
                        "[exec] id={} tool={} is_error={} status={} termination_reason={} exit_code={}",
                        request_id, tool_name, is_error, status, termination_reason, exit_code
                    ),
                );
            }
            if method == "tools/list" {
                if let Some(tools) = response.pointer("/result/tools").and_then(Value::as_array) {
                    append_profile_log(
                        &profile_id,
                        "mcp-requests.log",
                        &format!("[discovery] catalog_served tools_count={}", tools.len()),
                    );
                }
            }
            Json(response).into_response()
        }
        Err(error) => {
            append_profile_log(
                &profile_id,
                "mcp-requests.log",
                &format!(
                    "[rpc] worker_failed id={} method={} tool={} error={error}",
                    request_id, method, tool_name
                ),
            );
            Json(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32603,
                    "message": "Exec RPC worker failed",
                    "data": {
                        "stage": "rpc_worker",
                        "reason": "worker_failed",
                        "retryable": false,
                        "suggestion": "先检查操作状态，再决定是否重试；已接受的操作可能仍会完成"
                    }
                }
            }))
            .into_response()
        }
    }
}

fn require_mcp_auth(state: &ListenerState, headers: &HeaderMap) -> Option<Response> {
    if state.auth.bearer_enabled() {
        let expected = state.bearer_token.as_deref().unwrap_or("");
        return verify_bearer_header(headers, expected);
    }
    if state.auth.oauth_enabled() {
        if let Some(oauth) = state.oauth.as_ref() {
            let server_url = resolve_oauth_base(state, headers);
            return verify_oauth_bearer_header(headers, oauth, &server_url)
                .map(|response| transport::oauth_challenge(response, &server_url));
        }
    }
    if state.auth.auth_type == "noauth" {
        None
    } else {
        Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Authentication configuration is unavailable",
            )
                .into_response(),
        )
    }
}

async fn oauth_authorization_server_metadata(
    State(state): State<ListenerState>,
    headers: HeaderMap,
) -> Response {
    if !state.auth.oauth_enabled() {
        return oauth_not_configured();
    }
    let base = resolve_oauth_base(&state, &headers);
    Json(authorization_server_metadata(
        &base,
        state.oauth_client_secret.as_deref(),
    ))
    .into_response()
}

async fn oauth_protected_resource_metadata(
    State(state): State<ListenerState>,
    headers: HeaderMap,
) -> Response {
    if !state.auth.oauth_enabled() {
        return oauth_not_configured();
    }
    Json(protected_resource_metadata(&resolve_oauth_base(
        &state, &headers,
    )))
    .into_response()
}

async fn oauth_authorize_get(
    State(state): State<ListenerState>,
    Query(params): Query<AuthorizeParams>,
) -> Response {
    let Some(oauth) = state.oauth.as_ref() else {
        return oauth_not_configured();
    };
    let base = resolve_oauth_base(&state, &HeaderMap::new());
    authorize_get(oauth, params, Some(&base))
}

async fn oauth_authorize_post(
    State(state): State<ListenerState>,
    headers: HeaderMap,
    Form(form): Form<AuthorizeForm>,
) -> Response {
    let Some(oauth) = state.oauth.as_ref() else {
        return oauth_not_configured();
    };
    authorize_post_browser(oauth, &headers, form, &resolve_oauth_base(&state, &headers))
}

async fn oauth_token_post(
    State(state): State<ListenerState>,
    headers: HeaderMap,
    Form(form): Form<TokenForm>,
) -> Response {
    let Some(oauth) = state.oauth.as_ref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unsupported_grant_type" })),
        )
            .into_response();
    };
    token_exchange(oauth, &headers, form, &resolve_oauth_base(&state, &headers))
}

fn oauth_not_configured() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "OAuth not configured" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::header::CACHE_CONTROL;
    use axum::response::IntoResponse;

    use super::{bind_listener, mcp_discovery, mcp_discovery_payload};

    #[test]
    fn bind_listener_reports_port_conflict_synchronously() {
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("占用测试端口");
        let port = occupied.local_addr().expect("读取测试端口").port();

        assert!(bind_listener(port).is_err());
    }

    #[tokio::test]
    async fn discovery_reports_the_current_package_version() {
        let discovery = mcp_discovery_payload();

        assert_eq!(discovery["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn discovery_prevents_stale_tool_catalog_caching() {
        let response = mcp_discovery().await.into_response();

        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    }
}

#[cfg(test)]
mod live_permission_protocol_test {
    use super::*;
    use crate::tools::{live_policy::commit_updates, ToolContext};
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_policy_protocol_permission_updates_keep_same_listener_and_token() {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/live-http-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let mut context = ToolContext::for_test(root.clone(), root.join("harness")).unwrap();
        context.auth.auth_type = "bearer".into();
        let ctx = Arc::new(context);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = ListenerState {
            mcp: ctx.clone(),
            auth: ctx.auth.clone(),
            workspace_id: uuid::Uuid::new_v4().to_string(),
            bind_port: port,
            configured_public_url: String::new(),
            bearer_token: Some("isolated-fixture-token-not-a-real-secret".into()),
            oauth: None,
            oauth_client_secret: None,
        };
        let (stop, shutdown) = oneshot::channel();
        let worker = tokio::spawn(async move {
            serve(listener, port, state, shutdown).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let endpoint = format!("http://127.0.0.1:{port}/mcp");
        let request = |body: Value| {
            client
                .post(&endpoint)
                .bearer_auth("isolated-fixture-token-not-a-real-secret")
                .header("Accept", "application/json, text/event-stream")
                .json(&body)
                .send()
        };
        let catalog_request = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let before: Value = request(catalog_request.clone())
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(before["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "apply_patch"));
        let mut restricted = ctx.for_request().unwrap().policy;
        restricted.permission_mode = "read-only".into();
        commit_updates(vec![(ctx.clone(), restricted, "core".into())], || Ok(())).unwrap();
        let patch = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apply_patch","arguments":{"patch":"*** Begin Patch\n*** Add File: permission-live.txt\n+verified\n*** End Patch\n"}}});
        let denied: Value = request(patch.clone()).await.unwrap().json().await.unwrap();
        assert_eq!(denied["result"]["isError"], true, "{denied}");
        assert!(!root.join("permission-live.txt").exists());
        let mut writable = ctx.for_request().unwrap().policy;
        writable.permission_mode = "workspace-write".into();
        commit_updates(vec![(ctx.clone(), writable, "core".into())], || Ok(())).unwrap();
        let applied: Value = request(patch).await.unwrap().json().await.unwrap();
        assert_eq!(applied["result"]["isError"], false, "{applied}");
        assert_eq!(
            std::fs::read_to_string(root.join("permission-live.txt"))
                .unwrap()
                .trim(),
            "verified"
        );
        let after: Value = request(catalog_request)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            before["result"]["tools"], after["result"]["tools"],
            "Permission changes must not change tool schemas"
        );
        let info: Value = request(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"server_info","arguments":{}}})).await.unwrap().json().await.unwrap();
        assert_eq!(
            info["result"]["structuredContent"]["live_permissions"]["revision"], 2,
            "{info}"
        );
        let unauthorized = client
            .post(&endpoint)
            .json(&json!({"jsonrpc":"2.0","id":4,"method":"ping"}))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status().as_u16(), 401);
        assert!(
            !worker.is_finished(),
            "No listener restart or exit occurred"
        );
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .unwrap()
            .unwrap();
        println!("PASS: same HTTP listener + same bearer token + unchanged tool schemas; live read-only deny then workspace-write allow; no restart or relink");
    }
}
