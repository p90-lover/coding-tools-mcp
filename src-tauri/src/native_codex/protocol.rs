//! Strict host-side contract for the pinned official Codex app-server.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SUPPORTED_VERSION: &str = "0.153.4";
pub const MAX_FRAME: usize = 2 * 1024 * 1024;
pub const MAX_EVENT_BYTES: usize = 256 * 1024;
pub const MAX_EVENTS: usize = 128;
pub const MAX_PROMPT: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePolicy {
    pub sandbox: String,
    pub approval: String,
    pub network: bool,
    pub cwd: PathBuf,
    pub writable_roots: Vec<PathBuf>,
}

impl NativePolicy {
    pub fn new(
        sandbox: &str,
        approval: &str,
        network: bool,
        cwd: PathBuf,
        roots: Vec<PathBuf>,
    ) -> Self {
        let sandbox = match sandbox {
            "workspace-write" | "trusted" => "workspace-write",
            "danger-full-access" | "dangerous" => "danger-full-access",
            _ => "read-only",
        };
        let approval = match approval {
            "on-request" | "auto-workspace" => "on-request",
            "never" => "never",
            _ => "untrusted",
        };
        Self {
            sandbox: sandbox.into(),
            approval: approval.into(),
            network: sandbox == "danger-full-access" || (sandbox == "workspace-write" && network),
            cwd,
            writable_roots: roots,
        }
    }

    pub fn thread_params(&self) -> Value {
        let mut config = json!({
            "sandbox_workspace_write.network_access": self.network,
            "sandbox_workspace_write.writable_roots": self.writable_roots,
            "sandbox_workspace_write.exclude_tmpdir_env_var": true,
            "sandbox_workspace_write.exclude_slash_tmp": true,
            "approvals_reviewer": "user"
        });
        // Native Windows sandbox setup remains an explicit action in Codex itself.
        // Missing setup must fail, never become an unsandboxed fallback.
        #[cfg(windows)]
        config
            .as_object_mut()
            .expect("object")
            .insert("windows.sandbox".into(), json!("elevated"));
        #[cfg(not(windows))]
        let _ = &mut config;
        json!({
            "cwd": self.cwd, "sandbox": self.sandbox,
            "approvalPolicy": self.approval, "approvalsReviewer": "user",
            "config": config,
            "developerInstructions": "Preserve user files. Do not permanently delete files: move superseded or unwanted files to a recoverable Trash directory, keeping their relative paths. Put temporary files under aiTemp. Never bypass OS authentication, lock screens, UAC or another user's desktop. A timeout is not evidence that an operation was canceled; inspect state before retrying."
        })
    }

