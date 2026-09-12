//! The local operator can inspect existing task and runtime records; this command
//! cannot grant permissions, start agents, invoke a tool or replay an operation.
use crate::{
    app_state::AppState,
    error::{AppError, AppResult},
    harness::{
        monitor::{self, Cursor},
        Harness,
    },
    runtime::ServiceKind,
    tools::registry,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{State, WebviewWindow};
use tokio::sync::Semaphore;

fn message(s: impl Into<String>) -> AppError {
    AppError::Message(s.into())
}
#[tauri::command]
pub async fn task_monitor_read(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
    task_id: Option<String>,
    cursor: Option<Cursor>,
) -> AppResult<Value> {
    if window.label() != "main" {
        return Err(message(
            "Task monitor is only available in the main Desktop window",
        ));
    }
    static READS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let permit = READS
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| message("Task monitor busy; let the existing read finish"))?;
    let configured = state.with_workspaces(|s| {
        s.get(&workspace_id)
            .cloned()
            .ok_or_else(|| message("Workspace not found"))
    })?;
    let path = PathBuf::from(&configured.path);
    let history = Harness::default_root().map_err(|e| message(e.to_string()))?;
    let read_path = path.clone();
    let selected = task_id.clone();
    // The permit belongs to the blocking read even after a timeout, so a blocked
    // OS read cannot create an unbounded queue of replacement background reads.
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        monitor::read(&history, &read_path, selected.as_deref(), cursor.as_ref())
    });
    let observed = tokio::time::timeout(Duration::from_secs(8), handle)
        .await
        .map_err(|_| message("Task monitor read timed out; no operation was restarted"))?
        .map_err(|_| message("Task monitor worker failed"))?
        .map_err(|e| message(e.to_string()))?;
    let still_configured = state.with_workspaces(|s| {
        s.get(&workspace_id)
            .cloned()
            .ok_or_else(|| message("Workspace was removed during observation"))
    })?;
    if still_configured.path != configured.path {
        return Err(message(
            "Workspace changed during observation; refresh again",
        ));
    }
    let context = state.with_runtime(|r| {
        if r.is_running(&workspace_id, ServiceKind::Mcp) {
            r.native_bridge_context(&workspace_id).map(Some)
        } else {
            Ok(None)
        }
    })?;
    let (runtime, revision, mode) = if let Some(ctx) = context {
        let current = ctx.for_request().map_err(|e| message(e.message()))?;
        if current.workspace.root()
            != path
                .canonicalize()
                .map_err(|_| message("Workspace is unavailable"))?
        {
            return Err(message("Listener workspace differs from selected project"));
        }
        let tools = registry::list_tools_for_profile(&current.tool_profile);
        let names = tools
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect::<Vec<_>>();
        let receipts = current
            .operations
            .query_in_scope(
                &json!({"limit":20}),
                current.policy_revision,
                &names,
                &current.workspace.roots_revision(),
            )
            .map_err(message)?;
        (
            receipts,
            json!(current.policy_revision),
            current.permission_mode.clone(),
        )
    } else {
        (
            json!({"operations":[],"runtime_id":null}),
            Value::Null,
            configured.runtime.permission_mode.clone(),
        )
    };
    Ok(
        json!({"workspace_id":workspace_id,"requested_task_id":task_id,"workspace_path":configured.path,
        "desktop_version":env!("CARGO_PKG_VERSION"),"checked_at_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "listener_running":!runtime["runtime_id"].is_null(),"runtime_id":runtime["runtime_id"],"policy_revision":revision,"permission_mode":mode,
        "history":observed,"request_log_diagnostics":crate::mcp::request_log::status(),"operations":runtime["operations"],"retention":runtime["retention"],
        "retention_note":"Receipts belong to this listener and may expire. Dispatch completion does not prove a command finished. History shows recorded evidence, not live process inspection."}),
    )
}
