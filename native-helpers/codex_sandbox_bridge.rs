//! Sandbox-only helper, compiled in a pinned upstream codex-windows-sandbox workspace.
//! No Codex CLI, agent, login, model client, telemetry initialization or fallback.
use anyhow::{Context, Result, bail};
use codex_protocol::models::{ManagedFileSystemPermissions, PermissionProfile};
use codex_protocol::permissions::{
    FileSystemAccessMode, FileSystemSandboxEntry, NetworkSandboxPolicy,
};
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_windows_sandbox as sandbox;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const POLICY_REVISION: &str = "ctmcp-read-runtime-network-v1";
const UPSTREAM: &str = "3caf9f9586baedb4158a7b91545ead3dd320c348";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    workspace: PathBuf,
    home: PathBuf,
    #[serde(default)]
    argv: Vec<String>,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}
fn default_timeout() -> u64 { 15_000 }
fn checked_directory(p: &Path) -> Result<PathBuf> {
    if !p.is_absolute() { bail!("Absolute directory required"); }
    // Preserve canonical identity while using a legacy-compatible representation
    // when lossless. CMD otherwise interprets a local \\?\ drive as UNC and
    // silently falls back to Windows, breaking relative-file permissions.
    let real = dunce::canonicalize(p).context("Directory is unavailable")?;
    if !real.is_dir() { bail!("Directory is unavailable"); }
    Ok(real)
}
fn profile(root: &Path) -> Result<PermissionProfile> {
    let mut paths = vec![root.to_path_buf()];
    // Never recursively grant all installed applications or the entire OS tree.
    // System32 supplies native command/runtime binaries; other executables must
    // be deliberately placed in the locally approved workspace.
    let windows = PathBuf::from(
        std::env::var_os("SystemRoot").context("Windows runtime root unavailable")?
    );
    if !windows.is_absolute() { bail!("Windows runtime root must be absolute"); }
    let runtime = windows.join("System32").canonicalize()
        .context("Windows System32 unavailable")?;
    if !runtime.is_dir() { bail!("Windows runtime directory unavailable"); }
    paths.push(runtime);
    let helper = std::env::current_exe()?.parent()
        .context("Helper location unavailable")?.canonicalize()?;
    paths.push(helper);
    let mut entries = Vec::new();
    for path in paths {
        let path = AbsolutePathBuf::from_absolute_path(path)?;
        entries.push(FileSystemSandboxEntry::new(path.into(), FileSystemAccessMode::Read));
    }
    Ok(PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted {
            entries, glob_scan_max_depth: None,
        },
        network: NetworkSandboxPolicy::Restricted,
    })
}
fn sanitized_env(home: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in ["SystemRoot", "SystemDrive", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERNAME"] {
        if let Ok(value) = std::env::var(key) { env.insert(key.into(), value); }
    }
    if let Ok(root) = std::env::var("SystemRoot") {
        env.insert("PATH".into(), format!("{root}\\System32;{root}\\System32\\WindowsPowerShell\\v1.0"));
    }
    env.insert("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into());
    env.insert("TEMP".into(), home.join("aiTemp").to_string_lossy().into());
    env.insert("TMP".into(), home.join("aiTemp").to_string_lossy().into());
    env.insert("CODEX_HOME".into(), home.to_string_lossy().into());
    env.insert("OTEL_SDK_DISABLED".into(), "true".into());
    env.insert("DO_NOT_TRACK".into(), "1".into());
    env
}
fn policy_ready(home: &Path) -> bool {
    let path = home.join(".sandbox-secrets").join(POLICY_REVISION);
    let Ok(metadata) = std::fs::symlink_metadata(&path) else { return false; };
    use std::os::windows::fs::MetadataExt;
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 || metadata.len() > 256 { return false; }
    std::fs::read_to_string(path).is_ok_and(|s| s == format!("{POLICY_REVISION}\n{UPSTREAM}\n"))
}
fn record_policy(home: &Path) -> Result<()> {
    if policy_ready(home) { return Ok(()); }
    let directory = home.join(".sandbox-secrets");
    let path = directory.join(POLICY_REVISION);
    // Never replace a corrupt/legacy marker; explicit recovery preserves it.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    writeln!(file, "{POLICY_REVISION}\n{UPSTREAM}")?;
    file.sync_all()?;
    Ok(())
}
fn process(request: Request) -> Result<serde_json::Value> {
    let root = checked_directory(&request.workspace)?;
    let home = checked_directory(&request.home)?;
    if home.starts_with(&root) || root.starts_with(&home) {
        bail!("Sandbox state must be outside the delegated workspace");
    }
    let ready = policy_ready(&home) && sandbox::sandbox_setup_is_complete_with_settings(
        &home, &sandbox::WindowsSandboxProvisioningSettings::default(),
    );
    if request.operation == "status" {
        return Ok(json!({"ok":true,"ready":ready,"policy_revision":POLICY_REVISION,"upstream_commit":UPSTREAM,
            "backend":"codex_windows_elevated","filesystem":"read_only",
            "network":"restricted","model_calls":false}));
    }
    let permissions = profile(&root)?;
    let roots = vec![AbsolutePathBuf::from_absolute_path(&root)?];
    let env = sanitized_env(&home);
    if request.operation == "setup" {
        if std::env::var("CODING_TOOLS_LOCAL_SANDBOX_SETUP").as_deref() != Ok("1") {
            bail!("Sandbox setup requires the local UI");
        }
        let resolved = sandbox::ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots(&permissions, &roots)?;
        sandbox::run_elevated_setup(sandbox::SandboxSetupRequest {
            permissions: &resolved, command_cwd: &root, env_map: &env,
            codex_home: &home, proxy_enforced: false,
        })?;
        sandbox::run_setup_refresh(&permissions, &roots, &root, &env, &home, false)?;
        if !sandbox::sandbox_setup_is_complete_with_settings(&home, &sandbox::WindowsSandboxProvisioningSettings::default()) {
            bail!("Native provisioning did not complete; no ready marker was recorded");
        }
        record_policy(&home)?;
        return Ok(json!({"ok":true,"ready":sandbox::sandbox_setup_is_complete_with_settings(
            &home,&sandbox::WindowsSandboxProvisioningSettings::default()),
            "policy_revision":POLICY_REVISION,"upstream_commit":UPSTREAM,"model_calls":false}));
    }
    if request.operation != "exec" || !ready {
        bail!("Sandbox not prepared locally; no unsandboxed execution or automatic elevation is allowed");
    }
    if request.argv.is_empty() || request.argv.len() > 32
        || request.argv.iter().any(|a| a.len() > 8192 || a.contains('\0'))
        || !(100..=30_000).contains(&request.timeout_ms) {
        bail!("Command or timeout exceeds bounds");
    }
    // Fully qualified executable only. PATH lookup/helper option injection are not accepted.
    let executable = PathBuf::from(&request.argv[0]);
    if !executable.is_absolute() || !executable.is_file() { bail!("Use an absolute executable path"); }
    let result = sandbox::run_windows_sandbox_capture_for_permission_profile_elevated(
        sandbox::ElevatedSandboxProfileCaptureRequest {
            permission_profile: &permissions, workspace_roots: &roots, codex_home: &home,
            command: request.argv, cwd: &root, env_map: env,
            timeout_ms: Some(request.timeout_ms), cancellation: None,
            use_private_desktop: true, proxy_enforced: false,
            network_proxy_restricting_sid: None, read_roots_override: None,
            read_roots_include_platform_defaults: false, write_roots_override: Some(&[]),
            deny_read_paths_override: &[], deny_write_paths_override: &[],
        },
    )?;
    Ok(json!({"ok":result.exit_code==0,"exit_code":result.exit_code,"timed_out":result.timed_out,
        "stdout":String::from_utf8_lossy(&result.stdout),"stderr":String::from_utf8_lossy(&result.stderr),
        "output_may_be_truncated":result.stdout.len()>=262144||result.stderr.len()>=262144,
        "backend":"codex_windows_elevated","policy_revision":POLICY_REVISION,"upstream_commit":UPSTREAM,"filesystem":"read_only",
        "network":"restricted","private_desktop":true,"model_calls":false}))
}
fn main() {
    let result = (|| -> Result<serde_json::Value> {
        if std::env::args_os().len() != 1 {
            bail!("This helper accepts one bounded JSON request on stdin, not CLI agent commands");
        }
        let mut data = Vec::new();
        std::io::stdin().take(32769).read_to_end(&mut data)?;
        if data.len() > 32768 { bail!("Request exceeds 32 KiB"); }
        process(serde_json::from_slice(&data)?)
    })();
    let response = match result {
        Ok(value) => value,
        Err(e) => json!({"ok":false,"error":e.to_string(),"model_calls":false,"policy_revision":POLICY_REVISION,"upstream_commit":UPSTREAM}),
    };
    let _ = writeln!(std::io::stdout(), "{}", response);
    if response["ok"] != true { std::process::exit(1); }
}
