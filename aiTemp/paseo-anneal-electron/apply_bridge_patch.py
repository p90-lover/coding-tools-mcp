#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(content: str, old: str, new: str, label: str) -> str:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return content.replace(old, new, 1)


def insert_before(content: str, marker: str, addition: str, label: str) -> str:
    if addition.strip() in content:
        return content
    return replace_once(content, marker, addition + marker, label)


def patch_headless() -> None:
    path = "rust-core/coding-tools-headless/src/lib.rs"
    content = read(path)
    content = replace_once(
        content,
        "let core = Arc::new(CoreState::from_data(AppData::default()).map_err(text_error)?);",
        "let core = Arc::new(CoreState::load().map_err(text_error)?);",
        "persistent CoreState",
    )

    request_types = r'''
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionReadRequest {
    workspace_id: String,
    mission_id: Option<String>,
    #[serde(default)]
    refresh_source: bool,
}

#[derive(Debug, Deserialize)]
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

'''
    content = insert_before(
        content,
        "fn json_error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {",
        request_types,
        "execution request types",
    )

    handlers = r'''
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
    let change: integrations::execution::service::Change =
        match serde_json::from_value(body.change) {
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

'''
    content = insert_before(
        content,
        "async fn operation_read(",
        handlers,
        "execution handlers",
    )

    content = replace_once(
        content,
        '        .route("/api/v1/integrations/read", post(integration_read))\n'
        '        .route("/api/v1/tools/catalog", get(tool_catalog))',
        '        .route("/api/v1/integrations/read", post(integration_read))\n'
        '        .route("/api/v1/execution/read", post(execution_read))\n'
        '        .route("/api/v1/execution/provider", post(execution_provider))\n'
        '        .route("/api/v1/execution/update", post(execution_update))\n'
        '        .route("/api/v1/tools/catalog", get(tool_catalog))',
        "execution routes",
    )
    write(path, content)


def patch_ipc_schema() -> None:
    path = "desktop-electron/electron/ipc-schema.cjs"
    content = read(path)
    content = replace_once(
        content,
        '  "secret_key",\n  "password",',
        '  "secret_key",\n  "credential",\n  "password",',
        "credential response isolation",
    )
    schemas = r'''
const executionReadRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    missionId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    refreshSource: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const executionSettings = Object.freeze({
  type: "object",
  required: Object.freeze([
    "engine",
    "endpoint",
    "provider",
    "model",
    "mode",
    "maxDurationMin",
    "allowCodex",
    "confirmExternalExecution",
  ]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    engine: Object.freeze({ type: "string", enum: Object.freeze(["paseo", "anneal"]) }),
    endpoint: Object.freeze({ type: "string", minLength: 1, maxLength: 2048 }),
    provider: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    model: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    mode: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    projectId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    repoId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    assigneeId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    maxDurationMin: Object.freeze({ type: "integer", minimum: 1, maximum: 1440 }),
    allowCodex: Object.freeze({ type: "boolean" }),
    confirmExternalExecution: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const executionProviderRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "operation", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    operation: Object.freeze({
      type: "string",
      enum: Object.freeze(["configure", "connect", "disable"]),
    }),
    expectedRevision: Object.freeze({ type: "integer", minimum: 0, nullable: true }),
    bindingId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    settings: Object.freeze({ ...executionSettings, nullable: true }),
    credential: Object.freeze({ type: "string", maxLength: 4096 }),
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const executionUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "expectedRevision", "change", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    expectedRevision: Object.freeze({ type: "integer", minimum: 0 }),
    change: genericObject,
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

'''
    content = insert_before(
        content,
        "const CONTRACTS = Object.freeze({",
        schemas,
        "execution IPC schemas",
    )
    contracts = r'''  "execution.read": Object.freeze({
    channel: "coding-tools:execution:read",
    request: executionReadRequest,
    response: genericObject,
  }),
  "execution.provider": Object.freeze({
    channel: "coding-tools:execution:provider",
    request: executionProviderRequest,
    response: genericObject,
  }),
  "execution.update": Object.freeze({
    channel: "coding-tools:execution:update",
    request: executionUpdateRequest,
    response: genericObject,
  }),
'''
    content = replace_once(
        content,
        '  "updates.status": Object.freeze({',
        contracts + '  "updates.status": Object.freeze({',
        "execution IPC contracts",
    )
    write(path, content)


