//! Tauri-only administrative channel. None of these functions is an MCP tool.
use super::protocol::StatusArgs;
use serde_json::{json, Value};
use tauri::WebviewWindow;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
pub async fn native_codex_connect(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    binary: String,
    network: bool,
) -> Result<Value, String> {
    super::local_window(&window)?;
    let config = super::local_config(&app, &id)?;
    let approved_fingerprint = super::fingerprint(&config)?;
    let full = matches!(
        config.runtime.permission_mode.as_str(),
        "danger-full-access" | "dangerous"
    );
    let text = if full {
        "Enable native Codex FULL ACCESS for this workspace? This removes Codex filesystem and network sandbox restrictions. Authenticated tool clients may submit tasks using your Codex account and quota. Commands can act with your desktop account's privileges. File-preservation instructions are not an OS deletion prohibition."
    } else {
        "Enable official native Codex for this workspace? Authenticated tool clients may submit tasks using your configured Codex account/provider and quota. Native approvals will be shown only in this desktop window. Trust the selected executable and project. Native read access may extend beyond writable roots. Temp/file-preservation instructions do not replace backups."
    };
    let linked = crate::workspace::linked_projects::list_linked_projects_for_root(
        std::path::Path::new(&config.path),
    );
    let root_lines = linked
        .iter()
        .filter(|r| !r.read_only())
        .map(|r| r.path.clone())
        .collect::<Vec<_>>()
        .join("\n");
    if root_lines.len() > 32 * 1024 {
        return Err("Too many writable roots to review safely".into());
    }
    let reviewed = super::protocol::NativePolicy::new(
        &config.runtime.permission_mode,
        &config.runtime.approval_mode,
        network,
        std::path::PathBuf::from(&config.path),
        Vec::new(),
    );
    let text = format!("{text}\n\nExecutable: {binary}\nWorkspace: {}\nSandbox: {}\nApproval policy: {}\nCommand network access: {}\nAdditional writable roots (workspace-write only):\n{root_lines}\nThis native policy is shared by MCP and Actions; legacy Actions command settings do not override it.", config.path, reviewed.sandbox, reviewed.approval, reviewed.network);
    let dialog_app = app.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(text)
            .title("Enable native Codex / 啟用原生 Codex")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })
    .await
    .map_err(|_| "Native consent dialog failed")?;
    if !confirmed {
        return Err("Local user declined native connection".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        super::connect(app, id, binary, network, approved_fingerprint)
    })
    .await
    .map_err(|_| "Native connection worker failed")?
}

#[tauri::command]
pub async fn native_codex_disconnect(window: WebviewWindow, id: String) -> Result<(), String> {
    super::local_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || super::invalidate(&id))
        .await
        .map_err(|_| "Native shutdown worker failed")?;
    Ok(())
}

#[tauri::command]
pub fn native_codex_snapshot(
    window: WebviewWindow,
    id: String,
    cursor: Option<u64>,
) -> Result<Value, String> {
    super::local_window(&window)?;
    match super::get_session(&id) {
        Ok(session) => session.snapshot(
            StatusArgs {
                cursor: cursor.unwrap_or(0),
                max_events: Some(16),
            },
            true,
        ),
        Err(_) => Ok(
            json!({"connected":false,"events":[],"approvals":[],"next_cursor":cursor.unwrap_or(0),"has_more":false}),
        ),
    }
}

#[tauri::command]
pub async fn native_codex_approve(
    window: WebviewWindow,
    id: String,
    generation: String,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    super::local_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = super::get_session(&id)?;
        if super::fingerprint(&super::profile(&id)?)? != session.fingerprint {
            return Err("Workspace changed; approval refused".into());
        }
        session.approve(&generation, &request_id, &decision)
    })
    .await
    .map_err(|_| "Native approval worker failed")?
}

#[tauri::command]
pub async fn native_codex_submit(
    window: WebviewWindow,
    id: String,
    prompt: String,
    request_id: String,
    continuation: bool,
) -> Result<Value, String> {
    super::local_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = super::get_session(&id)?;
        if super::fingerprint(&super::profile(&id)?)? != session.fingerprint {
            return Err("Workspace changed; reconnect locally".into());
        }
        session.turn(
            super::protocol::PromptArgs::parse(&json!({"prompt":prompt,"request_id":request_id}))?,
            continuation,
        )
    })
    .await
    .map_err(|_| "Native turn worker failed")?
}

#[tauri::command]
pub async fn native_codex_interrupt(window: WebviewWindow, id: String) -> Result<Value, String> {
    super::local_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || super::get_session(&id)?.interrupt())
        .await
        .map_err(|_| "Native interrupt worker failed")?
}
