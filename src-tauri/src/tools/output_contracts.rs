//! MCP outputSchema describes structuredContent, never the outer content/image envelope.
//! Additive metadata stays open for per-workspace history, policy and future fields.
use serde_json::{json, Map, Value};
fn string() -> Value { json!({"type":"string"}) }
fn boolean() -> Value { json!({"type":"boolean"}) }
fn integer() -> Value { json!({"type":"integer","minimum":0}) }
fn array(items: Value) -> Value { json!({"type":"array","items":items}) }
fn object() -> Value { json!({"type":"object","additionalProperties":true}) }
fn nullable_string() -> Value { json!({"type":["string","null"]}) }
fn event() -> Value {
    json!({"type":"object","properties":{
        "id":{"type":"string"},"task_id":{"type":"string"},"operation_id":{"type":"string"},
        "kind":{"type":"string"},"tool_name":{"type":["string","null"]},
        "input_summary":{},"result_summary":{},"reason":{"type":["object","null"]},
        "affected_files":{"type":"array","items":{"type":"object"}},"created_at":{"type":"string"}},
        "required":["id","task_id","operation_id","kind","tool_name","input_summary","result_summary","created_at"],
        "additionalProperties":true})
}
pub fn for_tool(name: &str) -> Value {
    let mut properties = Map::new();
    properties.insert("ok".into(), json!({"type":"boolean","description":"True means this tool operation succeeded. False includes validation/policy denial and failed commands; inspect details before any retry. It is not an attestation that an entire task or external agent finished."}));
    properties.insert("error".into(), json!({"description":"When present, error details including code/message/category/retryable; native operations may use their own bounded error representation."}));
    let mut success_required: Vec<&str> = Vec::new();
    let fields: Vec<(&str, Value)> = match name {
        "list_task_events" => {
            success_required.extend(["events","next_cursor"]);
            vec![("events",array(event())),("next_cursor",integer())]
        }
        "operation_log" => {
            success_required.extend(["operations","next_cursor"]);
            vec![("operations",array(object())),("next_cursor",integer())]
        }
        "read_file" => {
            success_required.extend(["path","content","encoding","truncated"]);
            vec![("path",string()),("content",string()),("encoding",json!({"const":"utf-8"})),
                 ("start_line",integer()),("end_line",integer()),("total_lines",integer()),
                 ("total_bytes",integer()),("bytes_read",integer()),("truncated",boolean()),("warnings",array(string()))]
        }
        "list_dir" => vec![("path",string()),("entries",array(object())),("truncated",boolean())],
        "list_files" => vec![("path",string()),("files",array(object())),("truncated",boolean())],
        "search_text" | "grep_text" | "grep" => vec![("matches",array(object())),("truncated",boolean()),("warnings",array(string()))],
        "start_task" | "update_task" | "pause_task" | "resume_task" | "finish_task" | "task_context" => {
            vec![("task",json!({"type":["object","null"]})),("events",array(event()))]
        }
        "get_plan" | "update_plan" => vec![("plan",array(json!({"type":"object","properties":{
            "step":{"type":"string"},"status":{"enum":["pending","in_progress","completed"]}},
            "required":["step","status"],"additionalProperties":false}))),
            ("revision",integer()),("explanation",string())],
        "get_current_time" => {
            success_required.extend(["unix_seconds","unix_milliseconds","source"]);
            vec![("unix_seconds",integer()),("unix_milliseconds",integer()),("source",string()),("time_basis",string())]
        }
        "tool_search" => vec![("tools",array(json!({"type":"object","properties":{
            "name":{"type":"string"},"inputSchema":{"type":"object"},"outputSchema":{"type":"object"}},
            "required":["name","inputSchema","outputSchema"],"additionalProperties":true}))),
            ("truncated",boolean()),("network_used",boolean()),("policy_revision",integer())],
        "codex_tools_status" => vec![("tools",array(string())),("not_included",array(string())),
            ("codex_invoked",boolean()),("inference_client_in_this_path",boolean()),("native_runtime",object())],
        "server_info" => {
            success_required.extend(["server","version","tools","tool_count"]);
            vec![("server",string()),("version",string()),("workspace",string()),("tools",array(string())),
                ("tool_count",integer()),("tool_catalog",object()),("live_permissions",object())]
        }
        "sandbox_status" => vec![("available",boolean()),("enabled_for_workspace",boolean()),
            ("backend",string()),("helper_sha256",nullable_string()),("direct_workspace_write",boolean()),
            ("native_sandbox_verified",boolean()),("retention",object())],
        "sandbox_exec" | "exec_command" | "codex_command_exec" | "read_output" | "write_stdin" => {
            vec![("stdout",string()),("stderr",string()),("exit_code",json!({"type":["integer","null"]})),
                ("command_id",nullable_string()),("session_id",nullable_string()),("snapshot_id",string()),
                ("retained_directory",string()),("timed_out",boolean()),("limit_exceeded",boolean())]
        }
        "workflow_list" | "workflow_update" => vec![("workspace_id",string()),("revision",integer()),
            ("tasks",array(object())),("task",object()),("next_offset",json!({"type":["integer","null"],"minimum":0})),
            ("model_calls",boolean())],
        // Image bytes remain in content[] and are not repeated in structuredContent.
        "view_image" | "image_info" | "capture_screenshot" | "capture_window" | "computer_snapshot" => {
            vec![("mime_type",string()),("width",integer()),("height",integer())]
        }
        _ => Vec::new(),
    };
    for (key, value) in fields { properties.insert(key.into(), value); }
    let mut schema = json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "type":"object",
        "description":format!("Structured result for {name}. Shared ok/error envelope plus tool-specific fields and additive workspace/policy metadata. For images, bytes are separate MCP content blocks. Visibility and a successful read do not grant execution or model-use permission."),
        "properties":properties,"required":["ok"],"additionalProperties":true
    });
    if !success_required.is_empty() {
        schema["allOf"] = json!([{"if":{"properties":{"ok":{"const":true}},"required":["ok"]},
            "then":{"required":success_required}}]);
    }
    schema
}
