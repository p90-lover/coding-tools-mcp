//! The MCP event catalog: names, subscription filters and payload shapes.
//! Payloads are allow-listed against their schema so a detector can never leak an
//! undeclared field (tokens, prompts, paths) into a webhook body.
use serde_json::{json, Map, Value};

pub const WEB_TURN_FAILED: &str = "coding_tools.web_turn.failed";
pub const RUN_STALLED: &str = "coding_tools.run.stalled";
pub const MISSION_NEEDS_ATTENTION: &str = "coding_tools.mission.needs_attention";
pub const BRIDGE_DOWN: &str = "coding_tools.bridge.down";
pub const EVENT_NAMES: &[&str] = &[
    WEB_TURN_FAILED,
    RUN_STALLED,
    MISSION_NEEDS_ATTENTION,
    BRIDGE_DOWN,
];

const MAX_STRING: usize = 1000;

fn text(description: &str, max_length: usize) -> Value {
    json!({"type":"string","description":description,"maxLength":max_length})
}

fn choice(description: &str, values: &[&str]) -> Value {
    json!({"type":"string","description":description,"enum":values})
}

fn nullable_text(description: &str, max_length: usize) -> Value {
    json!({"type":["string","null"],"description":description,"maxLength":max_length})
}

/// Fields every incident payload carries so ChatGPT can act without a follow-up read.
fn common_payload(extra: Value, extra_required: &[&str]) -> Value {
    let mut properties = json!({
        "incident_id": text("Stable identifier of this incident. The same incident is delivered once per subscription; a recurrence after recovery gets a new id.", 200),
        "occurred_at": text("When Coding Tools detected the incident (ISO 8601 UTC).", 40),
        "reason_code": text("Machine-readable cause, for example failed, aborted, no_progress, pending_approval, ERR_PROXY_CONNECTION_FAILED.", 120),
        "reason": text("Short redacted human description of what went wrong. Never contains credentials.", MAX_STRING),
        "next_step": text("Suggested next action for the assistant or user.", MAX_STRING),
        "recovery_tools": {
            "type":"array",
            "description":"Coding Tools MCP tools that help inspect or recover from this incident, in suggested order.",
            "items":{"type":"string","maxLength":80},
            "maxItems":8
        }
    });
    if let (Some(base), Some(extra)) = (properties.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    let mut required = vec!["incident_id", "occurred_at", "reason_code", "next_step"];
    required.extend_from_slice(extra_required);
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn filters(properties: Value) -> Value {
    json!({"type":"object","properties":properties,"additionalProperties":false})
}

pub fn definitions() -> Vec<Value> {
    let conversation_key = || text("SHA-256 hex key of the Coding Tools web conversation.", 64);
    let workspace_id = || text("Coding Tools workspace profile id.", 128);
    vec![
        json!({
            "name": WEB_TURN_FAILED,
            "title": "Web chat turn failed",
            "description": "A ChatGPT web turn driven by Coding Tools ended as failed or aborted. Delivered once per turn.",
            "delivery": ["webhook"],
            "inputSchema": filters(json!({
                "conversation_key": conversation_key(),
                "status": choice("Only deliver this terminal status.", &["failed", "aborted"]),
                "turn_mode": choice("Only deliver automatic or Zero Risk (manual) turns.", &["automatic", "manual"])
            })),
            "payloadSchema": common_payload(json!({
                "status": choice("Terminal status reported for the turn.", &["failed", "aborted"]),
                "turn_mode": choice("automatic browser control or manual Zero Risk turn.", &["automatic", "manual"]),
                "trace_id": text("Coding Tools turn trace id.", 128),
                "conversation_key": nullable_text("SHA-256 hex key of the conversation, when the turn belongs to one.", 64)
            }), &["status", "turn_mode", "trace_id"])
        }),
        json!({
            "name": RUN_STALLED,
            "title": "Run stalled",
            "description": "A web chat turn stopped sending heartbeats, or an Agent Orchestrator run stayed running with no node change, for longer than the configured threshold (default 5 minutes).",
            "delivery": ["webhook"],
            "inputSchema": filters(json!({
                "run_kind": choice("Only deliver web turns or orchestrator runs.", &["web_turn", "orchestrator_run"]),
                "workspace_id": workspace_id(),
                "conversation_key": conversation_key()
            })),
            "payloadSchema": common_payload(json!({
                "run_kind": choice("What stalled.", &["web_turn", "orchestrator_run"]),
                "stalled_for_seconds": {"type":"integer","minimum":0,"description":"Seconds since the last observed progress."},
                "stall_threshold_seconds": {"type":"integer","minimum":1,"description":"Configured no-progress threshold."},
                "last_progress_at": text("Last observed progress (ISO 8601 UTC).", 40),
                "workspace_id": nullable_text("Workspace of an orchestrator run.", 128),
                "run_id": nullable_text("Agent Orchestrator run id.", 80),
                "trace_id": nullable_text("Web turn trace id.", 128),
                "conversation_key": nullable_text("SHA-256 hex key of the web conversation.", 64)
            }), &["run_kind", "stalled_for_seconds", "last_progress_at"])
        }),
        json!({
            "name": MISSION_NEEDS_ATTENTION,
            "title": "Mission needs attention",
            "description": "An Agent Orchestrator run was held, stopped with an error, or is waiting for a tool approval or worker input.",
            "delivery": ["webhook"],
            "inputSchema": filters(json!({
                "workspace_id": workspace_id(),
                "run_id": text("Agent Orchestrator run id.", 80),
                "attention": choice("Only deliver this kind of attention.", &["error", "pending_approval", "needs_input", "stopped"])
            })),
            "payloadSchema": common_payload(json!({
                "workspace_id": workspace_id(),
                "run_id": text("Agent Orchestrator run id.", 80),
                "status": choice("Background run status.", &["held", "paused", "running", "idle"]),
                "attention": choice("Why the mission needs attention.", &["error", "pending_approval", "needs_input", "stopped"])
            }), &["workspace_id", "run_id", "status", "attention"])
        }),
        json!({
            "name": BRIDGE_DOWN,
            "title": "Bridge or proxy down",
            "description": "The local Codex bridge or the configured network proxy route became unreachable. Delivered once per outage; re-armed after recovery.",
            "delivery": ["webhook"],
            "inputSchema": filters(json!({
                "component": choice("Only deliver outages of this component.", &["codex_bridge", "proxy_route"])
            })),
            "payloadSchema": common_payload(json!({
                "component": choice("Unreachable component.", &["codex_bridge", "proxy_route"]),
                "target": text("host:port that failed (never includes credentials).", 200),
                "down_since": text("First failed probe (ISO 8601 UTC).", 40),
                "net_error": nullable_text("Chromium or socket error name, when known.", 120)
            }), &["component", "target", "down_since"])
        }),
    ]
}

pub fn definition(name: &str) -> Option<Value> {
    definitions()
        .into_iter()
        .find(|event| event["name"] == name)
}

/// Validate subscription filter arguments against the event's inputSchema.
pub fn validate_arguments(name: &str, arguments: &Value) -> Result<Map<String, Value>, String> {
    let definition = definition(name).ok_or_else(|| format!("Unknown event: {name}"))?;
    let arguments = match arguments {
        Value::Null => return Ok(Map::new()),
        Value::Object(map) => map,
        _ => return Err("arguments must be an object".into()),
    };
    let properties = &definition["inputSchema"]["properties"];
    for (key, value) in arguments {
        let schema = properties
            .get(key)
            .ok_or_else(|| format!("Unsupported filter argument: {key}"))?;
        let value = value
            .as_str()
            .ok_or_else(|| format!("Filter argument {key} must be a string"))?;
        if let Some(max) = schema["maxLength"].as_u64() {
            if value.chars().count() as u64 > max {
                return Err(format!("Filter argument {key} is too long"));
            }
        }
        if let Some(allowed) = schema["enum"].as_array() {
            if !allowed.iter().any(|entry| entry == value) {
                return Err(format!("Filter argument {key} has an unsupported value"));
            }
        }
    }
    Ok(arguments.clone())
}

/// A subscription matches when every filter it set equals the event field of the same name.
pub fn matches_filters(filters: &Map<String, Value>, data: &Value) -> bool {
    filters
        .iter()
        .all(|(key, expected)| data.get(key) == Some(expected))
}

/// Remove credentials that may appear in upstream error text.
pub fn redact(text: &str) -> String {
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+",
            r"sk-[A-Za-z0-9_-]{8,}",
            r"whsec_[A-Za-z0-9+/=]+",
            r"(?i)(token|secret|password|api[_-]?key)=([^&\s]+)",
            r"(?i)://[^/\s:@]+:[^/\s@]+@",
        ]
        .iter()
        .map(|pattern| regex::Regex::new(pattern).expect("static redaction pattern"))
        .collect()
    });
    let mut output = text.to_string();
    for pattern in patterns {
        output = pattern.replace_all(&output, "[redacted]").into_owned();
    }
    output
}

