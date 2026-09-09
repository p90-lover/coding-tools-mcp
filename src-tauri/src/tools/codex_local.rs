//! Model-free Codex-style resource and human-interaction tools.
//! No Codex process, provider call, arbitrary URI proxy or screenshot persistence.
use crate::tools::workspace::{tool_ok, WorkspaceError};
use crate::tools::{session, ToolContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    time::{Duration, Instant},
};

pub const UPSTREAM: &str = "634ebc1865c6ac840ed3ba118f040d527bf4b55d";
pub const NAMES: &[&str] = &[
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "request_user_input",
    "read_user_input",
    "clock_sleep",
    "wait_for_environment",
];
const SERVER: &str = "coding-tools-mcp";
const TTL: Duration = Duration::from_secs(600);
fn invalid(message: &str) -> WorkspaceError {
    WorkspaceError::invalid_argument(message)
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub label: String,
    pub description: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<Choice>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    questions: Vec<Question>,
    request_id: Option<String>,
}
struct Entry {
    nonce: String,
    fingerprint: String,
    questions: Vec<Question>,
    revision: u64,
    created: Instant,
    result: Value,
}
#[derive(Default)]
pub struct HumanInputs {
    entries: Mutex<BTreeMap<String, Entry>>,
}
impl HumanInputs {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<String, Entry>>, WorkspaceError> {
        self.entries
            .lock()
            .map_err(|_| invalid("Human input state is unavailable"))
    }
    fn expire(entries: &mut BTreeMap<String, Entry>, revision: u64) {
        entries.retain(|_, entry| entry.created.elapsed() < TTL);
        for entry in entries.values_mut() {
            if entry.revision != revision {
                entry.result =
                    json!({"status":"cancelled","reason":"permissions_changed","answers":null});
            }
        }
    }
    pub fn submit(&self, args: &Value, revision: u64) -> Result<Value, WorkspaceError> {
        let input: Input =
            serde_json::from_value(args.clone()).map_err(|_| invalid("Invalid question fields"))?;
        if !(1..=3).contains(&input.questions.len()) {
            return Err(invalid("Supply one to three questions"));
        }
        let mut ids = BTreeSet::new();
        for q in &input.questions {
            if !identifier(&q.id)
                || !ids.insert(q.id.clone())
                || !text(&q.header, 96)
                || q.header.chars().count() > 12
                || !text(&q.question, 2048)
                || !(2..=3).contains(&q.options.len())
            {
                return Err(invalid(
                    "Use unique question IDs, headers up to 12 characters, and 2–3 options",
                ));
            }
            let mut labels = BTreeSet::new();
            for option in &q.options {
                if option.label == "__other"
                    || !text(&option.label, 128)
                    || !text(&option.description, 1024)
                    || !labels.insert(option.label.clone())
                {
                    return Err(invalid(
                        "Choice labels must be unique and text must be bounded",
                    ));
                }
            }
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&input.questions)
                    .map_err(|_| invalid("Cannot encode questions"))?
            )
        );
        let id = input
            .request_id
            .unwrap_or_else(|| format!("input-{fingerprint}"));
        if !identifier(&id) {
            return Err(invalid("Invalid request_id"));
        }
        let mut entries = self.lock()?;
        Self::expire(&mut entries, revision);
        if let Some(entry) = entries.get(&id) {
            if entry.fingerprint != fingerprint {
                return Err(invalid("request_id belongs to different questions"));
            }
            return Ok(Self::response(&id, entry));
        }
        if entries.len() >= 32 {
            return Err(invalid(
                "Human input capacity reached; pending requests were not discarded",
            ));
        }
        let entry = Entry {
            nonce: uuid::Uuid::new_v4().to_string(),
            fingerprint,
            questions: input.questions,
            revision,
            created: Instant::now(),
            result: json!({"status":"pending","answers":null}),
        };
        let result = Self::response(&id, &entry);
        entries.insert(id, entry);
        Ok(result)
    }
    fn response(id: &str, entry: &Entry) -> Value {
        let mut result = entry.result.clone();
        result["request_id"] = json!(id);
        result["remaining_seconds"] = json!(TTL.saturating_sub(entry.created.elapsed()).as_secs());
        result["storage"] = json!("memory_only");
        result["grants_permissions"] = json!(false);
        result["next_tool"] = if result["status"] == "pending" {
            json!("read_user_input")
        } else {
            Value::Null
        };
        result
    }
    pub fn poll(&self, id: &str, revision: u64) -> Result<Value, WorkspaceError> {
        let mut entries = self.lock()?;
        Self::expire(&mut entries, revision);
        let entry = entries
            .get(id)
            .ok_or_else(|| invalid("Unknown or expired request_id in this listener"))?;
        Ok(Self::response(id, entry))
    }
    pub fn pending(&self, revision: u64) -> Result<Value, WorkspaceError> {
        let mut entries = self.lock()?;
        Self::expire(&mut entries, revision);
        Ok(Value::Array(entries.iter().filter(|(_,v)|v.result["status"]=="pending").map(|(id,e)|
            json!({"request_id":id,"answer_nonce":e.nonce,"questions":e.questions,"remaining_seconds":TTL.saturating_sub(e.created.elapsed()).as_secs()})).collect()))
    }
    /// Called only by a visible, focused local main-window IPC command (or isolated test).
    pub fn answer(
        &self,
        id: &str,
        nonce: &str,
        answers: Value,
        cancel: bool,
        revision: u64,
    ) -> Result<Value, WorkspaceError> {
        let mut entries = self.lock()?;
        Self::expire(&mut entries, revision);
        let entry = entries
            .get_mut(id)
            .ok_or_else(|| invalid("Question expired or belongs to another listener"))?;
        if entry.result["status"] != "pending" || entry.nonce != nonce {
            return Err(invalid(
                "Question is no longer pending or this local form is stale",
            ));
        }
        if cancel {
            entry.result = json!({"status":"cancelled","reason":"user_cancelled","answers":null});
        } else {
            let map = answers
                .as_object()
                .ok_or_else(|| invalid("Answers must be keyed by question ID"))?;
            if map.len() != entry.questions.len() {
                return Err(invalid("Answer every displayed question exactly once"));
            }
            for q in &entry.questions {
                let obj = map
                    .get(&q.id)
                    .and_then(Value::as_object)
                    .ok_or_else(|| invalid("Missing question answer"))?;
                let answer = obj
                    .get("answers")
                    .and_then(Value::as_array)
                    .filter(|a| a.len() == 1)
                    .and_then(|a| a[0].as_str());
                if obj.len() != 1 || answer.is_none_or(|s| !text(s, 2048)) {
                    return Err(invalid("Each answer must contain one bounded text choice"));
                }
            }
            entry.result = json!({"status":"answered","answers":answers});
        }
        Ok(Self::response(id, entry))
    }
}

