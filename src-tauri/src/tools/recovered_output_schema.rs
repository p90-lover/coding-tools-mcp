//! Selective recovery from fix/verified-contracts-0.4.4-rc.2 (80043e2).
//! Only the two verified read-only contracts are registered. No execution behavior changes.
use serde_json::{json, Value};
pub fn for_tool(name: &str) -> Option<Value> {
    let (required, properties) = match name {
        "read_file" => (
            json!(["path", "content", "encoding", "truncated"]),
            json!({
                "path":{"type":"string"},"content":{"type":"string"},"encoding":{"const":"utf-8"},
                "start_line":{"type":"integer","minimum":0},"end_line":{"type":"integer","minimum":0},
                "total_lines":{"type":"integer","minimum":0},"total_bytes":{"type":"integer","minimum":0},
                "bytes_read":{"type":"integer","minimum":0},"truncated":{"type":"boolean"},"warnings":{"type":"array","items":{"type":"string"}}
            }),
        ),
        "operation_log" => (
            json!(["operations", "next_cursor"]),
            json!({
                "operations":{"type":"array","maxItems":200,"items":{"type":"object"}},
                "next_cursor":{"type":"integer","minimum":0}
            }),
        ),
        _ => return None,
    };
    let mut properties = properties.as_object().unwrap().clone();
    properties.insert("ok".into(), json!({"type":"boolean"}));
    properties.insert("error".into(), json!({"type":"object"}));
    Some(
        json!({"type":"object","required":["ok"],"properties":properties,"additionalProperties":true,
        "allOf":[{"if":{"properties":{"ok":{"const":true}},"required":["ok"]},"then":{"required":required}}]}),
    )
}
