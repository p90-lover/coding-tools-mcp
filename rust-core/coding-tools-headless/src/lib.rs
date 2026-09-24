//! Authenticated loopback control service for the Electron-first Coding Tools
//! desktop. The service owns no model and performs no automatic replay.

use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use coding_tools_core::{integrations, tools, CoreState};
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionReadRequest {
    workspace_id: String,
    mission_id: Option<String>,
    #[serde(default)]
    refresh_source: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionProviderRequest {
    workspace_id: String,
    operation: String,
    expected_revision: Option<u64>,
    binding_id: Option<String>,
    settings: Option<integrations::execution::service::Settings>,
    #[serde(default)]
    credential: String,
    #[serde(default)]
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionUpdateRequest {
    workspace_id: String,
    expected_revision: u64,
    change: Value,
    #[serde(default)]
    confirm: bool,
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
    let refresh_source = body.refresh_source;
    let outcome = tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        if refresh_source {
            let mission_id = mission_id
                .as_deref()
                .ok_or_else(|| "Select a mission before refreshing its source".to_string())?;
            integrations::execution::service::refresh(&request, mission_id).map_err(text_error)
        } else {
            integrations::execution::service::view(&request, mission_id.as_deref())
                .map_err(text_error)
        }
    })
    .await;
    execution_outcome(outcome, "EXECUTION_READ_FAILED")
}

async fn execution_provider(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<ExecutionProviderRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_provider") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm {
        return json_error(
            StatusCode::BAD_REQUEST,
            "LOCAL_PROVIDER_CONSENT_REQUIRED",
            "Local provider consent was not confirmed",
        );
    }
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    let outcome = tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        match body.operation.as_str() {
            "configure" => integrations::execution::service::configure(
                &request,
                body.expected_revision
                    .ok_or_else(|| "Missing execution-book revision".to_string())?,
                body.settings
                    .ok_or_else(|| "Provider settings required".to_string())?,
                body.credential,
            )
            .map_err(text_error),
            "connect" => integrations::execution::service::reconnect(
                &request,
                body.binding_id
                    .as_deref()
                    .ok_or_else(|| "Select an existing provider binding".to_string())?,
                body.credential,
                true,
            )
            .map_err(text_error),
            "disable" => integrations::execution::service::disable(
                &request,
                body.binding_id
                    .as_deref()
                    .ok_or_else(|| "Select an existing provider binding".to_string())?,
            )
            .map_err(text_error),
            _ => Err("Unsupported local provider operation".to_string()),
        }
    })
    .await;
    execution_outcome(outcome, "EXECUTION_PROVIDER_FAILED")
}

async fn execution_update(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<ExecutionUpdateRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_update") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    if !body.confirm {
        return json_error(
            StatusCode::BAD_REQUEST,
            "LOCAL_MISSION_CONSENT_REQUIRED",
            "Confirm this particular mission operation locally",
        );
    }
    let change: integrations::execution::service::Change = match serde_json::from_value(body.change)
    {
        Ok(change) => change,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "INVALID_MISSION_OPERATION",
                "Invalid mission operation",
            )
        }
    };
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    let expected_revision = body.expected_revision;
    let outcome = tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        integrations::execution::service::change(&request, expected_revision, change)
            .map_err(text_error)
    })
    .await;
    execution_outcome(outcome, "EXECUTION_UPDATE_FAILED")
}

async fn execution_orchestration_reserve(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<integrations::execution::service::OrchestrationReservation>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_orchestration_reserve") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    match tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        integrations::execution::service::reserve_orchestration(&request, body).map_err(text_error)
    })
    .await
    {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err(error)) => json_error(
            StatusCode::BAD_REQUEST,
            "ORCHESTRATION_RESERVATION_FAILED",
            error,
        ),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXECUTION_WORKER_UNAVAILABLE",
            "Local execution worker unavailable",
        ),
    }
}

async fn execution_orchestration_status(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<integrations::execution::service::OrchestrationStatus>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "execution_orchestration_status") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    let context = match state.context(&body.workspace_id) {
        Ok(context) => context,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, "WORKSPACE_CONTEXT_FAILED", error)
        }
    };
    match tokio::task::spawn_blocking(move || {
        let request = context
            .for_request()
            .map_err(|error| error.message().to_string())?;
        integrations::execution::service::update_orchestration_status(&request, body)
            .map_err(text_error)
    })
    .await
    {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err(error)) => json_error(
            StatusCode::BAD_REQUEST,
            "ORCHESTRATION_STATUS_FAILED",
            error,
        ),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXECUTION_WORKER_UNAVAILABLE",
            "Local execution worker unavailable",
        ),
    }
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
        .route("/api/v1/workspaces", get(workspace_list))
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
