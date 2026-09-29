//! Authenticated loopback control service for the Electron-first Coding Tools
//! desktop. The service owns no model and performs no automatic replay.

use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use coding_tools_core::{integrations, tools, AoCodexConnection, AoCodexHub, CoreState};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tokio::sync::Notify;

const CONTROL_PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_RESULT_BYTES: usize = 262_144;
const MAX_OPERATION_RECORDS: usize = 128;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn text_error(error: impl std::fmt::Display) -> String {
    error.to_string().chars().take(512).collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct LifecycleSnapshot {
    pub accepting: bool,
    pub active_requests: usize,
    pub max_active_requests: usize,
    pub drain_reason: Option<String>,
}

#[derive(Debug)]
struct LifecycleState {
    accepting: bool,
    active_requests: usize,
    drain_reason: Option<String>,
}

#[derive(Debug)]
struct LifecycleInner {
    state: Mutex<LifecycleState>,
    notify: Notify,
    max_active_requests: usize,
}

/// Bounded admission and explicit drain/resume control. Dropping a lease only
/// settles the admitted local request; it never replays or cancels tool work.
#[derive(Clone, Debug)]
pub struct Lifecycle {
    inner: Arc<LifecycleInner>,
}

#[derive(Debug)]
pub struct RequestLease {
    inner: Arc<LifecycleInner>,
    settled: bool,
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.settled = true;
        let mut state = self.inner.state.lock().expect("lifecycle state lock");
        state.active_requests = state.active_requests.saturating_sub(1);
        drop(state);
        self.inner.notify.notify_waiters();
    }
}

impl Lifecycle {
    pub fn new(max_active_requests: usize) -> Self {
        Self {
            inner: Arc::new(LifecycleInner {
                state: Mutex::new(LifecycleState {
                    accepting: true,
                    active_requests: 0,
                    drain_reason: None,
                }),
                notify: Notify::new(),
                max_active_requests: max_active_requests.max(1),
            }),
        }
    }

    pub fn admit(&self, _kind: &str) -> Result<RequestLease, String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "lifecycle unavailable")?;
        if !state.accepting {
            return Err("HEADLESS_DRAINING: new work is not accepted".into());
        }
        if state.active_requests >= self.inner.max_active_requests {
            return Err("HEADLESS_CAPACITY: request admission is full".into());
        }
        state.active_requests += 1;
        Ok(RequestLease {
            inner: self.inner.clone(),
            settled: false,
        })
    }

    pub fn drain(&self, reason: &str) -> Result<(), String> {
        let reason = reason.trim();
        if reason.is_empty() || reason.len() > 256 {
            return Err("Drain reason must contain 1..256 characters".into());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "lifecycle unavailable")?;
        state.accepting = false;
        state.drain_reason = Some(reason.to_string());
        self.inner.notify.notify_waiters();
        Ok(())
    }

    pub fn resume(&self) -> Result<(), String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "lifecycle unavailable")?;
        state.accepting = true;
        state.drain_reason = None;
        self.inner.notify.notify_waiters();
        Ok(())
    }

    pub fn snapshot(&self) -> LifecycleSnapshot {
        let state = self.inner.state.lock().expect("lifecycle state lock");
        LifecycleSnapshot {
            accepting: state.accepting,
            active_requests: state.active_requests,
            max_active_requests: self.inner.max_active_requests,
            drain_reason: state.drain_reason.clone(),
        }
    }

    pub async fn wait_idle(&self, timeout: Duration) -> bool {
        let wait = async {
            loop {
                if self.snapshot().active_requests == 0 {
                    return;
                }
                self.inner.notify.notified().await;
            }
        };
        tokio::time::timeout(timeout, wait).await.is_ok()
    }
}

#[derive(Clone)]
struct ControlAuth {
    token: Arc<str>,
    token_sha256: String,
}

