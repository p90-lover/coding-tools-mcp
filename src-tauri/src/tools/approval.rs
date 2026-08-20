use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::tools::workspace::WorkspaceError;

const PENDING_TTL: Duration = Duration::from_secs(5 * 60);
const ONCE_GRANT_TTL: Duration = Duration::from_secs(5 * 60);
const SESSION_GRANT_TTL: Duration = Duration::from_secs(30 * 60);
const SESSION_GRANT_USES: u16 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalMode {
    Ask,
    AutoWorkspace,
    Never,
}

impl ApprovalMode {
    pub fn parse(value: &str) -> Self {
        match value {
            "ask" => Self::Ask,
            "never" => Self::Never,
            _ => Self::AutoWorkspace,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AutoWorkspace => "auto-workspace",
            Self::Never => "never",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalRisk {
    RoutineMutation,
    Network,
    Destructive,
    InterpreterMutation,
    Elevation,
}

impl ApprovalRisk {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RoutineMutation => "routine_mutation",
            Self::Network => "network",
            Self::Destructive => "destructive",
            Self::InterpreterMutation => "interpreter_mutation",
            Self::Elevation => "elevation",
        }
    }

    fn summary(self, tool_name: &str) -> String {
        match self {
            Self::RoutineMutation => format!("Allow one workspace-scoped {tool_name} operation"),
            Self::Network => "Allow a command that may contact the network".into(),
            Self::Destructive => "Allow a destructive command or file-removal patch".into(),
            Self::InterpreterMutation => {
                "Allow interpreter-driven file mutation inside the approved workspace".into()
            }
            Self::Elevation => "Allow an operating-system elevation request".into(),
        }
    }

    fn is_routine(self) -> bool {
        self == Self::RoutineMutation
    }
}

#[derive(Debug, Clone)]
struct PendingApproval {
    tool_name: String,
    fingerprint: String,
    risk: ApprovalRisk,
    summary: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct ApprovalGrant {
    tool_name: String,
    fingerprint: String,
    expires_at: Instant,
    remaining_uses: u16,
}

#[derive(Debug)]
pub struct ApprovalFailure {
    code: &'static str,
    message: String,
    details: Value,
}

impl ApprovalFailure {
    fn required(request_id: String, pending: &PendingApproval, mode: ApprovalMode) -> Self {
        Self {
            code: "APPROVAL_REQUIRED",
            message: "This operation requires a scoped approval grant.".into(),
            details: json!({
                "stage": "approval",
                "reason": "approval_required",
                "request_id": request_id,
                "approval_mode": mode.as_str(),
                "tool": pending.tool_name,
                "risk": pending.risk.as_str(),
                "summary": pending.summary,
                "expires_in_seconds": PENDING_TTL.as_secs(),
                "recoverable": true,
                "suggestion": "Call request_permissions with this request_id, then retry with the returned approval_token"
            }),
        }
    }

    fn denied(risk: ApprovalRisk, mode: ApprovalMode) -> Self {
        Self {
            code: "APPROVAL_DENIED",
            message: "Approval mode is set to never for this sensitive operation.".into(),
            details: json!({
                "stage": "approval",
                "reason": "approval_disabled",
                "approval_mode": mode.as_str(),
                "risk": risk.as_str(),
                "recoverable": false,
                "suggestion": "Change Approval mode to Ask or Auto approve workspace operations"
            }),
        }
    }

    fn invalid(message: impl Into<String>, reason: &'static str) -> Self {
        Self {
            code: "INVALID_APPROVAL",
            message: message.into(),
            details: json!({
                "stage": "approval",
                "reason": reason,
                "recoverable": true
            }),
        }
    }

    pub fn into_workspace_error(self) -> WorkspaceError {
        WorkspaceError::ToolDetails {
            code: self.code,
            message: self.message,
            category: "permission",
            retryable: self.code == "APPROVAL_REQUIRED" || self.code == "INVALID_APPROVAL",
            details: self.details,
        }
    }
}

#[derive(Default)]
pub struct ApprovalStore {
    pending: Mutex<HashMap<String, PendingApproval>>,
    grants: Mutex<HashMap<String, ApprovalGrant>>,
}

impl ApprovalStore {
    pub fn preflight(
        &self,
        tool_name: &str,
        args: &mut Value,
        approval_mode: &str,
        permission_mode: &str,
    ) -> Result<(), ApprovalFailure> {
        let Some(risk) = classify_operation(tool_name, args) else {
            return Ok(());
        };
        let fingerprint = operation_fingerprint(tool_name, args);

        if self.consume_grant(args, tool_name, &fingerprint)? {
            set_confirmed(args);
            return Ok(());
        }

        // Dangerous mode skips only this soft approval layer. The normal policy
        // still executes afterwards and keeps protected paths, host scope, and
        // elevation requests blocked.
        if permission_mode == "dangerous" {
            set_confirmed(args);
            return Ok(());
        }

        let mode = ApprovalMode::parse(approval_mode);
        if mode == ApprovalMode::AutoWorkspace && risk.is_routine() {
            return Ok(());
        }
        if mode == ApprovalMode::Never {
            return Err(ApprovalFailure::denied(risk, mode));
        }

        self.prune_expired();
        let request_id = uuid::Uuid::new_v4().to_string();
        let pending = PendingApproval {
            tool_name: tool_name.to_string(),
            fingerprint,
            risk,
            summary: risk.summary(tool_name),
            expires_at: Instant::now() + PENDING_TTL,
        };
        self.pending
            .lock()
            .expect("approval pending lock")
            .insert(request_id.clone(), pending.clone());
        Err(ApprovalFailure::required(request_id, &pending, mode))
    }

