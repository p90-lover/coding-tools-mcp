//! Main-window-only control center. Live connections plus allowlisted original functions.
use crate::{
    data::DataStore,
    error::{AppError, AppResult},
    integrations::{
        self,
        actions::{ActRequest, ActResult},
        board::{Board, Change},
        commandcode::{
            CommandCodeProcessResult, CommandCodeProxyApplyResult, CommandCodeProxyStatus,
        },
        live::LiveStatus,
        Snapshot, Source,
    },
};
use tauri::WebviewWindow;
fn local(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::Message(
            "Control center is only available in the main desktop UI".into(),
        ));
    }
    Ok(())
}

/// Local parsing only; never reads arbitrary files, changes permissions or invokes providers.
#[tauri::command]
pub fn provider_config_preview(
    window: WebviewWindow,
    provider: String,
    content: String,
) -> AppResult<serde_json::Value> {
    local(&window)?;
    crate::config_compat::preview(&provider, &content).map_err(AppError::Message)
}
#[tauri::command]
pub async fn integration_read(
    window: WebviewWindow,
    source: Source,
    endpoint: String,
    credential: Option<String>,
) -> AppResult<Snapshot> {
    local(&window)?;
    integrations::read(source, &endpoint, credential.as_deref().unwrap_or("")).await
}
#[tauri::command]
pub async fn integration_live_connect(
    window: WebviewWindow,
    source: String,
    endpoint: String,
    web_ui: Option<String>,
    credential: Option<String>,
    keep_alive: bool,
    remember: bool,
) -> AppResult<LiveStatus> {
    local(&window)?;
    integrations::live::connect(
        &source,
        &endpoint,
        web_ui.as_deref().unwrap_or(""),
        credential.as_deref().unwrap_or(""),
        keep_alive,
        remember,
    )
    .await
}
#[tauri::command]
pub async fn integration_live_disconnect(
    window: WebviewWindow,
    source: String,
) -> AppResult<LiveStatus> {
    local(&window)?;
    integrations::live::disconnect(&source).await
}
#[tauri::command]
pub async fn integration_live_status(window: WebviewWindow) -> AppResult<Vec<LiveStatus>> {
    local(&window)?;
    Ok(integrations::live::all_status().await)
}
#[tauri::command]
pub async fn integration_act(
    window: WebviewWindow,
    source: String,
    endpoint: String,
    credential: Option<String>,
    request: ActRequest,
) -> AppResult<ActResult> {
    local(&window)?;
    let mut req = request;
    req.source = source.clone();
    let secret = if let Some(value) = credential.filter(|v| !v.is_empty()) {
        value
    } else {
        integrations::live::credential(&source).await
    };
    integrations::actions::act(&endpoint, &secret, req).await
}
#[tauri::command]
pub async fn commandcode_proxy_status(
    window: WebviewWindow,
    endpoint: String,
) -> AppResult<CommandCodeProxyStatus> {
    local(&window)?;
    integrations::commandcode::status(&endpoint).await
}
#[tauri::command]
pub async fn commandcode_proxy_apply(
    window: WebviewWindow,
    base_url: String,
    router_cli: String,
    curate_cli: String,
) -> AppResult<CommandCodeProxyApplyResult> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        integrations::commandcode::apply(&base_url, &router_cli, &curate_cli)
    })
    .await
    .map_err(|_| AppError::Message("CommandCode Proxy apply was interrupted".into()))?
}
#[tauri::command]
pub async fn commandcode_proxy_control(
    window: WebviewWindow,
    action: String,
    endpoint: String,
    bin: String,
) -> AppResult<CommandCodeProcessResult> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        integrations::commandcode::control(&action, &endpoint, &bin)
    })
    .await
    .map_err(|_| AppError::Message("CommandCode Proxy control was interrupted".into()))?
}
#[tauri::command]
pub fn control_board_read(window: WebviewWindow) -> AppResult<Board> {
    local(&window)?;
    DataStore::read_file(|d| Ok(d.control_board.clone()))
}
#[tauri::command]
pub fn control_board_change(
    window: WebviewWindow,
    revision: u64,
    change: Change,
) -> AppResult<Board> {
    local(&window)?;
    DataStore::update_file(|data| {
        if let Change::Create { workspace_id, .. } = &change {
            if !data.profiles.iter().any(|w| &w.id == workspace_id) {
                return Err(AppError::Message(
                    "Select an existing workspace first".into(),
                ));
            }
        }
        integrations::board::apply(&mut data.control_board, revision, change)?;
        Ok(data.control_board.clone())
    })
}