impl ControlAuth {
    fn generate() -> Self {
        let mut bytes = [0_u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let token_sha256 = format!("{:x}", Sha256::digest(token.as_bytes()));
        Self {
            token: Arc::from(token),
            token_sha256,
        }
    }

    fn require(&self, headers: &HeaderMap) -> Result<(), StatusCode> {
        let supplied = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let expected = self.token.as_bytes();
        let supplied = supplied.as_bytes();
        if expected.len() != supplied.len() || expected.ct_eq(supplied).unwrap_u8() != 1 {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub app_data_dir: PathBuf,
    pub descriptor_path: PathBuf,
    pub max_active_requests: usize,
    pub drain_timeout: Duration,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, String> {
        let app_data_dir = std::env::var_os("CODING_TOOLS_APP_DATA_DIR")
            .map(PathBuf::from)
            .ok_or("CODING_TOOLS_APP_DATA_DIR is required")?;
        let descriptor_path = std::env::var_os("CODING_TOOLS_CONTROL_DESCRIPTOR_FILE")
            .map(PathBuf::from)
            .ok_or("CODING_TOOLS_CONTROL_DESCRIPTOR_FILE is required")?;
        Ok(Self {
            app_data_dir,
            descriptor_path,
            max_active_requests: 16,
            drain_timeout: Duration::from_secs(15),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
struct Descriptor<'a> {
    schema: u32,
    protocol_version: u32,
    pid: u32,
    endpoint: &'a str,
    version: &'a str,
    token_sha256: &'a str,
    token_file: String,
    app_data_dir: String,
    started_at_ms: u64,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    shutdown_reason: Option<&'a str>,
}

fn restrict_file(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(text_error)?;
    }
    Ok(())
}

fn unique_name(prefix: &str, suffix: &str) -> String {
    format!("{prefix}-{}-{}.{}", now_ms(), uuid::Uuid::new_v4(), suffix)
}

fn preserve_existing(path: &Path, app_data_dir: &Path, label: &str) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to replace linked {label}: {}",
            path.display()
        ));
    }
    let retained = app_data_dir
        .join("Trash")
        .join("headless-control")
        .join(unique_name(label, "retained"));
    fs::create_dir_all(retained.parent().expect("retained parent")).map_err(text_error)?;
    fs::rename(path, retained).map_err(text_error)
}

fn write_private_file(
    path: &Path,
    bytes: &[u8],
    app_data_dir: &Path,
    label: &str,
) -> Result<(), String> {
    preserve_existing(path, app_data_dir, label)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(text_error)?;
    }
    let temp_dir = app_data_dir.join("aiTemp").join("headless-control");
    fs::create_dir_all(&temp_dir).map_err(text_error)?;
    let temp = temp_dir.join(unique_name(label, "tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(text_error)?;
    file.write_all(bytes).map_err(text_error)?;
    file.sync_all().map_err(text_error)?;
    restrict_file(&temp)?;
    fs::rename(&temp, path).map_err(text_error)?;
    restrict_file(path)
}

#[derive(Debug, Clone, Serialize)]
struct OperationReceipt {
    request_id: String,
    fingerprint: String,
    workspace_id: String,
    tool: String,
    state: String,
    admitted_at_ms: u64,
    finished_at_ms: Option<u64>,
    result: Option<Value>,
    error: Option<String>,
    automatic_replay: bool,
}

#[derive(Default)]
struct OperationStore {
    order: VecDeque<String>,
    records: HashMap<String, OperationReceipt>,
}

impl OperationStore {
    fn insert(&mut self, receipt: OperationReceipt) {
        let id = receipt.request_id.clone();
        if !self.records.contains_key(&id) {
            self.order.push_back(id.clone());
        }
        self.records.insert(id, receipt);
        while self.order.len() > MAX_OPERATION_RECORDS {
            if let Some(oldest) = self.order.pop_front() {
                if self
                    .records
                    .get(&oldest)
                    .is_some_and(|item| item.state != "running")
                {
                    self.records.remove(&oldest);
                } else {
                    self.order.push_front(oldest);
                    break;
                }
            }
        }
    }
}

struct ContextEntry {
    fingerprint: String,
    context: Arc<tools::ToolContext>,
}

#[derive(Clone)]
struct ServiceState {
    lifecycle: Lifecycle,
    auth: ControlAuth,
    local_ui_token: Option<String>,
    core: Arc<CoreState>,
    contexts: Arc<Mutex<HashMap<String, ContextEntry>>>,
    ao_hubs: Arc<Mutex<HashMap<(String, String, String), Arc<AoCodexHub>>>>,
    ao_home_root: PathBuf,
    operations: Arc<Mutex<OperationStore>>,
    shutdown_tx: tokio::sync::watch::Sender<Option<String>>,
    drain_timeout: Duration,
}

impl ServiceState {
    fn context(&self, workspace_id: &str) -> Result<Arc<tools::ToolContext>, String> {
        let profile = self
            .core
            .with_data(|store| {
                store.refresh()?;
                store.get(workspace_id).cloned().ok_or_else(|| {
                    coding_tools_core::error::AppError::Message("workspace not found".into())
                })
            })
            .map_err(text_error)?;
        let bytes = serde_json::to_vec(&profile).map_err(text_error)?;
        let fingerprint = format!("{:x}", Sha256::digest(bytes));
        let mut contexts = self
            .contexts
            .lock()
            .map_err(|_| "context cache unavailable")?;
        if let Some(entry) = contexts.get(workspace_id) {
            if entry.fingerprint == fingerprint {
                return Ok(entry.context.clone());
            }
        }
        let mut context = tools::ToolContext::new(PathBuf::from(&profile.path))?;
        context.bind_workspace_id(workspace_id);
        context.auth = profile.auth.clone();
        context.policy = tools::PolicySettings::from_runtime(&profile.runtime);
        context.tool_profile =
            tools::registry::normalize_tool_profile(&profile.runtime.tool_profile).into();
        context.permission_mode = context.policy.canonical_permission_mode().to_string();
        let context = Arc::new(context);
        contexts.insert(
            workspace_id.to_string(),
            ContextEntry {
                fingerprint,
                context: context.clone(),
            },
        );
        Ok(context)
    }

    fn safe_workspaces(&self) -> Result<Vec<Value>, String> {
        self.core
            .with_data(|store| {
                store.refresh()?;
                Ok(store
                    .list()
                    .iter()
                    .map(|profile| {
                        json!({
                            "id": profile.id,
                            "name": profile.name,
                            "path": profile.path,
                            "linked_projects": tools::Workspace::new(PathBuf::from(&profile.path))
                                .map(|workspace| workspace.linked_projects())
                                .unwrap_or_default(),
                            "tool_profile": profile.runtime.tool_profile,
                            "permission_mode": profile.runtime.permission_mode,
                            "approval_mode": profile.runtime.approval_mode,
                            "mcp_auth_type": profile.auth.auth_type,
                            "actions_auth_type": profile.actions.auth_type,
                            "mcp_local_port": profile.runtime.local_port,
                            "actions_local_port": profile.actions.local_port,
                            "screen_capture_enabled": profile.runtime.allow_screen_capture,
                            "mcp_oauth_client_id": profile.auth.oauth_client_id,
                            "mcp_oauth_redirect_uris": profile.auth.oauth_redirect_uris,
                            "mcp_use_shared_secrets": profile.auth.use_shared_secrets,
                            "actions_oauth_client_id": profile.actions.oauth_client_id,
                            "actions_oauth_redirect_uris": profile.actions.oauth_redirect_uris,
                            "actions_oauth_scopes": profile.actions.oauth_scopes,
                            "actions_use_shared_secrets": profile.actions.use_shared_secrets,
                        })
                    })
                    .collect())
            })
            .map_err(text_error)
    }
}

#[derive(Debug, Deserialize)]
struct DrainRequest {
    reason: String,
}

#[derive(Debug, Deserialize)]
struct WorkspaceQuery {
    workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceAuthUpdateRequest {
    workspace_id: String,
    service: String,
    auth_type: String,
    oauth_client_id: String,
    oauth_redirect_uris: Vec<String>,
    #[serde(default)]
    oauth_scopes: String,
    use_shared_secrets: bool,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceCreateRequest {
    path: String,
    name: Option<String>,
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspacePolicyUpdateRequest {
    workspace_id: String,
    permission_mode: String,
    approval_mode: String,
    tool_profile: String,
    screen_capture_enabled: bool,
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCodexWorkspaceRequest {
    workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCodexConnectRequest {
    workspace_id: String,
    connection: Value,
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCodexApprovalRequest {
    workspace_id: String,
    approval_id: String,
    allow: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceServiceRequest {
    workspace_id: String,
    service: String,
    operation: String,
    #[serde(default)]
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceSecretRequest {
    workspace_id: String,
    key: String,
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCallRequest {
    request_id: String,
    workspace_id: String,
    tool: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IntegrationReadRequest {
    source: integrations::Source,
    endpoint: String,
    #[serde(default)]
    credential: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoReadRequest {
    workspace_id: String,
    run_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum AoMutation {
    CreateFromTeam {
        run_id: String, task_id: String, expected_board_revision: u64, team_revision: u64, worker_limit: u8,
    },
    Create {
        expected_board_revision: u64,
        run: integrations::ao::Run,
    },
    Graph {
        run_id: String,
        expected_revision: u64,
        change: integrations::ao::GraphChange,
    },
    Cancel {
        run_id: String,
        expected_revision: u64,
    },
    SaveTeam { expected_revision: u64, team: integrations::ao_team::Team },
    ApplyTeam { run_id: String, expected_revision: u64, team_revision: u64 },
    SetLimits { expected_revision: u64, max_workers: u8, run_id: Option<String>, run_revision: Option<u64>, worker_limit: Option<u8> },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoUpdateRequest {
    workspace_id: String,
    change: AoMutation,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoControlRequest { workspace_id: String, run_id: String, action: String, confirm: bool }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoHarnessNodeRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoHarnessConnectRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
    connection: Value,
    #[serde(default)]
    private_proxy_api_key: Option<String>,
    #[serde(default)]
    web_bridge_base_url: Option<String>,
    #[serde(default)]
    web_model_catalog: Option<Value>,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoHarnessDisconnectRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoHarnessExecuteRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
    expected_revision: u64,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoExternalSubmittedRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
    request_key: String,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoExternalTerminalRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
    session_id: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    answer: Option<String>,
    completed: bool,
    #[serde(default)]
    failure: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoRunGrantRequest {
    workspace_id: String,
    run_id: String,
    expected_revision: u64,
    executable_sha256: String,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AoHarnessApprovalRequest {
    workspace_id: String,
    run_id: String,
    node_id: String,
    approval_id: String,
    allow: bool,
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionReadRequest {
    workspace_id: String,
    mission_id: Option<String>,
    #[serde(default)]
    refresh_source: bool,
}

fn json_error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": {"code": code, "message": message.into()}
        })),
    )
        .into_response()
}

fn auth(headers: &HeaderMap, state: &ServiceState) -> Result<(), Box<Response>> {
    state.auth.require(headers).map_err(|status| {
        Box::new(json_error(
            status,
            "UNAUTHORIZED",
            "A valid local control token is required",
        ))
    })
}

fn local_ui_authorized(headers: &HeaderMap, state: &ServiceState) -> bool {
    let Some(expected) = state.local_ui_token.as_deref() else {
        return false;
    };
    let Some(provided) = headers
        .get("x-coding-tools-local-ui")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    provided.len() == expected.len()
        && provided.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() == 1
}

fn admit(state: &ServiceState, kind: &str) -> Result<RequestLease, Box<Response>> {
    state.lifecycle.admit(kind).map_err(|message| {
        let status = if message.starts_with("HEADLESS_DRAINING") {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::TOO_MANY_REQUESTS
        };
        Box::new(json_error(status, "HEADLESS_NOT_ACCEPTING", message))
    })
}

async fn health(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "health") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let snapshot = state.lifecycle.snapshot();
    Json(json!({
        "ready": true,
        "protocol_version": CONTROL_PROTOCOL_VERSION,
        "version": env!("CARGO_PKG_VERSION"),
        "accepting": snapshot.accepting,
        "active_requests": snapshot.active_requests,
        "max_active_requests": snapshot.max_active_requests,
        "drain_reason": snapshot.drain_reason,
        "automatic_replay": false,
    }))
    .into_response()
}

async fn drain(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<DrainRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    if let Err(error) = state.lifecycle.drain(&body.reason) {
        return json_error(StatusCode::BAD_REQUEST, "INVALID_DRAIN", error);
    }
    let idle = state.lifecycle.wait_idle(state.drain_timeout).await;
    Json(json!({
        "ok": true,
        "accepting": false,
        "idle": idle,
        "active_requests": state.lifecycle.snapshot().active_requests,
        "safe_to_shutdown": idle,
        "automatic_replay": false,
    }))
    .into_response()
}

async fn resume(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    match state.lifecycle.resume() {
        Ok(()) => Json(json!({"ok":true,"accepting":true})).into_response(),
        Err(error) => json_error(StatusCode::CONFLICT, "RESUME_FAILED", error),
    }
}

async fn shutdown(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<DrainRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    if let Err(error) = state.lifecycle.drain(&body.reason) {
        return json_error(StatusCode::BAD_REQUEST, "INVALID_SHUTDOWN", error);
    }
    if !state.lifecycle.wait_idle(state.drain_timeout).await {
        return json_error(
            StatusCode::CONFLICT,
            "HEADLESS_BUSY",
            "Active requests remain; shutdown was not signalled",
        );
    }
    let _ = state.shutdown_tx.send(Some(body.reason));
    Json(json!({"ok":true,"shutdown_requested":true,"automatic_replay":false})).into_response()
}

async fn state_view(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "state") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match state.safe_workspaces() {
        Ok(workspaces) => Json(json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "lifecycle": state.lifecycle.snapshot(),
            "workspaces": workspaces,
            "automatic_replay": false,
        }))
        .into_response(),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "STATE_READ_FAILED",
            error,
        ),
    }
}

fn apply_workspace_auth_update(
    core: &CoreState,
    body: &WorkspaceAuthUpdateRequest,
) -> Result<Value, String> {
    if !body.confirm {
        return Err("Local confirmation is required to change workspace authentication".into());
    }
    if body.workspace_id.trim().is_empty() || body.workspace_id.len() > 128 {
        return Err("A valid workspace_id is required".into());
    }
    if body.oauth_client_id.len() > 256
        || body.oauth_client_id.chars().any(char::is_control)
        || body.oauth_scopes.len() > 1024
        || body.oauth_scopes.chars().any(char::is_control)
    {
        return Err("OAuth client ID or scopes are invalid".into());
    }
    let valid_type = match body.service.as_str() {
        "mcp" => matches!(body.auth_type.as_str(), "oauth" | "bearer" | "noauth"),
        "actions" => matches!(body.auth_type.as_str(), "oauth" | "api_key" | "none"),
        _ => false,
    };
    if !valid_type || (body.service == "mcp" && !body.oauth_scopes.is_empty()) {
        return Err("Unsupported service or authentication type".into());
    }
    if body.auth_type == "oauth" {
        if body.oauth_client_id.trim().is_empty() {
            return Err("OAuth client ID is required".into());
        }
        coding_tools_core::validate_redirect_uris(&body.oauth_redirect_uris)?;
    }
    core.with_data(|store| {
        let mut profile = store.get(&body.workspace_id).cloned().ok_or_else(|| {
            coding_tools_core::error::AppError::Message("Workspace was not found".into())
        })?;
        if body.service == "mcp" {
            profile.auth.auth_type = body.auth_type.clone();
            profile.auth.oauth_client_id = body.oauth_client_id.trim().into();
            profile.auth.oauth_redirect_uris = body.oauth_redirect_uris.clone();
            profile.auth.use_shared_secrets = body.use_shared_secrets;
        } else {
            profile.actions.auth_type = body.auth_type.clone();
            profile.actions.oauth_client_id = body.oauth_client_id.trim().into();
            profile.actions.oauth_redirect_uris = body.oauth_redirect_uris.clone();
            profile.actions.oauth_scopes = body.oauth_scopes.trim().into();
            profile.actions.use_shared_secrets = body.use_shared_secrets;
        }
        store.update(profile)
    })
    .map_err(text_error)?;
    Ok(json!({
        "ok": true,
        "workspace_id": body.workspace_id,
        "service": body.service,
        "auth_type": body.auth_type,
        "applies_on_next_listener_start": true,
    }))
}

fn apply_workspace_policy_update(
    core: &CoreState,
    body: &WorkspacePolicyUpdateRequest,
) -> Result<Value, String> {
    if !body.confirm {
        return Err("Local confirmation is required to change workspace policy".into());
    }
    if body.workspace_id.trim().is_empty()
        || body.workspace_id.len() > 128
        || !matches!(
            body.permission_mode.as_str(),
            "read-only" | "workspace-write"
        )
        || !matches!(body.approval_mode.as_str(), "ask" | "on-request" | "never")
        || !matches!(
            body.tool_profile.as_str(),
            "read-only" | "core" | "advanced" | "compat-readonly-all"
        )
    {
        return Err("Unsupported workspace policy".into());
    }
    let root = core
        .with_data(|store| {
            let mut profile = store.get(&body.workspace_id).cloned().ok_or_else(|| {
                coding_tools_core::error::AppError::Message("Workspace was not found".into())
            })?;
            if body.screen_capture_enabled
                && !matches!(profile.auth.auth_type.as_str(), "bearer" | "oauth")
            {
                return Err(coding_tools_core::error::AppError::Message(
                    "Screen capture requires Bearer or OAuth MCP authentication".into(),
                ));
            }
            profile.runtime.permission_mode = body.permission_mode.clone();
            profile.runtime.approval_mode = body.approval_mode.clone();
            profile.runtime.tool_profile = body.tool_profile.clone();
            profile.runtime.allow_screen_capture = body.screen_capture_enabled;
            let root = profile.path.clone();
            store.update(profile)?;
            Ok(root)
        })
        .map_err(text_error)?;
    if let Ok(workspace) = tools::Workspace::new(PathBuf::from(root)) {
        tools::computer::stop_workspace(workspace.root());
    }
    Ok(json!({
        "ok": true,
        "workspace_id": body.workspace_id,
        "applies_on_next_listener_start": true,
    }))
}

#[cfg(test)]
mod workspace_auth_tests {
    use super::*;

    #[test]
    fn ao_execute_accepts_only_saved_task_scope() {
        let request = json!({"workspace_id":"qa","run_id":"run","node_id":"planner",
            "expected_revision":1,"confirm":true});
        assert!(serde_json::from_value::<AoHarnessExecuteRequest>(request.clone()).is_ok());
        let mut with_prompt = request;
        with_prompt["prompt"] = json!("renderer override");
        assert!(serde_json::from_value::<AoHarnessExecuteRequest>(with_prompt).is_err());
    }

    #[test]
    fn orchestration_reservation_body_is_nested_and_rejects_credentials() {
        let body = json!({
            "workspace_id": "qa",
            "id": "run-1",
            "task_id": "parent-task",
            "expected_board_revision": 7,
            "planner_prompt": "{\"task\":\"plan only\"}",
            "planner": {
                "binding_id": "web",
                "binding_generation": "web-generation",
                "mission_id": "planner-mission",
                "request_key": "planner-request"
            },
            "workers": [{
                "binding_id": "gemini",
                "binding_generation": "gemini-generation",
                "mission_id": "worker-mission",
                "request_key": "worker-request"
            }],
            "reviewer": {
                "binding_id": "web",
                "binding_generation": "web-generation",
                "mission_id": "reviewer-mission",
                "request_key": "reviewer-request"
            }
        });
        let parsed = serde_json::from_value::<
            integrations::execution::service::OrchestrationReservation,
        >(body.clone())
        .unwrap();
        assert_eq!(parsed.workers.len(), 1);
        assert_eq!(parsed.planner_prompt, "{\"task\":\"plan only\"}");

        let mut with_secret = body;
        with_secret["credential"] = json!("must-not-enter-this-route");
        assert!(
            serde_json::from_value::<integrations::execution::service::OrchestrationReservation>(
                with_secret
            )
            .is_err()
        );
    }

    #[test]
    fn orchestration_status_body_rejects_credentials() {
        let body = json!({
            "workspace_id": "qa", "id": "run-1", "expected_revision": 2,
            "status": "reviewing"
        });
        let parsed =
            serde_json::from_value::<integrations::execution::service::OrchestrationStatus>(
                body.clone(),
            )
            .unwrap();
        assert_eq!(parsed.status, "reviewing");
        let mut with_secret = body;
        with_secret["credential"] = json!("not-accepted");
        assert!(
            serde_json::from_value::<integrations::execution::service::OrchestrationStatus>(
                with_secret
            )
            .is_err()
        );
    }

    #[test]
    fn orchestration_reservation_rejects_cross_run_identity_reuse_atomically() {
        use integrations::execution::{
            model::Action,
            service::{
                reserve_orchestration_in_data, OrchestrationReservation, OrchestrationStage,
            },
        };

        let workspace = tempfile::tempdir().unwrap();
        let harness = tempfile::tempdir().unwrap();
        let mut context = tools::ToolContext::for_test(
            workspace.path().to_path_buf(),
            harness.path().to_path_buf(),
        )
        .unwrap();
        context.bind_workspace_id("qa");
        context.auth.auth_type = "bearer".into();
        context.tool_profile = "advanced".into();
        let policy_stamp = format!(
            "{:x}",
            Sha256::digest(format!("{:?}|{}", context.policy, context.tool_profile).as_bytes())
        );
        let mut data: coding_tools_core::data::AppData = serde_json::from_value(json!({
            "profiles": [{
                "id": "qa", "name": "QA", "path": workspace.path().to_string_lossy(),
                "tunnel": {}, "auth": {"type": "bearer"},
                "runtime": {"permission_mode": "workspace-write", "tool_profile": "advanced"},
                "actions": {}
            }],
            "control_board": {"revision": 0, "tasks": [{
                "id": "parent-task", "workspace_id": "qa", "title": "User task",
                "description": "Keep", "state": "in_progress", "step": 0,
                "created_at": 1, "updated_at": 1, "evidence": []
            }]},
            "execution_book": {"bindings": [
                {
                    "id": "web", "workspace_id": "qa",
                    "root": context.workspace.root_display(),
                    "roots_revision": context.workspace.roots_revision(),
                    "policy_stamp": policy_stamp, "generation": "web-generation",
                    "engine": "paseo", "endpoint": "ws://127.0.0.1:6768/ws",
                    "provider": "chatgpt-web", "model": "chatgpt-web/high",
                    "account_id": "web-account", "route_id": "web-route",
                    "mode": "full-access", "project_id": null, "repo_id": null,
                    "assignee_id": null, "max_duration_min": 10,
                    "allow_codex": false, "enabled": true
                },
                {
                    "id": "gemini", "workspace_id": "qa",
                    "root": context.workspace.root_display(),
                    "roots_revision": context.workspace.roots_revision(),
                    "policy_stamp": policy_stamp, "generation": "gemini-generation",
                    "engine": "paseo", "endpoint": "ws://127.0.0.1:6768/ws",
                    "provider": "cliproxyapi-antigravity", "model": "gemini-3.8-flash-high",
                    "account_id": "gemini-account", "route_id": "gemini-route",
                    "mode": "full-access", "project_id": null, "repo_id": null,
                    "assignee_id": null, "max_duration_min": 10,
                    "allow_codex": false, "enabled": true
                }
            ]}
        }))
        .unwrap();
        let request = |id: &str, revision: u64| OrchestrationReservation {
            workspace_id: "qa".into(),
            id: id.into(),
            task_id: "parent-task".into(),
            expected_board_revision: revision,
            planner_prompt: "{\"task\":\"plan only\"}".into(),
            planner: OrchestrationStage {
                binding_id: "web".into(),
                binding_generation: "web-generation".into(),
                mission_id: format!("{id}-planner"),
                request_key: format!("{id}-planner-key"),
            },
            workers: vec![OrchestrationStage {
                binding_id: "gemini".into(),
                binding_generation: "gemini-generation".into(),
                mission_id: format!("{id}-worker"),
                request_key: format!("{id}-worker-key"),
            }],
            reviewer: OrchestrationStage {
                binding_id: "web".into(),
                binding_generation: "web-generation".into(),
                mission_id: format!("{id}-reviewer"),
                request_key: format!("{id}-reviewer-key"),
            },
        };

        let first = request("run-1", 0);
        reserve_orchestration_in_data(&context, &mut data, first.clone()).unwrap();
        let exact = serde_json::to_value(&data).unwrap();
        reserve_orchestration_in_data(&context, &mut data, first.clone()).unwrap();
        assert_eq!(serde_json::to_value(&data).unwrap(), exact);

        for collision in 0..6 {
            let mut candidate = request(
                &format!("run-{}", collision + 2),
                data.control_board.revision,
            );
            match collision {
                0 => candidate.planner.mission_id = first.planner.mission_id.clone(),
                1 => candidate.workers[0].mission_id = first.workers[0].mission_id.clone(),
                2 => candidate.reviewer.mission_id = first.reviewer.mission_id.clone(),
                3 => candidate.planner.request_key = first.planner.request_key.clone(),
                4 => candidate.workers[0].request_key = first.workers[0].request_key.clone(),
                _ => candidate.reviewer.request_key = first.reviewer.request_key.clone(),
            }
            let mut attempt = data.clone();
            let before = serde_json::to_value(&attempt).unwrap();
            assert!(reserve_orchestration_in_data(&context, &mut attempt, candidate).is_err());
            assert_eq!(serde_json::to_value(attempt).unwrap(), before);
        }

        let mut prepared = data.clone();
        prepared
            .execution_book
            .prepare(
                "qa",
                "web",
                "parent-task",
                "prepared-mission",
                "Prepared",
                "Prepared task",
                1,
            )
            .unwrap();
        prepared
            .execution_book
            .reserve(
                "qa",
                "prepared-mission",
                0,
                "prepared-key",
                "runtime",
                Action::Create,
            )
            .unwrap();
        for request in [
            {
                let mut candidate =
                    request("run-prepared-mission", prepared.control_board.revision);
                candidate.planner.mission_id = "prepared-mission".into();
                candidate
            },
            {
                let mut candidate = request("run-prepared-key", prepared.control_board.revision);
                candidate.planner.request_key = "prepared-key".into();
                candidate
            },
        ] {
            let mut attempt = prepared.clone();
            let before = serde_json::to_value(&attempt).unwrap();
            assert!(reserve_orchestration_in_data(&context, &mut attempt, request).is_err());
            assert_eq!(serde_json::to_value(attempt).unwrap(), before);
        }
    }

    #[test]
    fn confirmed_auth_update_preserves_other_workspace_settings() {
        let data = serde_json::from_value(serde_json::json!({
            "profiles": [{
                "id": "ws-1", "name": "Demo", "path": ".",
                "tunnel": {}, "auth": {"type": "bearer"},
                "runtime": {"permission_mode": "read-only"}, "actions": {"auth_type": "api_key"}
            }]
        }))
        .expect("in-memory profile");
        let core = CoreState::from_data(data).expect("in-memory core");
        let mut request = WorkspaceAuthUpdateRequest {
            workspace_id: "ws-1".into(),
            service: "mcp".into(),
            auth_type: "oauth".into(),
            oauth_client_id: "client-1".into(),
            oauth_redirect_uris: vec![
                "https://chatgpt.com/connector_platform/oauth/callback".into()
            ],
            oauth_scopes: String::new(),
            use_shared_secrets: false,
            confirm: false,
        };
        assert!(apply_workspace_auth_update(&core, &request).is_err());
        request.confirm = true;
        request.oauth_redirect_uris = vec!["http://example.com/callback".into()];
        assert!(apply_workspace_auth_update(&core, &request).is_err());
        request.oauth_redirect_uris =
            vec!["https://chatgpt.com/connector_platform/oauth/callback".into()];
        assert_eq!(
            apply_workspace_auth_update(&core, &request).unwrap()["ok"],
            true
        );
        let saved = core
            .with_data(|store| Ok(store.get("ws-1").cloned().unwrap()))
            .unwrap();
        assert_eq!(saved.auth.auth_type, "oauth");
        assert_eq!(saved.auth.oauth_client_id, "client-1");
        assert_eq!(saved.actions.auth_type, "api_key");
        assert_eq!(saved.runtime.permission_mode, "read-only");
    }

    #[test]
    fn ao_cpa_home_config_is_keyless_and_refuses_drift() {
        let app_data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../aiTemp/ao-cpa-home-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let home = app_data.join("ao-homes/worker");
        prepare_ao_cpa_home(&home, &app_data).unwrap();
        let config = home.join("config.toml");
        let saved = fs::read_to_string(&config).unwrap();
        assert!(saved.contains("model_provider = \"coding_tools_ao_cpa\""));
        assert!(saved.contains("base_url = \"http://127.0.0.1:8317/v1\""));
        assert!(saved.contains("env_key = \"CODING_TOOLS_AO_CPA_KEY\""));
        assert!(!saved.contains("SENTINEL_KEY_DO_NOT_LOG"));
        prepare_ao_cpa_home(&home, &app_data).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), saved);
        fs::write(&config, "unexpected provider config").unwrap();
        assert!(prepare_ao_cpa_home(&home, &app_data).is_err());
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "unexpected provider config"
        );
    }

    #[test]
    fn ao_web_home_uses_only_the_local_bridge_and_its_verified_catalog() {
        let app_data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../aiTemp/ao-web-home-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let home = app_data.join("ao-homes/planner");
        let catalog =
            serde_json::json!({"models":[{"slug":"chatgpt-web/high","visibility":"list"}]});
        prepare_ao_web_home(&home, &app_data, "http://127.0.0.1:17841/v1", &catalog).unwrap();
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"chatgpt-web/high\""));
        assert!(config.contains("env_key = \"CODING_TOOLS_AO_WEB_KEY\""));
        assert!(config.contains("base_url = \"http://127.0.0.1:17841/v1\""));
        assert!(!config.contains("SENTINEL_KEY_DO_NOT_LOG"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(home.join("models.json")).unwrap()
            )
            .unwrap(),
            catalog
        );
        assert!(
            prepare_ao_web_home(&home, &app_data, "http://127.0.0.1:17841/v1", &catalog).is_ok()
        );
        assert!(
            prepare_ao_web_home(&home, &app_data, "http://127.0.0.1:17842/v1", &catalog).is_err()
        );
        assert!(prepare_ao_web_home(&home, &app_data, "http://example.com/v1", &catalog).is_err());
    }

    #[test]
    fn ao_home_creation_is_scoped_to_one_hashed_node() {
        let app_data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../aiTemp/ao-home-scope-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&app_data).unwrap();
        let root = app_data.join("ao-homes");
        let child = root.join("a".repeat(64));
        let actual = prepare_ao_home(&root, &child).unwrap();
        assert!(actual.is_dir());
        assert_eq!(actual.parent().unwrap(), root.canonicalize().unwrap());
        let outside = app_data.join("outside");
        assert!(prepare_ao_home(&root, &outside).is_err());
        assert!(!outside.exists());
        let invalid = root.join("not-a-hash");
        assert!(prepare_ao_home(&root, &invalid).is_err());
        assert!(!invalid.exists());
    }

    #[test]
    fn ao_connect_policy_keeps_worker_pool_and_web_key_separate() {
        let mut node = integrations::ao::Node {
            id: "worker".into(),
            task_id: "task".into(),
            clause_id: None,
            role: integrations::ao::Role::Worker,
            parents: vec!["planner".into()],
            x: 0,
            y: 1,
            state: integrations::ao::State::Pending,
            route: integrations::ao::Route {
                harness_id: "codex-native".into(),
                provider_id: "cliproxyapi-antigravity".into(),
                account_id: "shared-cpa-pool".into(),
                model: "gemini-3.8-flash-high".into(),
                permission_profile: ":read-only".into(),
            },
            request_key: None,
            receipt: None,
        };
        let mut connection = AoCodexConnection {
            executable: PathBuf::from("codex"),
            expected_sha256: "0".repeat(64),
            codex_home: PathBuf::from("ao-home"),
            allow_model_usage: true,
            allow_command_execution: false,
            permission_profile: ":read-only".into(),
            model: "gemini-3.8-flash-high".into(),
            request_limit: 1,
            lifetime_seconds: 30,
        };
        let sentinel = "SENTINEL_KEY_DO_NOT_LOG_1234567890";
        assert_eq!(
            ao_connect_policy(&node, &connection, Some(sentinel)).unwrap(),
            true
        );
        assert!(ao_connect_policy(&node, &connection, None).is_err());
        // Any CPA pool model is allowed for a worker, but not a model name with config syntax.
        node.route.model = "claude-sonnet-4-6".into();
        connection.model = node.route.model.clone();
        assert!(ao_connect_policy(&node, &connection, Some(sentinel)).unwrap());
        node.route.model = "bad\"model".into();
        connection.model = node.route.model.clone();
        assert!(ao_connect_policy(&node, &connection, Some(sentinel)).is_err());
        // A worker may also run on WebGPT, which never receives the CPA key.
        node.route.provider_id = "chatgpt-web".into();
        node.route.model = "chatgpt-web/high".into();
        connection.model = node.route.model.clone();
        assert!(!ao_connect_policy(&node, &connection, None).unwrap());
        assert!(ao_connect_policy(&node, &connection, Some(sentinel)).is_err());
        node.route.provider_id = "cliproxyapi-antigravity".into();
        node.route.model = "gemini-3.8-flash-high".into();
        connection.model = node.route.model.clone();
        node.route.account_id = "one-specific-account".into();
        assert!(ao_connect_policy(&node, &connection, Some(sentinel)).is_err());
        node.role = integrations::ao::Role::Planner;
        node.parents.clear();
        node.route.provider_id = "chatgpt-web".into();
        node.route.account_id = "chatgpt-web".into();
        node.route.model = "chatgpt-web/high".into();
        connection.model = "chatgpt-web/high".into();
        assert!(ao_connect_policy(&node, &connection, Some(sentinel)).is_err());
        assert_eq!(ao_connect_policy(&node, &connection, None).unwrap(), false);
    }

    #[test]
    fn policy_update_requires_confirmation_and_preserves_authentication() {
        let data = serde_json::from_value(serde_json::json!({
            "profiles": [{
                "id": "ws-1", "name": "Demo", "path": ".",
                "tunnel": {}, "auth": {"type": "bearer"},
                "runtime": {"permission_mode": "read-only"}, "actions": {"auth_type": "api_key"}
            }]
        }))
        .unwrap();
        let core = CoreState::from_data(data).unwrap();
        let mut request = WorkspacePolicyUpdateRequest {
            workspace_id: "ws-1".into(),
            permission_mode: "workspace-write".into(),
            approval_mode: "ask".into(),
            tool_profile: "advanced".into(),
            screen_capture_enabled: true,
            confirm: false,
        };
        assert!(apply_workspace_policy_update(&core, &request).is_err());
        request.confirm = true;
        assert_eq!(
            apply_workspace_policy_update(&core, &request).unwrap()["ok"],
            true
        );
        let saved = core
            .with_data(|store| Ok(store.get("ws-1").cloned().unwrap()))
            .unwrap();
        assert_eq!(saved.runtime.permission_mode, "workspace-write");
        assert_eq!(saved.runtime.tool_profile, "advanced");
        assert!(saved.runtime.allow_screen_capture);
        assert_eq!(saved.auth.auth_type, "bearer");
        assert_eq!(saved.actions.auth_type, "api_key");
    }

    #[tokio::test]
    async fn listener_status_is_readable_but_start_requires_local_confirmation() {
        let data = serde_json::from_value(serde_json::json!({
            "profiles": [{
                "id": "ws-1", "name": "Demo", "path": ".",
                "tunnel": {}, "auth": {"type": "bearer"}, "runtime": {"permission_mode":"read-only"}, "actions": {}
            }]
        }))
        .expect("in-memory profile");
        let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(None);
        let auth = ControlAuth::generate();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {}", auth.token).parse().unwrap(),
        );
        let state = ServiceState {
            lifecycle: Lifecycle::new(4),
            auth,
            local_ui_token: None,
            core: Arc::new(CoreState::from_data(data).unwrap()),
            contexts: Arc::new(Mutex::new(HashMap::new())),
            ao_hubs: Arc::new(Mutex::new(HashMap::new())),
            ao_home_root: PathBuf::from("aiTemp/ao-test-home"),
            operations: Arc::new(Mutex::new(OperationStore::default())),
            shutdown_tx,
            drain_timeout: Duration::from_secs(1),
        };
        let mut gated = state.clone();
        gated.local_ui_token = Some("a".repeat(43));
        let mut ui_headers = headers.clone();
        ui_headers.insert("x-coding-tools-local-ui", "a".repeat(43).parse().unwrap());
        assert!(local_ui_authorized(&ui_headers, &gated));
        assert!(!local_ui_authorized(&headers, &gated));
        let status = workspace_service(
            State(state.clone()),
            headers.clone(),
            Json(WorkspaceServiceRequest {
                workspace_id: "ws-1".into(),
                service: "mcp".into(),
                operation: "status".into(),
                confirm: false,
            }),
        )
        .await;
        assert_eq!(status.status(), StatusCode::OK);
        let denied = workspace_service(
            State(state.clone()),
            headers.clone(),
            Json(WorkspaceServiceRequest {
                workspace_id: "ws-1".into(),
                service: "mcp".into(),
                operation: "start".into(),
                confirm: false,
            }),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let secret_denied = workspace_secret(
            State(state.clone()),
            headers.clone(),
            Json(WorkspaceSecretRequest {
                workspace_id: "ws-1".into(),
                key: "bearer_token".into(),
                confirm: false,
            }),
        )
        .await;
        assert_eq!(secret_denied.status(), StatusCode::FORBIDDEN);
        let native_status = native_codex_status(
            State(state.clone()),
            headers.clone(),
            Json(NativeCodexWorkspaceRequest {
                workspace_id: "ws-1".into(),
            }),
        )
        .await;
        assert_eq!(native_status.status(), StatusCode::OK);
        let read_only = state.context("ws-1").expect("read-only workspace context");
        let policy_denied = read_only
            .connect_native_codex(json!({
                "executable":std::env::current_exe().unwrap(),
                "expected_sha256":"0".repeat(64),
                "codex_home":std::env::current_dir().unwrap(),
                "allow_model_usage":false,
                "allow_command_execution":false,
                "permission_profile":":workspace",
                "model":"test",
                "request_limit":1,
                "lifetime_seconds":30
            }))
            .unwrap_err();
        assert!(policy_denied.contains("workspace-write"), "{policy_denied}");
        let unavailable_from_tool_endpoint = tool_call(
            State(state.clone()),
            headers.clone(),
            Json(ToolCallRequest {
                request_id: "native-status-without-listener".into(),
                workspace_id: "ws-1".into(),
                tool: "codex_runtime_status".into(),
                arguments: json!({}),
            }),
        )
        .await;
        assert_eq!(
            unavailable_from_tool_endpoint.status(),
            StatusCode::BAD_REQUEST
        );
        let native_denied = native_codex_connect(
            State(state.clone()),
            headers.clone(),
            Json(NativeCodexConnectRequest {
                workspace_id: "ws-1".into(),
                connection: json!({}),
                confirm: false,
            }),
        )
        .await;
        assert_eq!(native_denied.status(), StatusCode::FORBIDDEN);
        let no_local_ui = native_codex_connect(
            State(state.clone()),
            headers.clone(),
            Json(NativeCodexConnectRequest {
                workspace_id: "ws-1".into(),
                connection: json!({}),
                confirm: true,
            }),
        )
        .await;
        assert_eq!(no_local_ui.status(), StatusCode::FORBIDDEN);
        let model_cannot_approve = native_codex_approval(
            State(state.clone()),
            headers.clone(),
            Json(NativeCodexApprovalRequest {
                workspace_id: "ws-1".into(),
                approval_id: "unguarded-request".into(),
                allow: true,
            }),
        )
        .await;
        assert_eq!(model_cannot_approve.status(), StatusCode::FORBIDDEN);
        let invalid_key = workspace_secret(
            State(state),
            headers,
            Json(WorkspaceSecretRequest {
                workspace_id: "ws-1".into(),
                key: "unlisted_secret".into(),
                confirm: true,
            }),
        )
        .await;
        assert_eq!(invalid_key.status(), StatusCode::BAD_REQUEST);
    }
}

async fn workspace_secret(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceSecretRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "workspace_secret") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm {
        return json_error(
            StatusCode::FORBIDDEN,
            "LOCAL_CONFIRMATION_REQUIRED",
            "Local confirmation is required to copy a workspace credential",
        );
    }
    let profile = match state.core.with_data(|store| {
        store.get(&body.workspace_id).cloned().ok_or_else(|| {
            coding_tools_core::error::AppError::Message("Workspace was not found".into())
        })
    }) {
        Ok(profile) => profile,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "WORKSPACE_NOT_FOUND",
                text_error(error),
            )
        }
    };
    let shared = match body.key.as_str() {
        "bearer_token" if profile.auth.auth_type == "bearer" => profile.auth.use_shared_secrets,
        "oauth_password" if profile.auth.auth_type == "oauth" => profile.auth.use_shared_secrets,
        "actions_api_key" if profile.actions.auth_type == "api_key" => {
            profile.actions.use_shared_secrets
        }
        "actions_oauth_client_secret" | "actions_oauth_password"
            if profile.actions.auth_type == "oauth" =>
        {
            profile.actions.use_shared_secrets
        }
        _ => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "INVALID_SECRET_KEY",
                "Credential is not available for this workspace authentication mode",
            )
        }
    };
    match coding_tools_core::SecretStore::get_or_regenerate(&profile.id, &body.key, shared) {
        Ok(value) => Json(json!({"ok": true, "key": body.key, "value": value})).into_response(),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SECRET_UNAVAILABLE",
            "Local credential store is unavailable",
        ),
    }
}

