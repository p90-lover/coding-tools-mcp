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
use std::io::Write;
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
                            "tool_profile": profile.runtime.tool_profile,
                            "permission_mode": profile.runtime.permission_mode,
                            "approval_mode": profile.runtime.approval_mode,
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
    let context = match state.context(&body.workspace_id) {
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
        .route("/api/v1/integrations/read", post(integration_read))
        .route("/api/v1/execution/read", post(execution_read))
        .route("/api/v1/execution/provider", post(execution_provider))
        .route("/api/v1/execution/update", post(execution_update))
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
        let core =
            Arc::new(CoreState::load_from_app_data_dir(&config.app_data_dir).map_err(text_error)?);
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
        let state = ServiceState {
            lifecycle: Lifecycle::new(config.max_active_requests),
            auth: auth.clone(),
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