    pub fn grant(
        &self,
        request_id: &str,
        scope: &str,
        confirmed: bool,
    ) -> Result<Value, ApprovalFailure> {
        if !confirmed {
            return Err(ApprovalFailure::invalid(
                "request_permissions requires confirm=true",
                "confirmation_missing",
            ));
        }
        self.prune_expired();
        let pending = self
            .pending
            .lock()
            .expect("approval pending lock")
            .remove(request_id)
            .ok_or_else(|| {
                ApprovalFailure::invalid(
                    "Approval request was not found or has expired",
                    "request_missing",
                )
            })?;
        if pending.expires_at <= Instant::now() {
            return Err(ApprovalFailure::invalid(
                "Approval request has expired",
                "request_expired",
            ));
        }

        let (remaining_uses, ttl, normalized_scope) = match scope {
            "session" => (SESSION_GRANT_USES, SESSION_GRANT_TTL, "session"),
            "once" | "" => (1, ONCE_GRANT_TTL, "once"),
            _ => {
                return Err(ApprovalFailure::invalid(
                    "scope must be once or session",
                    "invalid_scope",
                ))
            }
        };
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.grants.lock().expect("approval grants lock").insert(
            token.clone(),
            ApprovalGrant {
                tool_name: pending.tool_name.clone(),
                fingerprint: pending.fingerprint,
                expires_at: Instant::now() + ttl,
                remaining_uses,
            },
        );
        Ok(json!({
            "ok": true,
            "status": "granted",
            "request_id": request_id,
            "approval_token": token,
            "scope": normalized_scope,
            "tool": pending.tool_name,
            "risk": pending.risk.as_str(),
            "summary": pending.summary,
            "expires_in_seconds": ttl.as_secs(),
            "remaining_uses": remaining_uses
        }))
    }

    fn consume_grant(
        &self,
        args: &Value,
        tool_name: &str,
        fingerprint: &str,
    ) -> Result<bool, ApprovalFailure> {
        let Some(token) = args.get("approval_token").and_then(Value::as_str) else {
            return Ok(false);
        };
        let now = Instant::now();
        let mut grants = self.grants.lock().expect("approval grants lock");
        let Some(grant) = grants.get_mut(token) else {
            return Err(ApprovalFailure::invalid(
                "Approval token is unknown or already consumed",
                "grant_missing",
            ));
        };
        if grant.expires_at <= now {
            grants.remove(token);
            return Err(ApprovalFailure::invalid(
                "Approval token has expired",
                "grant_expired",
            ));
        }
        if grant.tool_name != tool_name || grant.fingerprint != fingerprint {
            return Err(ApprovalFailure::invalid(
                "Approval token does not match this operation",
                "grant_mismatch",
            ));
        }
        grant.remaining_uses = grant.remaining_uses.saturating_sub(1);
        if grant.remaining_uses == 0 {
            grants.remove(token);
        }
        Ok(true)
    }

