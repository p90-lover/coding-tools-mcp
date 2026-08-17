use std::sync::Arc;

use serde_json::{json, Value};

use crate::tools::{
    call_tool, list_tools_for_profile, wrap_mcp_tool_result, SharedToolContext, ToolContext,
    Workspace,
};
use crate::workspace::AuthConfig;

pub type SharedState = SharedToolContext;

pub fn handle_request(state: &SharedState, body: &Value) -> Value {
    let method = body.get("method").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    if id.is_null() && method.starts_with("notifications/") {
        return Value::Null;
    }

    let result = match method {
        "initialize" => Ok(initialize_result()),
        "ping" => Ok(serde_json::json!({})),
        "tools/list" => {
            let tools = list_tools_for_profile(&state.tool_profile);
            Ok(serde_json::json!({ "tools": tools }))
        }
        "tools/call" => handle_tools_call(state, &params),
        _ => Err(serde_json::json!({
            "code": -32601,
            "message": format!("Method not found: {method}")
        })),
    };

    match result {
        Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    }
}

fn initialize_result() -> Value {
    serde_json::json!({
        "protocolVersion": "2025-06-18",
        "capabilities": {
            "tools": { "listChanged": false },
            "logging": {}
        },
        "serverInfo": {
            "name": "coding-tools-mcp",
            "title": "Coding Tools MCP",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": "Use these tools only for local coding operations inside the configured workspace. When the client supplies _meta.openai/session, the server automatically creates or resumes the matching bounded history session before the first non-history tool call and reports the stable target under history_session. The same conversation identifier resumes the same Markdown archive after a server restart. history_session_bootstrap remains available for clients without session metadata and whenever verbatim initial_user_input must be captured. Use history_session_search followed by history_session_read only when exact earlier context is needed; follow next_cursor with the returned content hash until the relevant archive page is complete. Preserve session_key and current_path, then pass them unchanged as session_key and expected_path to history_session_checkpoint. After completing each user-requested task, call history_session_checkpoint before the final response and pass that user's verbatim request as raw_user_input. Only state that progress was saved after checkpoint returns ok=true with the same target. The server cannot access ChatGPT transcript text that was not provided as a tool argument, so per-turn checkpoint text remains model-mediated rather than automatic background persistence. Every tool result also includes the bounded project_instructions selected from the addressed workspace or linked-project path."
    })
}

fn handle_tools_call(state: &SharedState, params: &Value) -> Result<Value, Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| json!({ "code": -32602, "message": "Missing tool name" }))?;
    let args = tool_arguments(name, params);

    let canonical_name = crate::tools::registry::canonical_tool_name(name);
    let known = crate::tools::registry::exposed_tool_names(&state.tool_profile);
    if !known.iter().any(|n| n == &canonical_name) {
        return Err(json!({
            "code": -32602,
            "message": format!("Unknown tool: {name}"),
            "data": { "reason": "unknown_tool" }
        }));
    }

    let host_session = host_session_key(params).map(str::to_string);
    let auto_history = if canonical_name.starts_with("history_session_") {
        None
    } else {
        host_session
            .as_deref()
            .map(|session_key| auto_bootstrap_history(state, session_key))
    };

    let mut structured = call_tool(state.as_ref(), canonical_name, &args);
    if canonical_name == "history_session_bootstrap" {
        if let Some(session_key) = host_session.as_deref() {
            if structured.get("ok").and_then(Value::as_bool) == Some(true) {
                let metadata = compact_history_result(&structured, false, false);
                state.cache_auto_history_session(session_key.to_string(), metadata);
            }
        }
    }
    if let Some(metadata) = auto_history {
        if let Some(object) = structured.as_object_mut() {
            object.insert("history_session".into(), metadata);
        }
    }

    Ok(wrap_mcp_tool_result(canonical_name, &args, structured))
}

fn auto_bootstrap_history(state: &SharedState, session_key: &str) -> Value {
    if let Some(mut cached) = state.cached_auto_history_session(session_key) {
        if let Some(object) = cached.as_object_mut() {
            object.insert("cached".into(), Value::Bool(true));
        }
        return cached;
    }

    let bootstrap = call_tool(
        state.as_ref(),
        "history_session_bootstrap",
        &json!({
            "_host_session_key": session_key,
            "title": "ChatGPT automatic session",
            "create_if_missing": true
        }),
    );
    let metadata = compact_history_result(&bootstrap, true, false);
    if bootstrap.get("ok").and_then(Value::as_bool) == Some(true) {
        state.cache_auto_history_session(session_key.to_string(), metadata.clone());
    }
    metadata
}