fn clamp_text(value: &str, max: usize) -> String {
    let redacted = redact(value);
    if redacted.chars().count() <= max {
        return redacted;
    }
    redacted
        .chars()
        .take(max.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn sanitize_value(schema: &Value, value: &Value) -> Option<Value> {
    let max = schema["maxLength"].as_u64().unwrap_or(MAX_STRING as u64) as usize;
    let allows_null = schema["type"]
        .as_array()
        .is_some_and(|types| types.iter().any(|entry| entry == "null"));
    match value {
        Value::Null if allows_null => Some(Value::Null),
        Value::String(text) => {
            let cleaned = clamp_text(text, max);
            if let Some(allowed) = schema["enum"].as_array() {
                return allowed
                    .iter()
                    .any(|entry| entry == &cleaned)
                    .then_some(Value::String(cleaned));
            }
            Some(Value::String(cleaned))
        }
        Value::Number(number) if schema["type"] == "integer" => {
            number.as_u64().map(|value| json!(value))
        }
        Value::Array(items) if schema["type"] == "array" => {
            let limit = schema["maxItems"].as_u64().unwrap_or(8) as usize;
            let item_schema = &schema["items"];
            Some(Value::Array(
                items
                    .iter()
                    .take(limit)
                    .filter_map(|item| sanitize_value(item_schema, item))
                    .collect(),
            ))
        }
        _ => None,
    }
}

/// Keep only declared payload fields, redact and bound strings, and require the required ones.
pub fn sanitize_payload(name: &str, data: &Value) -> Result<Value, String> {
    let definition = definition(name).ok_or_else(|| format!("Unknown event: {name}"))?;
    let data = data.as_object().ok_or("event data must be an object")?;
    let schema = &definition["payloadSchema"];
    let mut output = Map::new();
    if let Some(properties) = schema["properties"].as_object() {
        for (key, property) in properties {
            if let Some(value) = data
                .get(key)
                .and_then(|value| sanitize_value(property, value))
            {
                output.insert(key.clone(), value);
            }
        }
    }
    for required in schema["required"].as_array().into_iter().flatten() {
        let key = required.as_str().unwrap_or("");
        if !output.contains_key(key) {
            return Err(format!("event data is missing {key}"));
        }
    }
    Ok(Value::Object(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_declares_webhook_delivery_and_object_schemas() {
        let events = definitions();
        assert_eq!(events.len(), EVENT_NAMES.len());
        for event in &events {
            let name = event["name"].as_str().unwrap();
            assert!(EVENT_NAMES.contains(&name));
            assert!(name.starts_with("coding_tools."));
            assert!(!event["description"].as_str().unwrap().is_empty());
            assert_eq!(event["delivery"], json!(["webhook"]));
            assert_eq!(event["inputSchema"]["type"], "object");
            assert_eq!(event["inputSchema"]["additionalProperties"], false);
            // Filters are optional: a subscription with no arguments receives every event.
            assert!(event["inputSchema"].get("required").is_none());
            let payload = &event["payloadSchema"];
            assert_eq!(payload["type"], "object");
            for key in ["incident_id", "occurred_at", "reason_code", "next_step"] {
                assert!(payload["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == key));
            }
            for required in payload["required"].as_array().unwrap() {
                assert!(payload["properties"]
                    .get(required.as_str().unwrap())
                    .is_some());
            }
        }
    }

    #[test]
    fn arguments_are_checked_against_the_filter_schema() {
        assert!(validate_arguments(BRIDGE_DOWN, &json!({})).is_ok());
        assert!(validate_arguments(BRIDGE_DOWN, &Value::Null).is_ok());
        assert!(validate_arguments(BRIDGE_DOWN, &json!({"component":"codex_bridge"})).is_ok());
        assert!(validate_arguments(BRIDGE_DOWN, &json!({"component":"database"})).is_err());
        assert!(validate_arguments(BRIDGE_DOWN, &json!({"unknown":"x"})).is_err());
        assert!(validate_arguments(RUN_STALLED, &json!({"workspace_id":7})).is_err());
        assert!(validate_arguments("coding_tools.nope", &json!({})).is_err());
    }

    #[test]
    fn payloads_drop_undeclared_fields_and_redact_credentials() {
        let payload = sanitize_payload(
            WEB_TURN_FAILED,
            &json!({
                "incident_id":"web_turn:abc","occurred_at":"2026-09-30T00:00:00Z",
                "reason_code":"failed","next_step":"Retry the turn",
                "reason":"upstream said Bearer abc.def and sk-live_1234567890",
                "status":"failed","turn_mode":"automatic","trace_id":"trace_123",
                "prompt":"secret user text","authorization":"Bearer x"
            }),
        )
        .unwrap();
        assert!(payload.get("prompt").is_none());
        assert!(payload.get("authorization").is_none());
        let reason = payload["reason"].as_str().unwrap();
        assert!(!reason.contains("abc.def") && !reason.contains("sk-live"));
        assert!(sanitize_payload(WEB_TURN_FAILED, &json!({"incident_id":"x"})).is_err());
        assert!(sanitize_payload(
            BRIDGE_DOWN,
            &json!({"incident_id":"x","occurred_at":"t","reason_code":"r","next_step":"n",
                "component":"database","target":"127.0.0.1:1","down_since":"t"})
        )
        .is_err());
    }

    #[test]
    fn filters_match_on_exact_payload_fields() {
        let filters = validate_arguments(RUN_STALLED, &json!({"run_kind":"web_turn"})).unwrap();
        assert!(matches_filters(&filters, &json!({"run_kind":"web_turn"})));
        assert!(!matches_filters(
            &filters,
            &json!({"run_kind":"orchestrator_run"})
        ));
        assert!(matches_filters(
            &Map::new(),
            &json!({"run_kind":"orchestrator_run"})
        ));
    }
}
