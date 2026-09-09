//! Only the focused local main webview may answer an agent's human question.
use crate::{
    app_state::AppState,
    error::{AppError, AppResult},
    runtime::ServiceKind,
};
use serde_json::{json, Value};
use tauri::{State, WebviewWindow};
fn local(window: &WebviewWindow, answer: bool) -> AppResult<()> {
    if window.label() != "main"
        || (answer
            && (!window.is_visible().unwrap_or(false)
                || !window.is_focused().unwrap_or(false)
                || window.is_minimized().unwrap_or(true)))
    {
        return Err(AppError::Message(
            "Use the visible local main window to answer questions".into(),
        ));
    }
    Ok(())
}
#[tauri::command]
pub fn human_pending(window: WebviewWindow, state: State<'_, AppState>) -> AppResult<Value> {
    local(&window, false)?;
    state.with_runtime(|runtime|{
        let mut all=Vec::new();
        for (workspace_id,service,ctx) in runtime.interaction_contexts(){
            let current=ctx.for_request().map_err(|e|AppError::Message(e.message()))?;
            if !matches!(current.auth.auth_type.as_str(),"oauth"|"bearer"){continue;}
            let _guard=current.policy_execution_guard().map_err(|e|AppError::Message(e.message()))?;
            let pending=current.human_inputs.pending(current.policy_revision).map_err(|e|AppError::Message(e.message()))?;
            for request in pending.as_array().unwrap(){
                if all.len()>=32{return Ok(json!(all));}
                all.push(json!({"workspace_id":workspace_id,"service":if service==ServiceKind::Mcp{"mcp"}else{"actions"},"request":request}));
            }
        }
        Ok(json!(all))
    })
}
#[tauri::command]
pub fn human_answer(
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
    service: String,
    request_id: String,
    answer_nonce: String,
    answers: Value,
    cancel: bool,
) -> AppResult<Value> {
    local(&window, true)?;
    if answers.to_string().len() > 16000 || request_id.len() > 128 || answer_nonce.len() > 128 {
        return Err(AppError::Message("Answer is too large".into()));
    }
    let kind = match service.as_str() {
        "mcp" => ServiceKind::Mcp,
        "actions" => ServiceKind::Actions,
        _ => return Err(AppError::Message("Unknown listener".into())),
    };
    state.with_runtime(|runtime| {
        let (_, _, ctx) = runtime
            .interaction_contexts()
            .into_iter()
            .find(|(id, k, _)| id == &workspace_id && *k == kind)
            .ok_or_else(|| {
                AppError::Message("Listener stopped; question is no longer active".into())
            })?;
        let current = ctx
            .for_request()
            .map_err(|e| AppError::Message(e.message()))?;
        let _guard = current
            .policy_execution_guard()
            .map_err(|e| AppError::Message(e.message()))?;
        current
            .human_inputs
            .answer(
                &request_id,
                &answer_nonce,
                answers,
                cancel,
                current.policy_revision,
            )
            .map_err(|e| AppError::Message(e.message()))
    })
}
