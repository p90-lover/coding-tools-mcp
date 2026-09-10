//! Local-only inspection. Does not start a listener, tunnel, agent, or OAuth flow.
use crate::{app_state::AppState, error::{AppError,AppResult}, runtime::ServiceKind, tools::catalog};
use serde_json::{json,Value};
use tauri::State;

#[tauri::command]
pub fn get_tool_catalog_status(id: String, state: State<'_,AppState>) -> AppResult<Value> {
    let configured=state.with_workspaces(|store| store.get(&id).cloned()
        .ok_or_else(||AppError::Message("Workspace not found".into())))?;
    let context=state.with_runtime(|runtime| {
        if runtime.is_running(&id,ServiceKind::Mcp) {
            runtime.native_bridge_context(&id).map(Some)
        } else { Ok(None) }
    })?;
    let (mut report,evidence)=if let Some(ctx)=context {
        let current=ctx.for_request().map_err(|e|AppError::Message(e.message()))?;
        (catalog::describe_current(&current),"running_listener")
    } else {
        (catalog::describe(&configured.runtime.tool_profile),"saved_configuration_only")
    };
    report["evidence_source"]=json!(evidence);
    report["configured_profile"]=json!(configured.runtime.tool_profile);
    report["server_version"]=json!(env!("CARGO_PKG_VERSION"));
    Ok(report)
}
