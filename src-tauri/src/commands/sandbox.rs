//! Local setup of OS users/ACLs/firewall. Never expose preparation through MCP.
use crate::{
    app_state::AppState,
    error::{AppError, AppResult},
    tools::{native_sandbox, Workspace},
};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{State, WebviewWindow};
fn local(window: &WebviewWindow, focused: bool) -> AppResult<()> {
    if window.label() != "main"
        || !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || (focused && !window.is_focused().unwrap_or(false))
    {
        return Err(AppError::Message(
            "Use the visible local workspace UI to configure the OS sandbox".into(),
        ));
    }
    Ok(())
}
fn scope(state: &AppState, id: &str) -> AppResult<(crate::workspace::WorkspaceProfile, PathBuf)> {
    let p = state.with_workspaces(|s| {
        s.get(id)
            .cloned()
            .ok_or_else(|| AppError::Message("Workspace not found".into()))
    })?;
    if !matches!(p.auth.auth_type.as_str(), "bearer" | "oauth") {
        return Err(AppError::Message("Authenticated MCP is required".into()));
    }
    let w = Workspace::new(PathBuf::from(&p.path)).map_err(|e| AppError::Message(e.message()))?;
    Ok((p, w.root().to_path_buf()))
}
#[tauri::command]
pub async fn sandbox_local_prepare(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Value> {
    local(&window, true)?;
    let (profile, root) = scope(&state, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || native_sandbox::local_setup(profile, root))
        .await
        .map_err(|e| AppError::Message(e.to_string()))?
}
#[tauri::command]
pub fn sandbox_local_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Value> {
    local(&window, false)?;
    let (_, root) = scope(&state, &workspace_id)?;
    native_sandbox::local_status(&root)
}
#[tauri::command]
pub fn sandbox_local_disable(window: WebviewWindow, workspace_id: String) -> AppResult<()> {
    local(&window, true)?;
    native_sandbox::local_disable(&workspace_id)
}