async fn workspace_service(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceServiceRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "workspace_service") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !matches!(body.service.as_str(), "mcp" | "actions")
        || !matches!(
            body.operation.as_str(),
            "status" | "start" | "stop" | "restart"
        )
        || body.workspace_id.trim().is_empty()
        || body.workspace_id.len() > 128
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "INVALID_WORKSPACE_SERVICE",
            "Workspace, service, or operation is invalid",
        );
    }
    if body.operation != "status" && !body.confirm {
        return json_error(
            StatusCode::FORBIDDEN,
            "LOCAL_CONFIRMATION_REQUIRED",
            "Local confirmation is required to change a workspace listener",
        );
    }
    let profile = match state.core.with_data(|store| {
        store.get(&body.workspace_id).cloned().ok_or_else(|| {
            coding_tools_core::error::AppError::Message("Workspace was not found".into())
        })
    }) {
        Ok(profile) => profile,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "WORKSPACE_NOT_FOUND",
                text_error(error),
            )
        }
    };
    let kind = if body.service == "mcp" {
        coding_tools_core::runtime::ServiceKind::Mcp
    } else {
        coding_tools_core::runtime::ServiceKind::Actions
    };
    let port = if body.service == "mcp" {
        profile.runtime.local_port
    } else {
        profile.actions.local_port
    };
    let outcome: Result<_, String> = async {
        if matches!(body.operation.as_str(), "stop" | "restart") {
            let current = state
                .core
                .with_runtime(|runtime| {
                    Ok(if body.service == "mcp" {
                        runtime.mcp_status(&profile)
                    } else {
                        runtime.actions_status(&profile)
                    })
                })
                .map_err(text_error)?;
            if current.state != "stopped" {
                if body.service == "mcp" {
                    coding_tools_core::tools::computer::emergency_stop(
                        "MCP service lifecycle changed",
                    );
                }
                let handle = state
                    .core
                    .with_runtime(|runtime| Ok(runtime.begin_stop(&profile.id, kind)))
                    .map_err(text_error)?;
                coding_tools_core::runtime::await_listener_shutdown(handle, port).await;
                state
                    .core
                    .with_runtime(|runtime| {
                        runtime.finish_stop(&profile.id, kind);
                        Ok(())
                    })
                    .map_err(text_error)?;
            }
        }
        if matches!(body.operation.as_str(), "start" | "restart") {
            state
                .core
                .with_runtime(|runtime| {
                    if body.service == "mcp" {
                        runtime.start_mcp(&profile)
                    } else {
                        runtime.start_actions(&profile)
                    }
                })
                .map_err(text_error)?;
            tokio::time::sleep(Duration::from_millis(250)).await;
            state
                .core
                .with_runtime(|runtime| {
                    if body.service == "mcp" {
                        runtime.refresh_mcp(&profile);
                        Ok(runtime.mcp_status(&profile))
                    } else {
                        runtime.refresh_actions(&profile);
                        Ok(runtime.actions_status(&profile))
                    }
                })
                .map_err(text_error)
        } else {
            state
                .core
                .with_runtime(|runtime| {
                    Ok(if body.service == "mcp" {
                        runtime.mcp_status(&profile)
                    } else {
                        runtime.actions_status(&profile)
                    })
                })
                .map_err(text_error)
        }
    }
    .await;
    match outcome {
        Ok(status) => {
            Json(json!({"ok": true, "service": body.service, "status": status})).into_response()
        }
        Err(error) => json_error(StatusCode::BAD_REQUEST, "WORKSPACE_SERVICE_FAILED", error),
    }
}

