//! Owned bridge to an installed Codex Windows runtime. No vendor binaries or ambient Codex pipe.
use super::{check_same_lease, error, native, Lease, Result};
use crate::tools::process_tree::ProcessTree;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const BRIDGE: &str = include_str!("codex-bridge.mjs");
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
static GENERATION: AtomicU64 = AtomicU64::new(0);
static OWNER: Mutex<Option<Arc<ProcessTree>>> = Mutex::new(None);
static WORKER: Mutex<Option<Worker>> = Mutex::new(None);

struct Runtime {
    node: PathBuf,
    sky: PathBuf,
    helper: PathBuf,
    cli: PathBuf,
}
/// An engine call that failed: the bridge's code, and whether the worker ended with it. Only a
/// fatal failure (the engine closed or timed out, physical Escape, a changed window) stops
/// control; any other is that call's error alone, and the worker keeps serving.
#[derive(Clone, Debug, PartialEq)]
struct Failure {
    code: String,
    fatal: bool,
}
impl Failure {
    fn fatal(code: &str) -> Self {
        Self {
            code: code.into(),
            fatal: true,
        }
    }
}
type Outcome = std::result::Result<Value, Failure>;
struct Request {
    method: String,
    params: Value,
    response: mpsc::SyncSender<Outcome>,
}
struct Worker {
    binding: String,
    generation: u64,
    sender: mpsc::SyncSender<Request>,
}

pub(super) fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(tree) = OWNER.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = tree.terminate();
    }
    // Stop never waits for a startup/action holding the worker mutex.
    if let Ok(mut worker) = WORKER.try_lock() {
        *worker = None;
    }
}
fn unavailable(message: &str) -> crate::tools::workspace::WorkspaceError {
    error("CODEX_ENGINE_UNAVAILABLE", message)
}
fn runtime_at(resources: &Path) -> Option<Runtime> {
    let resources = resources.canonicalize().ok()?;
    let node = resources.join("cua_node/bin/node.exe");
    let sky = resources.join("cua_node/bin/node_modules/@oai/sky");
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    // Match the desktop app's Windows Swift helper, not the older incompatible helper beside it.
    let helper = sky.join(format!(
        "bin/windows/swift/{arch}/codex-computer-use-swift.exe"
    ));
    let cli = resources.join("codex.exe");
    if ![&node, &helper, &cli, &sky.join("package.json")]
        .iter()
        .all(|p| p.is_file())
    {
        return None;
    }
    Some(Runtime {
        node,
        sky,
        helper,
        cli,
    })
}
fn discover(generation: u64) -> Result<Runtime> {
    if !cfg!(windows) {
        return Err(unavailable(
            "Installed Codex computer control is Windows-only",
        ));
    }
    if let Some(root) = std::env::var_os("CODING_TOOLS_CODEX_RESOURCES") {
        return runtime_at(Path::new(&root)).ok_or_else(|| unavailable(
            "CODING_TOOLS_CODEX_RESOURCES must point to a compatible installed Codex app/resources directory",
        ));
    }
    let system = std::env::var_os("SystemRoot")
        .ok_or_else(|| unavailable("Windows system directory is unavailable"))?;
    let mut command = std::process::Command::new(
        PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    );
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-AppxPackage OpenAI.Codex | ForEach-Object { $_.InstallLocation }",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| unavailable("Cannot locate the installed Codex runtime"))?;
    let started = std::time::Instant::now();
    let status = loop {
        if generation != GENERATION.load(Ordering::SeqCst)
            || started.elapsed() > Duration::from_secs(8)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(unavailable(
                "Codex runtime discovery was stopped or timed out",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unavailable("Codex runtime discovery failed"));
            }
        }
    };
    if status.success() {
        use std::io::Read;
        let mut output = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            let _ = stdout.take(32768).read_to_end(&mut output);
        }
        for installation in String::from_utf8_lossy(&output).lines() {
            if let Some(runtime) =
                runtime_at(&PathBuf::from(installation.trim()).join("app/resources"))
            {
                return Ok(runtime);
            }
        }
    }
    Err(unavailable("Install a compatible Codex desktop runtime, or set CODING_TOOLS_CODEX_RESOURCES to its app/resources directory. No alternative input engine was used."))
}

