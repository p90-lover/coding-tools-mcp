//! Bounded, non-executing configuration compatibility reader.
//! A preview never authorizes a tool. Managed policy, root consent and native sandbox
//! capability checks must still occur in the normal policy path before any activation.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const MAX_CONFIG_BYTES: usize = 64 * 1024;

fn table(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "Configuration section must be an object/table".into())
}
fn strings(value: &Value) -> Result<Vec<String>, String> {
    let values = value.as_array().ok_or("Expected a string array")?;
    if values.len() > 128 {
        return Err("Configuration array exceeds 128 entries".into());
    }
    values
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.len() <= 2048 && !s.chars().any(char::is_control))
                .map(str::to_string)
                .ok_or_else(|| "Invalid configuration string".into())
        })
        .collect()
}
fn bounded(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("Configuration nesting exceeds the preview limit".into());
    }
    match value {
        Value::Object(map) => {
            if map.len() > 256 {
                return Err("Too many configuration keys".into());
            }
            for item in map.values() {
                bounded(item, depth + 1)?;
            }
        }
        Value::Array(items) => {
            if items.len() > 512 {
                return Err("Configuration array exceeds the preview limit".into());
            }
            for item in items {
                bounded(item, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn preview(provider: &str, content: &str) -> Result<Value, String> {
    if content.is_empty() || content.len() > MAX_CONFIG_BYTES {
        return Err("Configuration input must contain 1..65536 bytes".into());
    }
    // Parser errors are deliberately generic: they can otherwise quote credentials or hooks.
    let parsed: Value = match provider {
        "codex" => {
            let value: toml::Value =
                toml::from_str(content).map_err(|_| "Invalid Codex TOML configuration")?;
            serde_json::to_value(value).map_err(|_| "Unsupported TOML value")?
        }
        "claude" => {
            serde_json::from_str(content).map_err(|_| "Invalid Claude JSON configuration")?
        }
        _ => return Err("Choose codex or claude".into()),
    };
    bounded(&parsed, 0)?;
    let config = table(&parsed)?;
    let mut proposed =
        json!({"approval_mode": null, "permission_mode": null, "network_allowed": null});
    let mut roots: Vec<String> = Vec::new();
    let mut rules = json!({"deny": 0, "ask": 0, "allow": 0});
    let mut diagnostics = vec![
        "LOCAL_POLICY_REVIEW_REQUIRED",
        "OS_SANDBOX_EQUIVALENCE_NOT_ASSUMED",
    ];
    if config.contains_key("hooks") {
        diagnostics.push("HOOKS_NOT_EXECUTED_OR_IMPORTED");
    }
    if [
        "env",
        "apiKeyHelper",
        "model_provider",
        "model_providers",
        "mcpServers",
        "mcp_servers",
    ]
    .iter()
    .any(|key| config.contains_key(*key))
    {
        diagnostics.push("CREDENTIAL_ENVIRONMENT_AND_PROVIDER_CONFIGURATION_NOT_IMPORTED");
    }
    if provider == "codex" {
        if let Some(value) = config.get("approval_policy") {
            match value.as_str() {
                Some("on-request" | "never") => proposed["approval_mode"] = value.clone(),
                _ => diagnostics.push("UNSUPPORTED_OR_GRANULAR_APPROVAL_POLICY"),
            }
        }
        if let Some(value) = config.get("sandbox_mode") {
            match value.as_str() {
                Some("read-only" | "workspace-write") => {
                    proposed["permission_mode"] = value.clone()
                }
                _ => diagnostics.push("UNSUPPORTED_SANDBOX_MODE"),
            }
        }
        if let Some(value) = config.get("sandbox_workspace_write") {
            let sandbox = table(value)?;
            if let Some(network) = sandbox.get("network_access") {
                proposed["network_allowed"] =
                    Value::Bool(network.as_bool().ok_or("network_access must be boolean")?);
            }
            if let Some(value) = sandbox.get("writable_roots") {
                roots = strings(value)?;
            }
            if sandbox
                .keys()
                .any(|key| !matches!(key.as_str(), "network_access" | "writable_roots"))
            {
                diagnostics.push("ADDITIONAL_SANDBOX_OPTIONS_REQUIRE_REVIEW");
            }
        }
        if config.keys().any(|key| {
            !matches!(
                key.as_str(),
                "approval_policy"
                    | "sandbox_mode"
                    | "sandbox_workspace_write"
                    | "hooks"
                    | "env"
                    | "model"
                    | "model_provider"
                    | "model_providers"
                    | "mcp_servers"
            )
        }) {
            diagnostics.push("UNMAPPED_CODEX_SETTINGS_OR_PROFILE_LAYERS");
        }
    } else {
        let empty = json!({});
        let permissions = table(config.get("permissions").unwrap_or(&empty))?;
        if let Some(value) = permissions.get("defaultMode") {
            match value.as_str() {
                Some("acceptEdits") => {
                    proposed["permission_mode"] = json!("workspace-write");
                    proposed["approval_mode"] = json!("on-request");
                }
                Some("plan") => {
                    proposed["permission_mode"] = json!("read-only");
                    proposed["approval_mode"] = json!("on-request");
                }
                Some("default") => proposed["approval_mode"] = json!("on-request"),
                Some("dontAsk") => proposed["approval_mode"] = json!("never"),
                _ => diagnostics.push("AUTO_OR_BYPASS_MODE_NOT_TRANSLATED"),
            }
        }
        for key in ["deny", "ask", "allow"] {
            if let Some(value) = permissions.get(key) {
                let values = strings(value)?;
                rules[key] = json!(values.len());
                if !values.is_empty() {
                    diagnostics.push("TOOL_RULE_TRANSLATION_REQUIRES_REVIEW");
                }
                // Do not echo command-pattern contents: they may contain tokens or shell snippets.
            }
        }
        if let Some(value) = permissions.get("additionalDirectories") {
            roots = strings(value)?;
        }
        if permissions.keys().any(|key| {
            !matches!(
                key.as_str(),
                "defaultMode" | "deny" | "ask" | "allow" | "additionalDirectories"
            )
        }) || config.keys().any(|key| {
            !matches!(
                key.as_str(),
                "permissions" | "hooks" | "env" | "model" | "apiKeyHelper" | "mcpServers"
            )
        }) {
            diagnostics.push("UNMAPPED_CLAUDE_SETTINGS_OR_MANAGED_RESTRICTIONS");
        }
    }
    if !roots.is_empty() {
        diagnostics.push("ADDITIONAL_ROOTS_ARE_NOT_ACCESS_GRANTS");
    }
    if proposed["approval_mode"] == "never" {
        diagnostics.push("NEVER_DENIES_ESCALATION_NOT_FULL_ACCESS");
    }
    diagnostics.sort_unstable();
    diagnostics.dedup();
    Ok(
        json!({"ok": true, "provider": provider, "source_sha256": format!("{:x}", Sha256::digest(content.as_bytes())),
        "proposed": proposed, "proposed_roots": roots, "rules": rules, "rule_order": ["deny", "ask", "allow"],
        "diagnostics": diagnostics, "applied": false, "automatic_import_blocked": true,
        "requires_local_review": true, "sandbox_equivalent": false, "model_calls": false,
        "scope": "single supplied configuration; user/project/profile/managed precedence is not resolved"}),
    )
}