async fn native_codex_status(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<NativeCodexWorkspaceRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "native_codex_status") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let context = state
        .core
        .with_runtime(|runtime| runtime.native_bridge_context(&body.workspace_id));
    match context {
        Ok(context) => match context.native_codex_status() {
            Ok(status) => Json(status).into_response(),
            Err(error) => json_error(StatusCode::BAD_REQUEST, "NATIVE_CODEX_STATUS_FAILED", error),
        },
        Err(error) => Json(json!({
            "connected": false,
            "available": false,
            "reason": text_error(error),
        }))
        .into_response(),
    }
}

async fn native_codex_connect(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<NativeCodexConnectRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "native_codex_connect") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm {
        return json_error(
            StatusCode::FORBIDDEN,
            "LOCAL_CONFIRMATION_REQUIRED",
            "Local confirmation is required to connect native Codex",
        );
    }
    if !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "LOCAL_UI_REQUIRED",
            "Use the focused Coding Tools window to connect native Codex",
        );
    }
    let context = match state
        .core
        .with_runtime(|runtime| runtime.native_bridge_context(&body.workspace_id))
    {
        Ok(context) => context,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "NATIVE_CODEX_CONTEXT_FAILED",
                text_error(error),
            )
        }
    };
    match tokio::task::spawn_blocking(move || context.connect_native_codex(body.connection)).await {
        Ok(Ok(status)) => Json(status).into_response(),
        Ok(Err(error)) => json_error(
            StatusCode::BAD_REQUEST,
            "NATIVE_CODEX_CONNECT_FAILED",
            error,
        ),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "NATIVE_CODEX_WORKER_FAILED",
            "Native Codex connection worker failed",
        ),
    }
}

async fn native_codex_approval(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<NativeCodexApprovalRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "native_codex_approval") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "LOCAL_CONFIRMATION_REQUIRED",
            "Use the focused local Coding Tools window to answer a native file request",
        );
    }
    if !valid_request_id(&body.approval_id) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "INVALID_APPROVAL_ID",
            "Invalid native approval ID",
        );
    }
    let context = match state
        .core
        .with_runtime(|runtime| runtime.native_bridge_context(&body.workspace_id))
    {
        Ok(context) => context,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "WORKSPACE_CONTEXT_FAILED",
                text_error(error),
            )
        }
    };
    match tokio::task::spawn_blocking(move || {
        context.resolve_native_codex_approval(&body.approval_id, body.allow)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, "NATIVE_APPROVAL_FAILED", error),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "NATIVE_APPROVAL_WORKER_FAILED",
            "Native approval worker failed",
        ),
    }
}

async fn native_codex_disconnect(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<NativeCodexWorkspaceRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "native_codex_disconnect") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if let Ok(context) = state
        .core
        .with_runtime(|runtime| runtime.native_bridge_context(&body.workspace_id))
    {
        context.disconnect_native_codex();
    }
    Json(json!({"ok": true, "connected": false})).into_response()
}

async fn workspace_policy_update(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<WorkspacePolicyUpdateRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "workspace_policy_update") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match apply_workspace_policy_update(&state.core, &body) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(
            StatusCode::BAD_REQUEST,
            "WORKSPACE_POLICY_UPDATE_FAILED",
            error,
        ),
    }
}

async fn workspace_auth_update(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceAuthUpdateRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "workspace_auth_update") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match apply_workspace_auth_update(&state.core, &body) {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(
            StatusCode::BAD_REQUEST,
            "WORKSPACE_AUTH_UPDATE_FAILED",
            error,
        ),
    }
}

async fn workspace_list(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "workspaces") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match state.safe_workspaces() {
        Ok(workspaces) => Json(json!({"ok":true,"workspaces":workspaces})).into_response(),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "WORKSPACE_READ_FAILED",
            error,
        ),
    }
}

async fn workspace_create(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceCreateRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "workspace_create") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm || !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "LOCAL_CONFIRMATION_REQUIRED",
            "Confirm workspace creation in Coding Tools",
        );
    }
    let core = state.core.clone();
    match tokio::task::spawn_blocking(move || {
        core.with_data(|store| store.create_workspace(body.path, body.name))
    })
    .await
    {
        Ok(Ok(profile)) => {
            Json(json!({"id":profile.id,"name":profile.name,"path":profile.path})).into_response()
        }
        Ok(Err(error)) => json_error(
            StatusCode::BAD_REQUEST,
            "WORKSPACE_CREATE_FAILED",
            text_error(error),
        ),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "WORKSPACE_CREATE_UNKNOWN",
            "Workspace creation outcome unknown; refresh before retrying",
        ),
    }
}