    pub fn verify_thread(&self, response: &Value) -> Result<String, String> {
        let id = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() < 512)
            .ok_or("Codex omitted the thread identity")?;
        let cwd = response
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or("Codex omitted effective cwd")?;
        if !same_path(Path::new(cwd), &self.cwd) {
            return Err("Codex returned an unexpected workspace; connection refused".into());
        }
        if response.get("approvalPolicy").and_then(Value::as_str) != Some(self.approval.as_str())
            || response.get("approvalsReviewer").and_then(Value::as_str) != Some("user")
        {
            return Err(
                "Codex effective approval policy differs; review managed/local configuration"
                    .into(),
            );
        }
        let effective = &response["sandbox"];
        let expected = match self.sandbox.as_str() {
            "workspace-write" => "workspaceWrite",
            "danger-full-access" => "dangerFullAccess",
            _ => "readOnly",
        };
        if effective["type"].as_str() != Some(expected) {
            return Err("Codex did not confirm the requested sandbox; no fallback allowed".into());
        }
        if expected != "dangerFullAccess"
            && effective["networkAccess"].as_bool() != Some(self.network)
        {
            return Err("Codex effective network policy differs; connection refused".into());
        }
        if expected == "workspaceWrite" {
            let roots = effective["writableRoots"]
                .as_array()
                .ok_or("Codex omitted writable roots")?;
            if roots.iter().any(|root| {
                root.as_str().is_none_or(|s| {
                    !same_path(Path::new(s), &self.cwd)
                        && !self
                            .writable_roots
                            .iter()
                            .any(|r| same_path(Path::new(s), r))
                })
            }) || effective["excludeTmpdirEnvVar"].as_bool() != Some(true)
                || effective["excludeSlashTmp"].as_bool() != Some(true)
            {
                return Err("Codex writable scope exceeds the locally approved roots".into());
            }
        }
        Ok(id.into())
    }
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptArgs {
    pub prompt: String,
    pub request_id: String,
}
impl PromptArgs {
    pub fn parse(args: &Value) -> Result<Self, String> {
        let value: Self = serde_json::from_value(args.clone())
            .map_err(|_| "Expected only prompt and request_id")?;
        if value.prompt.trim().is_empty()
            || value.prompt.len() > MAX_PROMPT
            || value.request_id.is_empty()
            || value.request_id.len() > 64
            || !value
                .request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
        {
            return Err("Prompt must contain 1–65536 bytes; request_id must contain 1–64 letters, numbers, - or _".into());
        }
        Ok(value)
    }
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct StatusArgs {
    #[serde(default)]
    pub cursor: u64,
    #[serde(default)]
    pub max_events: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}

/// Only these typed server requests can reach the local approval UI.
pub fn approval_response(method: &str, params: &Value, decision: &str) -> Result<Value, String> {
    if !matches!(
        decision,
        "accept" | "acceptForSession" | "decline" | "cancel"
    ) {
        return Err("Unsupported local approval decision".into());
    }
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Ok(json!({"decision": decision}))
        }
        "item/permissions/requestApproval" => {
            let permissions = if matches!(decision, "accept" | "acceptForSession") {
                let requested = params["permissions"]
                    .as_object()
                    .ok_or("Malformed permission request")?;
                let mut granted = serde_json::Map::new();
                for key in ["network", "fileSystem"] {
                    if let Some(v) = requested.get(key) {
                        granted.insert(key.into(), v.clone());
                    }
                }
                Value::Object(granted)
            } else {
                json!({})
            };
            Ok(
                json!({"permissions":permissions, "scope": if decision == "acceptForSession" { "session" } else { "turn" }}),
            )
        }
        _ => Err("Unsupported native server request; not authorized".into()),
    }
}

#[derive(Default)]
pub struct EventBuffer {
    events: VecDeque<Value>,
    bytes: usize,
    next: u64,
}
impl EventBuffer {
    pub fn push(&mut self, method: &str, text: &str) {
        self.next += 1;
        let mut end = text.len().min(16 * 1024);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let event = json!({"cursor":self.next,"method":method,"text":&text[..end],"truncated":end<text.len()});
        self.bytes += event.to_string().len();
        self.events.push_back(event);
        while self.bytes > MAX_EVENT_BYTES || self.events.len() > MAX_EVENTS {
            if let Some(v) = self.events.pop_front() {
                self.bytes -= v.to_string().len();
            }
        }
    }
    pub fn page(&self, cursor: u64, limit: usize) -> Value {
        let mut size = 0;
        let events: Vec<Value> = self
            .events
            .iter()
            .filter(|e| e["cursor"].as_u64().unwrap_or(0) > cursor)
            .take(limit.clamp(1, 32))
            .take_while(|e| {
                size += e.to_string().len();
                size <= 64 * 1024
            })
            .cloned()
            .collect();
        let next = events
            .last()
            .and_then(|e| e["cursor"].as_u64())
            .unwrap_or(cursor);
        json!({"events":events,"next_cursor":next,"has_more":next<self.next,
            "history_truncated": self.events.front().and_then(|e|e["cursor"].as_u64()).is_some_and(|first|cursor.saturating_add(1)<first)})
    }
}
