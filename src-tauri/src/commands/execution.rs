//! Visible local operator controls; endpoints and credentials never originate
//! from an MCP prompt. MCP/Actions still use the shared workflow dispatcher,
//! while these commands require an explicitly visible local controller.
use crate::{
    app_state::AppState,
    error::{AppError, AppResult},
    integrations::execution::service,
    tools::{workflow, ToolContext},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{State, WebviewWindow};

fn fail(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}

fn local(window: &WebviewWindow, write: bool) -> AppResult<()> {
    if window.label() != "main"
        || !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || (write && !window.is_focused().unwrap_or(false))
    {
        return Err(fail(
            "Use the visible, focused main-window controller for provider consent",
        ));
    }
    Ok(())
}

fn context(state: &AppState, id: &str) -> AppResult<Arc<ToolContext>> {
    state.with_runtime(|runtime| runtime.native_bridge_context(id))
}

#[tauri::command]
pub async fn execution_local_read(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
    mission_id: Option<String>,
    refresh_source: Option<bool>,
) -> AppResult<Value> {
    local(&window, false)?;
    let ctx = context(&state, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = ctx.for_request().map_err(|error| fail(error.message()))?;
        workflow::call(
            &request,
            "workflow_list",
            &json!({
                "mission_id": mission_id,
                "refresh_source": refresh_source.unwrap_or(false),
            }),
        )
        .map_err(|error| fail(error.message()))
    })
    .await
    .map_err(|_| fail("Mission observation worker unavailable"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execution_local_provider(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
    operation: String,
    expected_revision: Option<u64>,
    binding_id: Option<String>,
    settings: Option<service::Settings>,
    credential: Option<String>,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Local provider consent was not confirmed"));
    }
    let ctx = context(&state, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = ctx.for_request().map_err(|error| fail(error.message()))?;
        match operation.as_str() {
            "configure" => service::configure(
                &request,
                expected_revision.ok_or_else(|| fail("Missing execution-book revision"))?,
                settings.ok_or_else(|| fail("Provider settings required"))?,
                credential.unwrap_or_default(),
            ),
            "connect" => service::reconnect(
                &request,
                binding_id
                    .as_deref()
                    .ok_or_else(|| fail("Select an existing provider binding"))?,
                credential.unwrap_or_default(),
                true,
            ),
            "disable" => service::disable(
                &request,
                binding_id
                    .as_deref()
                    .ok_or_else(|| fail("Select an existing provider binding"))?,
            ),
            _ => Err(fail("Unsupported local provider operation")),
        }
    })
    .await
    .map_err(|_| fail("Provider settings worker unavailable"))?
}

#[tauri::command]
pub async fn execution_local_update(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
    expected_revision: u64,
    change: Value,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm this particular mission operation locally"));
    }
    // This command is intentionally not a generic approval-token bypass. It
    // accepts only the typed mission operations and requires this focused UI.
    let change: service::Change =
        serde_json::from_value(change).map_err(|_| fail("Invalid mission operation"))?;
    let ctx = context(&state, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = ctx.for_request().map_err(|error| fail(error.message()))?;
        service::change(&request, expected_revision, change)
            .map(|execution| json!({"ok": true, "execution": execution}))
    })
    .await
    .map_err(|_| fail("Mission control worker unavailable"))?
}
