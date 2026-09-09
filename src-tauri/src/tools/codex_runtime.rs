//! Native-provider tools are separate from model-free local counterparts.
use crate::{codex_bridge::Control, tools::{ToolContext, workspace::{WorkspaceError, tool_ok}}};
use serde_json::{json, Value};
pub const NAMES: &[&str] = &["codex_runtime_status", "codex_agent_read", "codex_agent_control"];
pub fn input_schema(name: &str) -> Value {
    match name {
        "codex_agent_read" => json!({"type":"object","properties":{"thread_id":{"type":"string","minLength":1,"maxLength":128}},"required":["thread_id"],"additionalProperties":false}),
        "codex_agent_control" => json!({"type":"object","properties":{
            "operation":{"type":"string","enum":["start","send","review","compact","interrupt","close"]},
            "request_id":{"type":"string","minLength":1,"maxLength":128},
            "thread_id":{"type":"string","minLength":1,"maxLength":128},
            "text":{"type":"string","minLength":1,"maxLength":16000}},"required":["operation","request_id"],"additionalProperties":false}),
        _ => json!({"type":"object","properties":{},"additionalProperties":false}),
    }
}
fn error(message: String) -> WorkspaceError {
    WorkspaceError::Tool {code:"NATIVE_CODEX_BRIDGE",message,category:"native_runtime",retryable:false}
}
pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, WorkspaceError> {
    if !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth") {
        return Err(error("Native bridge requires an authenticated listener".into()));
    }
    let object=args.as_object().ok_or_else(||WorkspaceError::invalid_argument("Arguments must be an object"))?;
    if args.to_string().len()>18000 {return Err(WorkspaceError::invalid_argument("Native request exceeds the size limit"));}
    match name {
        "codex_runtime_status" if object.is_empty() => ctx.codex_bridge.status().map(tool_ok).map_err(error),
        "codex_agent_read" if object.len()==1 => {
            let id=object.get("thread_id").and_then(Value::as_str).filter(|v|!v.is_empty()&&v.len()<=128)
                .ok_or_else(||WorkspaceError::invalid_argument("thread_id is required"))?;
            ctx.codex_bridge.read(id).map(tool_ok).map_err(error)
        }
        "codex_agent_control" => {
            let request:Control=serde_json::from_value(args.clone()).map_err(|_|WorkspaceError::invalid_argument("Invalid native control fields"))?;
            let ticket={
                let _fence=ctx.policy_execution_guard()?;
                ctx.codex_bridge.admit(request).map_err(error)?
            };
            // Long native RPC waits do not hold the policy save lock. Revocation invalidates
            // the owned bridge and stops its process; submitted effects cannot be rolled back.
            ticket.run().map(|v|if v["ok"]==false {v}else{tool_ok(v)}).map_err(error)
        }
        _=>Err(WorkspaceError::invalid_argument("Unknown native tool or fields")),
    }
}