/// The bridge's reply to one call as an outcome. A reply without `fatal` (an older bridge) counts
/// as fatal, and a code is kept only in its documented shape: the bridge never sends native text.
fn reply_outcome(response: &Value) -> Outcome {
    if response["ok"] == true {
        return Ok(response["result"].clone());
    }
    let code = response["code"]
        .as_str()
        .filter(|code| {
            (3..=64).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        })
        .unwrap_or("CODEX_ENGINE_FAILED");
    Err(Failure {
        code: code.into(),
        fatal: response["fatal"].as_bool() != Some(false),
    })
}

async fn exchange(
    stdin: &mut tokio::process::ChildStdin,
    stdout: &mut BufReader<tokio::process::ChildStdout>,
    method: &str,
    params: Value,
) -> Outcome {
    let mut request = serde_json::to_vec(&json!({"method":method,"params":params}))
        .map_err(|_| Failure::fatal("CODEX_REQUEST_INVALID"))?;
    if request.len() > 32767 {
        // Refused before it reached the engine: the worker is untouched.
        return Err(Failure {
            code: "CODEX_REQUEST_TOO_LARGE".into(),
            fatal: false,
        });
    }
    request.push(b'\n');
    let read = async {
        stdin
            .write_all(&request)
            .await
            .map_err(|_| Failure::fatal("CODEX_ENGINE_CLOSED"))?;
        stdin
            .flush()
            .await
            .map_err(|_| Failure::fatal("CODEX_ENGINE_CLOSED"))?;
        let mut line = Vec::new();
        loop {
            let bytes = stdout
                .fill_buf()
                .await
                .map_err(|_| Failure::fatal("CODEX_ENGINE_CLOSED"))?;
            if bytes.is_empty() {
                return Err(Failure::fatal("CODEX_ENGINE_CLOSED"));
            }
            let end = bytes.iter().position(|b| *b == b'\n');
            let count = end.map_or(bytes.len(), |n| n + 1);
            if line.len() + count > MAX_RESPONSE {
                return Err(Failure::fatal("CODEX_RESPONSE_TOO_LARGE"));
            }
            line.extend_from_slice(&bytes[..count]);
            stdout.consume(count);
            if end.is_some() {
                break;
            }
        }
        let response: Value =
            serde_json::from_slice(&line).map_err(|_| Failure::fatal("INVALID_CODEX_RESPONSE"))?;
        reply_outcome(&response)
    };
    tokio::time::timeout(Duration::from_secs(12), read)
        .await
        .map_err(|_| Failure::fatal("CODEX_ENGINE_TIMEOUT"))?
}

