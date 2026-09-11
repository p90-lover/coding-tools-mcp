//! Local-only consent for an offline Windows AppContainer snapshot executor.
//! This is not the Codex agent or its complete Windows sandbox implementation.
use crate::{
    data::{AppData, DataStore},
    error::{AppError, AppResult},
    tools::{
        workspace::{tool_ok, WorkspaceError},
        ToolContext,
    },
    workspace::WorkspaceProfile,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
#[path = "sandbox_process.rs"]
mod process;
#[path = "sandbox_runner.rs"]
mod runner;
#[path = "sandbox_snapshot.rs"]
mod snapshot;
pub const NAMES: &[&str] = &["sandbox_status", "sandbox_exec"];
pub const RELEASE_STATUS: &str = "experimental_snapshot_appcontainer";
pub const BACKEND: &str = "windows-appcontainer-v1";
static EPOCH: AtomicU64 = AtomicU64::new(0);
static BLOCKED: AtomicBool = AtomicBool::new(false);
static AUTHORITY: Mutex<()> = Mutex::new(());
static EXECUTION: Mutex<()> = Mutex::new(());
#[cfg(all(windows, feature = "native-snapshot"))]
static HELPER: &[u8] = include_bytes!(env!("CODING_TOOLS_SNAPSHOT_HELPER"));
#[cfg(not(all(windows, feature = "native-snapshot")))]
static HELPER: &[u8] = &[];
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxGrant {
    pub workspace_id: String,
    pub root: PathBuf,
    pub configuration: String,
    pub enabled: bool,
    pub helper_sha256: String,
}
fn err(s: impl Into<String>) -> AppError {
    AppError::Message(s.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn config(p: &WorkspaceProfile) -> String {
    digest(json!({"backend":BACKEND,"id":p.id,"root":p.path,"auth":p.auth,"runtime":p.runtime,"actions":p.actions}).to_string().as_bytes())
}
pub fn initialize(_resources: PathBuf) {} // Helper is embedded in the verified application bytes.
pub fn available() -> bool {
    cfg!(windows) && !HELPER.is_empty()
}
fn home() -> AppResult<PathBuf> {
    #[cfg(test)]
    {
        Ok(std::env::current_dir()?.join("aiTemp/sandbox-test-store"))
    }
    #[cfg(not(test))]
    {
        Ok(crate::platform::platform()
            .app_config_dir()?
            .join("aiTemp/sandbox-snapshots"))
    }
}
fn grant_matches(data: &AppData, id: &str, root: &Path) -> bool {
    let Some(profile) = data.profiles.iter().find(|p| p.id == id) else {
        return false;
    };
    data.sandbox_permissions.iter().any(|g| {
        g.enabled
            && g.workspace_id == id
            && g.root == root
            && !g.helper_sha256.is_empty()
            && g.helper_sha256 == digest(HELPER)
            && g.configuration == config(profile)
            && Path::new(&profile.path).canonicalize().ok().as_deref() == Some(root)
            && matches!(profile.auth.auth_type.as_str(), "bearer" | "oauth")
    })
}
fn permitted(id: &str, root: &Path) -> AppResult<bool> {
    if !available() || BLOCKED.load(Ordering::SeqCst) {
        return Ok(false);
    }
    DataStore::read_file(|d| Ok(grant_matches(d, id, root)))
}
/// Stop first in memory, then suspend all remembered snapshot grants. A failed
/// save remains blocked in this process. Setup requires fresh visible local consent.
pub fn cancel_active() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
    BLOCKED.store(true, Ordering::SeqCst);
    let Ok(_guard) = AUTHORITY.lock() else {
        return;
    };
    if DataStore::update_file(|d| {
        for g in &mut d.sandbox_permissions {
            g.enabled = false;
        }
        Ok(())
    })
    .is_err()
    {
        eprintln!("Sandbox revocation could not be saved; execution remains blocked until fresh local approval");
    }
}
pub fn local_disable(_id: &str) -> AppResult<()> {
    cancel_active();
    DataStore::read_file(|d| {
        if d.sandbox_permissions.iter().any(|g| g.enabled) {
            Err(err("Stopped in memory; could not persist revocation. Do not restart until settings storage is repaired."))
        } else {
            Ok(())
        }
    })
}
pub fn local_setup(profile: WorkspaceProfile, root: PathBuf) -> AppResult<Value> {
    if !available() {
        return Err(err(
            "This platform/build does not include the snapshot helper; no fallback",
        ));
    }
    if !matches!(profile.auth.auth_type.as_str(), "bearer" | "oauth") {
        return Err(err("Authenticated MCP is required"));
    }
    let root = root.canonicalize()?;
    snapshot::safe_path(&root)?;
    if crate::tools::policy::PolicySettings::from_runtime(&profile.runtime)
        .canonical_permission_mode()
        == "read-only"
    {
        return Err(err("Read-only workspace cannot enable scratch execution"));
    }
    let epoch = EPOCH.load(Ordering::SeqCst);
    let _guard = AUTHORITY
        .lock()
        .map_err(|_| err("Sandbox authority is unavailable"))?;
    let configuration = config(&profile);
    DataStore::update_file(|d| {
        let p = d
            .profiles
            .iter()
            .find(|p| p.id == profile.id)
            .ok_or_else(|| err("Workspace disappeared"))?;
        if config(p) != configuration
            || Path::new(&p.path).canonicalize()? != root
            || epoch != EPOCH.load(Ordering::SeqCst)
        {
            return Err(err(
                "Workspace or permissions changed during local approval",
            ));
        }
        let grant = SandboxGrant {
            workspace_id: profile.id.clone(),
            root: root.clone(),
            configuration,
            enabled: true,
            helper_sha256: digest(HELPER),
        };
        if let Some(g) = d
            .sandbox_permissions
            .iter_mut()
            .find(|g| g.workspace_id == profile.id)
        {
            *g = grant;
        } else {
            if d.sandbox_permissions.len() >= 32 {
                return Err(err("Sandbox grant limit reached"));
            }
            d.sandbox_permissions.push(grant);
        }
        Ok(())
    })?;
    BLOCKED.store(false, Ordering::SeqCst);
    if epoch != EPOCH.load(Ordering::SeqCst) {
        BLOCKED.store(true, Ordering::SeqCst);
        return Err(err("Stop cancelled approval"));
    }
    drop(_guard);
    local_status_for(&profile.id, &root)
}
pub fn local_status_for(id: &str, root: &Path) -> AppResult<Value> {
    Ok(
        json!({"available":available(),"enabled_for_workspace":permitted(id,root)?,"release_status":RELEASE_STATUS,
        "backend":BACKEND,"helper_sha256":if available(){Some(digest(HELPER))}else{None},"model_calls":false,
        "native_sandbox_verified":false,"verification_scope":"Every launched child token is checked; this status call launches nothing",
        "filesystem":"explicit read-only input copies; separate writable scratch; no host-workspace edits",
        "network":"disabled; no network capabilities or loopback exemption","setup_requires_local_consent":true,
        "administrator_setup_required":false,"persistent_grant_scope":"workspace ID, canonical path, auth/policy and helper hash",
        "stop_scope":"one active sandbox job; Stop or permission changes suspend all snapshot grants",
        "scope":"Only sandbox_exec. Other command tools and GUI control are not sandboxed by this executor",
        "storage":"retained under application aiTemp; no automatic cleanup or import","max_input_bytes":16777216,
        "max_retained_runs":32,"direct_workspace_write":false,"arbitrary_program_compatibility":false,"windows_boundary":"AppContainer; OS/package-readable locations are not blanket-denied; not the full Codex Windows sandbox"}),
    )
}
// Compatibility entry point: never borrow another workspace's same-path authority.
pub fn local_status(root: &Path) -> AppResult<Value> {
    let ids = DataStore::read_file(|d| {
        Ok(d.profiles
            .iter()
            .filter(|p| Path::new(&p.path).canonicalize().ok().as_deref() == Some(root))
            .map(|p| p.id.clone())
            .collect::<Vec<_>>())
    })?;
    local_status_for(if ids.len() == 1 { &ids[0] } else { "" }, root)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    argv: Vec<String>,
    #[serde(default)]
    input_files: Vec<String>,
    #[serde(default = "timeout")]
    timeout_ms: u64,
}
fn timeout() -> u64 {
    15000
}
pub fn input(name: &str) -> Value {
    if name == "sandbox_status" {
        return json!({"type":"object","properties":{},"additionalProperties":false});
    }
    json!({"type":"object","properties":{
        "argv":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","maxLength":8192},"description":"Absolute Windows system EXE or selected input EXE relative path, followed by literal arguments. Use MCP_SANDBOX_INPUT/OUTPUT environment variables inside the program."},
        "input_files":{"type":"array","maxItems":64,"uniqueItems":true,"items":{"type":"string","maxLength":240},"description":"Explicit relative regular files only; no symlinks, hidden/credential paths, directories or linked projects; 16 MiB total. Nothing is copied by default."},
        "timeout_ms":{"type":"integer","minimum":100,"maximum":30000,"default":15000},
        "confirm":{"type":"boolean"},"approval_token":{"type":"string"}},"required":["argv"],"additionalProperties":false})
}
pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, WorkspaceError> {
    let result = (|| -> AppResult<Value> {
        if !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth") {
            return Err(err("Authenticated MCP is required"));
        }
        let id = ctx
            .workspace_id
            .as_deref()
            .ok_or_else(|| err("Workspace-bound context is required"))?;
        let mut args = args
            .as_object()
            .ok_or_else(|| err("Arguments must be an object"))?
            .clone();
        if name == "sandbox_status" && args.is_empty() {
            return local_status_for(id, ctx.workspace.root());
        }
        if name != "sandbox_exec" {
            return Err(err("Unknown sandbox operation"));
        }
        args.remove("confirm");
        args.remove("approval_token"); // Already handled by the shared approval store.
        let request: Request = serde_json::from_value(Value::Object(args))?;
        if request.argv.is_empty()
            || request.argv.len() > 32
            || request
                .argv
                .iter()
                .any(|a| a.len() > 8192 || a.contains('\0'))
            || !(100..=30000).contains(&request.timeout_ms)
        {
            return Err(err("Request exceeds sandbox limits"));
        }
        if ctx.policy.canonical_permission_mode() == "read-only" {
            return Err(err("Read-only policy does not permit scratch execution"));
        }
        if !permitted(id, ctx.workspace.root())? {
            return Err(err(
                "Approve this workspace locally; old, revoked or changed grants cannot execute",
            ));
        }
        let _execution = EXECUTION
            .try_lock()
            .map_err(|_| err("A sandbox job is already running; nothing queued"))?;
        let epoch = EPOCH.load(Ordering::SeqCst);
        let run = snapshot::prepare(ctx.workspace.root(), &home()?, &request.input_files)?;
        let executable = snapshot::executable(&request.argv[0], &run.input)?;
        let value = runner::run(
            ctx,
            id,
            epoch,
            &run,
            &executable,
            &request.argv[1..],
            request.timeout_ms,
        )?;
        Ok(value)
    })();
    result.map(tool_ok).map_err(|e| WorkspaceError::Tool {
        code: "NATIVE_SANDBOX_REJECTED",
        message: e.to_string(),
        category: "sandbox",
        retryable: false,
    })
}
#[cfg(test)]
#[path = "../../../aiTemp/sandbox-permissions/contract.rs"]
mod tests;

#[cfg(test)]
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../aiTemp/reliability/snapshot_contract.rs"
));
