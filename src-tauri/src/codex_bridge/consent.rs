//! Method-specific native request validation. Preserve authoritative choices and grant only
//! subsets of the exact live request; standalone command consent is unrelated.
use serde_json::{json, Value};

pub(super) fn kind(method: &str, request: &Value) -> Option<&'static str> {
    match method {
        "item/commandExecution/requestApproval" => Some("command"),
        "item/fileChange/requestApproval" => Some("file_change"),
        "item/permissions/requestApproval" | "permissions/requestApproval" => Some("permissions"),
        "item/tool/requestUserInput" | "tool/requestUserInput" => Some("questions"),
        "mcpServer/elicitation/request" => match request["mode"].as_str() {
            Some("form" | "openai/form" | "openaiForm") => Some("mcp_form"),
            Some("url") => Some("mcp_url"),
            _ => None,
        },
        _ => None,
    }
}

pub(super) fn denied(method: &str, request: &Value) -> Value {
    match kind(method, request) {
        Some("command" | "file_change") => json!({"decision":"decline"}),
        Some("permissions") => json!({"permissions":{},"scope":"turn"}),
        Some("questions") => json!({"answers":{}}),
        Some("mcp_form" | "mcp_url") => json!({"action":"cancel"}),
        _ => Value::Null,
    }
}

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}

/// No broader normalization: entries/path strings must be exactly those requested.
fn subset(granted: &Value, requested: &Value) -> bool {
    match (granted, requested) {
        (Value::Null, _) => true,
        (Value::Object(granted), Value::Object(requested)) => granted.iter().all(|(key, value)| {
            value.is_null()
                || requested
                    .get(key)
                    .is_some_and(|original| subset(value, original))
        }),
        (Value::Array(granted), Value::Array(requested)) => {
            granted.iter().all(|entry| requested.contains(entry))
        }
        (Value::Bool(false), Value::Bool(_)) => true,
        _ => granted == requested,
    }
}

fn command_decision(request: &Value, decision: &Value) -> bool {
    if let Some(offered) = request["availableDecisions"].as_array() {
        // Offered payloads, including amendment objects, are authoritative.
        return offered.contains(decision);
    }
    if let Some(decision) = decision.as_str() {
        return matches!(
            decision,
            "accept" | "acceptForSession" | "decline" | "cancel"
        );
    }
    if keys(decision, &["acceptWithExecpolicyAmendment"])
        && decision.get("acceptWithExecpolicyAmendment").is_some()
    {
        let amendment = &decision["acceptWithExecpolicyAmendment"];
        return keys(amendment, &["execpolicy_amendment"])
            && amendment["execpolicy_amendment"].is_array()
            && !request["proposedExecpolicyAmendment"].is_null()
            && amendment["execpolicy_amendment"] == request["proposedExecpolicyAmendment"];
    }
    if keys(decision, &["applyNetworkPolicyAmendment"])
        && decision.get("applyNetworkPolicyAmendment").is_some()
    {
        let amendment = &decision["applyNetworkPolicyAmendment"];
        return keys(amendment, &["network_policy_amendment"])
            && request["proposedNetworkPolicyAmendments"]
                .as_array()
                .is_some_and(|offered| offered.contains(&amendment["network_policy_amendment"]));
    }
    false
}

