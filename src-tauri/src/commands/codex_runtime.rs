//! Native connection/consent is available only in the visible local main window.
use crate::{app_state::AppState, codex_bridge::Connection, error::{AppError,AppResult}, tools::SharedToolContext};
use serde_json::Value;
use tauri::{State,WebviewWindow};
fn local(window:&WebviewWindow,focused:bool)->AppResult<()> {
    if window.label()!="main" || !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true) || (focused&&!window.is_focused().unwrap_or(false)) {
        return Err(AppError::Message("Use the visible local main window for native Codex controls".into()));
    }
    Ok(())
}
fn context(state:&AppState,id:&str)->AppResult<SharedToolContext> {
    state.with_runtime(|runtime|runtime.native_bridge_context(id))
}
#[tauri::command]
pub async fn codex_local_connect(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String,connection:Connection)->AppResult<Value> {
    local(&window,true)?;
    let ctx=context(&state,&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move|| {
        let snapshot=ctx.for_request().map_err(|e|AppError::Message(e.message()))?;
        if !matches!(snapshot.auth.auth_type.as_str(),"bearer"|"oauth") {
            return Err(AppError::Message("Enable bearer/OAuth authentication before native provider access".into()));
        }
        {
            let _fence=snapshot.policy_execution_guard().map_err(|e|AppError::Message(e.message()))?;
            snapshot.codex_bridge.connect(snapshot.workspace.root(),connection).map_err(AppError::Message)?;
        }
        snapshot.codex_bridge.initialize().map_err(AppError::Message)
    }).await.map_err(|_|AppError::Message("Native connection worker failed".into()))?
}
#[tauri::command]
pub fn codex_local_status(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String)->AppResult<Value> {
    local(&window,false)?;context(&state,&workspace_id)?.codex_bridge.status().map_err(AppError::Message)
}
#[tauri::command]
pub fn codex_local_disconnect(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String)->AppResult<()> {
    // Stop remains available without foreground focus; it does not expand any authority.
    if window.label()!="main" {return Err(AppError::Message("Use the local main window".into()));}
    context(&state,&workspace_id)?.codex_bridge.disconnect();Ok(())
}
#[tauri::command]
pub async fn codex_local_control(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String,args:Value)->AppResult<Value> {
    local(&window,true)?;let ctx=context(&state,&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move||crate::tools::call_tool_mcp(&ctx,"codex_agent_control",&args))
        .await.map_err(|_|AppError::Message("Native control worker failed; inspect state before retrying".into()))
}
#[tauri::command]
pub fn codex_local_read(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String,thread_id:String)->AppResult<Value> {
    local(&window,false)?;context(&state,&workspace_id)?.codex_bridge.read(&thread_id).map_err(AppError::Message)
}