async fn tool_catalog(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "catalog") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match state.context(&query.workspace_id) {
        Ok(context) => Json(json!({
            "ok": true,
            "workspace_id": query.workspace_id,
            "tool_profile": context.tool_profile,
            "tools": tools::list_tools_for_profile(&context.tool_profile),
        }))
        .into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error),
    }
}

async fn integration_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<IntegrationReadRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "integration_read") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match integrations::read(body.source, &body.endpoint, &body.credential).await {
        Ok(snapshot) => Json(json!({"ok":true,"snapshot":snapshot})).into_response(),
        Err(error) => json_error(
            StatusCode::BAD_REQUEST,
            "INTEGRATION_READ_FAILED",
            text_error(error),
        ),
    }
}

fn execution_outcome(
    outcome: Result<Result<Value, String>, tokio::task::JoinError>,
    code: &str,
) -> Response {
    match outcome {
        Ok(Ok(execution)) => Json(json!({"ok":true,"execution":execution})).into_response(),
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, code, error),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXECUTION_WORKER_UNAVAILABLE",
            "Local execution worker unavailable",
        ),
    }
}

fn ao_target(
    state: &ServiceState,
    workspace_id: &str,
    run_id: &str,
    node_id: &str,
) -> Result<(PathBuf, integrations::ao::Node, bool), String> {
    state
        .core
        .with_data(|store| {
            store.refresh()?;
            let profile = store.get(workspace_id).ok_or_else(|| {
                coding_tools_core::error::AppError::Message("Workspace not found".into())
            })?;
            let root = PathBuf::from(&profile.path).canonicalize().map_err(|_| {
                coding_tools_core::error::AppError::Message("Workspace path unavailable".into())
            })?;
            let run = store
                .data()
                .ao_runs
                .iter()
                .find(|run| run.id == run_id && run.workspace_id == workspace_id)
                .ok_or_else(|| {
                    coding_tools_core::error::AppError::Message(
                        "AO run not found in this workspace".into(),
                    )
                })?;
            let node = run
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .ok_or_else(|| {
                    coding_tools_core::error::AppError::Message("AO node not found".into())
                })?;
            Ok((root, node.clone(), run.cancelled))
        })
        .map_err(text_error)
}

fn ao_background_granted(
    state: &ServiceState,
    workspace_id: &str,
    run_id: &str,
    executable_sha256: &str,
) -> bool {
    state
        .core
        .with_data(|store| {
            store.refresh()?;
            let data = store.data();
            let run = data
                .ao_runs
                .iter()
                .find(|run| run.id == run_id && run.workspace_id == workspace_id)
                .ok_or_else(|| {
                    coding_tools_core::error::AppError::Message("AO run not found".into())
                })?;
            integrations::ao::grant_valid(data, run, now_ms(), executable_sha256)
        })
        .is_ok()
}

const AO_CPA_CONFIG: &str = "model_provider = \"coding_tools_ao_cpa\"\n\
[model_providers.coding_tools_ao_cpa]\n\
name = \"Coding Tools AO CPA\"\n\
base_url = \"http://127.0.0.1:8317/v1\"\n\
env_key = \"CODING_TOOLS_AO_CPA_KEY\"\n\
requires_openai_auth = false\n\
wire_api = \"responses\"\n";

fn prepare_ao_home(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    let parent = root.parent().ok_or("AO app data is unavailable")?;
    fs::create_dir_all(parent).map_err(text_error)?;
    let parent = parent.canonicalize().map_err(text_error)?;
    if root.exists() {
        if fs::symlink_metadata(root)
            .map_err(text_error)?
            .file_type()
            .is_symlink()
        {
            return Err("AO home root is linked".into());
        }
    } else {
        fs::create_dir(root).map_err(text_error)?;
    }
    let allowed = root.canonicalize().map_err(text_error)?;
    if allowed.parent() != Some(parent.as_path())
        || allowed.file_name().is_none_or(|name| name != "ao-homes")
    {
        return Err("AO home root left application data".into());
    }
    let name = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("AO node home name is invalid")?;
    if name.len() != 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || requested
            .parent()
            .and_then(|path| path.canonicalize().ok())
            .as_deref()
            != Some(allowed.as_path())
    {
        return Err("AO node home is outside its owned scope".into());
    }
    if requested.exists() {
        let metadata = fs::symlink_metadata(requested).map_err(text_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("AO node home is not a private directory".into());
        }
    } else {
        fs::create_dir(requested).map_err(text_error)?;
    }
    let selected = requested.canonicalize().map_err(text_error)?;
    if selected.parent() != Some(allowed.as_path()) {
        return Err("AO node home resolved outside its owned scope".into());
    }
    Ok(selected)
}

fn prepare_ao_cpa_home(home: &Path, app_data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(home).map_err(text_error)?;
    let config = home.join("config.toml");
    if config.exists() {
        if fs::symlink_metadata(&config)
            .map_err(text_error)?
            .file_type()
            .is_symlink()
            || fs::read(&config).map_err(text_error)? != AO_CPA_CONFIG.as_bytes()
        {
            return Err("AO CPA provider config changed; inspect before reconnecting".into());
        }
        return Ok(());
    }
    write_private_file(
        &config,
        AO_CPA_CONFIG.as_bytes(),
        app_data_dir,
        "ao-cpa-provider",
    )
}

fn prepare_ao_web_home(
    home: &Path,
    app_data_dir: &Path,
    base_url: &str,
    catalog: &Value,
) -> Result<(), String> {
    let url = url::Url::parse(base_url).map_err(|_| "AO WebGPT bridge URL is invalid")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/v1"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("AO WebGPT bridge must be the managed loopback Responses endpoint".into());
    }
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .ok_or("AO WebGPT catalog is invalid")?;
    if models.len() != 1
        || models[0].get("slug").and_then(Value::as_str) != Some("chatgpt-web/high")
    {
        return Err("AO WebGPT catalog must contain only the selected model".into());
    }
    let catalog_bytes = serde_json::to_vec(catalog).map_err(text_error)?;
    if catalog_bytes.len() > 256 * 1024 {
        return Err("AO WebGPT catalog is too large".into());
    }
    let catalog_path = home.join("models.json");
    let config_bytes = format!(
        "model = \"chatgpt-web/high\"\nmodel_provider = \"coding_tools_ao_web\"\nmodel_catalog_json = {}\n\
[model_providers.coding_tools_ao_web]\nname = \"Coding Tools AO WebGPT\"\nbase_url = {}\n\
env_key = \"CODING_TOOLS_AO_WEB_KEY\"\nrequires_openai_auth = false\nwire_api = \"responses\"\n\
supports_websockets = false\n",
        serde_json::to_string(&catalog_path.to_string_lossy().as_ref()).map_err(text_error)?,
        serde_json::to_string(base_url).map_err(text_error)?,
    );
    let config_path = home.join("config.toml");
    for (path, expected) in [
        (&catalog_path, catalog_bytes.as_slice()),
        (&config_path, config_bytes.as_bytes()),
    ] {
        if path.exists()
            && (fs::symlink_metadata(path)
                .map_err(text_error)?
                .file_type()
                .is_symlink()
                || fs::read(path).map_err(text_error)? != expected)
        {
            return Err("AO WebGPT provider config changed; inspect before reconnecting".into());
        }
    }
    if !catalog_path.exists() {
        write_private_file(
            &catalog_path,
            &catalog_bytes,
            app_data_dir,
            "ao-web-catalog",
        )?;
    }
    if !config_path.exists() {
        write_private_file(
            &config_path,
            config_bytes.as_bytes(),
            app_data_dir,
            "ao-web-provider",
        )?;
    }
    Ok(())
}

fn ao_connect_policy(
    node: &integrations::ao::Node,
    connection: &AoCodexConnection,
    private_key: Option<&str>,
) -> Result<bool, String> {
    if node.route.harness_id != "codex-native"
        || node.route.permission_profile != ":read-only"
        || connection.model != node.route.model
        || connection.permission_profile != ":read-only"
        || !connection.allow_model_usage
        || connection.allow_command_execution
        || connection.request_limit == 0
        || connection.lifetime_seconds == 0
    {
        return Err("AO selected route or read-only limits do not match".into());
    }
    // The route's provider decides the connection, not the role: any worker may use
    // WebGPT or any model in the shared CPA pool. Planner/reviewer routes are still
    // pinned to WebGPT by run validation.
    let cpa_model = |model: &str| {
        (1..=128).contains(&model.len())
            && model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-@+".contains(&byte))
    };
    match node.route.provider_id.as_str() {
        "chatgpt-web" if node.route.model == "chatgpt-web/high" && private_key.is_none() => Ok(false),
        "cliproxyapi-antigravity"
            if node.role == integrations::ao::Role::Worker
                && node.route.account_id == "shared-cpa-pool"
                && cpa_model(&node.route.model)
                && private_key.is_some_and(|key| {
                    (32..=512).contains(&key.len()) && !key.chars().any(char::is_control)
                }) =>
        {
            Ok(true)
        }
        _ => Err("AO provider, account policy, model, or private key does not match".into()),
    }
}

async fn ao_run_grant(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoRunGrantRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_run_grant") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm || !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Confirm this exact AO run in the focused local window",
        );
    }
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_WORKSPACE_INVALID",
                "AO workspace unavailable",
            )
        }
    };
    let now = now_ms();
    let result = tokio::task::spawn_blocking(move || {
        let request = context.for_request().map_err(text_error)?;
        let _guard = request.policy_execution_guard().map_err(text_error)?;
        coding_tools_core::data::DataStore::update_file(|data| {
            integrations::ao::grant_run(
                data,
                &body.workspace_id,
                &body.run_id,
                body.expected_revision,
                &body.executable_sha256,
                now,
            )
        })
        .map_err(text_error)
    })
    .await;
    match result {
        Ok(Ok(run)) => Json(json!({"ok":true,"grant":run.grant,"run":run})).into_response(),
        _ => json_error(
            StatusCode::CONFLICT,
            "AO_GRANT_FAILED",
            "AO run, graph, or executable changed; refresh before confirming",
        ),
    }
}

async fn ao_harness_status(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessNodeRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_harness_status") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if let Err(error) = ao_target(&state, &body.workspace_id, &body.run_id, &body.node_id) {
        return json_error(StatusCode::BAD_REQUEST, "AO_NODE_SCOPE_FAILED", error);
    }
    let key = (body.workspace_id, body.run_id, body.node_id);
    let hub = state
        .ao_hubs
        .lock()
        .ok()
        .and_then(|hubs| hubs.get(&key).cloned());
    match hub {
        Some(hub) => match hub.status() {
            Ok(status) => {
                Json(json!({"ok":true,"owned":true,"route_verified":false,"status":status}))
                    .into_response()
            }
            Err(error) => json_error(StatusCode::BAD_REQUEST, "AO_HARNESS_STATUS_FAILED", error),
        },
        None => Json(
            json!({"ok":true,"owned":false,"route_verified":false,"status":{"connected":false}}),
        )
        .into_response(),
    }
}

