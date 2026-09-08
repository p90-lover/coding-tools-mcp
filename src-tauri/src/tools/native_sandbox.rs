//! Release boundary: the unverified native command backend is not compiled here.
//! Its original source is preserved in native_sandbox_prototype.rs for review.
//! Windows computer-control/vision tools are independent and remain available.
use crate::{
    data::DataStore,
    error::{AppError, AppResult},
    tools::{workspace::{tool_ok, WorkspaceError}, ToolContext},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const NAMES: &[&str] = &["sandbox_status", "sandbox_exec"];
pub const UPSTREAM: &str = "3caf9f9586baedb4158a7b91545ead3dd320c348";
pub const RELEASE_STATUS: &str = "withheld_pending_native_verification";
const REASON: &str = "The native command sandbox is not included in this release because its Windows runtime/isolation verification has not passed. No helper, elevation, or unsandboxed fallback will run. Computer control and vision are separate features.";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxGrant {
    pub workspace_id: String,
    pub root: PathBuf,
    pub configuration: String,
    pub enabled: bool,
}
// Compatibility entry points do not open files, start processes, or provision OS accounts.
pub fn initialize(_directory: PathBuf) {}
pub fn cancel_active() {}
pub fn local_setup(_profile: crate::workspace::WorkspaceProfile, _root: PathBuf) -> AppResult<Value> {
    Err(AppError::Message(REASON.into()))
}
pub fn local_status(_root: &Path) -> AppResult<Value> {
    Ok(json!({"available":false,"enabled_for_workspace":false,"native_sandbox_verified":false,
        "release_status":RELEASE_STATUS,"reason":REASON,"upstream_commit":UPSTREAM,
        "filesystem":null,"network":null,"setup_requires_local_consent":true,"model_calls":false,
        "scope":"Native command sandbox withheld; existing GUI and command permissions are not an OS sandbox"}))
}
pub fn local_disable(id: &str) -> AppResult<()> {
    // Preserve old settings/accounts/files; only revoke an existing stored grant.
    DataStore::update_file(|data| {
        for grant in &mut data.sandbox_permissions {
            if grant.workspace_id == id { grant.enabled = false; }
        }
        Ok(())
    })
}
pub fn input(name: &str) -> Value {
    if name == "sandbox_status" {
        return json!({"type":"object","properties":{},"additionalProperties":false});
    }
    json!({"type":"object","description":"Unavailable in this release; always rejects without executing.",
        "properties":{"argv":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","maxLength":8192}},
        "timeout_ms":{"type":"integer","minimum":100,"maximum":30000,"default":15000}},
        "required":["argv"],"additionalProperties":false})
}
pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, WorkspaceError> {
    let result = (|| -> AppResult<Value> {
        if !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth") {
            return Err(AppError::Message("Sandbox status requires authenticated MCP".into()));
        }
        let object = args.as_object().ok_or_else(|| AppError::Message("Arguments must be an object".into()))?;
        if name == "sandbox_status" && object.is_empty() {
            return local_status(ctx.workspace.root());
        }
        Err(AppError::Message(REASON.into()))
    })();
    result.map(tool_ok).map_err(|e| WorkspaceError::Tool {
        code:"NATIVE_SANDBOX_NOT_RELEASED",message:e.to_string(),category:"sandbox",retryable:false,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sandbox_release_rejects_without_helpers_or_filesystem_access() {
        assert!(option_env!("CODING_TOOLS_SANDBOX_MANIFEST_SHA256").is_none(),
            "A withheld backend must never be built with a helper manifest");
        let status = local_status(Path::new("path-that-is-not-opened")).unwrap();
        assert_eq!(status["available"], false);
        assert_eq!(status["enabled_for_workspace"], false);
        assert_eq!(status["native_sandbox_verified"], false);
        assert_eq!(status["release_status"], RELEASE_STATUS);
        assert_eq!(status["model_calls"], false);
        assert_eq!(NAMES, ["sandbox_status", "sandbox_exec"]);
        let schema = input("sandbox_exec");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"].as_object().unwrap().len(), 2);
    }
}
