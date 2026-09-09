//! Board capabilities bound to the listener identity, never caller-supplied workspace IDs.
use crate::{
    data::{AppData, DataStore},
    error::{AppError, AppResult},
    integrations::board_sync,
    tools::{
        workspace::{tool_ok, WorkspaceError},
        ToolContext,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
pub const NAMES: &[&str] = &["workflow_list", "workflow_update"];
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct List {
    task_id: Option<String>,
    offset: usize,
    limit: usize,
    include_archived: bool,
}
impl Default for List {
    fn default() -> Self {
        Self {
            task_id: None,
            offset: 0,
            limit: 50,
            include_archived: false,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    expected_revision: u64,
    change: board_sync::Update,
}
fn scope(ctx: &ToolContext, data: &AppData) -> AppResult<String> {
    let id = ctx.workspace_id.as_deref().ok_or_else(|| {
        AppError::Message("Workflow access requires a workspace-bound listener".into())
    })?;
    let profile = data
        .profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::Message("Workspace no longer exists".into()))?;
    let root = std::path::Path::new(&profile.path).canonicalize()?;
    if root != ctx.workspace.root() {
        return Err(AppError::Message(
            "Workspace root changed; workflow access refused".into(),
        ));
    }
    Ok(id.into())
}
pub fn input_schema(name: &str) -> Value {
    if name == "workflow_list" {
        return json!({"type":"object","properties":{
        "task_id":{"type":"string","maxLength":128},"offset":{"type":"integer","minimum":0,"maximum":256},
        "limit":{"type":"integer","minimum":1,"maximum":100,"default":50},"include_archived":{"type":"boolean","default":false}},"additionalProperties":false});
    }
    let id = json!({"type":"string","minLength":1,"maxLength":128});
    let state = json!({"type":"string","enum":["backlog","in_progress","blocked","done"]});
    json!({"type":"object","properties":{"expected_revision":{"type":"integer","minimum":0},
        "approval_token":{"type":"string"},"change":{"oneOf":[
        {"type":"object","properties":{"operation":{"const":"create"},"title":{"type":"string","minLength":1,"maxLength":240},"description":{"type":"string","maxLength":8192},"state":state},"required":["operation","title"],"additionalProperties":false},
        {"type":"object","properties":{"operation":{"const":"move"},"id":id,"state":state,"before_id":id},"required":["operation","id","state"],"additionalProperties":false},
        {"type":"object","properties":{"operation":{"const":"edit"},"id":id,"title":{"type":"string","minLength":1,"maxLength":240},"description":{"type":"string","maxLength":8192}},"required":["operation","id","title","description"],"additionalProperties":false},
        {"type":"object","properties":{"operation":{"const":"observe"},"id":id,"note":{"type":"string","minLength":1,"maxLength":4096}},"required":["operation","id","note"],"additionalProperties":false},
        {"type":"object","properties":{"operation":{"enum":["archive","restore"]},"id":id},"required":["operation","id"],"additionalProperties":false}
        ]}},"required":["expected_revision","change"],"additionalProperties":false})
}
pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, WorkspaceError> {
    if !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth" | "api_key") {
        return Err(WorkspaceError::invalid_argument(
            "Workflow tools require authenticated MCP/Actions",
        ));
    }
    if !args.is_object() || args.to_string().len() > 16000 {
        return Err(WorkspaceError::invalid_argument(
            "Workflow request must be a bounded object",
        ));
    }
    let result = match name {
        "workflow_list" => {
            let r: List = serde_json::from_value(args.clone())
                .map_err(|_| WorkspaceError::invalid_argument("Invalid workflow query fields"))?;
            if r.offset > 256
                || r.task_id
                    .as_ref()
                    .is_some_and(|v| v.is_empty() || v.len() > 128)
            {
                return Err(WorkspaceError::invalid_argument(
                    "Invalid task ID or offset",
                ));
            }
            DataStore::read_file(|data| {
                let id = scope(ctx, data)?;
                board_sync::view(
                    &data.control_board,
                    &id,
                    r.task_id.as_deref(),
                    r.offset,
                    r.limit,
                    r.include_archived,
                )
            })
        }
        "workflow_update" => {
            let mut clean = args.clone();
            if let Some(o) = clean.as_object_mut() {
                o.remove("approval_token");
                o.remove("confirm");
            }
            let r: Write = serde_json::from_value(clean).map_err(|_| {
                WorkspaceError::invalid_argument(
                    "Invalid workflow mutation; human review cannot be completed by this tool",
                )
            })?;
            // Shared call dispatcher holds the policy fence through this atomic persistence.
            DataStore::update_file(|data| {
                let id = scope(ctx, data)?;
                let task = board_sync::apply_scoped(
                    &mut data.control_board,
                    &id,
                    r.expected_revision,
                    r.change,
                )?;
                board_sync::view(&data.control_board, &id, Some(&task), 0, 50, true)
            })
        }
        _ => return Err(WorkspaceError::invalid_argument("Unknown workflow tool")),
    };
    result.map(tool_ok).map_err(|e| WorkspaceError::Tool {
        code: "WORKFLOW_REJECTED",
        message: e.to_string(),
        category: "workflow",
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{dispatch::call_tool_mcp, live_policy::commit_updates};
    use std::sync::Arc;
    #[test]
    fn workflow_043_real_store_dispatch_and_live_permission_revocation() {
        let base = std::env::current_dir()
            .unwrap()
            .join("aiTemp/workflow-043")
            .join(uuid::Uuid::new_v4().to_string());
        let root = base.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        let file = base.join("app/data/profiles.json");
        crate::data::with_test_file(file.clone(), || {
            let profile = crate::workspace::WorkspaceProfile::new(
                root.to_string_lossy().into_owned(),
                Some("fixture".into()),
            );
            DataStore::update_file(|data| {
                data.profiles.push(profile.clone());
                Ok(())
            })
            .unwrap();
            let mut context = ToolContext::for_test(root, base.join("harness")).unwrap();
            context.auth.auth_type = "bearer".into();
            context.workspace_id = Some(profile.id.clone());
            let ctx = Arc::new(context);
            let input = json!({"expected_revision":0,"change":{"operation":"create","title":"MCP task","state":"blocked"}});
            let result = call_tool_mcp(&ctx, "workflow_update", &input);
            assert_eq!(result["ok"], true, "{result}");
            let id = result["task"]["id"].as_str().unwrap();
            let persisted: AppData =
                serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            assert_eq!(persisted.control_board.tasks[0].id, id);
            assert_eq!(
                call_tool_mcp(&ctx, "workflow_update", &input)["ok"],
                false,
                "A stale retry must not duplicate the task"
            );
            let observed = call_tool_mcp(
                &ctx,
                "workflow_update",
                &json!({"expected_revision":1,"change":{"operation":"observe","id":id,"note":"Needs human verification"}}),
            );
            assert_eq!(observed["ok"], true, "{observed}");
            assert_eq!(observed["task"]["step"], 0);
            assert_eq!(observed["task"]["evidence"][0]["source"], "mcp_observation");
            let before = std::fs::read(&file).unwrap();
            let mut policy = ctx.for_request().unwrap().policy;
            policy.permission_mode = "read-only".into();
            commit_updates(vec![(ctx.clone(), policy, "core".into())], || Ok(())).unwrap();
            let blocked = call_tool_mcp(
                &ctx,
                "workflow_update",
                &json!({"expected_revision":2,"change":{"operation":"archive","id":id}}),
            );
            assert_eq!(blocked["ok"], false, "{blocked}");
            assert_eq!(std::fs::read(&file).unwrap(), before);
            let read = call_tool_mcp(&ctx, "workflow_list", &json!({"task_id":id}));
            assert_eq!(read["ok"], true, "{read}");
            let status = call_tool_mcp(&ctx, "server_info", &json!({}));
            assert_eq!(
                status["live_permissions"]["permission_restart_required"],
                false
            );
        });
    }
}
