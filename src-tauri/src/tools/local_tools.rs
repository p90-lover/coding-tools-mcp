//! Model-free local counterparts, not a bundled Codex agent or OS sandbox.
use crate::tools::workspace::{tool_ok, WorkspaceError};
use crate::tools::{registry, ToolContext};
use serde_json::{json, Value};

pub const NAMES: &[&str] = &[
    "codex_tools_status",
    "tool_search",
    "get_current_time",
    "get_plan",
    "update_plan",
];

pub fn input_schema(name: &str) -> Value {
    match name {
        "tool_search" => json!({"type":"object","properties":{
            "query":{"type":"string","minLength":1,"maxLength":256},
            "limit":{"type":"integer","minimum":1,"maximum":20,"default":8}},"required":["query"],"additionalProperties":false}),
        "update_plan" => json!({"type":"object","properties":{
            "explanation":{"type":"string","maxLength":4096},
            "expected_revision":{"type":"integer","minimum":0},
            "plan":{"type":"array","maxItems":32,"items":{"type":"object","properties":{
                "step":{"type":"string","minLength":1,"maxLength":1024},
                "status":{"type":"string","enum":["pending","in_progress","completed"]}},
                "required":["step","status"],"additionalProperties":false}}},"required":["plan"],"additionalProperties":false}),
        _ => json!({"type":"object","properties":{},"additionalProperties":false}),
    }
}

pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, WorkspaceError> {
    let fields = args
        .as_object()
        .ok_or_else(|| WorkspaceError::invalid_argument("Tool arguments must be an object"))?;
    let allowed: &[&str] = match name {
        "tool_search" => &["query", "limit"],
        "update_plan" => &["plan", "explanation", "expected_revision"],
        _ => &[],
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) || args.to_string().len() > 40_000
    {
        return Err(WorkspaceError::invalid_argument(
            "Unknown arguments or excessive request size",
        ));
    }
    match name {
        "codex_tools_status" => {
            let installed = registry::exposed_tool_names(&ctx.tool_profile);
            let candidates = [
                "exec_command",
                "write_stdin",
                "read_output",
                "kill_command",
                "read_file",
                "list_dir",
                "list_files",
                "grep_text",
                "apply_patch",
                "request_permissions",
                "view_image",
                "update_plan",
                "get_plan",
                "tool_search",
                "get_current_time",
                "computer_snapshot",
                "computer_action",
                "computer_sequence",
            ];
            Ok(tool_ok(
                json!({"implementation":"local_mcp_counterparts","codex_invoked":false,
                "inference_client_in_this_path":false,"policy_revision":ctx.policy_revision,
                "tools":candidates.into_iter().filter(|n|installed.contains(n)).collect::<Vec<_>>(),
                "native_runtime":ctx.codex_bridge.status().unwrap_or_else(|_|json!({"connected":false,"state":"unavailable"})),
                "optional_native_tools":["codex_runtime_status","codex_agent_read","codex_agent_control"],
                "not_included":["Complete internal Codex tool parity","Codex account/plugin installation APIs","Codex cloud web-search service","Paseo/Anneal autonomous engines","unverified native command sandbox"],
                "command_execution_boundary":"policy_only","screenshots":"memory_only",
                "note":"This status/local-tool path does not invoke inference. The separate explicitly enabled native App Server bridge can use provider quota for agent turns, review and compaction; it is not an OS sandbox guarantee."}),
            ))
        }
        "tool_search" => {
            let query = fields
                .get("query")
                .and_then(Value::as_str)
                .filter(|q| !q.trim().is_empty() && q.len() <= 256)
                .ok_or_else(|| WorkspaceError::invalid_argument("query must contain 1–256 bytes"))?
                .to_lowercase();
            let limit = match fields.get("limit") {
                None => 8,
                Some(v) => v
                    .as_u64()
                    .filter(|n| (1..=20).contains(n))
                    .ok_or_else(|| WorkspaceError::invalid_argument("limit must be 1–20"))?
                    as usize,
            };
            let mut hits: Vec<_> = registry::list_tools_for_profile(&ctx.tool_profile)
                .into_iter()
                .filter_map(|tool| {
                    let name = tool["name"].as_str().unwrap_or("").to_lowercase();
                    let text = format!(
                        "{} {}",
                        name,
                        tool["description"].as_str().unwrap_or("").to_lowercase()
                    );
                    let score = if name == query {
                        3
                    } else if name.contains(&query) {
                        2
                    } else if query.split_whitespace().all(|part| text.contains(part)) {
                        1
                    } else {
                        0
                    };
                    (score > 0).then_some((score, tool))
                })
                .collect();
            hits.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| a.1["name"].as_str().cmp(&b.1["name"].as_str()))
            });
            let truncated = hits.len() > limit;
            Ok(tool_ok(
                json!({"tools":hits.into_iter().take(limit).map(|(_,t)|t).collect::<Vec<_>>(),"truncated":truncated,"network_used":false,"policy_revision":ctx.policy_revision}),
            ))
        }
        "get_current_time" => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| {
                    WorkspaceError::invalid_argument("System clock predates the Unix epoch")
                })?;
            Ok(tool_ok(
                json!({"unix_seconds":now.as_secs(),"unix_milliseconds":now.as_millis() as u64,"time_basis":"UTC Unix epoch","source":"local_system_clock"}),
            ))
        }
        "get_plan" => Ok(tool_ok(
            ctx.local_plan
                .lock()
                .map_err(|_| WorkspaceError::invalid_argument("Plan store unavailable"))?
                .clone(),
        )),
        "update_plan" => {
            let steps = fields
                .get("plan")
                .and_then(Value::as_array)
                .filter(|p| p.len() <= 32)
                .ok_or_else(|| {
                    WorkspaceError::invalid_argument("plan must be an array of up to 32 steps")
                })?;
            let mut active = 0;
            for step in steps {
                let Some(obj) = step.as_object() else {
                    return Err(WorkspaceError::invalid_argument(
                        "Each step must be an object",
                    ));
                };
                if obj.len() != 2
                    || obj
                        .get("step")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.trim().is_empty() || s.len() > 1024)
                    || !matches!(
                        obj.get("status").and_then(Value::as_str),
                        Some("pending" | "in_progress" | "completed")
                    )
                {
                    return Err(WorkspaceError::invalid_argument(
                        "Each plan step needs bounded text and a valid status",
                    ));
                }
                if step["status"] == "in_progress" {
                    active += 1;
                }
            }
            if active > 1 {
                return Err(WorkspaceError::invalid_argument(
                    "At most one step may be in_progress",
                ));
            }
            let explanation = match fields.get("explanation") {
                None => "",
                Some(v) => v.as_str().filter(|s| s.len() <= 4096).ok_or_else(|| {
                    WorkspaceError::invalid_argument("explanation must be bounded text")
                })?,
            };
            let expected = fields
                .get("expected_revision")
                .map(|v| {
                    v.as_u64().ok_or_else(|| {
                        WorkspaceError::invalid_argument(
                            "expected_revision must be a nonnegative integer",
                        )
                    })
                })
                .transpose()?;
            let mut saved = ctx
                .local_plan
                .lock()
                .map_err(|_| WorkspaceError::invalid_argument("Plan store unavailable"))?;
            let revision = saved["revision"].as_u64().unwrap_or(0);
            if expected.is_some_and(|e| e != revision) {
                return Err(WorkspaceError::Tool {
                    code: "PLAN_REVISION_CONFLICT",
                    message: "Plan changed; call get_plan before updating".into(),
                    category: "conflict",
                    retryable: false,
                });
            }
            let revision = revision
                .checked_add(1)
                .ok_or_else(|| WorkspaceError::invalid_argument("Plan revision exhausted"))?;
            *saved = json!({"plan":steps,"explanation":explanation,"revision":revision,"storage":"memory_only","executed":false});
            Ok(tool_ok(saved.clone()))
        }
        _ => Err(WorkspaceError::invalid_argument("Unknown local tool")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_codex_tools_use_real_handlers_without_model_clients() {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/local-tools-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let ctx = ToolContext::for_test(root.clone(), root.join("harness")).unwrap();
        let update = crate::tools::call_tool(
            &ctx,
            "update_plan",
            &json!({"expected_revision":0,"plan":[{"step":"Verify live policy","status":"in_progress"}]}),
        );
        assert_eq!(update["ok"], true, "{update}");
        assert_eq!(update["revision"], 1);
        let stale = crate::tools::call_tool(
            &ctx,
            "update_plan",
            &json!({"expected_revision":0,"plan":[]}),
        );
        assert_eq!(stale["ok"], false);
        assert_eq!(
            crate::tools::call_tool(&ctx, "get_plan", &json!({}))["plan"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let search = crate::tools::call_tool(
            &ctx,
            "tool_search",
            &json!({"query":"apply_patch","limit":1}),
        );
        assert_eq!(search["tools"][0]["name"], "apply_patch");
        assert!(search["tools"][0]["inputSchema"].is_object());
        assert!(
            crate::tools::call_tool(&ctx, "get_current_time", &json!({}))["unix_seconds"]
                .as_u64()
                .unwrap()
                > 0
        );
        let status = crate::tools::call_tool(&ctx, "codex_tools_status", &json!({}));
        assert_eq!(status["codex_invoked"], false);
        assert!(status["not_included"].is_array());
        for name in NAMES {
            assert!(registry::list_tools_for_profile("core")
                .iter()
                .any(|t| t["name"] == *name));
        }
    }
}