pub fn input_schema(name: &str) -> Value {
    let props = match name {
        "list_mcp_resources" | "list_mcp_resource_templates" => {
            json!({"server":{"type":"string","enum":[SERVER]},"cursor":{"type":"string","maxLength":128}})
        }
        "read_mcp_resource" => {
            json!({"server":{"type":"string","enum":[SERVER]},"uri":{"type":"string","maxLength":2048}})
        }
        "request_user_input" => {
            json!({"request_id":{"type":"string","maxLength":128},"questions":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","properties":{
            "id":{"type":"string","maxLength":128},"header":{"type":"string","maxLength":12},"question":{"type":"string","maxLength":2048},
            "options":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"object","properties":{"label":{"type":"string","maxLength":128},"description":{"type":"string","maxLength":1024}},"required":["label","description"],"additionalProperties":false}}},"required":["id","header","question","options"],"additionalProperties":false}}})
        }
        "read_user_input" => json!({"request_id":{"type":"string","maxLength":128}}),
        "clock_sleep" => json!({"duration_ms":{"type":"integer","minimum":1,"maximum":5000}}),
        _ => json!({"timeout_ms":{"type":"integer","minimum":0,"maximum":5000,"default":1000}}),
    };
    let required = match name {
        "read_mcp_resource" => json!(["server", "uri"]),
        "request_user_input" => json!(["questions"]),
        "read_user_input" => json!(["request_id"]),
        "clock_sleep" => json!(["duration_ms"]),
        _ => json!([]),
    };
    json!({"type":"object","properties":props,"required":required,"additionalProperties":false})
}
fn environment(ctx: &ToolContext) -> Value {
    json!({"workspace":ctx.workspace.root_display(),"permission_mode":ctx.permission_mode,"policy_revision":ctx.policy_revision,"tool_profile":ctx.tool_profile,"codex_invoked":false,"os_sandbox":false})
}
fn contents(uri: &str, value: Value) -> Result<Value, WorkspaceError> {
    let body = serde_json::to_string(&value).map_err(|_| invalid("Cannot encode resource"))?;
    if body.len() > 65536 {
        return Err(invalid(
            "Resource exceeds 64 KiB; use a smaller output page",
        ));
    }
    Ok(tool_ok(
        json!({"contents":[{"uri":uri,"mimeType":"application/json","text":body}]}),
    ))
}
fn resource(ctx: &ToolContext, uri: &str) -> Result<Value, WorkspaceError> {
    match uri {
        "coding-tools://workspace/environment" => return contents(uri, environment(ctx)),
        "coding-tools://workspace/plan" => {
            return contents(
                uri,
                ctx.local_plan
                    .lock()
                    .map_err(|_| invalid("Plan unavailable"))?
                    .clone(),
            )
        }
        _ => {}
    }
    let u = url::Url::parse(uri).map_err(|_| invalid("Invalid resource URI"))?;
    if u.scheme() != "coding-tools"
        || u.host_str() != Some("command")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.port().is_some()
    {
        return Err(invalid("Only listed workspace resources and owned-command output are readable; no file or network URI proxy"));
    }
    let path: Vec<_> = u.path().trim_start_matches('/').split('/').collect();
    if path.len() != 2 || !identifier(path[0]) || !matches!(path[1], "stdout" | "stderr") {
        return Err(invalid("Use the returned command-output template"));
    }
    let mut offset = 0u64;
    let mut limit = 8192u64;
    let mut seen = BTreeSet::new();
    for (key, value) in u.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err(invalid("Duplicate resource parameter"));
        }
        let n = value
            .parse::<u64>()
            .map_err(|_| invalid("Output paging values must be integers"))?;
        match key.as_ref() {
            "offset" if n <= 1_048_576 => offset = n,
            "limit" if (1..=8192).contains(&n) => limit = n,
            _ => return Err(invalid("Unknown or excessive output paging parameter")),
        }
    }
    let output = session::read_output(
        &ctx.sessions,
        &json!({"output_ref":format!("command:{}:{}",path[0],path[1]),"offset":offset,"limit":limit}),
    )?;
    contents(uri, output)
}
pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, WorkspaceError> {
    let object = args
        .as_object()
        .ok_or_else(|| invalid("Arguments must be an object"))?;
    if args.to_string().len() > 16000 {
        return Err(invalid("Local tool request exceeds 16 KiB"));
    }
    let schema = input_schema(name);
    let allowed = schema["properties"].as_object().unwrap();
    if object.keys().any(|k| !allowed.contains_key(k)) {
        return Err(invalid("Unknown local-tool field"));
    }
    if let Some(server) = object.get("server") {
        if server.as_str() != Some(SERVER) {
            return Err(invalid(
                "Unknown MCP resource server; this adapter serves only this listener",
            ));
        }
    }
    if object.contains_key("cursor") {
        return Err(invalid(
            "This bounded resource catalog has no next page or cursor",
        ));
    }
    match name {
        "list_mcp_resources" => Ok(tool_ok(json!({"resources":[
            {"server":SERVER,"uri":"coding-tools://workspace/environment","name":"Workspace environment","mimeType":"application/json"},
            {"server":SERVER,"uri":"coding-tools://workspace/plan","name":"Current plan","mimeType":"application/json"}]}))),
        "list_mcp_resource_templates" => Ok(tool_ok(
            json!({"resourceTemplates":[{"server":SERVER,"uriTemplate":"coding-tools://command/{command_id}/{stream}{?offset,limit}","name":"Owned command stdout/stderr","mimeType":"application/json","description":"Only this listener's returned command_id; stream stdout or stderr; limit 1–8192 bytes."}]}),
        )),
        "read_mcp_resource" => {
            if args["server"] != SERVER {
                return Err(invalid("server is required"));
            }
            resource(
                ctx,
                args["uri"]
                    .as_str()
                    .filter(|s| s.len() <= 2048)
                    .ok_or_else(|| invalid("uri is required"))?,
            )
        }
        "request_user_input" | "read_user_input" => {
            if !matches!(ctx.auth.auth_type.as_str(), "oauth" | "bearer") {
                return Err(invalid(
                    "Human interaction requires an authenticated listener",
                ));
            }
            let value = if name == "request_user_input" {
                ctx.human_inputs.submit(args, ctx.policy_revision)?
            } else {
                let id = args["request_id"]
                    .as_str()
                    .filter(|id| identifier(id))
                    .ok_or_else(|| invalid("Valid request_id required"))?;
                ctx.human_inputs.poll(id, ctx.policy_revision)?
            };
            Ok(tool_ok(value))
        }
        "clock_sleep" | "wait_for_environment" => {
            let millis = if name == "clock_sleep" {
                args["duration_ms"]
                    .as_u64()
                    .filter(|n| (1..=5000).contains(n))
                    .ok_or_else(|| invalid("duration_ms must be 1–5000"))?
            } else {
                match args.get("timeout_ms") {
                    None => 1000,
                    Some(v) => v
                        .as_u64()
                        .filter(|n| *n <= 5000)
                        .ok_or_else(|| invalid("timeout_ms must be 0–5000"))?,
                }
            };
            let started = Instant::now();
            let mut ready = false;
            loop {
                if ctx.current_policy_revision()? != ctx.policy_revision {
                    return Err(invalid(
                        "Permissions changed; waiting interrupted without submitting an action",
                    ));
                }
                if name == "wait_for_environment" {
                    ready = std::fs::read_dir(ctx.workspace.root()).is_ok();
                    if ready {
                        break;
                    }
                }
                let remaining = Duration::from_millis(millis).saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                std::thread::sleep(remaining.min(Duration::from_millis(25)));
            }
            Ok(tool_ok(
                json!({"ready":if name=="wait_for_environment"{json!(ready)}else{Value::Null},"elapsed_ms":started.elapsed().as_millis() as u64,"requested_ms":millis,"environment":environment(ctx),"network_used":false,"codex_invoked":false,"scope":"local_workspace_only"}),
            ))
        }
        _ => Err(invalid("Unknown local Codex counterpart")),
    }
}