fn field_valid(value: &Value, schema: &Value) -> bool {
    if !keys(
        schema,
        &[
            "type",
            "title",
            "description",
            "default",
            "enum",
            "enumNames",
            "oneOf",
            "items",
            "minItems",
            "maxItems",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "format",
            "properties",
            "required",
            "additionalProperties",
            "$schema",
        ],
    ) {
        return false; // Richer schemas need a supported validator, not an unchecked acceptance.
    }
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return false;
        }
    }
    if let Some(options) = schema["oneOf"].as_array() {
        if !options.iter().any(|option| option["const"] == *value) {
            return false;
        }
    }
    match schema["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|value| {
            let length = value.chars().count() as u64;
            length <= 16_384
                && super::form_format::valid(schema["format"].as_str(), value)
                && schema["minLength"].as_u64().is_none_or(|min| length >= min)
                && schema["maxLength"].as_u64().is_none_or(|max| length <= max)
        }),
        Some("boolean") => value.is_boolean(),
        Some("number" | "integer") => value.as_f64().is_some_and(|value| {
            (schema["type"] != "integer" || value.fract() == 0.0)
                && schema["minimum"].as_f64().is_none_or(|min| value >= min)
                && schema["maximum"].as_f64().is_none_or(|max| value <= max)
        }),
        Some("array") => value.as_array().is_some_and(|values| {
            let count = values.len() as u64;
            count <= 64
                && schema["minItems"].as_u64().is_none_or(|min| count >= min)
                && schema["maxItems"].as_u64().is_none_or(|max| count <= max)
                && values.iter().all(|value| {
                    let item = &schema["items"];
                    if let Some(options) = item["anyOf"].as_array() {
                        options.iter().any(|option| option["const"] == *value)
                    } else {
                        field_valid(value, item)
                    }
                })
        }),
        Some("object") => form_valid(value, schema),
        _ => false, // Unsupported richer schemas stay visible but cannot gain an invented accept.
    }
}

fn form_valid(content: &Value, schema: &Value) -> bool {
    if !keys(
        schema,
        &[
            "type",
            "title",
            "description",
            "properties",
            "required",
            "additionalProperties",
            "$schema",
        ],
    ) {
        return false;
    }
    let (Some(content), Some(properties)) = (content.as_object(), schema["properties"].as_object())
    else {
        return false;
    };
    content.iter().all(|(key, value)| {
        properties
            .get(key)
            .is_some_and(|field| field_valid(value, field))
    }) && schema["required"].as_array().is_none_or(|required| {
        required
            .iter()
            .all(|key| key.as_str().is_some_and(|key| content.contains_key(key)))
    })
}