async fn ao_harness_connect(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessConnectRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_harness_connect") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if body.confirm && !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Confirm the exact AO harness locally",
        );
    }
    let (root, node, cancelled) =
        match ao_target(&state, &body.workspace_id, &body.run_id, &body.node_id) {
            Ok(target) => target,
            Err(error) => {
                return json_error(StatusCode::BAD_REQUEST, "AO_NODE_SCOPE_FAILED", error)
            }
        };
    let root = match root.join(&node.settings.working_directory).canonicalize() {
        Ok(directory) if directory.is_dir() && directory.starts_with(&root) => directory,
        _ => return json_error(StatusCode::BAD_REQUEST, "AO_WORKING_DIRECTORY_INVALID", "Role working directory must exist inside the registered workspace"),
    };
    if cancelled
        || !matches!(
            node.state,
            integrations::ao::State::Pending | integrations::ao::State::Reserved
        )
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "AO_NODE_NOT_READY",
            "Select a pending AO node in an active run",
        );
    }
    let private_key = body.private_proxy_api_key;
    let web_base_url = body.web_bridge_base_url;
    let web_catalog = body.web_model_catalog;
    let connection: AoCodexConnection = match serde_json::from_value(body.connection) {
        Ok(connection) => connection,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_CONNECTION_INVALID",
                "Invalid AO harness connection",
            )
        }
    };
    let worker = match ao_connect_policy(&node, &connection, private_key.as_deref()) {
        Ok(worker) => worker,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, "AO_ROUTE_MISMATCH", error),
    };
    if worker == web_base_url.is_some() || worker == web_catalog.is_some() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "AO_PROVIDER_CONFIG_MISMATCH",
            "AO provider inputs do not match the selected role",
        );
    }
    if !(body.confirm && local_ui_authorized(&headers, &state))
        && (body.confirm
            || !ao_background_granted(
                &state,
                &body.workspace_id,
                &body.run_id,
                &connection.expected_sha256,
            ))
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_RUN_GRANT_REQUIRED",
            "Confirm the exact AO run or card in the focused local window",
        );
    }
    let selected_home = match prepare_ao_home(&state.ao_home_root, &connection.codex_home) {
        Ok(home) => home,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_HOME_SCOPE",
                "Use a dedicated AO home under application data",
            )
        }
    };
    if worker {
        let Some(app_data_dir) = state.ao_home_root.parent() else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_HOME_UNAVAILABLE",
                "AO app data is unavailable",
            );
        };
        if prepare_ao_cpa_home(&selected_home, app_data_dir).is_err() {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_CPA_HOME_INVALID",
                "AO CPA provider config is unavailable or changed",
            );
        }
    } else {
        let Some(app_data_dir) = state.ao_home_root.parent() else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_HOME_UNAVAILABLE",
                "AO app data is unavailable",
            );
        };
        if prepare_ao_web_home(
            &selected_home,
            app_data_dir,
            web_base_url.as_deref().unwrap(),
            web_catalog.as_ref().unwrap(),
        )
        .is_err()
        {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_WEB_HOME_INVALID",
                "AO WebGPT bridge catalog is unavailable or changed",
            );
        }
    }
    let key = (body.workspace_id, body.run_id, body.node_id);
    let hub = Arc::new(AoCodexHub::default());
    {
        let mut hubs = match state.ao_hubs.lock() {
            Ok(hubs) => hubs,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "AO_HUBS_UNAVAILABLE",
                    "AO harness store unavailable",
                )
            }
        };
        if hubs.contains_key(&key) {
            return json_error(
                StatusCode::CONFLICT,
                "AO_HARNESS_OWNERSHIP",
                "AO harness already connected",
            );
        }
        if hubs.len() >= 8 { return Json(json!({"ok":true,"waiting":true,"reason":"harness_capacity"})).into_response(); }
        hubs.insert(key.clone(), hub.clone());
    }
    let running = hub.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        if let Some(key) = private_key {
            running.connect_ao_with_cpa_key(&root, connection, key)?;
        } else {
            running.connect_ao_web(&root, connection)?;
        }
        running.initialize()
    })
    .await;
    match outcome {
        Ok(Ok(status)) => {
            Json(json!({"ok":true,"owned":true,"route_verified":false,"status":status}))
                .into_response()
        }
        failure => {
            hub.disconnect();
            if let Ok(mut hubs) = state.ao_hubs.lock() {
                hubs.remove(&key);
            }
            let detail = match failure {
                Ok(Err(error)) => error,
                Err(_) => "AO harness connection outcome unknown; inspect before retrying".into(),
                Ok(Ok(_)) => unreachable!(),
            };
            json_error(StatusCode::BAD_REQUEST, "AO_HARNESS_CONNECT_FAILED", detail)
        }
    }
}

async fn ao_harness_disconnect(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessDisconnectRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_harness_disconnect") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm || !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Confirm AO harness stop locally",
        );
    }
    if let Err(error) = ao_target(&state, &body.workspace_id, &body.run_id, &body.node_id) {
        return json_error(StatusCode::BAD_REQUEST, "AO_NODE_SCOPE_FAILED", error);
    }
    let key = (body.workspace_id, body.run_id, body.node_id);
    let hub = state
        .ao_hubs
        .lock()
        .ok()
        .and_then(|mut hubs| hubs.remove(&key));
    if let Some(hub) = hub {
        hub.disconnect();
    }
    Json(json!({"ok":true,"connected":false,"owned":false})).into_response()
}

async fn ao_harness_execute(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessExecuteRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_harness_execute") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let background = !body.confirm;
    if body.confirm && !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Confirm the selected AO turn locally",
        );
    }
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_WORKSPACE_INVALID",
                "AO workspace unavailable",
            )
        }
    };
    let key = (
        body.workspace_id.clone(),
        body.run_id.clone(),
        body.node_id.clone(),
    );
    let hub = match state
        .ao_hubs
        .lock()
        .ok()
        .and_then(|hubs| hubs.get(&key).cloned())
    {
        Some(hub) => hub,
        None => {
            return json_error(
                StatusCode::CONFLICT,
                "AO_HARNESS_NOT_CONNECTED",
                "Connect the selected AO harness first",
            )
        }
    };
    let (_root, node, cancelled) =
        match ao_target(&state, &body.workspace_id, &body.run_id, &body.node_id) {
            Ok(target) => target,
            Err(_) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "AO_NODE_SCOPE_FAILED",
                    "AO node unavailable",
                )
            }
        };
    if cancelled || node.state != integrations::ao::State::Pending {
        return json_error(
            StatusCode::CONFLICT,
            "AO_NODE_NOT_PENDING",
            "AO node has already been reserved or cancelled",
        );
    }
    let status = match hub.status() {
        Ok(status) => status,
        Err(_) => {
            return json_error(
                StatusCode::CONFLICT,
                "AO_HARNESS_UNAVAILABLE",
                "AO harness status unavailable",
            )
        }
    };
    if status["connected"] != true
        || status["model"] != node.route.model
        || status["permission_profile"] != node.route.permission_profile
    {
        return json_error(
            StatusCode::CONFLICT,
            "AO_ROUTE_CHANGED",
            "Selected AO harness route changed",
        );
    }
    if background
        && !status["executable_sha256"]
            .as_str()
            .is_some_and(|sha| ao_background_granted(&state, &body.workspace_id, &body.run_id, sha))
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_RUN_GRANT_REQUIRED",
            "AO run grant expired or changed",
        );
    }
    let grant_now_ms = background.then(now_ms);
    let request_key = format!("ao-{}", uuid::Uuid::new_v4());
    let workspace_id = body.workspace_id;
    let run_id = body.run_id;
    let node_id = body.node_id;
    let expected_revision = body.expected_revision;
    let reserved = tokio::task::spawn_blocking({
        let workspace_id = workspace_id.clone();
        let run_id = run_id.clone();
        let node_id = node_id.clone();
        let request_key = request_key.clone();
        move || {
            let request = context.for_request().map_err(text_error)?;
            let _guard = request.policy_execution_guard().map_err(text_error)?;
            coding_tools_core::data::DataStore::update_file(|data| {
                let run = data
                    .ao_runs
                    .iter()
                    .find(|run| run.id == run_id && run.workspace_id == workspace_id)
                    .ok_or_else(|| {
                        coding_tools_core::error::AppError::Message("AO run not found".into())
                    })?;
                let prompt = integrations::ao::prompt_for_node(data, run, &node_id)?;
                let next = integrations::ao::reserve(
                    data,
                    &workspace_id,
                    &run_id,
                    &node_id,
                    expected_revision,
                    request_key,
                    grant_now_ms,
                )?;
                Ok((next, prompt))
            })
            .map_err(text_error)
        }
    })
    .await;
    let (_reserved_run, prompt) = match reserved {
        Ok(Ok(value)) => value,
        Ok(Err(error)) if error == "AO_WORKER_CAPACITY_BUSY" => {
            return Json(json!({"ok":true,"waiting":true,"reason":"worker_capacity"})).into_response();
        },
        Ok(Err(error)) if error == "AO node is not ready or run revision changed" => {
            return Json(json!({"ok":true,"waiting":true,"reason":"revision_changed"})).into_response();
        },
        _ => {
            return json_error(
                StatusCode::CONFLICT,
                "AO_RESERVATION_FAILED",
                "AO graph or revision changed; refresh before retrying",
            )
        }
    };
    let submitted = tokio::task::spawn_blocking({
        let hub = hub.clone();
        let request_key = request_key.clone();
        move || hub.start_ao(request_key, prompt)
    })
    .await;
    let thread_id = submitted.ok().and_then(Result::ok).and_then(|value| {
        if value["ok"] == true {
            value["thread_id"].as_str().map(str::to_owned)
        } else {
            None
        }
    });
    if thread_id.is_none() {
        if let Ok(mut hubs) = state.ao_hubs.lock() {
            if hubs.get(&key).is_some_and(|current| Arc::ptr_eq(current, &hub)) { hubs.remove(&key); }
        }
        hub.disconnect();
    }
    let saved = tokio::task::spawn_blocking({
        let request_key = request_key.clone();
        move || {
            coding_tools_core::data::DataStore::update_file(|data| {
                integrations::ao::record_submission(
                    data,
                    &workspace_id,
                    &run_id,
                    &node_id,
                    &request_key,
                    thread_id.as_deref(),
                )
            })
            .map_err(text_error)
        }
    })
    .await;
    match saved {
        Ok(Ok(run)) => {
            let receipt = run.nodes.iter().find(|node| node.id == key.2.as_str()).and_then(|node| node.receipt.clone());
            Json(json!({"ok":true,"run":run,"receipt":receipt})).into_response()
        }
        _ => json_error(StatusCode::INTERNAL_SERVER_ERROR, "AO_SUBMISSION_UNKNOWN", "AO native submission outcome could not be saved; inspect the reserved request before any retry"),
    }
}

async fn ao_harness_observe(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessNodeRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_harness_observe") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let current = state.core.with_data(|store| {
        store.refresh()?;
        store
            .data()
            .ao_runs
            .iter()
            .find(|run| run.id == body.run_id && run.workspace_id == body.workspace_id)
            .cloned()
            .ok_or_else(|| coding_tools_core::error::AppError::Message("AO run not found".into()))
    });
    let run = match current {
        Ok(run) => run,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_RUN_NOT_FOUND",
                "AO run unavailable",
            )
        }
    };
    let Some(node) = run.nodes.iter().find(|node| node.id == body.node_id) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "AO_NODE_NOT_FOUND",
            "AO node unavailable",
        );
    };
    let Some(receipt) = node.receipt.as_ref() else {
        return json_error(
            StatusCode::CONFLICT,
            "AO_NODE_NOT_RESERVED",
            "AO node has no execution receipt",
        );
    };
    if node.state == integrations::ao::State::Reserved {
        return Json(json!({"ok":true,"run":run,"receipt":receipt,
            "note":"AO submission is unresolved; inspect this request key before any retry"}))
        .into_response();
    }
    let key = (
        body.workspace_id.clone(),
        body.run_id.clone(),
        body.node_id.clone(),
    );
    if node.state != integrations::ao::State::Running {
        return Json(json!({"ok":true,"run":run,"receipt":receipt})).into_response();
    }
    let Some(thread_id) = receipt.thread_id.as_deref() else {
        return json_error(
            StatusCode::CONFLICT,
            "AO_THREAD_UNKNOWN",
            "AO native thread identity unavailable",
        );
    };
    let hub = state
        .ao_hubs
        .lock()
        .ok()
        .and_then(|hubs| hubs.get(&key).cloned());
    let pending_approvals = hub
        .as_ref()
        .and_then(|hub| hub.status().ok())
        .and_then(|status| status.get("pending_approvals").cloned())
        .unwrap_or_else(|| json!([]));
    let native = hub.as_ref().and_then(|hub| hub.read(thread_id).ok());
    if native.as_ref().is_some_and(|native| {
        matches!(
            native["status"].as_str(),
            Some("starting" | "inProgress" | "interrupt_requested")
        )
    }) {
        return Json(
            json!({"ok":true,"run":run,"receipt":receipt,"pending_approvals":pending_approvals}),
        )
        .into_response();
    }
    if native.as_ref().is_some_and(|native| {
        !matches!(
            native["status"].as_str(),
            Some("completed" | "failed" | "interrupted")
        )
    }) {
        return Json(
            json!({"ok":true,"run":run,"receipt":receipt,"pending_approvals":pending_approvals}),
        )
        .into_response();
    }
    let completed = native
        .as_ref()
        .is_some_and(|native| native["status"] == "completed");
    let failure = native.as_ref().and_then(|native| native["notice"].as_str()).map(str::to_owned)
        .or_else(|| native.is_none().then(|| "Native connection ended without a terminal receipt; the reserved request will not be replayed".to_owned()));
    let expected_request_key = receipt.request_key.clone();
    let turn_id = native
        .as_ref()
        .and_then(|native| native["turn_id"].as_str())
        .map(str::to_owned);
    let answer = native
        .as_ref()
        .and_then(|native| native["answer"].as_str())
        .map(str::to_owned);
    let workspace_id = body.workspace_id;
    let run_id = body.run_id;
    let node_id = body.node_id;
    let thread_id = thread_id.to_owned();
    let saved = tokio::task::spawn_blocking(move || {
        coding_tools_core::data::DataStore::update_file(|data| {
            integrations::ao::record_terminal(
                data,
                &workspace_id,
                &run_id,
                &node_id,
                &thread_id,
                turn_id.as_deref(),
                answer.as_deref(),
                completed,
                failure.as_deref(),
            )
        })
        .map_err(text_error)
    })
    .await;
    match saved {
        Ok(Ok(mut run)) => {
            let receipt = run
                .nodes
                .iter()
                .find(|node| node.id == key.2.as_str())
                .and_then(|node| node.receipt.clone());
            if native.is_some() {
                if let Ok(mut hubs) = state.ao_hubs.lock() {
                    if let Some(hub) = hubs.remove(&key) {
                        hub.disconnect();
                    }
                }
            }
            if receipt.as_ref().is_some_and(|receipt| receipt.verdict.as_deref() == Some("CHANGES_REQUIRED")) {
                if let Ok(Some(reworked)) = coding_tools_core::data::DataStore::update_file(|data| {
                    integrations::ao_team::queue_rework(data, &key.0, &key.1, &key.2, &expected_request_key, now_ms())
                }) { run = reworked; }
            }
            Json(json!({"ok":true,"run":run,"receipt":receipt})).into_response()
        }
        _ => {
            let settled = state.core.with_data(|store| {
                store.refresh()?;
                let run = store
                    .data()
                    .ao_runs
                    .iter()
                    .find(|run| run.id == key.1 && run.workspace_id == key.0)
                    .ok_or_else(|| {
                        coding_tools_core::error::AppError::Message("AO run not found".into())
                    })?;
                let node = run
                    .nodes
                    .iter()
                    .find(|node| node.id == key.2)
                    .ok_or_else(|| {
                        coding_tools_core::error::AppError::Message("AO node not found".into())
                    })?;
                if !matches!(
                    node.state,
                    integrations::ao::State::Finished | integrations::ao::State::Held
                ) || node
                    .receipt
                    .as_ref()
                    .is_none_or(|receipt| receipt.request_key != expected_request_key)
                {
                    if let Some(previous) = node.history.iter().find(|receipt| receipt.request_key == expected_request_key && receipt.turn_id.is_some()) {
                        return Ok((run.clone(), Some(previous.clone())));
                    }
                    return Err(coding_tools_core::error::AppError::Message(
                        "AO receipt changed".into(),
                    ));
                }
                Ok((run.clone(), node.receipt.clone()))
            });
            match settled {
                Ok((run, receipt)) => {
                    Json(json!({"ok":true,"run":run,"receipt":receipt})).into_response()
                }
                Err(_) => json_error(
                    StatusCode::CONFLICT,
                    "AO_OBSERVE_CHANGED",
                    "AO receipt changed; refresh before retrying",
                ),
            }
        }
    }
}