fn start(lease: &Lease, generation: u64) -> Result<mpsc::SyncSender<Request>> {
    let runtime = discover(generation)?;
    let data = lease.root.join("aiTemp/codex-computer-use");
    if cfg!(windows)
        && data
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_ascii_lowercase()
            .starts_with("c:")
    {
        return Err(unavailable(
            "Codex computer-use state must be on the project's non-C: drive",
        ));
    }
    std::fs::create_dir_all(&data)
        .map_err(|_| unavailable("Cannot prepare the private computer-use state directory"))?;
    let executable = native::executable_path(lease.target.pid)?;
    let init = json!({"sky_root":runtime.sky,"helper":runtime.helper,"window_id":lease.target.window_id,"executable":executable});
    let (sender, requests) = mpsc::sync_channel::<Request>(1);
    let (ready, startup) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let run = || -> std::result::Result<(), String> {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "CODEX_ENGINE_START_FAILED")?;
            let mut command = tokio::process::Command::new(runtime.node);
            command
                .args([
                    "--input-type=module",
                    "-e",
                    BRIDGE,
                    "--",
                    "--coding-tools-computer-bridge",
                ])
                .current_dir(&data)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .env_remove("SKY_CUA_NATIVE_PIPE")
                .env_remove("SKY_CUA_NATIVE_PIPE_DIRECTORY")
                .env_remove("OAI_SKY_WINDOWS_BIN")
                .env_remove("SKY_ENABLE_AUDIO")
                .env("CODEX_HOME", &data)
                .env("TEMP", &data)
                .env("TMP", &data)
                .env("CODEX_CLI_PATH", runtime.cli)
                .kill_on_drop(true);
            let mut tree =
                ProcessTree::prepare(&mut command).map_err(|_| "CODEX_ENGINE_OWNERSHIP_FAILED")?;
            let mut child = {
                let _entered = rt.enter();
                command.spawn().map_err(|_| "CODEX_ENGINE_START_FAILED")?
            };
            tree.admit(&child)
                .map_err(|_| "CODEX_ENGINE_OWNERSHIP_FAILED")?;
            let tree = Arc::new(tree);
            {
                let mut owner = OWNER.lock().unwrap_or_else(|p| p.into_inner());
                if generation != GENERATION.load(Ordering::SeqCst) {
                    let _ = tree.terminate();
                    return Err("CODEX_ENGINE_CANCELLED".into());
                }
                *owner = Some(tree.clone());
            }
            let mut stdin = child.stdin.take().ok_or("CODEX_ENGINE_START_FAILED")?;
            let mut stdout =
                BufReader::new(child.stdout.take().ok_or("CODEX_ENGINE_START_FAILED")?);
            let initialized = rt.block_on(exchange(&mut stdin, &mut stdout, "initialize", init));
            if initialized.is_err() {
                let _ = tree.terminate();
            }
            let _ = ready.send(initialized.clone());
            initialized.map_err(|failure| failure.code)?;
            loop {
                if generation != GENERATION.load(Ordering::SeqCst) {
                    break;
                }
                if child
                    .try_wait()
                    .map_err(|_| "CODEX_ENGINE_CLOSED")?
                    .is_some()
                {
                    super::emergency_stop(
                        "Codex native helper exited; local re-enablement required",
                    );
                    break;
                }
                let request = match requests.recv_timeout(Duration::from_millis(100)) {
                    Ok(request) => request,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let result = rt.block_on(exchange(
                    &mut stdin,
                    &mut stdout,
                    &request.method,
                    request.params,
                ));
                // A refused call is answered and the worker serves the next one.
                let failed = matches!(&result, Err(failure) if failure.fatal);
                let _ = request.response.send(result);
                if failed {
                    break;
                }
            }
            let _ = tree.terminate();
            let _ = rt.block_on(child.wait());
            Ok(())
        };
        if let Err(code) = run() {
            let _ = ready.send(Err(Failure::fatal(&code)));
        }
    });
    match startup.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(_)) => Ok(sender),
        _ => {
            cancel();
            Err(unavailable(
                "The installed Codex engine could not start. Control was not transferred.",
            ))
        }
    }
}

/// The error for a call the engine refused while its worker kept serving: control stays on.
fn refused(failure: &Failure) -> crate::tools::workspace::WorkspaceError {
    if failure.code == "CODEX_WINDOW_HIDDEN" {
        return error(
            WINDOW_UNAVAILABLE,
            "Codex's computer-use engine cannot reach this window: Codex leaves its own windows \
             (ChatGPT and Codex) out of what it controls. No input was sent. Control stays on, and \
             computer_snapshot still shows this window; to click or type, select another app's window.",
        );
    }
    error(
        "CODEX_ACTION_REJECTED",
        &format!(
            "The Codex engine refused this call ({}). Control stays on. If it was an input, it may \
             have been submitted: take a fresh computer_snapshot before trying again.",
            failure.code
        ),
    )
}

/// The code of a call that never reached a window Codex's engine will not control.
pub(super) const WINDOW_UNAVAILABLE: &str = "CODEX_WINDOW_UNAVAILABLE";