    fn prune_expired(&self) {
        let now = Instant::now();
        self.pending
            .lock()
            .expect("approval pending lock")
            .retain(|_, pending| pending.expires_at > now);
        self.grants
            .lock()
            .expect("approval grants lock")
            .retain(|_, grant| grant.expires_at > now && grant.remaining_uses > 0);
    }
}

fn set_confirmed(args: &mut Value) {
    if !args.is_object() {
        *args = json!({});
    }
    args["confirm"] = Value::Bool(true);
}

fn classify_operation(tool_name: &str, args: &Value) -> Option<ApprovalRisk> {
    match tool_name {
        "exec_command" => {
            let command = args.get("cmd").and_then(Value::as_str).unwrap_or("");
            Some(classify_command(command))
        }
        "apply_patch" => {
            let patch = args.get("patch").and_then(Value::as_str).unwrap_or("");
            if patch.contains("*** Delete File:")
                || patch.contains("+++ /dev/null")
                || patch.contains("--- /dev/null")
            {
                Some(ApprovalRisk::Destructive)
            } else {
                Some(ApprovalRisk::RoutineMutation)
            }
        }
        "kill_command" | "kill_session" | "write_stdin" => {
            Some(ApprovalRisk::RoutineMutation)
        }
        _ => None,
    }
}

pub fn classify_command(command: &str) -> ApprovalRisk {
    let normalized = command.to_ascii_lowercase();
    let elevation = normalized.contains("sudo ")
        || normalized.starts_with("sudo")
        || normalized.contains(" doas ")
        || normalized.starts_with("doas ")
        || normalized.contains("pkexec")
        || normalized.contains("runas ")
        || (normalized.contains("start-process") && normalized.contains("-verb runas"));
    if elevation {
        return ApprovalRisk::Elevation;
    }

    let destructive = normalized.contains("git reset --hard")
        || (normalized.contains("git clean ") && normalized.contains('f'))
        || normalized.contains("git checkout -- .")
        || normalized.contains("rm -rf")
        || normalized.contains("rm -fr")
        || (normalized.contains("remove-item") && normalized.contains("-recurse"))
        || normalized.contains("rmdir /s")
        || normalized.contains("del /s");
    if destructive {
        return ApprovalRisk::Destructive;
    }

    let network = normalized.contains("http://")
        || normalized.contains("https://")
        || normalized.contains("curl ")
        || normalized.starts_with("curl")
        || normalized.contains("wget ")
        || normalized.starts_with("wget")
        || normalized.contains("invoke-webrequest")
        || normalized.contains("invoke-restmethod")
        || normalized.contains(" ssh ")
        || normalized.starts_with("ssh ")
        || normalized.contains(" scp ")
        || normalized.starts_with("scp ")
        || normalized.contains("npm install")
        || normalized.contains("npm add")
        || normalized.contains("pnpm add")
        || normalized.contains("yarn add")
        || normalized.contains("cargo install")
        || normalized.contains("go install")
        || normalized.contains("pip install");
    if network {
        return ApprovalRisk::Network;
    }

    let interpreter_mutation = normalized.contains("write_text")
        || normalized.contains("write_bytes")
        || normalized.contains("writefile")
        || normalized.contains("set-content")
        || normalized.contains("out-file")
        || normalized.contains("new-item")
        || normalized.contains("shutil.rmtree")
        || normalized.contains("os.remove")
        || normalized.contains("os.unlink");
    if interpreter_mutation {
        return ApprovalRisk::InterpreterMutation;
    }

    ApprovalRisk::RoutineMutation
}

fn operation_fingerprint(tool_name: &str, args: &Value) -> String {
    let mut canonical = args.clone();
    if let Some(object) = canonical.as_object_mut() {
        object.remove("approval_token");
        object.remove("confirm");
    }
    let mut hasher = Sha256::new();
    hasher.update(tool_name.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(&canonical).unwrap_or_default());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_workspace_allows_routine_command() {
        let store = ApprovalStore::default();
        let mut args = json!({"cmd": "cargo test"});
        store
            .preflight("exec_command", &mut args, "auto-workspace", "trusted")
            .expect("routine command");
        assert!(args.get("confirm").is_none());
    }

    #[test]
    fn ask_mode_requires_approval_for_routine_command() {
        let store = ApprovalStore::default();
        let mut args = json!({"cmd": "cargo test"});
        let error = store
            .preflight("exec_command", &mut args, "ask", "trusted")
            .expect_err("approval required");
        assert_eq!(error.code, "APPROVAL_REQUIRED");
        assert!(error.details["request_id"].as_str().is_some());
    }

    #[test]
    fn network_command_uses_scoped_one_time_grant() {
        let store = ApprovalStore::default();
        let mut args = json!({"cmd": "curl https://example.com"});
        let error = store
            .preflight("exec_command", &mut args, "auto-workspace", "trusted")
            .expect_err("approval required");
        let request_id = error.details["request_id"].as_str().unwrap();
        let granted = store.grant(request_id, "once", true).expect("grant");
        args["approval_token"] = granted["approval_token"].clone();
        store
            .preflight("exec_command", &mut args, "auto-workspace", "trusted")
            .expect("approved command");
        assert_eq!(args["confirm"], true);
        assert!(store
            .preflight("exec_command", &mut args, "auto-workspace", "trusted")
            .is_err());
    }

    #[test]
    fn grant_cannot_be_reused_for_different_arguments() {
        let store = ApprovalStore::default();
        let mut args = json!({"cmd": "curl https://example.com/a"});
        let error = store
            .preflight("exec_command", &mut args, "auto-workspace", "trusted")
            .expect_err("approval required");
        let granted = store
            .grant(error.details["request_id"].as_str().unwrap(), "once", true)
            .expect("grant");
        let mut changed = json!({
            "cmd": "curl https://example.com/b",
            "approval_token": granted["approval_token"]
        });
        let mismatch = store
            .preflight(
                "exec_command",
                &mut changed,
                "auto-workspace",
                "trusted",
            )
            .expect_err("mismatch");
        assert_eq!(mismatch.code, "INVALID_APPROVAL");
    }

    #[test]
    fn never_mode_denies_sensitive_commands_without_creating_grant() {
        let store = ApprovalStore::default();
        let mut args = json!({"cmd": "curl https://example.com"});
        let error = store
            .preflight("exec_command", &mut args, "never", "trusted")
            .expect_err("denied");
        assert_eq!(error.code, "APPROVAL_DENIED");
    }

    #[test]
    fn classifier_recognizes_elevation_and_file_deletion() {
        assert_eq!(
            classify_command("powershell Start-Process cmd -Verb RunAs"),
            ApprovalRisk::Elevation
        );
        assert_eq!(classify_command("rm -rf build"), ApprovalRisk::Destructive);
    }
}
