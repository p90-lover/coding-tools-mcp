//! Visible local operator controls; endpoints and credentials never originate
//! from an MCP prompt. The same workflow dispatcher handles GUI mission actions.
use crate::{app_state::AppState,error::{AppError,AppResult},integrations::execution::service,tools::{ToolContext,dispatch::call_tool_mcp}};
use serde_json::{json,Value};
use std::sync::Arc;
use tauri::{State,WebviewWindow};
fn fail(s:impl Into<String>)->AppError{AppError::Message(s.into())}
fn local(window:&WebviewWindow,write:bool)->AppResult<()> {
 if window.label()!="main"||!window.is_visible().unwrap_or(false)||window.is_minimized().unwrap_or(true)||(write&&!window.is_focused().unwrap_or(false)){
  return Err(fail("Use the visible, focused main-window controller for provider consent"));
 }Ok(())
}
fn context(state:&AppState,id:&str)->AppResult<Arc<ToolContext>>{
 state.with_runtime(|r|r.native_bridge_context(id))
}
#[tauri::command]
pub async fn execution_local_read(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String,mission_id:Option<String>,refresh_source:Option<bool>)->AppResult<Value>{
 local(&window,false)?;let ctx=context(&state,&workspace_id)?;
 tauri::async_runtime::spawn_blocking(move||call_tool_mcp(&ctx,"workflow_list",&json!({"mission_id":mission_id,"refresh_source":refresh_source.unwrap_or(false)})))
  .await.map_err(|_|fail("Mission observation worker unavailable"))
}
#[tauri::command]
pub async fn execution_local_provider(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String,operation:String,expected_revision:Option<u64>,binding_id:Option<String>,settings:Option<service::Settings>,credential:Option<String>,confirm:bool)->AppResult<Value>{
 local(&window,true)?;
 if !confirm{return Err(fail("Local provider consent was not confirmed"))}
 let ctx=context(&state,&workspace_id)?;
 tauri::async_runtime::spawn_blocking(move||{
  let request=ctx.for_request().map_err(|e|fail(e.message()))?;
  match operation.as_str(){
   "configure"=>service::configure(&request,expected_revision.ok_or_else(||fail("Missing execution-book revision"))?,settings.ok_or_else(||fail("Provider settings required"))?,credential.unwrap_or_default()),
   "connect"=>service::reconnect(&request,binding_id.as_deref().ok_or_else(||fail("Select an existing provider binding"))?,credential.unwrap_or_default(),true),
   "disable"=>service::disable(&request,binding_id.as_deref().ok_or_else(||fail("Select an existing provider binding"))?),
   _=>Err(fail("Unsupported local provider operation")),
  }
 }).await.map_err(|_|fail("Provider settings worker unavailable"))?
}
#[tauri::command]
pub async fn execution_local_update(window:WebviewWindow,state:State<'_,AppState>,workspace_id:String,expected_revision:u64,change:Value,confirm:bool)->AppResult<Value>{
 local(&window,true)?;
 if !confirm{return Err(fail("Confirm this particular mission operation locally"))}
 // Only the declared mission operations are accepted; this local command is
 // not a generic way to approve unrelated MCP tools or arbitrary board changes.
 let _:service::Change=serde_json::from_value(change.clone()).map_err(|_|fail("Invalid mission operation"))?;
 let ctx=context(&state,&workspace_id)?;
 tauri::async_runtime::spawn_blocking(move||{
  let mut args=json!({"expected_revision":expected_revision,"change":change});
  let first=call_tool_mcp(&ctx,"workflow_update",&args);
  if first.pointer("/error/code").and_then(Value::as_str)!=Some("APPROVAL_REQUIRED"){return first;}
  let Some(id)=first.pointer("/error/details/request_id").and_then(Value::as_str) else{return first};
  // The visible button's explicit confirmation grants this exact fingerprint
 // once. Hard policy/root/provider-consent checks still run on the second call.
  let granted=call_tool_mcp(&ctx,"request_permissions",&json!({"request_id":id,"scope":"once","confirm":true}));
  if granted["ok"]!=true{return granted;}
  let Some(token)=granted["approval_token"].as_str() else{return granted};
  args["approval_token"]=json!(token);
  call_tool_mcp(&ctx,"workflow_update",&args)
 }).await.map_err(|_|fail("Mission control worker unavailable"))
}
