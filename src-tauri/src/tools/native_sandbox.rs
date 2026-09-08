//! Pinned sandbox-only native helper. This never invokes the Codex CLI or inference.
use crate::{
    data::DataStore,
    error::{AppError, AppResult},
    tools::{
        workspace::{tool_ok, WorkspaceError},
        ToolContext,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

pub const NAMES: &[&str] = &["sandbox_status", "sandbox_exec"];
pub const UPSTREAM: &str = "3caf9f9586baedb4158a7b91545ead3dd320c348";
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
static GATE: Mutex<()> = Mutex::new(());
static CANCEL: AtomicU64 = AtomicU64::new(0);
static PIPE_FAILED: AtomicBool = AtomicBool::new(false);
#[path = "sandbox_process.rs"]
mod sandbox_process;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxGrant {
    pub workspace_id: String,
    pub root: PathBuf,
    pub configuration: String,
    pub enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperManifest {
    upstream_commit: String,
    files: std::collections::BTreeMap<String, String>,
}
fn err(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}
pub fn initialize(directory: PathBuf) {
    let _ = RESOURCES.set(directory.join("native-sandbox"));
}
pub fn cancel_active() {
    CANCEL.fetch_add(1, Ordering::SeqCst);
}
fn home() -> AppResult<PathBuf> {
    Ok(crate::platform::platform()
        .app_config_dir()?
        .join("data/native-sandbox"))
}
fn digest_file(file: &mut std::fs::File) -> AppResult<String> {
    let m = file.metadata()?;
    if !m.is_file() || m.len() > 150_000_000 {
        return Err(err("Sandbox helper exceeds size limit"));
    }
    let mut h = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = file.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn verified_helpers() -> AppResult<(PathBuf, Vec<std::fs::File>)> {
    if !cfg!(target_os = "windows") {
        return Err(err("The upstream native sandbox backend is Windows-only"));
    }
    let expected = option_env!("CODING_TOOLS_SANDBOX_MANIFEST_SHA256")
        .filter(|s| s.len() == 64)
        .ok_or_else(|| err("This build does not contain verified sandbox helpers"))?;
    let root = RESOURCES
        .get()
        .ok_or_else(|| err("Sandbox resource directory is unavailable"))?
        .canonicalize()?;
    let m = root.join("manifest.json");
    if std::fs::symlink_metadata(&m)?.len() > 8192 {
        return Err(err("Sandbox manifest exceeds limit"));
    }
    let bytes = std::fs::read(m)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(err("Sandbox manifest differs from the compiled release"));
    }
    let manifest: HelperManifest = serde_json::from_slice(&bytes)?;
    if manifest.upstream_commit != UPSTREAM || manifest.files.len() != 3 {
        return Err(err("Unexpected sandbox helper source"));
    }
    let mut handles = Vec::new();
    for name in [
        "coding-tools-codex-sandbox.exe",
        "codex-command-runner.exe",
        "codex-windows-sandbox-setup.exe",
    ] {
        let expected = manifest
            .files
            .get(name)
            .ok_or_else(|| err("Missing sandbox helper digest"))?;
        let p = root.join(name);
        if p.canonicalize()?.parent() != Some(root.as_path())
            || std::fs::symlink_metadata(&p)?.file_type().is_symlink()
        {
            return Err(err("Sandbox helper path escaped its resource directory"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut file = options.open(&p)?;
        if &digest_file(&mut file)? != expected {
            return Err(err(
                "Sandbox executable digest mismatch; no fallback was attempted",
            ));
        }
        handles.push(file);
    }
    Ok((root.join("coding-tools-codex-sandbox.exe"), handles))
}
fn read_bounded<R: Read>(mut reader: R, limit: usize, overflow: &AtomicBool) -> Vec<u8> {
    let mut output = Vec::new();
    let mut b = [0u8; 8192];
    while let Ok(n) = reader.read(&mut b) {
        if n == 0 {
            break;
        }
        let keep = n.min(limit.saturating_sub(output.len()));
        output.extend_from_slice(&b[..keep]);
        if keep < n {
            overflow.store(true, Ordering::SeqCst);
        }
    }
    output
}
fn invoke_helper(
    root: &Path,
    operation: &str,
    argv: &[String],
    timeout_ms: u64,
) -> AppResult<Value> {
    if PIPE_FAILED.load(Ordering::SeqCst) {
        return Err(err(
            "A prior sandbox output pipe did not close; restart the application before retrying",
        ));
    }
    let _permit = GATE
        .try_lock()
        .map_err(|_| err("Another sandbox operation is still running; no work queued"))?;
    let epoch = CANCEL.load(Ordering::SeqCst);
    if operation == "exec" && !enabled_for(root)? {
        return Err(err("Native sandbox permission is no longer enabled"));
    }
    let (executable, _verified_handles) = verified_helpers()?;
    let home = home()?;
    if operation == "setup" {
        std::fs::create_dir_all(home.join("aiTemp"))?;
    }
    if !home.is_dir() {
        return Err(err(
            "Prepare the OS sandbox in the local workspace UI first",
        ));
    }
    let home = home.canonicalize()?;
    let root = root.canonicalize()?;
    if home.starts_with(&root) || root.starts_with(&home) {
        return Err(err("Sandbox state must be outside the selected workspace"));
    }
    let request = json!({"operation":operation,"workspace":root,"home":home,"argv":argv,"timeout_ms":timeout_ms});
    let data = serde_json::to_vec(&request)?;
    if data.len() > 32768 {
        return Err(err("Sandbox input exceeds 32 KiB"));
    }
    let mut cmd = Command::new(executable);
    cmd.env_clear()
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in [
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "USERNAME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    // No API tokens, proxy, agent settings, inherited CODEX_HOME or automatic telemetry.
    cmd.env("CODEX_HOME", &home)
        .env("TEMP", home.join("aiTemp"))
        .env("TMP", home.join("aiTemp"))
        .env("OTEL_SDK_DISABLED", "true")
        .env("DO_NOT_TRACK", "1");
    if operation == "setup" {
        cmd.env("CODING_TOOLS_LOCAL_SANDBOX_SETUP", "1");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| err("Verified sandbox helper could not start"))?;
    let job = match sandbox_process::assign(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    if CANCEL.load(Ordering::SeqCst) != epoch {
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
        return Err(err("Sandbox start cancelled"));
    }
    if let Err(e) = child
        .stdin
        .take()
        .ok_or_else(|| err("Helper stdin unavailable"))?
        .write_all(&data)
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e.into());
    }
    let overflow = std::sync::Arc::new(AtomicBool::new(false));
    let flag = overflow.clone();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| err("Helper output unavailable"))?;
    let (out_tx, out_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = out_tx.send(read_bounded(stdout, 4_194_304, &flag));
    });
    let flag = overflow.clone();
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| err("Helper diagnostics unavailable"))?;
    let (err_tx, err_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = err_tx.send(read_bounded(stderr, 65536, &flag));
    });
    let deadline = Instant::now()
        + Duration::from_millis(if operation == "setup" {
            180_000
        } else {
            timeout_ms + 60_000
        });
    let cancelled = loop {
        if child.try_wait()?.is_some() {
            break false;
        }
        if Instant::now() >= deadline
            || overflow.load(Ordering::SeqCst)
            || CANCEL.load(Ordering::SeqCst) != epoch
        {
            let _ = child.kill();
            let _ = child.wait();
            break true;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // The root cannot leave descendants alive holding inherited output pipes.
    drop(job);
    let output = out_rx.recv_timeout(Duration::from_secs(3));
    let diagnostics = err_rx.recv_timeout(Duration::from_secs(3));
    if output.is_err() || diagnostics.is_err() {
        PIPE_FAILED.store(true, Ordering::SeqCst);
        return Err(err("Sandbox process output did not close after termination; further helper launches blocked until restart"));
    }
    let bytes = output.map_err(|_| err("Sandbox output unavailable"))?;
    if cancelled {
        return Err(err("Sandbox helper cancelled, timed out, or exceeded output bounds. No unsandboxed retry was made."));
    }
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| err("Sandbox helper returned an invalid result"))?;
    if value["upstream_commit"] != UPSTREAM || value["model_calls"] != false {
        return Err(err("Unexpected sandbox response identity"));
    }
    value["read_scope"] = json!("sandbox_account_acl_not_path_whitelist");
    value["read_scope_notice"] = json!("Shared Windows-readable files outside the workspace may remain readable. Read-only limits workspace writes; it is not a read-path privacy boundary.");
    Ok(value)
}
pub fn local_setup(profile: crate::workspace::WorkspaceProfile, root: PathBuf) -> AppResult<Value> {
    let config = crate::tools::computer::permissions::configuration(&profile);
    let epoch = CANCEL.load(Ordering::SeqCst);
    let value = invoke_helper(&root, "setup", &[], 30_000)?;
    if value["ok"] != true || value["ready"] != true {
        return Ok(value);
    }
    DataStore::update_file(|data| {
        let p = data
            .profiles
            .iter()
            .find(|p| p.id == profile.id)
            .ok_or_else(|| err("Workspace disappeared"))?;
        if crate::tools::computer::permissions::configuration(p) != config
            || CANCEL.load(Ordering::SeqCst) != epoch
        {
            return Err(err(
                "Sandbox permission changed or was cancelled during setup",
            ));
        }
        if let Some(g) = data
            .sandbox_permissions
            .iter_mut()
            .find(|g| g.workspace_id == profile.id)
        {
            g.root = root;
            g.configuration = config;
            g.enabled = true;
        } else {
            if data.sandbox_permissions.len() >= 32 {
                return Err(err("Too many sandbox grants"));
            }
            data.sandbox_permissions.push(SandboxGrant {
                workspace_id: profile.id,
                root,
                configuration: config,
                enabled: true,
            });
        }
        Ok(())
    })?;
    Ok(value)
}
pub fn local_disable(id: &str) -> AppResult<()> {
    cancel_active();
    DataStore::update_file(|data| {
        if let Some(g) = data
            .sandbox_permissions
            .iter_mut()
            .find(|g| g.workspace_id == id)
        {
            g.enabled = false;
        }
        Ok(())
    })
}
fn enabled_for(root: &Path) -> AppResult<bool> {
    DataStore::read_file(|data| {
        Ok(data.sandbox_permissions.iter().any(|g| {
            g.enabled
                && g.root == root
                && data.profiles.iter().any(|p| {
                    p.id == g.workspace_id
                        && crate::tools::computer::permissions::configuration(p) == g.configuration
                })
        }))
    })
}
pub fn local_status(root: &Path) -> AppResult<Value> {
    let available = cfg!(target_os = "windows")
        && option_env!("CODING_TOOLS_SANDBOX_MANIFEST_SHA256").is_some();
    Ok(
        json!({"available":available,"enabled_for_workspace":enabled_for(root)?,"upstream_commit":UPSTREAM,
        "filesystem":"read_only","network":"restricted","setup_requires_local_consent":true,"model_calls":false,
        "read_scope":"sandbox_account_acl_not_path_whitelist","read_scope_notice":"Shared Windows-readable files outside the workspace may remain readable; private files depend on Windows ACLs",
        "scope":"Sandbox applies only to sandbox_exec, not GUI tools or existing unsandboxed command tools"}),
    )
}
pub fn input(name: &str) -> Value {
    if name == "sandbox_status" {
        return json!({"type":"object","properties":{},"additionalProperties":false});
    }
    json!({"type":"object","properties":{"argv":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","maxLength":8192},"description":"Absolute executable path followed by literal arguments. No Codex agent is launched by the executor."},"timeout_ms":{"type":"integer","minimum":100,"maximum":30000,"default":15000}},"required":["argv"],"additionalProperties":false})
}
pub fn call(
    ctx: &ToolContext,
    name: &str,
    args: &Value,
) -> std::result::Result<Value, WorkspaceError> {
    let result = (|| -> AppResult<Value> {
        if !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth") {
            return Err(err("Sandbox tools require authenticated MCP"));
        }
        let object = args
            .as_object()
            .ok_or_else(|| err("Arguments must be an object"))?;
        if name == "sandbox_status" {
            if !object.is_empty() {
                return Err(err("Unknown sandbox status argument"));
            }
            return local_status(ctx.workspace.root());
        }
        if name != "sandbox_exec" || object.keys().any(|k| k != "argv" && k != "timeout_ms") {
            return Err(err("Unsupported sandbox operation or argument"));
        }
        if !enabled_for(ctx.workspace.root())? {
            return Err(err(
                "Prepare and approve the native OS sandbox locally for this workspace first",
            ));
        }
        let argv: Vec<String> = serde_json::from_value(args["argv"].clone())
            .map_err(|_| err("argv must be an array of strings"))?;
        let timeout = args
            .get("timeout_ms")
            .map(|v| {
                v.as_u64()
                    .ok_or_else(|| err("timeout_ms must be an integer"))
            })
            .transpose()?
            .unwrap_or(15000);
        if argv.is_empty()
            || argv.len() > 32
            || argv.iter().any(|a| a.len() > 8192 || a.contains('\0'))
            || !(100..=30000).contains(&timeout)
        {
            return Err(err("Sandbox request exceeds bounds"));
        }
        invoke_helper(ctx.workspace.root(), "exec", &argv, timeout)
    })();
    result.map(tool_ok).map_err(|e| WorkspaceError::Tool {
        code: "NATIVE_SANDBOX_REJECTED",
        message: e.to_string(),
        category: "sandbox",
        retryable: false,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sandbox_contract_has_no_remote_setup_or_permission_widening() {
        assert_eq!(NAMES, ["sandbox_status", "sandbox_exec"]);
        let schema = input("sandbox_exec");
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 2);
        assert!(!properties.contains_key("operation"));
        assert!(!properties.contains_key("home"));
        let flag = AtomicBool::new(false);
        let data = read_bounded(std::io::Cursor::new(vec![b'x'; 100]), 17, &flag);
        assert_eq!(data.len(), 17);
        assert!(flag.load(Ordering::SeqCst));
    }
}
