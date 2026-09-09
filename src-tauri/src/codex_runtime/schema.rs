//! Fixed, text-only operations. Never pass arbitrary native RPC methods or options.
use serde_json::{json, Value};
pub const NAMES: &[&str] = &[
    "codex_runtime_status",
    "codex_runtime_models",
    "codex_agent_start",
    "codex_agent_list",
    "codex_agent_read",
    "codex_agent_wait",
    "codex_agent_send",
    "codex_agent_steer",
    "codex_agent_review",
    "codex_agent_compact",
    "codex_agent_interrupt",
    "codex_agent_close",
];
pub fn mutating(name: &str) -> bool {
    matches!(
        name,
        "codex_agent_start"
            | "codex_agent_send"
            | "codex_agent_steer"
            | "codex_agent_review"
            | "codex_agent_compact"
            | "codex_agent_interrupt"
            | "codex_agent_close"
    )
}
pub fn inference(name: &str) -> bool {
    matches!(
        name,
        "codex_agent_start"
            | "codex_agent_send"
            | "codex_agent_steer"
            | "codex_agent_review"
            | "codex_agent_compact"
    )
}
fn identified(name: &str) -> bool {
    name.starts_with("codex_agent_") && !matches!(name, "codex_agent_start" | "codex_agent_list")
}
fn prompted(name: &str) -> bool {
    matches!(
        name,
        "codex_agent_start" | "codex_agent_send" | "codex_agent_steer" | "codex_agent_review"
    )
}
pub fn input_schema(name: &str) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if identified(name) {
        properties.insert(
            "agent_id".into(),
            json!({"type":"string","minLength":1,"maxLength":100}),
        );
        required.push("agent_id");
    }
    if mutating(name) {
        properties.insert("request_key".into(),json!({"type":"string","minLength":8,"maxLength":100,"description":"Unique operation key. Repeat this exact key and arguments to retrieve the original acknowledgement; never replay an uncertain action with a new key."}));
        required.push("request_key");
    }
    if prompted(name) {
        properties.insert(
            "prompt".into(),
            json!({"type":"string","minLength":1,"maxLength":16000}),
        );
        required.push("prompt");
    }
    if name == "codex_agent_wait" {
        properties.insert(
            "timeout_ms".into(),
            json!({"type":"integer","minimum":0,"maximum":1000,"default":1000}),
        );
    }
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub fn validate(name: &str, args: &Value) -> Result<(), String> {
    if !NAMES.contains(&name) {
        return Err("RUNTIME_UNKNOWN_OPERATION".into());
    }
    let fields = args.as_object().ok_or("RUNTIME_OBJECT_REQUIRED")?;
    if args.to_string().len() > 20000 {
        return Err("RUNTIME_REQUEST_LIMIT".into());
    }
    let schema = input_schema(name);
    let allowed = schema["properties"]
        .as_object()
        .ok_or("RUNTIME_SCHEMA_ERROR")?;
    if fields.keys().any(|key| !allowed.contains_key(key)) {
        return Err("RUNTIME_UNKNOWN_ARGUMENT".into());
    }
    for key in schema["required"]
        .as_array()
        .ok_or("RUNTIME_SCHEMA_ERROR")?
    {
        if !fields.contains_key(key.as_str().ok_or("RUNTIME_SCHEMA_ERROR")?) {
            return Err("RUNTIME_REQUIRED_ARGUMENT_MISSING".into());
        }
    }
    for (key, value) in fields {
        if key == "timeout_ms" {
            if !value.as_u64().is_some_and(|n| n <= 1000) {
                return Err("RUNTIME_INVALID_TIMEOUT".into());
            }
            continue;
        }
        let limit = if key == "prompt" { 16000 } else { 100 };
        let minimum = if key == "request_key" { 8 } else { 1 };
        let value = value.as_str().ok_or("RUNTIME_TEXT_REQUIRED")?;
        if value.trim().is_empty()
            || value.len() < minimum
            || value.len() > limit
            || value.contains('\0')
        {
            return Err("RUNTIME_INVALID_TEXT".into());
        }
        if key != "prompt"
            && !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
        {
            return Err("RUNTIME_INVALID_IDENTIFIER".into());
        }
    }
    Ok(())
}