fn compact_history_result(result: &Value, automatic: bool, cached: bool) -> Value {
    let mut compact = json!({
        "ok": result.get("ok").cloned().unwrap_or(Value::Bool(false)),
        "automatic": automatic,
        "cached": cached,
        "session_key": result.get("session_key").cloned().unwrap_or(Value::Null),
        "session_key_source": result
            .get("session_key_source")
            .cloned()
            .unwrap_or(Value::Null),
        "current_number": result.get("current_number").cloned().unwrap_or(Value::Null),
        "current_path": result.get("current_path").cloned().unwrap_or(Value::Null),
        "created": result.get("created").cloned().unwrap_or(Value::Bool(false)),
        "resumed": result.get("resumed").cloned().unwrap_or(Value::Bool(false)),
        "initial_input_captured": result
            .get("initial_input_captured")
            .cloned()
            .unwrap_or(Value::Bool(false)),
        "warnings": result.get("warnings").cloned().unwrap_or_else(|| json!([]))
    });
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        if let Some(object) = compact.as_object_mut() {
            object.insert(
                "error".into(),
                result.get("error").cloned().unwrap_or(Value::Null),
            );
        }
    }
    compact
}

fn host_session_key(params: &Value) -> Option<&str> {
    params
        .get("_meta")
        .and_then(|meta| meta.get("openai/session"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn tool_arguments(name: &str, params: &Value) -> Value {
    let mut args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if name.starts_with("history_session_") {
        if let Some(session_key) = host_session_key(params) {
            if !args.is_object() {
                args = serde_json::json!({});
            }
            args["_host_session_key"] = Value::String(session_key.to_string());
        }
    }
    args
}

pub fn new_state(
    workspace: Workspace,
    auth: AuthConfig,
    policy: crate::tools::policy::PolicySettings,
    tool_profile: String,
    permission_mode: String,
) -> SharedState {
    Arc::new(ToolContext::from_workspace(
        workspace,
        auth,
        policy,
        tool_profile,
        permission_mode,
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use serde_json::json;

    use crate::tools::ToolContext;

    use super::{handle_request, initialize_result, tool_arguments};

    #[test]
    fn initialize_instructions_define_the_history_persistence_workflow() {
        let initialized = initialize_result();
        let instructions = initialized["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("_meta.openai/session"));
        assert!(instructions.contains("automatically creates or resumes"));
        assert!(instructions.contains("same Markdown archive after a server restart"));
        assert!(instructions.contains("history_session_bootstrap remains available"));
        assert!(instructions.contains("initial_user_input"));
        assert!(instructions.contains("history_session_checkpoint"));
        assert!(instructions.contains("raw_user_input"));
        assert!(instructions.contains("history_session_search"));
        assert!(instructions.contains("history_session_read"));
        assert!(instructions.contains("follow next_cursor"));
        assert!(instructions.contains("session_key and current_path"));
        assert!(instructions.contains("session_key and expected_path"));
        assert!(instructions.contains("before the final response"));
        assert!(instructions.contains("checkpoint returns ok=true"));
        assert!(instructions.contains("model-mediated"));
        assert!(instructions.contains("project_instructions"));
    }

    #[test]
    fn initialize_does_not_claim_tool_catalog_notifications_without_a_stream() {
        let initialized = initialize_result();

        assert_eq!(initialized["capabilities"]["tools"]["listChanged"], false);
    }

    #[test]
    fn workspace_prompt_initializes_or_restores_a_chatgpt_session() {
        let component = include_str!("../../../src/lib/components/ChatGptSessionPrompt.svelte");

        assert!(component.contains("ChatGPT 会话自动恢复"));
        assert!(component.contains("openai/session"));
        assert!(component.contains("自动建立或恢复历史"));
        assert!(component.contains("兼容提示词"));
        assert!(component.contains("请初始化或恢复当前项目会话"));
        assert!(component.contains("initial_user_input"));
        assert!(component.contains("raw_user_input"));
        assert!(component.contains("history_session_search"));
        assert!(component.contains("history_session_checkpoint"));
        assert!(!component.contains("打开连接器设置"));
    }

    #[test]
    fn chatgpt_session_metadata_is_injected_only_for_history_tools() {
        let params = json!({
            "arguments": {"session_key": "explicit"},
            "_meta": {"openai/session": "chatgpt-conversation"}
        });
        let history = tool_arguments("history_session_bootstrap", &params);
        assert_eq!(history["session_key"], "explicit");
        assert_eq!(history["_host_session_key"], "chatgpt-conversation");

        let existing = tool_arguments("read_file", &params);
        assert_eq!(existing["session_key"], "explicit");
        assert!(existing.get("_host_session_key").is_none());
    }

    #[test]
    fn normal_tool_call_auto_bootstraps_and_reuses_the_openai_session() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let harness = tempfile::tempdir().expect("harness tempdir");
        fs::write(workspace.path().join("sample.txt"), "automatic history")
            .expect("sample file");
        let state = Arc::new(
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("tool context"),
        );
        let request = |id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": "read_file",
                    "arguments": {"path": "sample.txt"},
                    "_meta": {"openai/session": "automatic-chatgpt-session"}
                }
            })
        };

        let first = handle_request(&state, &request(1));
        let first = &first["result"]["structuredContent"];
        assert_eq!(first["ok"], true);
        assert_eq!(first["history_session"]["ok"], true);
        assert_eq!(first["history_session"]["automatic"], true);
        assert_eq!(first["history_session"]["cached"], false);
        assert_eq!(first["history_session"]["created"], true);
        assert_eq!(
            first["history_session"]["current_path"],
            "docs/history-session/1.md"
        );
        assert!(workspace.path().join("docs/history-session/1.md").is_file());

        let second = handle_request(&state, &request(2));
        let second = &second["result"]["structuredContent"];
        assert_eq!(second["history_session"]["cached"], true);
        assert_eq!(
            second["history_session"]["current_path"],
            "docs/history-session/1.md"
        );

        let restarted_harness = tempfile::tempdir().expect("restarted harness");
        let restarted = Arc::new(
            ToolContext::for_test(
                workspace.path().to_path_buf(),
                restarted_harness.path().to_path_buf(),
            )
            .expect("restarted tool context"),
        );
        let resumed = handle_request(&restarted, &request(3));
        let resumed = &resumed["result"]["structuredContent"];
        assert_eq!(resumed["history_session"]["ok"], true);
        assert_eq!(resumed["history_session"]["created"], false);
        assert_eq!(resumed["history_session"]["resumed"], true);
        assert_eq!(
            resumed["history_session"]["current_path"],
            "docs/history-session/1.md"
        );

        let numeric_archives = fs::read_dir(workspace.path().join("docs/history-session"))
            .expect("history directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("md")
                    && entry
                        .path()
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .is_some_and(|value| value.parse::<u64>().is_ok())
            })
            .count();
        assert_eq!(numeric_archives, 1);
    }

    #[test]
    fn host_session_key_takes_precedence_over_explicit_session_key() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let harness = tempfile::tempdir().expect("harness tempdir");
        let state = Arc::new(
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("tool context"),
        );
        let response = handle_request(
            &state,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "history_session_bootstrap",
                    "arguments": {
                        "session_key": "explicit-session",
                        "initial_user_input": "保存首轮原文"
                    },
                    "_meta": {"openai/session": "chatgpt-session"}
                }
            }),
        );
        let structured = &response["result"]["structuredContent"];
        assert_eq!(structured["ok"], true);
        assert_eq!(structured["session_key_source"], "platform_conversation_id");
        assert_eq!(structured["session_key"], "chatgpt-session");
        assert_eq!(structured["initial_input_captured"], true);
        let content = fs::read_to_string(workspace.path().join("docs/history-session/1.md"))
            .expect("read history file");
        assert!(content.contains("**Session key:** chatgpt-session"));
        assert!(!content.contains("**Session key:** explicit-session"));
    }

    #[test]
    fn legacy_grep_calls_are_mapped_to_the_public_grep_text_tool() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let harness = tempfile::tempdir().expect("harness tempdir");
        fs::write(workspace.path().join("sample.txt"), "catalog needle")
            .expect("write sample file");
        let state = Arc::new(
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("tool context"),
        );

        let response = handle_request(
            &state,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "grep",
                    "arguments": {"query": "needle", "path": "."}
                }
            }),
        );

        assert!(response.get("error").is_none());
        assert_eq!(response["result"]["structuredContent"]["ok"], true);
    }
}
