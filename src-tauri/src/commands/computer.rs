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
pub(super) fn approved_root(state: &AppState, id: &str) -> AppResult<PathBuf> {
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
    always_enabled: Option<bool>,
    remember_app: Option<bool>,
    restore_on_start: Option<bool>,
    start_at_login: Option<bool>,
    discover_windows: Option<bool>,
    observe_in_background: Option<bool>,
) -> AppResult<Value> {
    local_window(&window, true)?;
    if !window.is_focused().unwrap_or(false) {
        return Err(AppError::Message(
            "Use the visible local Start button to grant control".into(),
        ));
    }
    let root = approved_root(&state, &workspace_id)?;
    let remember = remember_app.unwrap_or(false);
    let restore = restore_on_start.unwrap_or(false);
    let login = start_at_login.unwrap_or(false);
    let discovery = discover_windows.unwrap_or(false);
    if (restore && (!remember || !always_enabled.unwrap_or(false)))
        || (login && !restore)
        || (discovery && !remember)
    {
        return Err(AppError::Message("Remember app is required for discovery; restart recovery also requires Always enabled; sign-in startup requires restart recovery".into()));
    }
    let profile = state.with_workspaces(|s| {
        s.get(&workspace_id)
            .cloned()
            .ok_or_else(|| AppError::Message("Workspace missing".into()))
    })?;
    computer::permissions::block_restore();
    let epoch = computer::permissions::epoch();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let target = computer::list_local_targets()?
            .into_iter()
            .find(|t| t.window_id == window_id && t.pid == pid)
            .ok_or_else(|| {
                crate::tools::workspace::WorkspaceError::invalid_argument(
                    "Selected window changed; refresh the window list",
                )
            })?;
        // Consent is local and explicit; binding includes canonical executable and digest.
        computer::permissions::set_active(&profile.id);
        let result = computer::local_arm_at_epoch(
            root.clone(),
            target.clone(),
            duration_seconds,
            always_enabled.unwrap_or(false),
            epoch,
        )?;
        let saved = (|| -> AppResult<()> {
            if remember {
                computer::permissions::save_local(
                    &profile, root, &target, restore, login, discovery, epoch,
                )?;
                computer::permissions::login_startup(login)?;
            } else {
                // A session-only grant must not reactivate older remembered authority.
                computer::permissions::forget_local(&profile.id)?;
                computer::permissions::login_startup(false)?;
            }
            if computer::permissions::epoch() != epoch {
                return Err(AppError::Message(
                    "Stop cancelled startup registration".into(),
                ));
            }
            Ok(())
        })();
        if saved.is_err() {
            computer::emergency_stop("Remembered permission could not be saved");
            return Err(crate::tools::workspace::WorkspaceError::invalid_argument(
                "Could not save permission/startup settings. Control stopped.",
            ));
        }
        Ok(result)
    })
    .await
    .map_err(|e| AppError::Message(e.to_string()))?
    .map_err(|e| AppError::Message(e.message()))?;
    let opened = open_monitor(&app);
    if let Err(e) = opened {
        computer::emergency_stop("Control display failed to open");
        return Err(AppError::Message(e.to_string()));
    }
    // Observation-only startup does not steal focus. Input still requires foreground.
    if !observe_in_background.unwrap_or(false) {
        let _ = computer::focus_local_target();
    }
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
    let expected_epoch = computer::permissions::epoch();
    computer::resume_local().map_err(|e| AppError::Message(e.message()))?;
    if let Err(e) = computer::permissions::resume_active(expected_epoch) {
        computer::emergency_stop("Could not save local resume");
        return Err(e);
    }
    computer::focus_local_target().map_err(|e| AppError::Message(e.message()))
}
#[tauri::command]
pub fn computer_local_stop(window: WebviewWindow) -> AppResult<()> {
    local_window(&window, false)?;
    computer::emergency_stop("Stopped by local user");
    if !computer::permissions::revocation_saved() {
        return Err(AppError::Message("Control stopped now, but saved revocation could not be written. Disable sign-in startup and revoke remembered permission before restarting this app.".into()));
    }
    Ok(())
}

pub(super) fn open_monitor(app: &AppHandle) -> tauri::Result<()> {
    if let Some(overlay) = app.get_webview_window("computer-use-overlay") {
        overlay.show()?;
        overlay.set_always_on_top(true)?;
    } else {
        WebviewWindowBuilder::new(
            app,
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
}

#[tauri::command]
pub fn computer_local_permissions(window: WebviewWindow, workspace_id: String) -> AppResult<Value> {
    local_window(&window, true)?;
    Ok(computer::permissions::get(&workspace_id)?
        .map(|g| g.summary())
        .unwrap_or_else(|| serde_json::json!({"remembered":false})))
}
#[tauri::command]
pub fn computer_local_forget(window: WebviewWindow, workspace_id: String) -> AppResult<()> {
    local_window(&window, true)?;
    if !window.is_focused().unwrap_or(false) {
        return Err(AppError::Message(
            "Revoke permission from the focused local window".into(),
        ));
    }
    computer::emergency_stop("Remembered approval revoked by local user");
    computer::permissions::set_active(&workspace_id);
    computer::permissions::forget_local(&workspace_id)?;
    computer::permissions::login_startup(false)
}