def patch_preload() -> None:
    path = "desktop-electron/electron/preload.cjs"
    content = read(path)
    addition = r'''  execution: Object.freeze({
    read: (input) => invokeContract(ipcRenderer, "execution.read", input),
    provider: (input) => invokeContract(ipcRenderer, "execution.provider", input),
    update: (input) => invokeContract(ipcRenderer, "execution.update", input),
  }),
'''
    content = replace_once(
        content,
        '  updates: Object.freeze({',
        addition + '  updates: Object.freeze({',
        "execution preload facade",
    )
    write(path, content)


def patch_main() -> None:
    path = "desktop-electron/electron/main.cjs"
    content = read(path)
    content = replace_once(
        content,
        'const { RuntimeHost } = require("./runtime.cjs");',
        'const { RuntimeHost } = require("./runtime.cjs");\n'
        'const { HeadlessHost } = require("./headless-host.cjs");',
        "headless host import",
    )
    content = replace_once(
        content,
        "let runtimeHost = null;\nlet browserControl = null;",
        "let runtimeHost = null;\nlet headlessHost = null;\nlet browserControl = null;",
        "headless host state",
    )

    helpers = r'''
function assertFocusedMainWindow(event, write = false) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const valid = window
    && window === mainWindow
    && !window.isDestroyed()
    && window.isVisible()
    && !window.isMinimized()
    && (!write || (window.isFocused() && event.sender.isFocused()));
  if (!valid) {
    throw new Error("Use the visible, focused main-window controller for provider consent");
  }
}

function executionSettingsPayload(settings) {
  if (!settings) return null;
  return {
    id: settings.id ?? null,
    engine: settings.engine,
    endpoint: settings.endpoint,
    provider: settings.provider,
    model: settings.model,
    mode: settings.mode,
    project_id: settings.projectId ?? null,
    repo_id: settings.repoId ?? null,
    assignee_id: settings.assigneeId ?? null,
    max_duration_min: settings.maxDurationMin,
    allow_codex: settings.allowCodex,
    confirm_external_execution: settings.confirmExternalExecution,
  };
}

'''
    content = insert_before(
        content,
        "function registerIpc({ logger, stateStore }) {",
        helpers,
        "focused execution helpers",
    )

    handlers = r'''  handle("coding-tools:execution:read", async (event, input) => {
    assertFocusedMainWindow(event, false);
    if (!headlessHost) throw new Error("Local execution service is unavailable");
    return headlessHost.request("/api/v1/execution/read", {
      workspace_id: input.workspaceId,
      mission_id: input.missionId ?? null,
      refresh_source: input.refreshSource === true,
    });
  });
  handle("coding-tools:execution:provider", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost) throw new Error("Local execution service is unavailable");
    return headlessHost.request("/api/v1/execution/provider", {
      workspace_id: input.workspaceId,
      operation: input.operation,
      expected_revision: input.expectedRevision ?? null,
      binding_id: input.bindingId ?? null,
      settings: executionSettingsPayload(input.settings),
      credential: input.credential ?? "",
      confirm: input.confirm === true,
    });
  });
  handle("coding-tools:execution:update", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost) throw new Error("Local execution service is unavailable");
    return headlessHost.request("/api/v1/execution/update", {
      workspace_id: input.workspaceId,
      expected_revision: input.expectedRevision,
      change: input.change,
      confirm: input.confirm === true,
    });
  });

'''
    content = replace_once(
        content,
        '  handle("launcher:snapshot", async () => ({',
        handlers + '  handle("launcher:snapshot", async () => ({',
        "execution IPC handlers",
    )

    content = replace_once(
        content,
        "    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });\n"
        "    stopCatalogVerificationMonitor();",
        "    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });\n"
        "    await headlessHost?.shutdown(\"launcher-quit\");\n"
        "    stopCatalogVerificationMonitor();",
        "headless shutdown",
    )

    content = replace_once(
        content,
        "  const startHidden = process.argv.includes(\"--hidden\") && stateStore.read().onboardingComplete;\n"
        "  nativeTheme.themeSource = \"system\";",
        "  const startHidden = process.argv.includes(\"--hidden\") && stateStore.read().onboardingComplete;\n"
        "  headlessHost = new HeadlessHost({\n"
        "    app,\n"
        "    logger,\n"
        "    sourceRoot: SOURCE_ROOT,\n"
        "  });\n"
        "  nativeTheme.themeSource = \"system\";",
        "headless host construction",
    )
    write(path, content)


def main() -> None:
    patch_headless()
    patch_ipc_schema()
    patch_preload()
    patch_main()


if __name__ == "__main__":
    main()
