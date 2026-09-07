use serde_json::{json, Value};
pub const NAMES: &[&str] = &[
    "computer_status",
    "computer_route",
    "computer_snapshot",
    "computer_find_control",
    "computer_wait",
    "computer_action",
    "computer_sequence",
    "computer_stop",
];
pub const WRITES: &[&str] = &["computer_action", "computer_sequence"];
fn selector() -> Value {
    json!({"type":"object","properties":{"name":{"type":"string","maxLength":256},"automation_id":{"type":"string","maxLength":256},"role":{"type":"string","maxLength":64},"contains":{"type":"boolean","default":false}},"additionalProperties":false})
}
fn step() -> Value {
    json!({"type":"object","properties":{
    "action":{"type":"string","enum":["find","click","move","type","key","scroll","wait","verify"]},
    "selector":selector(),"x":{"type":"integer"},"y":{"type":"integer"},
    "snapshot_id":{"type":"string","description":"Fresh id from computer_snapshot; x/y use returned image pixels, not desktop pixels"},
    "button":{"type":"string","enum":["left","right","double"]},"text":{"type":"string","maxLength":2048},
    "key":{"type":"string","description":"enter, tab, escape, backspace, arrows, home/end, pageup/pagedown, space, shift+tab, ctrl+a/c/v/z/y/s"},
    "amount":{"type":"integer","minimum":-10,"maximum":10},"timeout_ms":{"type":"integer","minimum":1,"maximum":15000}},"required":["action"],"additionalProperties":false})
}
pub fn input(name: &str) -> Value {
    let mut properties = json!({"session_id":{"type":"string","description":"Session from computer_status, enabled only through the local UI"}});
    let mut required = vec!["session_id"];
    match name {
        "computer_status" => {
            properties = json!({});
            required.clear();
        }
        "computer_route" => {
            properties = json!({"api_available":{"type":"boolean"},"specialized_available":{"type":"boolean"},"visual_only":{"type":"boolean"}});
            required.clear();
        }
        "computer_snapshot" => properties["include_ui"] = json!({"type":"boolean","default":true}),
        "computer_find_control" | "computer_wait" => {
            properties["selector"] = selector();
            required.push("selector");
            if name == "computer_wait" {
                properties["timeout_ms"] =
                    json!({"type":"integer","minimum":1,"maximum":15000,"default":5000});
            }
        }
        "computer_action" | "computer_sequence" => {
            properties["request_id"] = json!({"type":"string","maxLength":80,"description":"Unique id; identical retries never repeat input"});
            required.push("request_id");
            if name == "computer_action" {
                properties["step"] = step();
                required.push("step");
            } else {
                properties["steps"] =
                    json!({"type":"array","minItems":1,"maxItems":8,"items":step()});
                properties["resume_from_step"] = json!({"type":"integer","minimum":0,"description":"Explicit resume at exactly the server's next_step; omit steps when resuming"});
            }
        }
        _ => {}
    }
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

/// Enforce the advertised top-level shape before touching either UIA or pixels.
pub(super) fn validate(name: &str, args: &Value) -> super::Result<()> {
    let obj = args
        .as_object()
        .ok_or_else(|| super::error("INVALID_INPUT", "Computer arguments must be an object"))?;
    if args.to_string().len() > 32_768 {
        return Err(super::error(
            "INPUT_TOO_LARGE",
            "Computer arguments exceed 32 KiB",
        ));
    }
    let spec = input(name);
    let props = spec["properties"].as_object().expect("schema properties");
    for (key, value) in obj {
        let field = props.get(key).ok_or_else(|| {
            super::error(
                "INVALID_INPUT",
                "Unknown computer argument; file destinations and saving are not supported",
            )
        })?;
        let valid = match field["type"].as_str().unwrap_or("") {
            "string" => value.is_string(),
            "integer" => value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            _ => false,
        };
        if !valid {
            return Err(super::error(
                "INVALID_INPUT",
                "Computer argument has an invalid type",
            ));
        }
    }
    for key in spec["required"].as_array().expect("required") {
        if !obj.contains_key(key.as_str().expect("key")) {
            return Err(super::error(
                "INVALID_INPUT",
                "A required computer argument is missing",
            ));
        }
    }
    Ok(())
}
