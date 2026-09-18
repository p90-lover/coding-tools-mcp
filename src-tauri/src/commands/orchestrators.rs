use crate::{
    error::{AppError, AppResult},
    orchestrator_run::{self, AnnealOrchestratorRunInput, AnnealOrchestratorRunResult},
    orchestrators::{self, OrchestratorProfileInput},
};
use serde_json::Value;
use tauri::WebviewWindow;

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
            "Use the visible, focused main-window controller for orchestrator changes",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn orchestrator_profiles_read(window: WebviewWindow) -> AppResult<Value> {
    local(&window, false)?;
    tauri::async_runtime::spawn_blocking(orchestrators::read)
        .await
        .map_err(|_| fail("Orchestrator registry worker unavailable"))?
}

#[tauri::command]
pub async fn orchestrator_profile_save(
    window: WebviewWindow,
    expected_revision: u64,
    profile: OrchestratorProfileInput,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm orchestrator profile changes locally"));
    }
    tauri::async_runtime::spawn_blocking(move || orchestrators::save(expected_revision, profile))
        .await
        .map_err(|_| fail("Orchestrator save worker unavailable"))?
}

#[tauri::command]
pub async fn orchestrator_profile_archive(
    window: WebviewWindow,
    profile_id: String,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm orchestrator archival locally"));
    }
    tauri::async_runtime::spawn_blocking(move || orchestrators::archive(&profile_id))
        .await
        .map_err(|_| fail("Orchestrator archival worker unavailable"))?
}

#[tauri::command]
pub async fn orchestrator_profile_run(
    window: WebviewWindow,
    input: AnnealOrchestratorRunInput,
    confirm: bool,
) -> AppResult<AnnealOrchestratorRunResult> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm the external Anneal orchestrator run locally"));
    }
    orchestrator_run::run(input).await
}