fn ao_external_node(
    state: &ServiceState,
    workspace_id: &str,
    run_id: &str,
    node_id: &str,
) -> Result<integrations::ao::Node, Response> {
    match ao_target(state, workspace_id, run_id, node_id) {
        Ok((_root, node, _cancelled))
            if node.role == integrations::ao::Role::Worker
                && integrations::ao::external_harness(&node.route).is_some() =>
        {
            Ok(node)
        }
        _ => Err(json_error(
            StatusCode::BAD_REQUEST,
            "AO_EXTERNAL_SCOPE_FAILED",
            "AO harness worker unavailable",
        )),
    }
}

/// Reserve one ready AO-harness worker card and return its prompt. The caller
/// spawns the AO session and reports it back; a reservation is never replayed.
async fn ao_external_reserve(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessExecuteRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_external_reserve") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let background = !body.confirm;
    if body.confirm && !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Confirm the selected AO turn locally",
        );
    }
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(_) => {
            return json_error(StatusCode::BAD_REQUEST, "AO_WORKSPACE_INVALID", "AO workspace unavailable")
        }
    };
    if let Err(response) = ao_external_node(&state, &body.workspace_id, &body.run_id, &body.node_id) {
        return response;
    }
    let grant_now_ms = background.then(now_ms);
    let request_key = format!("ao-{}", uuid::Uuid::new_v4());
    let reserved = tokio::task::spawn_blocking({
        let request_key = request_key.clone();
        move || {
            let request = context.for_request().map_err(text_error)?;
            let _guard = request.policy_execution_guard().map_err(text_error)?;
            coding_tools_core::data::DataStore::update_file(|data| {
                let run = data
                    .ao_runs
                    .iter()
                    .find(|run| run.id == body.run_id && run.workspace_id == body.workspace_id)
                    .ok_or_else(|| coding_tools_core::error::AppError::Message("AO run not found".into()))?;
                let prompt = integrations::ao::prompt_for_node(data, run, &body.node_id)?;
                let next = integrations::ao::reserve(
                    data,
                    &body.workspace_id,
                    &body.run_id,
                    &body.node_id,
                    body.expected_revision,
                    request_key,
                    grant_now_ms,
                )?;
                Ok((next, prompt))
            })
            .map_err(text_error)
        }
    })
    .await;
    match reserved {
        Ok(Ok((run, prompt))) => {
            Json(json!({"ok":true,"run":run,"request_key":request_key,"prompt":prompt})).into_response()
        }
        Ok(Err(error)) if error == "AO_WORKER_CAPACITY_BUSY" => {
            Json(json!({"ok":true,"waiting":true,"reason":"worker_capacity"})).into_response()
        }
        Ok(Err(error)) if error == "AO node is not ready or run revision changed" => {
            Json(json!({"ok":true,"waiting":true,"reason":"revision_changed"})).into_response()
        }
        _ => json_error(
            StatusCode::CONFLICT,
            "AO_RESERVATION_FAILED",
            "AO graph or revision changed; refresh before retrying",
        ),
    }
}

async fn ao_external_submitted(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoExternalSubmittedRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_external_submitted") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if let Err(response) = ao_external_node(&state, &body.workspace_id, &body.run_id, &body.node_id) {
        return response;
    }
    let saved = tokio::task::spawn_blocking(move || {
        coding_tools_core::data::DataStore::update_file(|data| {
            integrations::ao::record_submission(
                data,
                &body.workspace_id,
                &body.run_id,
                &body.node_id,
                &body.request_key,
                body.session_id.as_deref(),
            )
        })
        .map_err(text_error)
    })
    .await;
    match saved {
        Ok(Ok(run)) => Json(json!({"ok":true,"run":run})).into_response(),
        _ => json_error(
            StatusCode::CONFLICT,
            "AO_SUBMISSION_UNKNOWN",
            "AO session outcome could not be saved; inspect the reserved card before any retry",
        ),
    }
}

async fn ao_external_terminal(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoExternalTerminalRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_external_terminal") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if let Err(response) = ao_external_node(&state, &body.workspace_id, &body.run_id, &body.node_id) {
        return response;
    }
    let node_id = body.node_id.clone();
    let saved = tokio::task::spawn_blocking(move || {
        coding_tools_core::data::DataStore::update_file(|data| {
            integrations::ao::record_terminal(
                data,
                &body.workspace_id,
                &body.run_id,
                &body.node_id,
                &body.session_id,
                body.turn_id.as_deref(),
                body.answer.as_deref(),
                body.completed,
                body.failure.as_deref(),
            )
        })
        .map_err(text_error)
    })
    .await;
    match saved {
        Ok(Ok(run)) => {
            let receipt = run.nodes.iter().find(|node| node.id == node_id).and_then(|node| node.receipt.clone());
            Json(json!({"ok":true,"run":run,"receipt":receipt})).into_response()
        }
        _ => json_error(
            StatusCode::CONFLICT,
            "AO_OBSERVE_CHANGED",
            "AO receipt changed; refresh before retrying",
        ),
    }
}

async fn ao_harness_approval(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoHarnessApprovalRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_harness_approval") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm || !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Answer this AO approval in the focused local window",
        );
    }
    let (_, node, _) = match ao_target(&state, &body.workspace_id, &body.run_id, &body.node_id) {
        Ok(target) => target,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "AO_NODE_SCOPE_FAILED",
                "AO node unavailable",
            )
        }
    };
    if node.state != integrations::ao::State::Running {
        return json_error(
            StatusCode::CONFLICT,
            "AO_NODE_NOT_RUNNING",
            "AO node has no active turn",
        );
    }
    let key = (body.workspace_id, body.run_id, body.node_id);
    let hub = state
        .ao_hubs
        .lock()
        .ok()
        .and_then(|hubs| hubs.get(&key).cloned());
    let Some(hub) = hub else {
        return json_error(
            StatusCode::CONFLICT,
            "AO_HARNESS_NOT_CONNECTED",
            "AO harness unavailable",
        );
    };
    match hub.resolve_approval(&body.approval_id, body.allow) {
        Ok(result) => Json(json!({"ok":true,"result":result})).into_response(),
        Err(_) => json_error(
            StatusCode::CONFLICT,
            "AO_APPROVAL_UNAVAILABLE",
            "AO approval expired or belongs to another turn",
        ),
    }
}

async fn ao_control(State(state): State<ServiceState>, headers: HeaderMap, Json(body): Json<AoControlRequest>) -> Response {
    if let Err(response) = auth(&headers, &state) { return *response; }
    let _lease = match admit(&state, "ao_control") { Ok(lease) => lease, Err(response) => return *response };
    if !body.confirm || !local_ui_authorized(&headers, &state) || !matches!(body.action.as_str(), "pause" | "resume" | "stop") {
        return json_error(StatusCode::FORBIDDEN, "AO_CONTROL_LOCAL_ONLY", "Use the local mission controls");
    }
    let workspace_id = body.workspace_id;
    let run_id = body.run_id;
    let stopping = body.action == "stop";
    let updated = tokio::task::spawn_blocking({
        let workspace_id = workspace_id.clone(); let run_id = run_id.clone();
        move || coding_tools_core::data::DataStore::update_file(|data| integrations::ao_team::control(data, &workspace_id, &run_id, &body.action))
    }).await;
    let mut run = match updated {
        Ok(Ok(run)) => run,
        _ => return json_error(StatusCode::CONFLICT, "AO_CONTROL_FAILED", "Mission control failed; refresh its saved state"),
    };
    if stopping {
        let owned = match state.ao_hubs.lock() {
            Ok(mut hubs) => {
                let keys: Vec<_> = hubs.keys().filter(|key| key.0 == workspace_id && key.1 == run_id).cloned().collect();
                keys.iter().filter_map(|key| hubs.remove(key)).collect::<Vec<_>>()
            },
            Err(_) => return json_error(StatusCode::CONFLICT, "AO_STOP_UNKNOWN", "Future work is cancelled; owned harness shutdown needs inspection"),
        };
        let stopped = tokio::task::spawn_blocking(move || {
            for hub in owned { hub.disconnect(); }
            coding_tools_core::data::DataStore::update_file(|data| integrations::ao_team::control(data, &workspace_id, &run_id, "stopped"))
        }).await;
        match stopped {
            Ok(Ok(stopped)) => run = stopped,
            _ => return json_error(StatusCode::CONFLICT, "AO_STOP_UNKNOWN", "Owned harnesses stopped; refresh the final mission state"),
        }
    }
    Json(json!({"ok":true,"run":run})).into_response()
}

async fn ao_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoReadRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_read") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if body.workspace_id.is_empty() || body.workspace_id.len() > 128 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "AO_WORKSPACE_REQUIRED",
            "Select a workspace",
        );
    }
    if let Err(error) = state.context(&body.workspace_id) {
        return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error);
    }
    let core = state.core.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        core.with_data(|store| {
            store.refresh()?;
            let data = store.data();
            let mut scoped = data
                .ao_runs
                .iter()
                .filter(|run| run.workspace_id == body.workspace_id);
            let runs = if let Some(run_id) = body.run_id {
                let run = scoped.find(|run| run.id == run_id).ok_or_else(|| {
                    coding_tools_core::error::AppError::Message(
                        "AO run not found in this workspace".into(),
                    )
                })?;
                vec![run.clone()]
            } else {
                scoped.take(100).cloned().collect()
            };
            let team = data.ao_teams.iter().find(|team| team.workspace_id == body.workspace_id);
            let capacity: std::collections::HashMap<_, _> = runs.iter().map(|run| (run.id.clone(), integrations::ao_team::available_workers(data, run))).collect();
            Ok(json!({"ok":true,"runs":runs,"board_revision":data.control_board.revision,"team":team,"limits":data.ao_limits,"worker_capacity":capacity}))
        })
        .map_err(text_error)
    })
    .await;
    match outcome {
        Ok(Ok(view)) => Json(view).into_response(),
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, "AO_READ_FAILED", error),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AO_READ_UNKNOWN",
            "AO read outcome unknown",
        ),
    }
}

async fn ao_update(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<AoUpdateRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "ao_update") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm || !local_ui_authorized(&headers, &state) {
        return json_error(
            StatusCode::FORBIDDEN,
            "AO_LOCAL_CONFIRMATION_REQUIRED",
            "Confirm AO changes in the focused local window",
        );
    }
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    let workspace_id = body.workspace_id;
    let outcome = tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        let _guard = request
            .policy_execution_guard()
            .map_err(|error| error.message().to_string())?;
        coding_tools_core::data::DataStore::update_file(|data| match body.change {
            AoMutation::CreateFromTeam { run_id, task_id, expected_board_revision, team_revision, worker_limit } =>
                integrations::ao_team::create_run(data, &workspace_id, run_id, task_id, expected_board_revision, team_revision, worker_limit)
                    .map(|run| json!({"ok":true,"run":run})),
            AoMutation::SaveTeam { expected_revision, team } => integrations::ao_team::save(data, &workspace_id, expected_revision, team)
                .map(|team| json!({"ok":true,"team":team})),
            AoMutation::ApplyTeam { run_id, expected_revision, team_revision } => integrations::ao_team::apply(data, &workspace_id, &run_id, expected_revision, team_revision)
                .map(|run| json!({"ok":true,"run":run})),
            AoMutation::SetLimits { expected_revision, max_workers, run_id, run_revision, worker_limit } => {
                let mission = match (run_id.as_deref(), run_revision, worker_limit) {
                    (Some(id), Some(revision), Some(limit)) => Some((id, revision, limit)),
                    (None, None, None) => None,
                    _ => return Err(coding_tools_core::error::AppError::Message("Select a mission revision and worker limit together".into())),
                };
                integrations::ao_team::set_limits(data, &workspace_id, expected_revision, max_workers, mission)?;
                Ok(json!({"ok":true,"limits":data.ao_limits}))
            },
            AoMutation::Create {
                expected_board_revision,
                run,
            } => {
                if run.workspace_id != workspace_id {
                    return Err(coding_tools_core::error::AppError::Message(
                        "AO run belongs to another workspace".into(),
                    ));
                }
                integrations::ao::create(data, expected_board_revision, run).map(|run| json!({"ok":true,"run":run}))
            }
            AoMutation::Graph {
                run_id,
                expected_revision,
                change,
            } => integrations::ao::update_graph(
                data,
                &workspace_id,
                &run_id,
                expected_revision,
                change,
            ).map(|run| json!({"ok":true,"run":run})),
            AoMutation::Cancel {
                run_id,
                expected_revision,
            } => integrations::ao::cancel(data, &workspace_id, &run_id, expected_revision).map(|run| json!({"ok":true,"run":run})),
        })
        .map_err(text_error)
    })
    .await;
    match outcome {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, "AO_UPDATE_FAILED", error),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AO_UPDATE_UNKNOWN",
            "AO update outcome unknown; refresh before retrying",
        ),
    }
}