pub(super) fn request(lease: &Lease, method: &str, params: Value) -> Result<Value> {
    check_same_lease(lease, true)?;
    native::validate_identity(&lease.target, false)?;
    let binding = format!(
        "{}:{}:{}",
        lease.id, lease.target.window_id, lease.target.pid
    );
    let sender = {
        let mut worker = WORKER.lock().unwrap_or_else(|p| p.into_inner());
        if worker.as_ref().is_some_and(|w| {
            w.binding != binding || w.generation != GENERATION.load(Ordering::SeqCst)
        }) {
            cancel();
            *worker = None;
        }
        if worker.is_none() {
            let generation = GENERATION.load(Ordering::SeqCst);
            let sender = start(lease, generation)?;
            *worker = Some(Worker {
                binding,
                generation,
                sender,
            });
        }
        worker.as_ref().expect("initialized worker").sender.clone()
    };
    // A Stop while discovery/startup ran must fence the first request as well.
    check_same_lease(lease, true)?;
    let (response, result) = mpsc::sync_channel(1);
    sender
        .try_send(Request {
            method: method.into(),
            params,
            response,
        })
        .map_err(|_| unavailable("Codex engine is unavailable; no request was queued"))?;
    let started = std::time::Instant::now();
    loop {
        if let Err(e) = check_same_lease(lease, true)
            .and_then(|_| native::validate_identity(&lease.target, false))
        {
            cancel();
            return Err(e);
        }
        match result.recv_timeout(Duration::from_millis(40)) {
            Ok(Ok(value)) => {
                check_same_lease(lease, true)?;
                return Ok(value);
            }
            Ok(Err(failure)) if !failure.fatal => return Err(refused(&failure)),
            Ok(Err(failure)) => {
                super::emergency_stop(if failure.code == "CODEX_ENGINE_INTERRUPTED" {
                    "Codex engine stopped by physical Escape"
                } else {
                    "Codex engine failed; automatic replay disabled"
                });
                return Err(unavailable("Codex engine stopped or failed. An input may have been submitted; do not automatically retry. Enable control locally again."));
            }
            Err(mpsc::RecvTimeoutError::Timeout) if started.elapsed() < Duration::from_secs(15) => {
            }
            _ => {
                super::emergency_stop("Codex engine response lost; automatic replay disabled");
                return Err(unavailable(
                    "Codex engine did not complete. Control stopped; input outcome is unknown.",
                ));
            }
        }
    }
}

