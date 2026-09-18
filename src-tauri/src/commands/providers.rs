use crate::{
    error::{AppError, AppResult},
    media::{self, ImageGenerationInput, ImageGenerationResult},
    providers::{self, ProviderProfileInput},
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
            "Use the visible, focused main-window controller for provider changes",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn provider_profiles_read(window: WebviewWindow) -> AppResult<Value> {
    local(&window, false)?;
    tauri::async_runtime::spawn_blocking(providers::read)
        .await
        .map_err(|_| fail("Provider registry worker unavailable"))?
}

#[tauri::command]
pub async fn provider_profile_save(
    window: WebviewWindow,
    expected_revision: u64,
    profile: ProviderProfileInput,
    credential: Option<String>,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm provider profile changes locally"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        providers::save(expected_revision, profile, credential)
    })
    .await
    .map_err(|_| fail("Provider save worker unavailable"))?
}

#[tauri::command]
pub async fn provider_profile_connect(
    window: WebviewWindow,
    profile_id: String,
    credential: String,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm provider authentication locally"));
    }
    tauri::async_runtime::spawn_blocking(move || providers::connect(&profile_id, credential))
        .await
        .map_err(|_| fail("Provider connection worker unavailable"))?
}

#[tauri::command]
pub async fn provider_profile_disable(
    window: WebviewWindow,
    profile_id: String,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm provider admission change locally"));
    }
    tauri::async_runtime::spawn_blocking(move || providers::disable(&profile_id))
        .await
        .map_err(|_| fail("Provider disable worker unavailable"))?
}

#[tauri::command]
pub async fn provider_profile_archive(
    window: WebviewWindow,
    profile_id: String,
    confirm: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm provider archival locally"));
    }
    tauri::async_runtime::spawn_blocking(move || providers::archive(&profile_id))
        .await
        .map_err(|_| fail("Provider archival worker unavailable"))?
}

#[tauri::command]
pub async fn provider_profile_probe(
    window: WebviewWindow,
    profile_id: String,
    discover_models: Option<bool>,
) -> AppResult<Value> {
    local(&window, false)?;
    providers::probe(&profile_id, discover_models.unwrap_or(false)).await
}

#[tauri::command]
pub async fn provider_image_generate(
    window: WebviewWindow,
    input: ImageGenerationInput,
    confirm: bool,
) -> AppResult<ImageGenerationResult> {
    local(&window, true)?;
    if !confirm {
        return Err(fail("Confirm provider image generation and any provider cost locally"));
    }
    media::generate(input).await
}