async fn execution_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<ExecutionReadRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_read") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if body.workspace_id.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "EXECUTION_WORKSPACE_REQUIRED",
            "Workspace is required",
        );
    }
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    let mission_id = body.mission_id;
    let _ = body.refresh_source;
    let outcome = tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        integrations::execution::service::view(&request, mission_id.as_deref()).map_err(text_error)
    })
    .await;
    execution_outcome(outcome, "EXECUTION_READ_FAILED")
}

async fn execution_provider(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_provider") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    json_error(
        StatusCode::GONE,
        "APP_MODULE_RETIRED",
        "Standalone execution is retired; use AO routes",
    )
}

async fn execution_update(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_update") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    json_error(
        StatusCode::GONE,
        "APP_MODULE_RETIRED",
        "Standalone execution is retired; use AO routes",
    )
}

async fn execution_orchestration_reserve(
    State(state): State<ServiceState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_orchestration_reserve") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    json_error(
        StatusCode::GONE,
        "APP_MODULE_RETIRED",
        "Standalone execution is retired; use AO routes",
    )
}

async fn execution_orchestration_status(
    State(state): State<ServiceState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_orchestration_status") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    json_error(
        StatusCode::GONE,
        "APP_MODULE_RETIRED",
        "Standalone execution is retired; use AO routes",
    )
}

async fn operation_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    AxumPath(request_id): AxumPath<String>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "operation_read") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let operations = match state.operations.lock() {
        Ok(operations) => operations,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "OPERATIONS_UNAVAILABLE",
                "Operation store unavailable",
            )
        }
    };
    match operations.records.get(&request_id) {
        Some(receipt) => Json(json!({"ok":true,"operation":receipt})).into_response(),
        None => json_error(
            StatusCode::NOT_FOUND,
            "OPERATION_NOT_FOUND",
            "No retained operation has this request ID",
        ),
    }
}

fn valid_request_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

async fn tool_call(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<ToolCallRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "tool_call") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !valid_request_id(&body.request_id) || body.workspace_id.is_empty() || body.tool.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "INVALID_TOOL_REQUEST",
            "Request ID, workspace and tool are required",
        );
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([body.workspace_id, body.tool, body.arguments]))
                .unwrap_or_default(),
        )
    );
    {
        let operations = match state.operations.lock() {
            Ok(operations) => operations,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "OPERATIONS_UNAVAILABLE",
                    "Operation store unavailable",
                )
            }
        };
        if let Some(existing) = operations.records.get(&body.request_id) {
            if existing.fingerprint != fingerprint {
                return json_error(
                    StatusCode::CONFLICT,
                    "REQUEST_ID_REUSED",
                    "Request ID already identifies different arguments",
                );
            }
            return Json(
                json!({"ok":true,"operation":existing,"replayed":false,"redispatched":false}),
            )
            .into_response();
        }
    }
    let context = match if matches!(
        body.tool.as_str(),
        "codex_runtime_status" | "codex_agent_read" | "codex_agent_control" | "codex_command_exec"
    ) {
        state
            .core
            .with_runtime(|runtime| runtime.native_bridge_context(&body.workspace_id))
            .map_err(text_error)
    } else {
        state.context(&body.workspace_id)
    } {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    let admitted_at_ms = now_ms();
    {
        let mut operations = match state.operations.lock() {
            Ok(operations) => operations,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "OPERATIONS_UNAVAILABLE",
                    "Operation store unavailable",
                )
            }
        };
        operations.insert(OperationReceipt {
            request_id: body.request_id.clone(),
            fingerprint: fingerprint.clone(),
            workspace_id: body.workspace_id.clone(),
            tool: body.tool.clone(),
            state: "running".into(),
            admitted_at_ms,
            finished_at_ms: None,
            result: None,
            error: None,
            automatic_replay: false,
        });
    }
    let request_id = body.request_id.clone();
    let workspace_id = body.workspace_id.clone();
    let tool = body.tool.clone();
    let arguments = body.arguments.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        tools::dispatch::call_tool_mcp(&context, &tool, &arguments)
    })
    .await;
    let (state_name, result, error) = match outcome {
        Ok(value) => match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= MAX_RESULT_BYTES => ("completed", Some(value), None),
            Ok(_) => (
                "failed",
                None,
                Some("Tool result exceeded the retained response limit".into()),
            ),
            Err(error) => ("failed", None, Some(text_error(error))),
        },
        Err(error) => ("unknown", None, Some(text_error(error))),
    };
    let receipt = OperationReceipt {
        request_id: request_id.clone(),
        fingerprint,
        workspace_id,
        tool: body.tool,
        state: state_name.into(),
        admitted_at_ms,
        finished_at_ms: Some(now_ms()),
        result,
        error,
        automatic_replay: false,
    };
    if let Ok(mut operations) = state.operations.lock() {
        operations.insert(receipt.clone());
    }
    Json(json!({"ok":true,"operation":receipt,"replayed":false,"redispatched":false}))
        .into_response()
}

fn router(state: ServiceState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/control/v1/health", get(health))
        .route("/admin/drain", post(drain))
        .route("/control/v1/drain", post(drain))
        .route("/admin/resume", post(resume))
        .route("/control/v1/resume", post(resume))
        .route("/control/v1/shutdown", post(shutdown))
        .route("/api/v1/state", get(state_view))
        .route(
            "/api/v1/workspaces",
            get(workspace_list).post(workspace_create),
        )
        .route("/api/v1/workspaces/auth", post(workspace_auth_update))
        .route("/api/v1/workspaces/policy", post(workspace_policy_update))
        .route("/api/v1/native-codex/status", post(native_codex_status))
        .route("/api/v1/native-codex/approval", post(native_codex_approval))
        .route("/api/v1/native-codex/connect", post(native_codex_connect))
        .route(
            "/api/v1/native-codex/disconnect",
            post(native_codex_disconnect),
        )
        .route("/api/v1/workspaces/service", post(workspace_service))
        .route("/api/v1/workspaces/secret", post(workspace_secret))
        .route("/api/v1/integrations/read", post(integration_read))
        .route("/api/v1/ao/read", post(ao_read))
        .route("/api/v1/ao/control", post(ao_control))
        .route("/api/v1/ao/grant", post(ao_run_grant))
        .route("/api/v1/ao/update", post(ao_update))
        .route("/api/v1/ao/harness/status", post(ao_harness_status))
        .route("/api/v1/ao/harness/connect", post(ao_harness_connect))
        .route("/api/v1/ao/harness/execute", post(ao_harness_execute))
        .route("/api/v1/ao/harness/observe", post(ao_harness_observe))
        .route("/api/v1/ao/harness/approval", post(ao_harness_approval))
        .route("/api/v1/ao/harness/disconnect", post(ao_harness_disconnect))
        .route("/api/v1/ao/external/reserve", post(ao_external_reserve))
        .route("/api/v1/ao/external/submitted", post(ao_external_submitted))
        .route("/api/v1/ao/external/terminal", post(ao_external_terminal))
        .route("/api/v1/execution/read", post(execution_read))
        .route("/api/v1/execution/provider", post(execution_provider))
        .route("/api/v1/execution/update", post(execution_update))
        .route(
            "/api/v1/execution/orchestration/reserve",
            post(execution_orchestration_reserve),
        )
        .route(
            "/api/v1/execution/orchestration/status",
            post(execution_orchestration_status),
        )
        .route("/api/v1/tools/catalog", get(tool_catalog))
        .route("/api/v1/tools/call", post(tool_call))
        .route("/api/v1/operations/{request_id}", get(operation_read))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

#[derive(Clone)]
pub struct ShutdownHandle {
    sender: tokio::sync::watch::Sender<Option<String>>,
}

impl ShutdownHandle {
    pub fn request(&self, reason: impl Into<String>) {
        let _ = self.sender.send(Some(reason.into()));
    }
}

pub struct HeadlessService {
    endpoint: String,
    token_file: PathBuf,
    descriptor_path: PathBuf,
    shutdown: ShutdownHandle,
    join: tokio::task::JoinHandle<Result<(), String>>,
}

impl HeadlessService {
    pub async fn start(config: ServiceConfig) -> Result<Self, String> {
        let core = Arc::new(CoreState::load().map_err(text_error)?);
        Self::start_with_core(config, core).await
    }

    pub async fn start_with_core(
        config: ServiceConfig,
        core: Arc<CoreState>,
    ) -> Result<Self, String> {
        fs::create_dir_all(&config.app_data_dir).map_err(text_error)?;
        let auth = ControlAuth::generate();
        let token_file = std::env::var_os("CODING_TOOLS_CONTROL_TOKEN_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                config
                    .app_data_dir
                    .join("aiTemp")
                    .join("headless-control")
                    .join(format!("token-{}.txt", uuid::Uuid::new_v4()))
            });
        write_private_file(
            &token_file,
            auth.token.as_bytes(),
            &config.app_data_dir,
            "control-token",
        )?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(text_error)?;
        let address = listener.local_addr().map_err(text_error)?;
        let endpoint = format!("http://{address}");
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel::<Option<String>>(None);
        let local_ui_token = if std::env::var("CODING_TOOLS_LOCAL_UI_STDIN").as_deref() == Ok("1") {
            let mut raw = String::new();
            std::io::stdin()
                .take(128)
                .read_to_string(&mut raw)
                .map_err(text_error)?;
            let value = raw.trim();
            if value.len() != 43
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
            {
                return Err("Invalid local UI confirmation channel".into());
            }
            Some(value.to_owned())
        } else {
            None
        };
        let state = ServiceState {
            lifecycle: Lifecycle::new(config.max_active_requests),
            auth: auth.clone(),
            local_ui_token,
            core,
            contexts: Arc::new(Mutex::new(HashMap::new())),
            ao_hubs: Arc::new(Mutex::new(HashMap::new())),
            ao_home_root: config.app_data_dir.join("ao-homes"),
            operations: Arc::new(Mutex::new(OperationStore::default())),
            shutdown_tx: shutdown_tx.clone(),
            drain_timeout: config.drain_timeout,
        };
        let started_at_ms = now_ms();
        let descriptor_path = config.descriptor_path.clone();
        let ready = Descriptor {
            schema: 1,
            protocol_version: CONTROL_PROTOCOL_VERSION,
            pid: std::process::id(),
            endpoint: &endpoint,
            version: env!("CARGO_PKG_VERSION"),
            token_sha256: &auth.token_sha256,
            token_file: token_file.to_string_lossy().into_owned(),
            app_data_dir: config.app_data_dir.to_string_lossy().into_owned(),
            started_at_ms,
            status: "ready",
            shutdown_reason: None,
        };
        write_private_file(
            &descriptor_path,
            &serde_json::to_vec_pretty(&ready).map_err(text_error)?,
            &config.app_data_dir,
            "control-descriptor",
        )?;
        let service_app_data = config.app_data_dir.clone();
        let service_descriptor = descriptor_path.clone();
        let service_endpoint = endpoint.clone();
        let service_token_file = token_file.clone();
        let token_hash = auth.token_sha256.clone();
        let service_shutdown_tx = shutdown_tx.clone();
        let join = tokio::spawn(async move {
            let app = router(state);
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    while shutdown_rx.borrow().is_none() {
                        if shutdown_rx.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await
                .map_err(text_error);
            let reason = service_shutdown_tx
                .borrow()
                .clone()
                .unwrap_or_else(|| "listener-stopped".into());
            let stopped = Descriptor {
                schema: 1,
                protocol_version: CONTROL_PROTOCOL_VERSION,
                pid: std::process::id(),
                endpoint: &service_endpoint,
                version: env!("CARGO_PKG_VERSION"),
                token_sha256: &token_hash,
                token_file: service_token_file.to_string_lossy().into_owned(),
                app_data_dir: service_app_data.to_string_lossy().into_owned(),
                started_at_ms,
                status: "stopped",
                shutdown_reason: Some(&reason),
            };
            let descriptor_result = write_private_file(
                &service_descriptor,
                &serde_json::to_vec_pretty(&stopped).map_err(text_error)?,
                &service_app_data,
                "control-descriptor-stopped",
            );
            result.and(descriptor_result)
        });
        Ok(Self {
            endpoint,
            token_file,
            descriptor_path,
            shutdown: ShutdownHandle {
                sender: shutdown_tx,
            },
            join,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn token_file(&self) -> &Path {
        &self.token_file
    }

    pub fn descriptor_path(&self) -> &Path {
        &self.descriptor_path
    }

    pub fn shutdown_handle(&self) -> ShutdownHandle {
        self.shutdown.clone()
    }

    pub async fn wait(self) -> Result<(), String> {
        self.join.await.map_err(text_error)?
    }

    pub async fn shutdown(self, reason: &str) -> Result<(), String> {
        self.shutdown.request(reason.to_string());
        self.join.await.map_err(text_error)?
    }
}