pub(super) fn legacy_step(
    lease: &Lease,
    step: &super::Step,
    point: Option<(i32, i32)>,
) -> Result<()> {
    use super::Step;
    let mut params = json!({});
    let method = match step {
        Step::Type { text } => { params["text"] = json!(text); "type_text" }
        Step::Key { key } => {
            let normalized = key.split('+').map(|part| match part.to_ascii_lowercase().as_str() {
                "ctrl" => "Control_L".to_string(), "shift" => "Shift_L".to_string(),
                "enter" => "Return".to_string(), "escape" => "Escape".to_string(),
                "backspace" => "BackSpace".to_string(), "pageup" => "Page_Up".to_string(),
                "pagedown" => "Page_Down".to_string(), "tab" => "Tab".to_string(),
                "left" => "Left".to_string(), "right" => "Right".to_string(),
                "up" => "Up".to_string(), "down" => "Down".to_string(),
                "home" => "Home".to_string(), "end" => "End".to_string(),
                _ => part.to_string(),
            }).collect::<Vec<_>>().join("+");
            params["key"] = json!(normalized); "press_key"
        }
        Step::Click { button, .. } => {
            params["mouse_button"] = json!(if button == "right" { "right" } else { "left" });
            params["click_count"] = json!(if button == "double" { 2 } else { 1 }); "click"
        }
        Step::Scroll { amount } => {
            params["scrollX"] = json!(0); params["scrollY"] = json!(-amount * 120); "scroll"
        }
        Step::Move { .. } => return Err(error("CODEX_METHOD_UNAVAILABLE", "Codex window2 has no standalone pointer-move method. Use click or drag; no alternate input engine was used.")),
        _ => return Err(error("INVALID_CODEX_METHOD", "This step is not a native input action")),
    };
    if matches!(step, Step::Click { .. } | Step::Scroll { .. }) {
        let before = native::validate_target(&lease.target, true)?;
        let point = match point {
            Some(point) => point,
            None => native::pointer_position(&lease.target)?,
        };
        let current = request(
            lease,
            "get_window_state",
            json!({"include_screenshot":true}),
        )?;
        if native::validate_target(&lease.target, true)? != before {
            return Err(error(
                "TARGET_GEOMETRY_CHANGED",
                "Window moved before Codex input; capture a new snapshot",
            ));
        }
        native::validate_point(&lease.target, point.0, point.1)?;
        let image = current["screenshots"]
            .as_array()
            .and_then(|images| images.first())
            .ok_or_else(|| {
                error(
                    "INVALID_CODEX_RESPONSE",
                    "Codex returned no coordinate reference",
                )
            })?;
        let width = image["width"]
            .as_f64()
            .filter(|w| w.is_finite() && *w > 0.0)
            .ok_or_else(|| {
                error(
                    "INVALID_CODEX_RESPONSE",
                    "Codex returned no logical screenshot width",
                )
            })?;
        let height = image["height"]
            .as_f64()
            .filter(|h| h.is_finite() && *h > 0.0)
            .ok_or_else(|| {
                error(
                    "INVALID_CODEX_RESPONSE",
                    "Codex returned no logical screenshot height",
                )
            })?;
        params["x"] = json!((point.0 - before.x) as f64 * width / before.width as f64);
        params["y"] = json!((point.1 - before.y) as f64 * height / before.height as f64);
        params["screenshotId"] = image["id"].clone();
    }
    request(lease, method, params).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_never_accepts_an_incomplete_installation() {
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR")).join("../aiTemp");
        std::fs::create_dir_all(&scratch).unwrap();
        let root = tempfile::tempdir_in(scratch).unwrap();
        assert!(runtime_at(root.path()).is_none());
    }
    #[test]
    fn only_a_fatal_reply_ends_the_worker_and_codes_keep_their_shape() {
        assert_eq!(
            reply_outcome(&json!({"ok":true,"result":{"a":1}})),
            Ok(json!({"a":1}))
        );
        let refused =
            reply_outcome(&json!({"ok":false,"code":"CODEX_WINDOW_HIDDEN","fatal":false}));
        assert_eq!(
            refused,
            Err(Failure {
                code: "CODEX_WINDOW_HIDDEN".into(),
                fatal: false
            })
        );
        // An older bridge sends no `fatal`: it ended its worker, so control stops as before.
        assert!(
            reply_outcome(&json!({"ok":false,"code":"CODEX_ENGINE_FAILED"}))
                .is_err_and(|f| f.fatal)
        );
        // Anything but an upper-case code is never passed on to the agent.
        let odd = reply_outcome(&json!({"ok":false,"code":"secret text: C:\\x","fatal":false}));
        assert_eq!(odd.unwrap_err().code, "CODEX_ENGINE_FAILED");
        assert_eq!(refused_code("CODEX_WINDOW_HIDDEN"), WINDOW_UNAVAILABLE);
        assert_eq!(refused_code("INVALID_ELEMENT"), "CODEX_ACTION_REJECTED");
    }
    fn refused_code(code: &str) -> &'static str {
        refused(&Failure {
            code: code.into(),
            fatal: false,
        })
        .code()
    }
    #[test]
    fn worker_code_does_not_use_an_ambient_codex_pipe_or_write_frames() {
        assert!(!BRIDGE.contains("createConnection("));
        assert!(!BRIDGE.contains("writeFile"));
        assert!(BRIDGE.contains("--parent-pid"));
        assert!(BRIDGE.contains("createElicitation: request => bridge.approve(request)"));
    }
}
