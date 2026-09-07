//! Local-only IPC. No corresponding MCP method can arm or resume desktop input.
use crate::app_state::AppState;
use crate::error::{AppError, AppResult};
use crate::tools::{computer, PolicySettings, Workspace};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn local_window(window: &WebviewWindow, main_only: bool) -> AppResult<()> {
    if window.label() != "main" && (main_only || window.label() != "computer-use-overlay") {
        return Err(AppError::Message(
            "Computer consent is available only in the local controller UI".into(),
        ));
    }
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        if window.label() == "computer-use-overlay" {
            computer::emergency_stop("Control monitor hidden or minimized");
        }
        return Err(AppError::Message(
            "Open the local controller window first".into(),
        ));
    }
    Ok(())
}
fn approved_root(state: &AppState, id: &str) -> AppResult<PathBuf> {
    let profile = state.with_workspaces(|store| {
        store
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Message("Workspace not found".into()))
    })?;
    if !profile.runtime.allow_screen_capture
        || !matches!(profile.auth.auth_type.as_str(), "bearer" | "oauth")
    {
        return Err(AppError::Message("Enable screen capture and Bearer/OAuth authentication in the workspace MCP settings, then restart the MCP service".into()));
    }
    if PolicySettings::from_runtime(&profile.runtime).canonical_permission_mode() == "read-only" {
        return Err(AppError::Message(
            "Read-only workspace mode cannot enable computer input".into(),
        ));
    }
    Workspace::new(PathBuf::from(profile.path))
        .map(|w| w.root().to_path_buf())
        .map_err(|e| AppError::Message(e.message()))
}
#[tauri::command]
pub async fn computer_local_targets(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<computer::Target>> {
    local_window(&window, true)?;
    approved_root(&state, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(computer::list_local_targets)
        .await
        .map_err(|e| AppError::Message(e.to_string()))?
        .map_err(|e| AppError::Message(e.message()))
}
#[tauri::command]
pub async fn computer_local_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
    window_id: u32,
    pid: u32,
    duration_seconds: u64,
) -> AppResult<Value> {
    local_window(&window, true)?;
    if !window.is_focused().unwrap_or(false) {
        return Err(AppError::Message(
            "Use the visible local Start button to grant control".into(),
        ));
    }
    let root = approved_root(&state, &workspace_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let target = computer::list_local_targets()?
            .into_iter()
            .find(|t| t.window_id == window_id && t.pid == pid)
            .ok_or_else(|| {
                crate::tools::workspace::WorkspaceError::invalid_argument(
                    "Selected window changed; refresh the window list",
                )
            })?;
        computer::local_arm(root, target, duration_seconds)
    })
    .await
    .map_err(|e| AppError::Message(e.to_string()))?
    .map_err(|e| AppError::Message(e.message()))?;
    let opened = (|| -> tauri::Result<()> {
        if let Some(overlay) = app.get_webview_window("computer-use-overlay") {
            overlay.show()?;
            overlay.set_always_on_top(true)?;
        } else {
            WebviewWindowBuilder::new(
                &app,
                "computer-use-overlay",
                WebviewUrl::App("control".into()),
            )
            .title("ChatGPT / MCP computer control — Stop: Ctrl+Alt+Escape")
            .inner_size(500.0, 430.0)
            .min_inner_size(400.0, 360.0)
            .position(24.0, 24.0)
            .always_on_top(true)
            .skip_taskbar(false)
            .focused(false)
            .build()?;
        }
        Ok(())
    })();
    if let Err(e) = opened {
        computer::emergency_stop("Control display failed to open");
        return Err(AppError::Message(e.to_string()));
    }
    // Foreground activation follows the user's local Start gesture, never a remote tool call.
    let _ = computer::focus_local_target();
    Ok(result)
}
#[tauri::command]
pub fn computer_local_poll(
    window: WebviewWindow,
    last_snapshot_id: Option<String>,
) -> AppResult<Value> {
    local_window(&window, false)?;
    Ok(computer::local_status(
        window.label() == "computer-use-overlay",
        last_snapshot_id.as_deref(),
    ))
}
#[tauri::command]
pub async fn computer_local_preview(window: WebviewWindow) -> AppResult<Value> {
    local_window(&window, false)?;
    if window.label() != "computer-use-overlay" {
        return Err(AppError::Message(
            "The preview belongs to the visible control monitor".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(computer::local_preview)
        .await
        .map_err(|e| AppError::Message(e.to_string()))?
        .map_err(|e| AppError::Message(e.message()))
}
#[tauri::command]
pub fn computer_local_pause(window: WebviewWindow) -> AppResult<()> {
    local_window(&window, false)?;
    computer::pause();
    Ok(())
}
#[tauri::command]
pub fn computer_local_resume(window: WebviewWindow) -> AppResult<()> {
    local_window(&window, false)?;
    if !window.is_focused().unwrap_or(false) {
        return Err(AppError::Message(
            "Resume must be initiated from the local control window".into(),
        ));
    }
    computer::resume_local().map_err(|e| AppError::Message(e.message()))?;
    computer::focus_local_target().map_err(|e| AppError::Message(e.message()))
}
#[tauri::command]
pub fn computer_local_stop(window: WebviewWindow) -> AppResult<()> {
    local_window(&window, false)?;
    computer::emergency_stop("Stopped by local user");
    Ok(())
}