pub(super) fn validate(method: &str, request: &Value, response: &Value) -> Result<(), String> {
    if response.to_string().len() > 64 * 1024 {
        return Err("Native response exceeds 64 KiB".into());
    }
    let valid = match kind(method, request) {
        Some("command") => {
            keys(response, &["decision"]) && command_decision(request, &response["decision"])
        }
        Some("file_change") => {
            keys(response, &["decision"])
                && response["decision"].as_str().is_some_and(|decision| {
                    matches!(
                        decision,
                        "accept" | "acceptForSession" | "decline" | "cancel"
                    )
                })
                && request["availableDecisions"]
                    .as_array()
                    .is_none_or(|offered| offered.contains(&response["decision"]))
        }
        Some("permissions") => {
            keys(response, &["permissions", "scope", "strictAutoReview"])
                && matches!(response["scope"].as_str(), Some("turn" | "session"))
                && keys(&response["permissions"], &["fileSystem", "network"])
                && subset(&response["permissions"], &request["permissions"])
                && (response["strictAutoReview"].is_null()
                    || response["strictAutoReview"].is_boolean())
        }
        Some("questions") => {
            keys(response, &["answers"])
                && response["answers"].as_object().is_some_and(|answers| {
                    request["questions"].as_array().is_some_and(|questions| {
                        answers.iter().all(|(id, answer)| {
                            questions
                                .iter()
                                .any(|question| question["id"] == id.as_str())
                                && keys(answer, &["answers"])
                                && answer["answers"].as_array().is_some_and(|values| {
                                    values.len() <= 16
                                        && values.iter().all(|value| {
                                            value.as_str().is_some_and(|text| text.len() <= 16_384)
                                        })
                                })
                        })
                    })
                })
        }
        Some("mcp_form" | "mcp_url") => {
            keys(response, &["action", "content"])
                && match response["action"].as_str() {
                    Some("decline" | "cancel") => response["content"].is_null(),
                    Some("accept") if request["mode"] == "url" => response["content"].is_null(),
                    Some("accept") => form_valid(&response["content"], &request["requestedSchema"]),
                    _ => false,
                }
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Response does not match the exact native request, offered decisions, schema or requested permission subset".into())
    }
}

pub(super) fn granted(method: &str, request: &Value, response: &Value) -> bool {
    match kind(method, request) {
        Some("command" | "file_change") => {
            !matches!(response["decision"].as_str(), Some("decline" | "cancel"))
        }
        Some("permissions") => {
            response["permissions"]["network"]["enabled"] == true
                || ["entries", "read", "write"].iter().any(|key| {
                    response["permissions"]["fileSystem"][key]
                        .as_array()
                        .is_some_and(|values| !values.is_empty())
                })
        }
        Some("questions") => true,
        Some("mcp_form" | "mcp_url") => response["action"] == "accept",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authoritative_command_choices_and_amendments_cannot_be_forged() {
        let method = "item/commandExecution/requestApproval";
        let offered = json!({"availableDecisions":["decline",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status"]}}]});
        assert!(validate(method, &offered, &json!({"decision":"accept"})).is_err());
        assert!(validate(
            method,
            &offered,
            &json!({"decision":offered["availableDecisions"][1]})
        )
        .is_ok());
        assert!(validate(method, &offered, &json!({"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["powershell"]}}})).is_err());
    }
    #[test]
    fn permission_grants_are_exact_subsets_with_explicit_scope() {
        let method = "item/permissions/requestApproval";
        let request = json!({"permissions":{"fileSystem":{"write":["C:/requested"],"read":["C:/read"]},"network":{"enabled":true}}});
        assert!(validate(
            method,
            &request,
            &json!({"permissions":{"fileSystem":{"write":["C:/requested"]}},"scope":"turn"})
        )
        .is_ok());
        assert!(validate(
            method,
            &request,
            &json!({"permissions":{"network":{"enabled":true}},"scope":"session"})
        )
        .is_ok());
        assert!(validate(
            method,
            &request,
            &json!({"permissions":{"fileSystem":{"write":["C:/read"]}},"scope":"turn"})
        )
        .is_err());
        assert!(validate(
            method,
            &request,
            &json!({"permissions":{"fileSystem":{"write":["C:/unrelated"]}},"scope":"turn"})
        )
        .is_err());
        assert!(validate(method, &request, &json!({"permissions":{}})).is_err());
        assert!(validate(method, &request, &denied(method, &request)).is_ok());
    }
    #[test]
    fn mcp_standard_string_formats_accept_valid_and_reject_invalid_answers() {
        for (format, valid, invalid) in [
            ("email", "first.last+tag@example.com", "bad address"),
            ("uri", "https://example.com/forms?id=1", "not uri"),
            ("date", "2024-02-29", "2026-02-29"),
            (
                "date-time",
                "2026-10-04T16:20:30+08:00",
                "2026-10-04T99:20:30Z",
            ),
        ] {
            let request = json!({"mode":"form","requestedSchema":{"type":"object","properties":{"value":{"type":"string","format":format}},"required":["value"]}});
            assert!(
                validate(
                    "mcpServer/elicitation/request",
                    &request,
                    &json!({"action":"accept","content":{"value":valid}})
                )
                .is_ok(),
                "{format}"
            );
            assert!(
                validate(
                    "mcpServer/elicitation/request",
                    &request,
                    &json!({"action":"accept","content":{"value":invalid}})
                )
                .is_err(),
                "{format}"
            );
        }
    }
    #[test]
    fn questions_and_mcp_forms_use_distinct_payloads() {
        let questions = json!({"questions":[{"id":"choice"}]});
        assert!(validate(
            "item/tool/requestUserInput",
            &questions,
            &json!({"answers":{"choice":{"answers":["Yes"]}}})
        )
        .is_ok());
        assert!(validate(
            "item/tool/requestUserInput",
            &questions,
            &json!({"answers":{"unrelated":{"answers":["Yes"]}}})
        )
        .is_err());
        let form = json!({"mode":"form","requestedSchema":{"type":"object","properties":{"name":{"type":"string","minLength":1}},"required":["name"]}});
        assert!(validate(
            "mcpServer/elicitation/request",
            &form,
            &json!({"action":"accept","content":{"name":"Ethan"}})
        )
        .is_ok());
        assert!(validate(
            "mcpServer/elicitation/request",
            &form,
            &json!({"action":"accept","content":{"name":"Ethan","unrelated":true}})
        )
        .is_err());
        assert!(validate(
            "mcpServer/elicitation/request",
            &form,
            &json!({"action":"cancel"})
        )
        .is_ok());
    }
}
