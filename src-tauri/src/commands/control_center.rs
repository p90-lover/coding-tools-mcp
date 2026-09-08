//! Main-window-only control center. External project integrations expose reads only.
use crate::{
    data::DataStore,
    error::{AppError, AppResult},
    integrations::{
        self,
        board::{Board, Change},
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
