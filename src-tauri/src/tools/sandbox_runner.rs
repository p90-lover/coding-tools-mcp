use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
static PIPE_FAILED: AtomicBool = AtomicBool::new(false);
fn read_bounded(mut input: impl Read, limit: usize, overflow: &AtomicBool) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    while let Ok(n) = input.read(&mut buffer) {
        if n == 0 {
            break;
        }
        let keep = n.min(limit.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..keep]);
        if keep < n {
            overflow.store(true, Ordering::SeqCst);
        }
    }
    output
}
fn helper(home: &Path) -> AppResult<(PathBuf, File)> {
    let directory = home.join("helpers");
    snapshot::create_safe_directory(&directory)?;
    let path = directory.join(format!("appcontainer-{}.exe", digest(HELPER)));
    if !path.exists() {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(HELPER)?;
        file.sync_all()?;
    }
    snapshot::safe_path(&path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut handle = options.open(&path)?;
    if handle.metadata()?.len() != HELPER.len() as u64 {
        return Err(err("Embedded helper was replaced; no fallback"));
    }
    let mut bytes = Vec::new();
    handle.read_to_end(&mut bytes)?;
    if bytes != HELPER {
        return Err(err("Helper hash mismatch; no execution"));
    }
    Ok((path, handle))
}
pub(super) fn run(
    ctx: &ToolContext,
    id: &str,
    epoch: u64,
    snapshot: &snapshot::Snapshot,
    exe: &Path,
    args: &[String],
    timeout: u64,
) -> AppResult<Value> {
    if PIPE_FAILED.load(Ordering::SeqCst) {
        return Err(err(
            "Prior process pipes did not close; restart only after investigation",
        ));
    }
    let (helper, _locked) = helper(&home()?)?;
    let policy = ctx.policy_execution_guard().map_err(|e| err(e.message()))?;
    if EPOCH.load(Ordering::SeqCst) != epoch || !permitted(id, ctx.workspace.root())? {
        return Err(err("Permission revoked before launch"));
    }
    let identity = format!(
        "CodingToolsMcp.Snapshot.{}",
        &digest(snapshot.id.as_bytes())[..30]
    );
    let mut command = Command::new(helper);
    command
        .arg(identity)
        .arg(&snapshot.input)
        .arg(&snapshot.work)
        .arg(timeout.to_string())
        .arg("--")
        .arg(exe)
        .args(args)
        .env_clear()
        .current_dir(&snapshot.directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["SystemRoot", "WINDIR", "SystemDrive"] {
        if let Some(v) = std::env::var_os(key) {
            command.env(key, v);
        }
    }
    command
        .env("TEMP", &snapshot.work)
        .env("TMP", &snapshot.work);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let job = match process::assign(&child) {
        Ok(j) => j,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let start = || -> AppResult<()> {
        if EPOCH.load(Ordering::SeqCst) != epoch || !permitted(id, ctx.workspace.root())? {
            return Err(err("Permission revoked during admission"));
        }
        // The trusted helper cannot configure ACLs or launch untrusted code
        // until it has been placed in the outer kill-on-close process job.
        child
            .stdin
            .take()
            .ok_or_else(|| err("Helper input missing"))?
            .write_all(b"start")?;
        Ok(())
    };
    let mut start = start;
    if let Err(e) = start() {
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    drop(policy);
    let overflow = Arc::new(AtomicBool::new(false));
    let flag = overflow.clone();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| err("Missing helper output"))?;
    let (out_tx, out_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = out_tx.send(read_bounded(stdout, 262144, &flag));
    });
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| err("Missing helper diagnostics"))?;
    let flag = overflow.clone();
    let (err_tx, err_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = err_tx.send(read_bounded(stderr, 16384, &flag));
    });
    let deadline = Instant::now() + Duration::from_millis(timeout + 5000);
    let mut interrupted = false;
    let mut status = None;
    loop {
        if let Some(s) = child.try_wait()? {
            status = Some(s);
            break;
        }
        if Instant::now() >= deadline
            || overflow.load(Ordering::SeqCst)
            || EPOCH.load(Ordering::SeqCst) != epoch
            || ctx.current_policy_revision().ok() != Some(ctx.policy_revision)
            || !permitted(id, ctx.workspace.root()).unwrap_or(false)
        {
            interrupted = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    drop(job); // kills helper plus descendants, including children in nested job
    let _ = child.kill();
    let _ = child.wait();
    let out = out_rx.recv_timeout(Duration::from_secs(3));
    let diagnostics = err_rx.recv_timeout(Duration::from_secs(3));
    if out.is_err() || diagnostics.is_err() {
        PIPE_FAILED.store(true, Ordering::SeqCst);
        return Err(err(
            "Process tree output remained open; further launches blocked",
        ));
    }
    if interrupted
        || overflow.load(Ordering::SeqCst)
        || EPOCH.load(Ordering::SeqCst) != epoch
        || ctx.current_policy_revision().ok() != Some(ctx.policy_revision)
        || !permitted(id, ctx.workspace.root()).unwrap_or(false)
    {
        return Err(err("Sandbox stopped or permissions changed; outputs retained, no host fallback or automatic replay"));
    }
    if !status.is_some_and(|s| s.success()) {
        return Err(err(format!(
            "Native isolation failed: {}",
            String::from_utf8_lossy(&diagnostics.unwrap())
        )));
    }
    let mut value: Value = serde_json::from_slice(&out.unwrap())?;
    if value["backend"] != BACKEND
        || value["appcontainer_token_verified"] != true
        || value["network_capabilities"] != 0
        || value["model_requests"] != 0
        || value["requested_identity_verified"] != true
    {
        return Err(err("Unexpected isolation evidence from helper"));
    }
    for name in ["stdout", "stderr"] {
        let encoded = value[format!("{name}_base64")]
            .as_str()
            .ok_or_else(|| err("Missing encoded output"))?;
        let decoded = STANDARD
            .decode(encoded)
            .map_err(|_| err("Invalid helper output"))?;
        if decoded.len() > 65536 {
            return Err(err("Helper output exceeded contract"));
        }
        value[name] = json!(String::from_utf8_lossy(&decoded));
        value
            .as_object_mut()
            .unwrap()
            .remove(&format!("{name}_base64"));
    }
    value["ok"] = json!(
        value["exit_code"] == 0 && value["timed_out"] == false && value["limit_exceeded"] == false
    );
    value["snapshot_id"] = json!(snapshot.id);
    value["retained_directory"] = json!(snapshot.directory);
    value["direct_workspace_access_granted"] = json!(false);
    value["original_workspace_modified"] = Value::Null;
    value["scope"]=json!("Explicit read-only input copies; outputs retained separately, never auto-imported; other command tools unaffected");
    Ok(value)
}
