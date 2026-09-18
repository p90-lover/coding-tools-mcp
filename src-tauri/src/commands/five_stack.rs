//! Focused-main-window original UI lifecycle for the five managed stacks.
use crate::error::{AppError, AppResult};
use crate::integrations::five_stack::{
    self, window_label, Catalog, OpenResult, ToolId, ToolSnapshot,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn local_focused(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::Message(
            "Original UI controls are only available in the main desktop UI".into(),
        ));
    }
    if !window.is_focused().unwrap_or(false) {
        return Err(AppError::Message(
            "Open original UI from the focused Coding Tools window".into(),
        ));
    }
    Ok(())
}

fn parse_id(tool_id: &str) -> AppResult<ToolId> {
    ToolId::parse(tool_id)
}

#[tauri::command]
pub async fn five_stack_snapshot(window: WebviewWindow) -> AppResult<Catalog> {
    if window.label() != "main" {
        return Err(AppError::Message(
            "Original UI controls are only available in the main desktop UI".into(),
        ));
    }
    Ok(five_stack::snapshot().await)
}

#[tauri::command]
pub async fn five_stack_inspect(window: WebviewWindow, tool_id: String) -> AppResult<ToolSnapshot> {
    if window.label() != "main" {
        return Err(AppError::Message(
            "Original UI controls are only available in the main desktop UI".into(),
        ));
    }
    Ok(five_stack::inspect(parse_id(&tool_id)?).await)
}

#[tauri::command]
pub async fn five_stack_start(window: WebviewWindow, tool_id: String) -> AppResult<ToolSnapshot> {
    local_focused(&window)?;
    five_stack::start(parse_id(&tool_id)?).await
}

#[tauri::command]
pub async fn five_stack_stop(window: WebviewWindow, tool_id: String) -> AppResult<ToolSnapshot> {
    local_focused(&window)?;
    five_stack::stop(parse_id(&tool_id)?)
}

#[tauri::command]
pub async fn five_stack_restart(window: WebviewWindow, tool_id: String) -> AppResult<ToolSnapshot> {
    local_focused(&window)?;
    five_stack::restart(parse_id(&tool_id)?).await
}

#[tauri::command]
pub async fn five_stack_bootstrap(window: WebviewWindow) -> AppResult<Catalog> {
    local_focused(&window)?;
    five_stack::bootstrap().await
}

#[tauri::command]
pub async fn five_stack_copy_cpa_management_key(window: WebviewWindow) -> AppResult<String> {
    local_focused(&window)?;
    five_stack::cpa_management_key()
}

#[tauri::command]
pub async fn five_stack_open(
    app: AppHandle,
    window: WebviewWindow,
    tool_id: String,
    section: Option<String>,
) -> AppResult<OpenResult> {
    local_focused(&window)?;
    let id = parse_id(&tool_id)?;
    let mut opened = five_stack::open_target(id, section.as_deref())?;
    let current = five_stack::inspect(id).await;
    opened.tool = current.clone();
    if current.status != "ready" {
        let started = five_stack::start(id).await?;
        opened.tool = started;
    }
    if id == ToolId::CommandCodeProxy {
        opened.original_window = false;
        return Ok(opened);
    }
    let parsed = opened
        .url
        .parse::<url::Url>()
        .map_err(|_| AppError::Message("Original UI URL is invalid".into()))?;
    let label = window_label(id);
    if let Some(existing) = app.get_webview_window(&label) {
        let script = format!(
            "location.replace({})",
            serde_json::to_string(&opened.url).unwrap_or_else(|_| "''".into())
        );
        let _ = existing.eval(&script);
        let _ = existing.set_focus();
        opened.original_window = true;
        return Ok(opened);
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(five_stack::spec(id).name)
        .inner_size(1280.0, 800.0)
        .focused(true)
        .build()
        .map_err(|error| AppError::Message(error.to_string()))?;
    opened.original_window = true;
    Ok(opened)
}