/// Inventory is pinned to upstream source, not a promise of hidden host capabilities.
pub fn coverage(ctx: &ToolContext) -> Value {
    let exposed = crate::tools::registry::exposed_tool_names(&ctx.tool_profile);
    let entries: [(&str, &[&str], &str, &str); 25] = [
        (
            "apply_patch",
            &["apply_patch"],
            "local_counterpart",
            "Workspace policy and reviewed patch executor",
        ),
        (
            "current_time",
            &["get_current_time"],
            "local_counterpart",
            "UTC Unix time from the local system clock",
        ),
        (
            "unified_exec",
            &["exec_command", "write_stdin", "read_output", "kill_command"],
            "local_counterpart",
            "Existing owned-command runtime; not the upstream OS sandbox",
        ),
        (
            "shell_spec",
            &["exec_command"],
            "local_counterpart",
            "Use the returned local command schema and permission policy",
        ),
        (
            "view_image",
            &["view_image"],
            "local_counterpart",
            "Bounded workspace images returned as MCP image content",
        ),
        (
            "plan",
            &["update_plan", "get_plan"],
            "local_counterpart",
            "Listener-owned RAM plan; not automatic execution",
        ),
        (
            "tool_search",
            &["tool_search"],
            "local_counterpart",
            "Search this listener's real exposed schemas",
        ),
        (
            "request_permissions",
            &["request_permissions"],
            "local_counterpart",
            "Existing approval workflow; cannot silently widen local permissions",
        ),
        (
            "mcp_resource",
            &[
                "list_mcp_resources",
                "list_mcp_resource_templates",
                "read_mcp_resource",
            ],
            "local_counterpart",
            "This server's plan/environment and owned-command output only",
        ),
        (
            "request_user_input",
            &["request_user_input", "read_user_input"],
            "local_counterpart",
            "Explicit local desktop answers; returns pending rather than blocking HTTP",
        ),
        (
            "request_user_input_async",
            &["request_user_input", "read_user_input"],
            "local_counterpart",
            "Same bounded question store; only local IPC can answer",
        ),
        (
            "sleep",
            &["clock_sleep"],
            "local_counterpart",
            "1–5000 ms; interrupted by policy changes, not by ChatGPT message events",
        ),
        (
            "wait_for_environment",
            &["wait_for_environment"],
            "local_counterpart",
            "Check current workspace readability only; no remote environment management",
        ),
        (
            "mcp",
            &[],
            "requires_configured_external_server",
            "No arbitrary MCP server or credential proxy is enabled",
        ),
        (
            "dynamic",
            &[],
            "requires_host_runtime",
            "Dynamic Codex turn-defined callbacks are not invented",
        ),
        (
            "extension_tools",
            &[],
            "requires_host_runtime",
            "Extension capabilities belong to their actual provider and account",
        ),
        (
            "multi_agents",
            &[],
            "requires_model_inference",
            "Model/subagent launches are excluded by zero-Codex-quota requirement",
        ),
        (
            "multi_agents_v2",
            &[],
            "requires_model_inference",
            "No substitute agent output or autonomous inference",
        ),
        (
            "get_context_remaining",
            &[],
            "requires_host_runtime",
            "The MCP server cannot measure the hosting ChatGPT context window",
        ),
        (
            "new_context_window",
            &[],
            "requires_host_runtime",
            "The server cannot create or compress a ChatGPT model context",
        ),
        (
            "list_available_plugins_to_install",
            &[],
            "requires_host_runtime",
            "Requires the host's real plugin registry",
        ),
        (
            "request_plugin_install",
            &[],
            "requires_host_runtime",
            "Cannot silently install or authorize ChatGPT plugins",
        ),
        (
            "send_message_to_user_async",
            &[],
            "requires_host_runtime",
            "No unsolicited ChatGPT conversation-message API is exposed",
        ),
        (
            "code_mode_execute_wait",
            &[],
            "requires_host_runtime",
            "Does not relabel shell execution as Codex code-mode orchestration",
        ),
        (
            "test_sync",
            &[],
            "internal_test_not_exposed",
            "Upstream test-only handler is not an application feature",
        ),
    ];
    Value::Array(entries.into_iter().map(|(family,tools,status,boundary)| json!({
        "family":family,"integration":status,"local_tools":tools,
        "enabled_tools":tools.iter().filter(|n|exposed.contains(n)).copied().collect::<Vec<_>>(),"boundary":boundary
    })).collect())
}

#[cfg(test)]
mod tests {
    include!("../../../aiTemp/codex-local-integration/tests.rs");
}
