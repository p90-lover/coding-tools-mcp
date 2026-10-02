//! Explicitly opted-in native Codex App Server sessions. No hidden model calls or RPC proxy.
mod native_command;
mod process;
pub use native_command::CommandRequest;
use process::OwnedProcess;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const PROTOCOL_SOURCE: &str = "721f46a07ab48f00b5e7cdbf2efb78b993d100de";
/// One JSON-RPC line from the App Server. Larger lines are skipped (see `skip_oversized`), not fatal.
const MAX_FRAME: usize = 4 * 1024 * 1024;
/// Stored answer per thread (at most MAX_THREADS threads). Reads return it in READ_PAGE pages.
const MAX_TEXT: usize = 1024 * 1024;
/// One codex_agent_read page of the answer; keeps the result well under the 256 KiB tool limit.
const READ_PAGE: usize = 96 * 1024;
const MAX_THREADS: usize = 4;
const MAX_LEDGER: usize = 64;
const LEDGER_RETENTION: Duration = Duration::from_secs(90 * 60);
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub executable: PathBuf,
    pub expected_sha256: String,
    pub codex_home: PathBuf,
    pub allow_model_usage: bool,
    #[serde(default)]
    pub allow_command_execution: bool,
    #[serde(default = "default_permission_profile")]
    pub permission_profile: String,
    pub model: String,
    pub request_limit: u32,
    pub lifetime_seconds: u64,
    /// Reasoning effort sent with every turn; None keeps the model's default. AO fills it from
    /// the card's route.
    #[serde(default)]
    pub effort: Option<String>,
    /// Context window in tokens, sent as the model_context_window config when the thread starts.
    #[serde(default)]
    pub context_window: Option<u32>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub operation: String,
    pub request_id: String,
    pub thread_id: Option<String>,
    pub text: Option<String>,
}
#[derive(Clone, Default, Serialize)]
struct ThreadState {
    id: String,
    status: String,
    turn_id: Option<String>,
    answer: String,
    answer_truncated: bool,
    notice: Option<String>,
    #[serde(skip)]
    item_id: String,
    /// What the turn is doing now ("thinking", "running a command", ...): the kind of step only,
    /// never command text or file contents.
    activity: Option<String>,
    /// When `activity` last changed and when anything was last heard (Unix ms; 0 = never).
    activity_at_ms: u64,
    last_event_at_ms: u64,
    /// When the thread was opened (Unix ms), so a turn that never starts shows how long it waited.
    started_at_ms: u64,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// The step a notification starts, in plain words, or None when it starts nothing new.
fn activity_for(method: &str, params: &Value) -> Option<&'static str> {
    match method {
        "turn/started" => Some("starting"),
        "turn/completed" => Some("finished"),
        "item/started" => Some(match params["item"]["type"].as_str().unwrap_or("") {
            "reasoning" => "thinking",
            "commandExecution" => "running a command",
            "fileChange" => "editing files",
            "mcpToolCall" | "dynamicToolCall" => "using a tool",
            "webSearch" => "searching the web",
            "agentMessage" => "writing the answer",
            "contextCompaction" => "compacting its context",
            "enteredReviewMode" => "reviewing",
            _ => "working",
        }),
        _ => None,
    }
}
struct NativeApproval {
    rpc_id: Value,
    // File path for a write request, or the exact working directory for a command.
    path: PathBuf,
    canonical: PathBuf,
    command: Option<String>,
    permissions: Option<Value>,
    thread_id: String,
    turn_id: String,
    reason: String,
    expires_at: Instant,
}
impl NativeApproval {
    fn target_is_current(&self, root: &Path, commands_allowed: bool) -> bool {
        self.expires_at > Instant::now()
            && std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| {
                !metadata.file_type().is_symlink()
                    && if self.command.is_some() {
                        metadata.is_dir()
                            && commands_allowed
                            && root
                                .canonicalize()
                                .is_ok_and(|root| self.path.starts_with(root))
                    } else {
                        metadata.is_file()
                    }
            })
            && self.path.canonicalize().ok().as_ref() == Some(&self.canonical)
    }
    fn reply(&self, approved: bool) -> Value {
        if self.command.is_some() {
            json!({"id":self.rpc_id,"result":{"decision":if approved {"accept"} else {"decline"}}})
        } else if approved {
            json!({"id":self.rpc_id,"result":{"permissions":{"fileSystem":{"entries":[{
                "access":"write","path":{"type":"path","path":self.path}
            }]}},"scope":"turn"}})
        } else {
            json!({"id":self.rpc_id,"error":{"code":-32601,"message":"Local approval was denied or expired"}})
        }
    }
}

fn command_approval_details(
    root: &Path,
    params: &Value,
) -> Option<(PathBuf, String, Option<Value>)> {
    let root = root.canonicalize().ok()?;
    if params.get("kind").is_some_and(|kind| kind != "command")
        || (!params["environmentId"].is_null() && params["environmentId"] != "local")
        || !params["itemId"].as_str().is_some_and(token)
        || params
            .get("availableDecisions")
            .filter(|value| !value.is_null())
            .is_some_and(|value| {
                !value
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item == "accept"))
            })
    {
        return None;
    }
    let command = params["command"].as_str()?;
    if command.trim().is_empty()
        || command.len() > 4096
        || command.chars().any(|c| {
            (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return None;
    }
    let cwd = Path::new(params["cwd"].as_str()?).canonicalize().ok()?;
    if !cwd.starts_with(&root) || !cwd.is_dir() {
        return None;
    }
    let extra = &params["additionalPermissions"];
    let network = &params["networkApprovalContext"];
    if (!extra.is_null() && !extra.is_object()) || (!network.is_null() && !network.is_object()) {
        return None;
    }
    let permissions = if extra.is_null() && network.is_null() {
        None
    } else {
        Some(json!({"additionalPermissions":extra,"networkApprovalContext":network}))
    };
    if permissions
        .as_ref()
        .is_some_and(|value| value.to_string().len() > 4096)
    {
        return None;
    }
    Some((cwd, command.into(), permissions))
}
struct LedgerEntry {
    fingerprint: String,
    result: Option<Value>,
    completed_at: Option<Instant>,
}
#[derive(Default)]
struct Memory {
    threads: BTreeMap<String, ThreadState>,
    ledger: BTreeMap<String, LedgerEntry>,
    requests_used: u32,
    native_identity: String,
    stop_reason: Option<String>,
}

/// Owned by an actual authenticated listener, never keyed only by a filesystem path.
#[derive(Default)]
pub struct Hub {
    current: Mutex<Option<Arc<Bridge>>>,
}
pub struct Ticket {
    bridge: Arc<Bridge>,
    request: Control,
    replay: Option<Value>,
}
struct Bridge {
    root: PathBuf,
    options: Connection,
    ao_worker_command_approvals: bool,
    started: Instant,
    live: AtomicBool,
    ready: AtomicBool,
    next_id: AtomicU64,
    process: Mutex<OwnedProcess>,
    outgoing: SyncSender<Value>,
    pending: Mutex<BTreeMap<u64, SyncSender<Result<Value>>>>,
    approvals: Arc<Mutex<BTreeMap<String, NativeApproval>>>,
    memory: Mutex<Memory>,
    operation: Mutex<()>,
}
fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock()
        .map_err(|_| "Native bridge state unavailable".into())
}
fn bounded(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
}
fn validate_control(request: &Control) -> Result<bool> {
    if !token(&request.request_id) {
        return Err("Use a unique 1–128 character request_id".into());
    }
    let uses_model = matches!(
        request.operation.as_str(),
        "start" | "send" | "review" | "compact"
    );
    if !uses_model && !matches!(request.operation.as_str(), "interrupt" | "close") {
        return Err("Unsupported native operation; arbitrary methods are not forwarded".into());
    }
    if request.operation == "start" {
        if request.thread_id.is_some() {
            return Err("start cannot reuse an existing thread".into());
        }
    } else if request.thread_id.as_deref().is_none_or(|v| !token(v)) {
        return Err("An owned thread_id is required".into());
    }
    if matches!(request.operation.as_str(), "start" | "send" | "review") {
        if request
            .text
            .as_deref()
            .is_none_or(|v| v.trim().is_empty() || v.len() > 16_000 || v.contains('\0'))
        {
            return Err("text must contain 1–16000 UTF-8 bytes without NUL".into());
        }
    } else if request.text.is_some() {
        return Err("This operation does not accept text".into());
    }
    Ok(uses_model)
}
fn default_permission_profile() -> String {
    ":read-only".into()
}
fn model_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .split('/')
            .all(|part| part != "." && part != ".." && token(part))
}

fn checked_options(root: &Path, mut options: Connection) -> Result<Connection> {
    if !options.executable.is_absolute()
        || !options.codex_home.is_absolute()
        || options.request_limit > 20
        || (options.lifetime_seconds != 0 && !(30..=900).contains(&options.lifetime_seconds))
        || !matches!(
            options.permission_profile.as_str(),
            ":read-only" | ":workspace"
        )
        || !model_id(&options.model)
        || options.expected_sha256.len() != 64
        || !options
            .expected_sha256
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err(
            "Use absolute native paths, SHA-256, model ID and :read-only/:workspace profile; request_limit accepts 0 or 1–20, lifetime_seconds accepts 0 or 30–900"
                .into(),
        );
    }
    options.executable = options
        .executable
        .canonicalize()
        .map_err(|_| "Native executable unavailable")?;
    options.codex_home = options
        .codex_home
        .canonicalize()
        .map_err(|_| "Dedicated Codex home unavailable")?;
    if !options.executable.is_file()
        || !options.codex_home.is_dir()
        || options.executable.starts_with(root)
        || options.executable.starts_with(&options.codex_home)
        || options.codex_home.starts_with(root)
        || root.starts_with(&options.codex_home)
    {
        return Err(
            "Use an installed native binary and a dedicated home outside the delegated workspace"
                .into(),
        );
    }
    #[cfg(windows)]
    if options
        .executable
        .extension()
        .and_then(|v| v.to_str())
        .is_none_or(|v| !v.eq_ignore_ascii_case("exe"))
    {
        return Err("Select codex.exe, not a .cmd/.bat wrapper or shell".into());
    }
    let mut file =
        std::fs::File::open(&options.executable).map_err(|_| "Cannot read selected executable")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect executable")?
        .len()
        > 512 * 1024 * 1024
    {
        return Err("Native executable exceeds the inspection limit".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes_read = 0usize;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "Cannot hash selected executable")?;
        if n == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(n);
        if bytes_read > 512 * 1024 * 1024 {
            return Err("Native executable grew beyond the inspection limit".into());
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != options.expected_sha256.to_ascii_lowercase() {
        return Err("Native executable SHA-256 mismatch; nothing was started".into());
    }
    options.expected_sha256.make_ascii_lowercase();
    Ok(options)
}
fn prune_ledger(memory: &mut Memory, now: Instant) {
    memory.ledger.retain(|_, entry| {
        entry
            .completed_at
            .is_none_or(|completed| now.saturating_duration_since(completed) < LEDGER_RETENTION)
    });
}

fn make_ledger_room(memory: &mut Memory) -> Result<()> {
    while memory.ledger.len() >= MAX_LEDGER {
        let oldest = memory
            .ledger
            .iter()
            .filter_map(|(id, entry)| entry.completed_at.map(|completed| (id.clone(), completed)))
            .min_by_key(|(_, completed)| *completed)
            .map(|(id, _)| id);
        let Some(id) = oldest else {
            return Err(
                "Connection request ledger is full of pending outcomes; no request submitted"
                    .into(),
            );
        };
        memory.ledger.remove(&id);
    }
    Ok(())
}

fn reserve(
    memory: &mut Memory,
    request: &Control,
    uses_model: bool,
    options: &Connection,
    live: bool,
    ready: bool,
) -> Result<Option<Value>> {
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(request).map_err(|_| "Invalid control request")?)
    );
    prune_ledger(memory, Instant::now());
    if let Some(entry) = memory.ledger.get(&request.request_id) {
        if entry.fingerprint != fingerprint {
            return Err("request_id already belongs to different arguments".into());
        }
        Ok(Some(entry.result.clone().unwrap_or_else(
            || json!({"state":"pending","request_id":request.request_id,"replayed":false}),
        )))
    } else {
        if !live || !ready {
            return Err(
                "Native connection is stopped or not initialized; do not replay an unknown outcome"
                    .into(),
            );
        }
        make_ledger_room(memory)?;
        if let Some(id) = &request.thread_id {
            let thread = memory
                .threads
                .get(id)
                .ok_or("Thread is not owned by this listener connection")?;
            if thread.status == "closed" {
                return Err("Thread is closed".into());
            }
            if uses_model
                && !matches!(
                    thread.status.as_str(),
                    "idle" | "completed" | "interrupted" | "failed"
                )
            {
                return Err(
                    "A turn is active or its outcome is unknown; inspect or interrupt it first"
                        .into(),
                );
            }
        } else if memory.threads.len() >= MAX_THREADS {
            return Err("This connection has reached its four-thread limit".into());
        }
        if uses_model {
            if !options.allow_model_usage {
                return Err("Model use has not been approved in the local UI".into());
            }
            if options.request_limit != 0 && memory.requests_used >= options.request_limit {
                return Err("Local model-request limit reached".into());
            }
            memory.requests_used = memory.requests_used.saturating_add(1);
        }
        memory.ledger.insert(
            request.request_id.clone(),
            LedgerEntry {
                fingerprint,
                result: None,
                completed_at: None,
            },
        );
        Ok(None)
    }
}

/// AO children run like Codex: read-only, or the built-in workspace profile (create, edit
/// and delete inside the workspace; anything else goes to the user as an approval). Native
/// command execution stays a separate, off switch.
fn ao_permission_allowed(options: &Connection) -> bool {
    matches!(
        options.permission_profile.as_str(),
        ":read-only" | ":workspace"
    ) && !options.allow_command_execution
}

fn developer_instructions(profile: &str) -> &'static str {
    if profile == ":workspace" {
        "Work only on the explicitly requested task. You may create, edit and delete files inside the working directory; never modify anything outside it, and use aiTemp for temporary files. Do not change permissions or use unsandboxed fallbacks. Explain evidence and uncertainty. Do not launch extra agents unless explicitly requested."
    } else {
        "Work only on the explicitly requested task. Never delete files; use Trash for unwanted files and aiTemp for temporary files. Do not change permissions or use unsandboxed fallbacks. Explain evidence and uncertainty. Do not launch extra agents unless explicitly requested."
    }
}

fn native_child_command(
    options: &Connection,
    temp: &Path,
    private_cpa_key: Option<&str>,
    ao_web: bool,
) -> Command {
    let mut command = Command::new(&options.executable);
    #[cfg(windows)]
    if options.permission_profile == ":workspace" {
        // AO cards each get a fresh CODEX_HOME; the elevated sandbox needs a one-time admin
        // setup per home, so AO children use Codex's unelevated Windows sandbox instead.
        let ao_child = private_cpa_key.is_some() || ao_web;
        command.arg("-c").arg(if ao_child {
            "windows.sandbox=unelevated"
        } else {
            "windows.sandbox=elevated"
        });
    }
    command
        .arg("app-server")
        .current_dir(&options.codex_home)
        .env_clear();
    for key in [
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "PATH",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("CODEX_HOME", &options.codex_home)
        .env("TMPDIR", temp)
        .env("TMP", temp)
        .env("TEMP", temp)
        .env("OTEL_SDK_DISABLED", "true")
        .env("DO_NOT_TRACK", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(key) = private_cpa_key {
        command.env("CODING_TOOLS_AO_CPA_KEY", key);
    }
    if ao_web {
        command.env("CODING_TOOLS_AO_WEB_KEY", "loopback-ao-web");
    }
    #[cfg(test)]
    if std::env::var_os("NATIVE_CODEX_PROBE_BIN").is_some() {
        command.env("CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG", "1");
    }
    command
}

impl Hub {
    /// Local desktop admission only. Caller must hold the listener's current policy fence.
    /// Returns before the handshake; a later policy change can cancel the provisional child.
    pub fn connect(&self, root: &Path, options: Connection) -> Result<()> {
        self.connect_inner(root, options, None, false)
    }
    pub fn connect_ao_with_cpa_key(
        &self,
        root: &Path,
        options: Connection,
        key: String,
    ) -> Result<()> {
        if key.len() < 32 || key.len() > 512 || key.chars().any(char::is_control) {
            return Err("AO CPA proxy key is unavailable or invalid".into());
        }
        if !ao_permission_allowed(&options) {
            return Err("AO CPA child must use a read-only or workspace profile".into());
        }
        self.connect_inner(root, options, Some(key), false)
    }
    pub fn connect_ao_web(&self, root: &Path, options: Connection) -> Result<()> {
        let tier = options.model.strip_prefix("chatgpt-web/");
        if !tier.is_some_and(|tier| crate::integrations::ao::WEB_TIERS.contains(&tier))
            || !ao_permission_allowed(&options)
        {
            return Err(
                "AO WebGPT child must use a served tier and a read-only or workspace profile"
                    .into(),
            );
        }
        self.connect_inner(root, options, None, true)
    }
    fn connect_inner(
        &self,
        root: &Path,
        options: Connection,
        private_cpa_key: Option<String>,
        ao_web: bool,
    ) -> Result<()> {
        let options = checked_options(root, options)?;
        let mut current = lock(&self.current)?;
        if current.is_some() {
            return Err("Disconnect the existing native session before reconnecting".into());
        }
        let temp = options.codex_home.join("aiTemp");
        std::fs::create_dir_all(&temp).map_err(|_| "Cannot prepare dedicated aiTemp directory")?;
        let mut command = native_child_command(&options, &temp, private_cpa_key.as_deref(), ao_web);
        OwnedProcess::configure(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start selected native executable")?;
        let input = child.stdin.take().ok_or("Native stdin unavailable")?;
        let output = child.stdout.take().ok_or("Native stdout unavailable")?;
        let process = OwnedProcess::attach(child)?;
        let (tx, rx) = mpsc::sync_channel::<Value>(16);
        let bridge = Arc::new(Bridge {
            root: root.to_path_buf(),
            options,
            // Every AO child routes its command approvals to the local approval queue.
            ao_worker_command_approvals: private_cpa_key.is_some() || ao_web,
            started: Instant::now(),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            process: Mutex::new(process),
            outgoing: tx,
            pending: Mutex::new(BTreeMap::new()),
            approvals: Arc::new(Mutex::new(BTreeMap::new())),
            memory: Mutex::new(Memory::default()),
            operation: Mutex::new(()),
        });
        *current = Some(bridge.clone());
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || {
            let mut input = input;
            while let Ok(value) = rx.recv() {
                let Some(bridge) = weak.upgrade() else {
                    break;
                };
                if !bridge.live.load(Ordering::SeqCst) {
                    break;
                }
                let mut bytes = match serde_json::to_vec(&value) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                bytes.push(b'\n');
                if input.write_all(&bytes).and_then(|_| input.flush()).is_err() {
                    bridge.stop("native_input_disconnected");
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let result = (&mut reader)
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut line);
                let Some(bridge) = weak.upgrade() else {
                    break;
                };
                if !bridge.live.load(Ordering::SeqCst) {
                    break;
                }
                if result.is_err() || line.is_empty() {
                    bridge.stop("native_output_disconnected");
                    break;
                }
                if line.last() != Some(&b'\n') {
                    // A line longer than MAX_FRAME (a large command output or file item) used to
                    // stop the whole bridge. Skip just that message; a reply it carried fails fast.
                    if line.len() <= MAX_FRAME || skip_rest_of_line(&mut reader).is_err() {
                        bridge.stop("native_output_disconnected");
                        break;
                    }
                    bridge.skip_oversized(&line);
                    continue;
                }
                match serde_json::from_slice::<Value>(&line) {
                    Ok(value) => bridge.receive(value),
                    Err(_) => {
                        bridge.stop("invalid_native_protocol");
                        break;
                    }
                }
            }
        });
        let lifetime = bridge.options.lifetime_seconds;
        if lifetime != 0 {
            let weak = Arc::downgrade(&bridge);
            std::thread::spawn(move || {
                for _ in 0..lifetime {
                    std::thread::sleep(Duration::from_secs(1));
                    let Some(bridge) = weak.upgrade() else {
                        return;
                    };
                    if !bridge.live.load(Ordering::SeqCst) {
                        return;
                    }
                }
                if let Some(bridge) = weak.upgrade() {
                    bridge.stop("local_consent_expired");
                }
            });
        }
        Ok(())
    }
    pub fn initialize(&self) -> Result<Value> {
        let bridge = self.bridge()?;
        let result = bridge.rpc(
            "initialize",
            json!({"clientInfo":{"name":"coding_tools_mcp",
            "title":"Coding Tools MCP","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}}),
        );
        match result {
            Ok(value) => {
                if let Ok(mut memory) = bridge.memory.lock() {
                    memory.native_identity =
                        bounded(value["userAgent"].as_str().unwrap_or("initialized"), 300);
                }
                bridge.enqueue(json!({"method":"initialized","params":{}}))?;
                bridge.ready.store(true, Ordering::SeqCst);
                self.status()
            }
            Err(error) => {
                bridge.stop("initialization_failed");
                Err(error)
            }
        }
    }
    fn bridge(&self) -> Result<Arc<Bridge>> {
        lock(&self.current)?
            .clone()
            .ok_or_else(|| "Enable the native connection in the local desktop UI first".into())
    }
    pub fn status(&self) -> Result<Value> {
        let current = lock(&self.current)?;
        let Some(bridge) = current.as_ref() else {
            return Ok(
                json!({"connected":false,"model_usage_enabled":false,"command_execution_enabled":false,"command_runtime_sha256":native_command::COMMAND_RUNTIME_SHA256,"implementation":"native_app_server_opt_in",
                "protocol_source":PROTOCOL_SOURCE,"native_sandbox_verified":false,"pending_approvals":[]}),
            );
        };
        let memory = lock(&bridge.memory)?;
        let approvals = lock(&bridge.approvals)?;
        Ok(
            json!({"connected":bridge.live.load(Ordering::SeqCst)&&bridge.ready.load(Ordering::SeqCst),
            "model_usage_enabled":bridge.live.load(Ordering::SeqCst)&&bridge.options.allow_model_usage,
            "command_execution_enabled":bridge.live.load(Ordering::SeqCst)&&bridge.options.allow_command_execution
                && native_command::COMMAND_RUNTIME_SHA256.is_some_and(|sha|sha.eq_ignore_ascii_case(&bridge.options.expected_sha256)),
            "command_runtime_sha256":native_command::COMMAND_RUNTIME_SHA256,
            "native_identity":memory.native_identity,"executable_sha256":bridge.options.expected_sha256,
            "model":bridge.options.model,"requests_used":memory.requests_used,
            "request_limit":if bridge.options.request_limit==0 { Value::Null } else { json!(bridge.options.request_limit) },
            "request_limit_unbounded":bridge.options.request_limit==0,
            "seconds_remaining":if bridge.options.lifetime_seconds==0 { Value::Null } else { json!(bridge.options.lifetime_seconds.saturating_sub(bridge.started.elapsed().as_secs())) },
            "lifetime_unbounded":bridge.options.lifetime_seconds==0,
            "replay_retention_seconds":LEDGER_RETENTION.as_secs(),"replay_capacity":MAX_LEDGER,
            "stop_reason":memory.stop_reason,"threads":memory.threads.values().map(|t|json!({"id":t.id,"status":t.status,"turn_id":t.turn_id,
                "activity":t.activity,"activity_at_ms":t.activity_at_ms,"last_event_at_ms":t.last_event_at_ms,"started_at_ms":t.started_at_ms})).collect::<Vec<_>>(),
            "requested_sandbox":if bridge.options.permission_profile==":workspace" {"workspace-write"} else {"read-only"},
            "permission_profile":bridge.options.permission_profile,
            "ao_worker_command_approvals":bridge.ao_worker_command_approvals,
            "pending_approvals":approvals.iter().filter(|(_, request)| request.expires_at > Instant::now()).map(|(id, request)| json!({"approval_id":id,"kind":if request.command.is_some() {"command"} else {"file_write"},"path":request.path,"cwd":request.command.as_ref().map(|_| &request.path),"command":request.command,"permissions":request.permissions,"reason":request.reason,"thread_id":request.thread_id,"turn_id":request.turn_id,"seconds_remaining":request.expires_at.saturating_duration_since(Instant::now()).as_secs()})).collect::<Vec<_>>(),
            "native_sandbox_verified":false,"protocol_source":PROTOCOL_SOURCE,
            "storage":"bounded_bridge_memory; native runtime and provider retention are separate",
            "limits_note":"Zero request/lifetime limits mean no app-side ceiling until disconnect; provider quotas still apply. Completed replay receipts are bounded RAM with 90-minute age expiry and oldest-first pressure eviction; pending outcomes are never evicted."}),
        )
    }
    pub fn resolve_approval(&self, id: &str, allow: bool) -> Result<Value> {
        let bridge = self.bridge()?;
        let request = lock(&bridge.approvals)?
            .remove(id)
            .ok_or("Native approval expired or was already answered")?;
        let active = lock(&bridge.memory)?
            .threads
            .get(&request.thread_id)
            .is_some_and(|thread| {
                thread.turn_id.as_deref() == Some(&request.turn_id) && thread.status == "inProgress"
            });
        let approved = allow
            && bridge.live.load(Ordering::SeqCst)
            && active
            && request.target_is_current(&bridge.root, bridge.ao_worker_command_approvals);
        bridge.enqueue(request.reply(approved))?;
        if let Some(thread) = lock(&bridge.memory)?.threads.get_mut(&request.thread_id) {
            if thread.turn_id.as_deref() == Some(&request.turn_id) {
                thread.notice = if approved {
                    None
                } else {
                    Some("Native approval declined (denied, expired, or no longer in scope). The mission requires local review before another attempt.".into())
                };
            }
        }
        Ok(
            json!({"ok":true,"approved":approved,"scope":if !approved {"none"} else if request.command.is_some() {"once"} else {"turn"}}),
        )
    }
    /// The thread state with the first page of its answer.
    pub fn read(&self, id: &str) -> Result<Value> {
        self.read_page(id, 0)
    }
    pub fn read_page(&self, id: &str, offset: usize) -> Result<Value> {
        let bridge = self.bridge()?;
        let memory = lock(&bridge.memory)?;
        let thread = memory
            .threads
            .get(id)
            .ok_or("Thread is not owned by this listener connection")?;
        let mut value =
            serde_json::to_value(thread).map_err(|_| "Cannot serialize native thread state")?;
        // Long answers are read in pages; answer_next_offset continues on a character boundary.
        let answer = thread.answer.as_str();
        let mut start = offset.min(answer.len());
        while !answer.is_char_boundary(start) {
            start += 1;
        }
        let page = bounded(&answer[start..], READ_PAGE);
        let end = start + page.len();
        value["answer"] = json!(page);
        value["answer_offset"] = json!(start);
        value["answer_total_bytes"] = json!(answer.len());
        value["answer_next_offset"] = json!((end < answer.len()).then_some(end));
        if bridge.ao_worker_command_approvals
            && lock(&bridge.approvals)?.values().any(|request| {
                request.thread_id == id
                    && thread.turn_id.as_deref() == Some(&request.turn_id)
                    && request.expires_at <= Instant::now()
            })
        {
            value["notice"] = json!("Native approval declined (local command approval expired). The mission requires local review before another attempt.");
        }
        Ok(value)
    }
    pub fn admit(&self, request: Control) -> Result<Ticket> {
        let uses_model = validate_control(&request)?;
        let bridge = self.bridge()?;
        let replay = {
            let mut memory = lock(&bridge.memory)?;
            reserve(
                &mut memory,
                &request,
                uses_model,
                &bridge.options,
                bridge.live.load(Ordering::SeqCst),
                bridge.ready.load(Ordering::SeqCst),
            )?
        };
        Ok(Ticket {
            bridge,
            request,
            replay,
        })
    }
    pub fn start_ao(&self, request_key: String, prompt: String) -> Result<Value> {
        self.admit(Control {
            operation: "start".into(),
            request_id: request_key,
            thread_id: None,
            text: Some(prompt),
        })?
        .run()
    }
    /// Nonblocking invalidation relative to model RPCs. Already submitted effects are not undone.
    pub fn cancel(&self, reason: &str) {
        if let Ok(current) = self.current.lock() {
            if let Some(bridge) = current.as_ref() {
                bridge.stop(reason);
            }
        }
    }
    pub fn disconnect(&self) {
        if let Ok(mut current) = self.current.lock() {
            if let Some(bridge) = current.take() {
                bridge.stop("local_disconnect");
            }
        }
    }
}
impl Drop for Hub {
    fn drop(&mut self) {
        self.disconnect();
    }
}
impl Ticket {
    pub fn run(self) -> Result<Value> {
        if let Some(value) = self.replay {
            return Ok(value);
        }
        let result = match self.bridge.operation.try_lock() {
            Ok(_operation) => self.bridge.control(&self.request),
            Err(_) => Err(
                "Another native control request is in progress; this request was not submitted"
                    .into(),
            ),
        };
        let stored = match &result {
            Ok(value) => value.clone(),
            Err(error) => json!({"ok":false,"request_id":self.request.request_id,"error":error,
                "outcome":if self.bridge.live.load(Ordering::SeqCst){"rejected_or_native_error"}else{"unknown_or_stopped"},"replayed":false}),
        };
        if let Ok(mut memory) = self.bridge.memory.lock() {
            if let Some(entry) = memory.ledger.get_mut(&self.request.request_id) {
                entry.result = Some(stored.clone());
                entry.completed_at = Some(Instant::now());
            }
        }
        // Return the exact stored result on both the first call and retry, including failures.
        Ok(stored)
    }
}
fn exact_external_write(root: &Path, permissions: &Value) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let permissions = permissions.as_object()?;
    if permissions.len() != 1 {
        return None;
    }
    let file_system = permissions.get("fileSystem")?.as_object()?;
    if file_system.len() != 1 {
        return None;
    }
    let entries = file_system.get("entries")?.as_array()?;
    if entries.len() != 1 {
        return None;
    }
    let entry = entries[0].as_object()?;
    if entry.len() != 2 || entry.get("access")? != "write" {
        return None;
    }
    let path_value = entry.get("path")?.as_object()?;
    if path_value.len() != 2 || path_value.get("type")? != "path" {
        return None;
    }
    let path_text = path_value.get("path")?.as_str()?;
    if path_text.is_empty() || path_text.len() > 4096 {
        return None;
    }
    let path = PathBuf::from(path_text);
    if !path.is_absolute() {
        return None;
    }
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    // Compare canonical forms: on Windows canonicalize() adds a `\\?\` prefix, so a raw
    // root would never contain the path and in-workspace files would look external.
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    (!canonical.starts_with(&root)).then_some(canonical)
}

impl Bridge {
    fn enqueue(&self, value: Value) -> Result<()> {
        if self.options.lifetime_seconds != 0
            && self.started.elapsed() >= Duration::from_secs(self.options.lifetime_seconds)
        {
            self.stop("local_consent_expired");
        }
        if !self.live.load(Ordering::SeqCst) {
            return Err("Native session stopped; request not submitted".into());
        }
        self.outgoing
            .try_send(value)
            .map_err(|_| "Native outgoing queue unavailable; request not submitted".into())
    }
    fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = lock(&self.pending)?;
            if pending.len() >= 8 {
                return Err("Native request capacity reached".into());
            }
            pending.insert(id, tx);
        }
        if let Err(error) = self.enqueue(json!({"id":id,"method":method,"params":params})) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        match rx.recv_timeout(RPC_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                self.stop("native_request_timeout_outcome_unknown");
                Err("Native request timed out; its outcome is unknown. Connection stopped; never replay automatically".into())
            }
        }
    }
    fn stop(&self, reason: &str) {
        if !self.live.swap(false, Ordering::SeqCst) {
            return;
        }
        self.ready.store(false, Ordering::SeqCst);
        if let Ok(mut memory) = self.memory.lock() {
            memory.stop_reason = Some(reason.into());
            for thread in memory.threads.values_mut() {
                if !matches!(
                    thread.status.as_str(),
                    "completed" | "failed" | "interrupted" | "closed" | "idle"
                ) {
                    thread.status = "unknown_stopped".into();
                }
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in std::mem::take(&mut *pending) {
                let _ = sender.try_send(Err(
                    "Native connection stopped; a submitted outcome may be unknown".into(),
                ));
            }
        }
        if let Ok(mut approvals) = self.approvals.lock() {
            approvals.clear();
        }
        if let Ok(mut process) = self.process.lock() {
            process.stop();
        }
    }
    fn queue_file_approval(&self, value: &Value) -> bool {
        if self.options.permission_profile != ":workspace" || !self.live.load(Ordering::SeqCst) {
            return false;
        }
        let params = &value["params"];
        if params["cwd"]
            .as_str()
            .and_then(|cwd| Path::new(cwd).canonicalize().ok())
            != Some(self.root.clone())
        {
            return false;
        }
        let Some(path) = exact_external_write(&self.root, &params["permissions"]) else {
            return false;
        };
        self.queue_local_approval(value, path, None, None)
    }
    fn queue_command_approval(&self, value: &Value) -> bool {
        if !self.ao_worker_command_approvals || !self.live.load(Ordering::SeqCst) {
            return false;
        }
        let Some((cwd, command, permissions)) =
            command_approval_details(&self.root, &value["params"])
        else {
            return false;
        };
        self.queue_local_approval(value, cwd, Some(command), permissions)
    }
    fn queue_local_approval(
        &self,
        value: &Value,
        path: PathBuf,
        command: Option<String>,
        permissions: Option<Value>,
    ) -> bool {
        let rpc_id = &value["id"];
        if !rpc_id.is_i64() && !rpc_id.as_str().is_some_and(token) {
            return false;
        }
        let params = &value["params"];
        let Some(thread_id) = params["threadId"].as_str().filter(|id| token(id)) else {
            return false;
        };
        let Some(turn_id) = params["turnId"].as_str().filter(|id| token(id)) else {
            return false;
        };
        let active = self.memory.lock().ok().and_then(|memory| {
            memory.threads.get(thread_id).map(|thread| {
                thread.turn_id.as_deref() == Some(turn_id) && thread.status == "inProgress"
            })
        }) == Some(true);
        if !active {
            return false;
        }
        let canonical = path.clone();
        let approval_id = uuid::Uuid::new_v4().to_string();
        let request = NativeApproval {
            rpc_id: rpc_id.clone(),
            path,
            canonical,
            command,
            permissions,
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            reason: bounded(params["reason"].as_str().unwrap_or(""), 500),
            expires_at: Instant::now() + Duration::from_secs(120),
        };
        let Ok(mut approvals) = self.approvals.lock() else {
            return false;
        };
        if approvals.values().any(|request| request.rpc_id == *rpc_id) {
            return true;
        }
        if approvals.len() >= 4 {
            return false;
        }
        approvals.insert(approval_id.clone(), request);
        drop(approvals);
        if let Ok(mut memory) = self.memory.lock() {
            if let Some(thread) = memory.threads.get_mut(thread_id) {
                thread.notice = Some("Native tool approval is waiting in the local panel. Review the exact request within two minutes; it will not be approved automatically.".into());
            }
        }
        let approvals = self.approvals.clone();
        let outgoing = self.outgoing.clone();
        let retain_expired = self.ao_worker_command_approvals;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(120));
            let expired = approvals.lock().ok().and_then(|mut pending| {
                if retain_expired {
                    pending
                        .get(&approval_id)
                        .map(|request| request.reply(false))
                } else {
                    pending
                        .remove(&approval_id)
                        .map(|request| request.reply(false))
                }
            });
            if let Some(reply) = expired {
                let _ = outgoing.send(reply);
            }
        });
        true
    }
    /// Answers a pending request whose reply was too large to accept, instead of letting it time
    /// out (which stops the bridge). Notifications that are too large are dropped.
    fn skip_oversized(&self, prefix: &[u8]) {
        if let Some(id) = reply_id(prefix) {
            self.receive(json!({"id":id,"error":{"code":-32001,"message":"Native reply exceeded the bridge frame limit"}}));
        }
    }
    fn receive(&self, value: Value) {
        if let Some(method) = value["method"].as_str() {
            #[cfg(test)]
            if std::env::var_os("NATIVE_CODEX_PROBE_BIN").is_some()
                && (method == "error"
                    || (method == "turn/completed"
                        && value["params"]["turn"]["status"] == "failed"))
            {
                // Credential-free fixture only; no production logging of payloads.
                eprintln!(
                    "SYNTHETIC_NATIVE_FAILURE {}",
                    bounded(&value.to_string(), 4096)
                );
            }
            if method == "permissions/requestApproval" && self.queue_file_approval(&value) {
                return;
            }
            if method == "item/commandExecution/requestApproval"
                && self.queue_command_approval(&value)
            {
                return;
            }
            if value.get("id").is_some() {
                // Unsupported native requests are declined without an unsandboxed fallback.
                let reply = if matches!(
                    method,
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                ) {
                    json!({"id":value["id"],"result":{"decision":"decline"}})
                } else {
                    json!({"id":value["id"],"error":{"code":-32601,"message":"This bridge does not grant permissions or synthesize human answers"}})
                };
                if self.enqueue(reply).is_err() {
                    self.stop("native_approval_response_unavailable");
                }
                let params = &value["params"];
                if let (Some(id), Ok(mut memory)) =
                    (params["threadId"].as_str(), self.memory.lock())
                {
                    if let Some(thread) = memory.threads.get_mut(id) {
                        let kind = match params["kind"].as_str() {
                            None => "default",
                            Some("command") => "command",
                            Some("writeStdin") => "writeStdin",
                            _ => "other",
                        };
                        let environment = match params["environmentId"].as_str() {
                            None => "default",
                            Some("local") => "local",
                            Some("default") => "default-id",
                            _ => "other",
                        };
                        let method = match method {
                            "item/commandExecution/requestApproval"
                            | "permissions/requestApproval"
                            | "item/fileChange/requestApproval"
                            | "execCommandApproval"
                            | "applyPatchApproval" => method,
                            _ => "unsupported-request",
                        };
                        let cwd_ok = params["cwd"]
                            .as_str()
                            .and_then(|cwd| Path::new(cwd).canonicalize().ok())
                            .is_some_and(|cwd| {
                                self.root
                                    .canonicalize()
                                    .is_ok_and(|root| cwd.starts_with(root))
                            });
                        let decisions_ok = params
                            .get("availableDecisions")
                            .filter(|value| !value.is_null())
                            .is_none_or(|value| {
                                value
                                    .as_array()
                                    .is_some_and(|items| items.iter().any(|item| item == "accept"))
                            });
                        thread.notice = Some(format!("Native approval declined (method={method}; kind={kind}; environment={environment}; cwd_in_workspace={cwd_ok}; command_present={}; item_valid={}; accept_available={decisions_ok}; worker_controls={}). No command, token or credential was logged.",
                            params["command"].as_str().is_some(), params["itemId"].as_str().is_some_and(token), self.ao_worker_command_approvals));
                    }
                }
            } else if let Ok(mut memory) = self.memory.lock() {
                apply_notification(&mut memory, method, &value["params"]);
            }
            return;
        }
        if let Some(id) = value["id"].as_u64() {
            let sender = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
            if let Some(sender) = sender {
                let result = if value.get("error").is_some() {
                    #[cfg(test)]
                    if std::env::var_os("NATIVE_CODEX_PROBE_BIN").is_some() {
                        eprintln!(
                            "Isolated bridge RPC error: {}",
                            bounded(&value["error"].to_string(), 2048)
                        );
                    }
                    Err(format!("Native RPC rejected (code {}). Inspect local runtime configuration; no automatic fallback",value["error"]["code"].as_i64().unwrap_or(-1)))
                } else {
                    value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Malformed native RPC response".into())
                };
                let _ = sender.try_send(result);
            }
        }
    }
    /// AO cards run unattended inside Codex's sandbox (unelevated on Windows): every command
    /// runs there without asking, reads reach the whole disk, writes stay inside the profile's
    /// boundary, and anything beyond it fails instead of waiting for a person. Other native
    /// connections keep asking.
    fn approval_policy(&self) -> &'static str {
        if self.ao_worker_command_approvals {
            "never"
        } else {
            "on-request"
        }
    }
    fn control(&self, request: &Control) -> Result<Value> {
        if !self.live.load(Ordering::SeqCst) {
            return Err("Native consent was revoked before submission".into());
        }
        let id = if request.operation == "start" {
            // Select only a locally approved built-in profile and require exact confirmation.
            // Never substitute an unsandboxed permission profile on native failure.
            let profile = self.options.permission_profile.as_str();
            let mut params = json!({"cwd":self.root,"model":self.options.model,
                "permissions":profile,"approvalPolicy":self.approval_policy(),"approvalsReviewer":"user","ephemeral":true,
                "developerInstructions":developer_instructions(profile)});
            if let Some(tokens) = self.options.context_window {
                params["config"] = json!({"model_context_window": tokens});
            }
            let value = self.rpc("thread/start", params)?;
            if value["activePermissionProfile"]["id"].as_str() != Some(profile) {
                self.stop("native_permission_profile_mismatch");
                return Err("Native runtime did not confirm the locally selected permission profile; no turn submitted".into());
            }
            let id = value["thread"]["id"]
                .as_str()
                .filter(|s| token(s))
                .ok_or("Native thread/start returned no valid thread ID")?
                .to_string();
            let mut memory = lock(&self.memory)?;
            if memory.threads.contains_key(&id) || memory.threads.len() >= MAX_THREADS {
                drop(memory);
                self.stop("native_thread_identity_conflict");
                return Err("Native thread identity conflict".into());
            }
            memory.threads.insert(
                id.clone(),
                ThreadState {
                    id: id.clone(),
                    status: "idle".into(),
                    started_at_ms: unix_ms(),
                    ..Default::default()
                },
            );
            id
        } else {
            request.thread_id.clone().ok_or("Missing thread")?
        };
        if matches!(request.operation.as_str(), "interrupt" | "close") {
            let state = lock(&self.memory)?
                .threads
                .get(&id)
                .ok_or("Thread not owned")?
                .status
                .clone();
            if request.operation == "close"
                && !matches!(
                    state.as_str(),
                    "idle" | "completed" | "interrupted" | "failed"
                )
            {
                return Err("Interrupt and confirm a terminal turn before closing; local Stop disconnects all threads immediately".into());
            }
            if request.operation == "interrupt" && state == "compacting" {
                self.stop("compaction_interrupt_stopped_connection");
                return Ok(
                    json!({"ok":true,"thread_id":id,"state":"connection_stopped","affects_all_threads":true,"request_id":request.request_id}),
                );
            }
            let turn = {
                let memory = lock(&self.memory)?;
                let thread = memory.threads.get(&id).ok_or("Thread not owned")?;
                if matches!(
                    thread.status.as_str(),
                    "inProgress" | "starting" | "compacting" | "interrupt_requested"
                ) {
                    thread.turn_id.clone()
                } else {
                    None
                }
            };
            if let Some(turn) = turn {
                self.rpc("turn/interrupt", json!({"threadId":id,"turnId":turn}))?;
                if let Some(thread) = lock(&self.memory)?.threads.get_mut(&id) {
                    if thread.status == "inProgress" {
                        thread.status = "interrupt_requested".into();
                    }
                }
            }
            if request.operation == "close" {
                // Unsubscribe removes no saved files. Once the native runtime confirms it,
                // release this in-memory ownership slot so long-lived connections are not
                // limited to four lifetime threads. The close request remains replay-safe
                // through the bounded request ledger.
                self.rpc("thread/unsubscribe", json!({"threadId":id}))?;
                lock(&self.memory)?.threads.remove(&id);
            }
            return Ok(
                json!({"ok":true,"thread_id":id,"operation":request.operation,"request_id":request.request_id,
                "cancellation_note":"A signal/acknowledgment is not rollback of submitted effects; inspect thread status"}),
            );
        }
        {
            let mut memory = lock(&self.memory)?;
            let thread = memory.threads.get_mut(&id).ok_or("Thread not owned")?;
            if !matches!(
                thread.status.as_str(),
                "idle" | "completed" | "interrupted" | "failed"
            ) {
                return Err("Thread already has an active operation".into());
            }
            thread.status = if request.operation == "compact" {
                "compacting"
            } else {
                "starting"
            }
            .into();
            thread.turn_id = None;
            thread.answer.clear();
            thread.item_id.clear();
            thread.answer_truncated = false;
            thread.notice = None;
        }
        let result = match request.operation.as_str() {
            "compact" => self.rpc("thread/compact/start", json!({"threadId":id})),
            "review" => self.rpc(
                "review/start",
                json!({"threadId":id,"delivery":"inline",
                "target":{"type":"custom","instructions":request.text}}),
            ),
            _ => {
                let mut params = json!({"threadId":id,"input":[{"type":"text","text":request.text}],
                // Reassert the same supported boundary on every turn, including send.
                "permissions":self.options.permission_profile,"approvalsReviewer":"user",
                "cwd":self.root,"model":self.options.model,"approvalPolicy":self.approval_policy()});
                if let Some(effort) = &self.options.effort {
                    params["effort"] = json!(effort);
                }
                self.rpc("turn/start", params)
            }
        };
        match result {
            Ok(value) => {
                if request.operation == "review"
                    && value["reviewThreadId"].as_str().is_some_and(|r| r != id)
                {
                    self.stop("native_review_scope_mismatch");
                    return Err("Native review escaped the owned thread; connection stopped".into());
                }
                if let Some(turn) = value["turn"]["id"].as_str() {
                    if !token(turn) {
                        self.stop("invalid_native_turn_id");
                        return Err("Invalid native turn ID".into());
                    }
                    if let Some(thread) = lock(&self.memory)?.threads.get_mut(&id) {
                        // A completion notification can precede this response. Never regress it.
                        if thread.turn_id.as_deref() != Some(turn) {
                            thread.turn_id = Some(turn.into());
                            thread.status = "inProgress".into();
                        }
                    }
                }
                Ok(
                    json!({"ok":true,"thread_id":id,"operation":request.operation,"request_id":request.request_id,
                    "state":"submitted","model_usage_possible":true}),
                )
            }
            Err(error) => {
                if let Some(thread) = lock(&self.memory)?.threads.get_mut(&id) {
                    if matches!(thread.status.as_str(), "starting" | "compacting") {
                        thread.status = "failed".into();
                    }
                }
                Err(error)
            }
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop("bridge_dropped");
    }
}

fn apply_notification(memory: &mut Memory, method: &str, params: &Value) {
    let Some(id) = params["threadId"].as_str() else {
        return;
    };
    let Some(thread) = memory.threads.get_mut(id) else {
        return;
    };
    if thread.status == "closed" {
        return;
    }
    let now = unix_ms();
    thread.last_event_at_ms = now;
    if let Some(activity) = activity_for(method, params) {
        thread.activity = Some(activity.into());
        thread.activity_at_ms = now;
    }
    match method {
        "item/started" | "item/completed" if params["item"]["type"] == "enteredReviewMode" => {
            // Inline review emits its parent item before the delegate's start event.
            // Pin it even when the review/start response has not arrived yet.
            if thread.status == "starting" && thread.turn_id.is_none() {
                if let Some(turn) = params["turnId"].as_str().filter(|s| token(s)) {
                    thread.turn_id = Some(turn.into());
                }
            }
        }
        "turn/started" => {
            if let Some(turn) = params["turn"]["id"].as_str().filter(|s| token(s)) {
                // Codex forwards a review delegate's start under the parent thread.
                // It must not replace the authoritative outer review/turn identity.
                if thread
                    .turn_id
                    .as_deref()
                    .is_some_and(|active| active != turn)
                {
                    return;
                }
                if thread.turn_id.as_deref() == Some(turn)
                    && matches!(
                        thread.status.as_str(),
                        "completed" | "interrupted" | "failed"
                    )
                {
                    return;
                }
                thread.turn_id = Some(turn.into());
                thread.status = "inProgress".into();
            }
        }
        "turn/completed" => {
            if let Some(turn) = params["turn"]["id"].as_str().filter(|s| token(s)) {
                if thread
                    .turn_id
                    .as_deref()
                    .is_none_or(|before| before == turn)
                {
                    thread.turn_id = Some(turn.into());
                    thread.status = match params["turn"]["status"].as_str() {
                        Some("completed") => "completed",
                        Some("interrupted") => "interrupted",
                        _ => "failed",
                    }
                    .into();
                    if thread.status == "failed" {
                        if let Some(message) = params["turn"]["error"]["message"].as_str() {
                            let mut notice = message.to_owned();
                            crate::tools::history::redact_text(&mut notice);
                            thread.notice = Some(bounded(&notice, 2048));
                        }
                    }
                }
            }
        }
        "item/agentMessage/delta" => {
            if params["turnId"].as_str() != thread.turn_id.as_deref() {
                return;
            }
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str())
            {
                if !token(item) {
                    return;
                }
                if thread.item_id != item {
                    thread.item_id = item.into();
                    thread.answer.clear();
                    thread.answer_truncated = false;
                }
                let kept = bounded(delta, MAX_TEXT.saturating_sub(thread.answer.len()));
                thread.answer_truncated |= kept.len() != delta.len();
                thread.answer.push_str(&kept);
            }
        }
        "item/completed" if params["item"]["type"] == "agentMessage" => {
            if params["turnId"].as_str() != thread.turn_id.as_deref() {
                return;
            }
            if let (Some(item), Some(text)) = (
                params["item"]["id"].as_str(),
                params["item"]["text"].as_str(),
            ) {
                if !token(item) {
                    return;
                }
                thread.item_id = item.into();
                thread.answer = bounded(text, MAX_TEXT);
                thread.answer_truncated = text.len() > MAX_TEXT;
            }
        }
        "item/completed" if params["item"]["type"] == "exitedReviewMode" => {
            if params["turnId"].as_str() != thread.turn_id.as_deref() {
                return;
            }
            if let (Some(item), Some(review)) = (
                params["item"]["id"].as_str().filter(|s| token(s)),
                params["item"]["review"].as_str(),
            ) {
                thread.item_id = item.into();
                thread.answer = bounded(review, MAX_TEXT);
                thread.answer_truncated = review.len() > MAX_TEXT;
            }
        }
        "item/completed" if params["item"]["type"] == "contextCompaction" => {
            if thread.status == "compacting" {
                thread.status = "idle".into();
            }
        }
        "thread/compacted" if thread.status == "compacting" => {
            thread.status = "idle".into();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_external_write_requires_one_existing_file() {
        let file = std::env::current_exe().expect("test binary path");
        let outside_root = file.parent().unwrap().join("unrelated-workspace");
        std::fs::create_dir_all(&outside_root).unwrap();
        let request = json!({"fileSystem":{"entries":[{
            "access":"write","path":{"type":"path","path":file}
        }]}});
        assert_eq!(
            exact_external_write(&outside_root, &request),
            file.canonicalize().ok()
        );
        assert!(exact_external_write(file.parent().unwrap(), &request).is_none());
        let mut network = request.clone();
        network["network"] = json!({"enabled":true});
        let mut read = request.clone();
        read["fileSystem"]["entries"][0]["access"] = json!("read");
        let mut glob = request.clone();
        glob["fileSystem"]["entries"][0]["path"] = json!({"type":"glob_pattern","pattern":"**"});
        let mut folder = request.clone();
        folder["fileSystem"]["entries"][0]["path"]["path"] = json!(file.parent().unwrap());
        let mut multiple = request.clone();
        multiple["fileSystem"]["entries"]
            .as_array_mut()
            .unwrap()
            .push(request["fileSystem"]["entries"][0].clone());
        for denied in [network, read, glob, folder, multiple] {
            assert!(exact_external_write(&outside_root, &denied).is_none());
        }
    }
    #[test]
    fn native_bridge_control_scope_and_limits() {
        let good = Control {
            operation: "start".into(),
            request_id: "test-1".into(),
            thread_id: None,
            text: Some("Review without edits".into()),
        };
        assert!(validate_control(&good).unwrap());
        let mut bad = good.clone();
        bad.operation = "thread/delete".into();
        assert!(validate_control(&bad).is_err());
        bad = good.clone();
        bad.thread_id = Some("foreign".into());
        assert!(validate_control(&bad).is_err());
        bad = good.clone();
        bad.operation = "send".into();
        assert!(validate_control(&bad).is_err());
        bad = good.clone();
        bad.text = Some("x".repeat(16001));
        assert!(validate_control(&bad).is_err());
        assert!(serde_json::from_value::<Control>(
            json!({"operation":"start","request_id":"a","text":"x","approvalPolicy":"never"})
        )
        .is_err());
        let hub = Hub::default();
        assert_eq!(hub.status().unwrap()["model_usage_enabled"], false);
        assert!(hub.admit(good.clone()).is_err());
        assert!(hub.read("foreign").is_err());
        let mut memory = Memory::default();
        let mut options = Connection {
            executable: PathBuf::new(),
            expected_sha256: String::new(),
            codex_home: PathBuf::new(),
            allow_model_usage: false,
            allow_command_execution: false,
            permission_profile: default_permission_profile(),
            model: "fixture".into(),
            request_limit: 1,
            lifetime_seconds: 30,
            effort: None,
            context_window: None,
        };
        assert!(reserve(&mut memory, &good, true, &options, true, true).is_err());
        assert_eq!(memory.requests_used, 0);
        assert!(memory.ledger.is_empty());
        options.allow_model_usage = true;
        assert!(reserve(&mut memory, &good, true, &options, true, true)
            .unwrap()
            .is_none());
        assert_eq!(memory.requests_used, 1);
        assert!(reserve(&mut memory, &good, true, &options, false, false)
            .unwrap()
            .is_some());
        assert_eq!(memory.requests_used, 1); // Same request is a cached result, never a new model call.
        let mut changed = good.clone();
        changed.text = Some("different".into());
        assert!(reserve(&mut memory, &changed, true, &options, true, true).is_err());
        changed.request_id = "test-2".into();
        assert!(reserve(&mut memory, &changed, true, &options, true, true).is_err());
    }
    #[test]
    fn native_bridge_accepts_web_gpt_model_without_widening_rpc_tokens() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../aiTemp/ao-model-validation");
        let root = base.join("workspace");
        let home = base.join("home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let executable = std::env::current_exe().unwrap();
        let expected_sha256 = format!("{:x}", Sha256::digest(std::fs::read(&executable).unwrap()));
        let options = Connection {
            executable,
            expected_sha256,
            codex_home: home.canonicalize().unwrap(),
            allow_model_usage: true,
            allow_command_execution: false,
            permission_profile: ":read-only".into(),
            model: "chatgpt-web/high".into(),
            request_limit: 1,
            lifetime_seconds: 30,
            effort: None,
            context_window: None,
        };
        assert!(checked_options(&root.canonicalize().unwrap(), options).is_ok());
        assert!(!token("thread/foreign"));
    }

    #[test]
    fn ao_private_cpa_key_is_only_in_the_ao_child_environment() {
        let options = Connection {
            executable: PathBuf::from("codex"),
            expected_sha256: "0".repeat(64),
            codex_home: PathBuf::from("ao-home"),
            allow_model_usage: true,
            allow_command_execution: false,
            permission_profile: ":read-only".into(),
            model: "gemini-3.8-flash-high".into(),
            request_limit: 1,
            lifetime_seconds: 30,
            effort: None,
            context_window: None,
        };
        let regular = native_child_command(&options, Path::new("aiTemp"), None, false);
        let ao = native_child_command(&options, Path::new("aiTemp"), Some("SENTINEL_KEY"), false);
        let key = std::ffi::OsStr::new("CODING_TOOLS_AO_CPA_KEY");
        assert!(!regular.get_envs().any(|(name, _)| name == key));
        assert_eq!(
            ao.get_envs()
                .find(|(name, _)| *name == key)
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new("SENTINEL_KEY"))
        );
        assert!(ao
            .get_args()
            .all(|arg| !arg.to_string_lossy().contains("SENTINEL_KEY")));
        let web = native_child_command(&options, Path::new("aiTemp"), None, true);
        assert_eq!(
            web.get_envs()
                .find(|(name, _)| *name == std::ffi::OsStr::new("CODING_TOOLS_AO_WEB_KEY"))
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new("loopback-ao-web"))
        );
        assert!(!web.get_envs().any(|(name, _)| name == key));
    }

    #[test]
    fn ao_children_may_use_the_workspace_profile_without_an_admin_sandbox() {
        let mut options = Connection {
            executable: PathBuf::from("codex"),
            expected_sha256: "0".repeat(64),
            codex_home: PathBuf::from("ao-home"),
            allow_model_usage: true,
            allow_command_execution: false,
            permission_profile: ":workspace".into(),
            model: "chatgpt-web/extra-high".into(),
            request_limit: 1,
            lifetime_seconds: 30,
            effort: None,
            context_window: None,
        };
        assert!(ao_permission_allowed(&options));
        options.allow_command_execution = true;
        assert!(!ao_permission_allowed(&options));
        options.allow_command_execution = false;
        options.permission_profile = ":danger-full-access".into();
        assert!(!ao_permission_allowed(&options));
        options.permission_profile = ":workspace".into();
        let sandbox = |command: &Command| {
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .find(|arg| arg.starts_with("windows.sandbox="))
        };
        #[cfg(windows)]
        {
            // Each AO card has its own CODEX_HOME, so AO children never need the admin setup.
            assert_eq!(
                sandbox(&native_child_command(
                    &options,
                    Path::new("aiTemp"),
                    None,
                    true
                ))
                .as_deref(),
                Some("windows.sandbox=unelevated")
            );
            assert_eq!(
                sandbox(&native_child_command(
                    &options,
                    Path::new("aiTemp"),
                    Some("K"),
                    false
                ))
                .as_deref(),
                Some("windows.sandbox=unelevated")
            );
            assert_eq!(
                sandbox(&native_child_command(
                    &options,
                    Path::new("aiTemp"),
                    None,
                    false
                ))
                .as_deref(),
                Some("windows.sandbox=elevated")
            );
        }
        options.permission_profile = ":read-only".into();
        assert_eq!(
            sandbox(&native_child_command(
                &options,
                Path::new("aiTemp"),
                None,
                true
            )),
            None
        );
        assert!(developer_instructions(":workspace")
            .contains("delete files inside the working directory"));
        assert!(developer_instructions(":read-only").contains("Never delete files"));
    }

    #[test]
    fn native_bridge_zero_request_limit_and_rotating_replay_ledger_are_long_lived() {
        let request = Control {
            operation: "start".into(),
            request_id: "unbounded-1".into(),
            thread_id: None,
            text: Some("Review without edits".into()),
        };
        let options = Connection {
            executable: PathBuf::new(),
            expected_sha256: String::new(),
            codex_home: PathBuf::new(),
            allow_model_usage: true,
            allow_command_execution: false,
            permission_profile: default_permission_profile(),
            model: "fixture".into(),
            request_limit: 0,
            lifetime_seconds: 0,
            effort: None,
            context_window: None,
        };
        let mut memory = Memory {
            requests_used: 25,
            ..Default::default()
        };
        assert!(reserve(&mut memory, &request, true, &options, true, true)
            .unwrap()
            .is_none());
        assert_eq!(memory.requests_used, 26);

        let now = Instant::now();
        memory.ledger.clear();
        for index in 0..MAX_LEDGER {
            memory.ledger.insert(
                format!("old-{index:03}"),
                LedgerEntry {
                    fingerprint: format!("fp-{index}"),
                    result: Some(json!({"ok":true})),
                    completed_at: Some(now - LEDGER_RETENTION - Duration::from_secs(1)),
                },
            );
        }
        let fresh = Control {
            request_id: "fresh-after-expiry".into(),
            ..request.clone()
        };
        assert!(reserve(&mut memory, &fresh, true, &options, true, true)
            .unwrap()
            .is_none());
        assert_eq!(memory.ledger.len(), 1);

        memory.ledger.clear();
        for index in 0..MAX_LEDGER {
            memory.ledger.insert(
                format!("pending-{index:03}"),
                LedgerEntry {
                    fingerprint: format!("pending-fp-{index}"),
                    result: None,
                    completed_at: None,
                },
            );
        }
        let blocked = Control {
            request_id: "blocked-by-pending".into(),
            ..request
        };
        assert!(reserve(&mut memory, &blocked, true, &options, true, true).is_err());
        assert_eq!(memory.ledger.len(), MAX_LEDGER);
    }

    #[test]
    fn ao_command_approval_is_bounded_and_always_a_single_decision() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../aiTemp/ao-command-approval-test");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let params = json!({"itemId":"command-1","command":"Get-Content tool-check.txt","cwd":root,
            "kind":"command","availableDecisions":["accept","acceptForSession","decline"],"additionalPermissions":null});
        let (cwd, command, permissions) = command_approval_details(&root, &params).unwrap();
        let mut local = params.clone();
        local["environmentId"] = json!("local");
        assert!(command_approval_details(&root, &local).is_some());
        let mut request = NativeApproval {
            rpc_id: json!(0),
            path: cwd.clone(),
            canonical: cwd,
            command: Some(command),
            permissions,
            thread_id: "thread-one".into(),
            turn_id: "turn-one".into(),
            reason: "Read fixture".into(),
            expires_at: Instant::now() + Duration::from_secs(120),
        };
        assert_eq!(
            request.reply(true),
            json!({"id":0,"result":{"decision":"accept"}})
        );
        assert_eq!(
            request.reply(false),
            json!({"id":0,"result":{"decision":"decline"}})
        );
        assert!(request.target_is_current(&root, true));
        assert!(!request.target_is_current(&root, false));
        assert!(!request.target_is_current(&root.join("another-workspace"), true));
        request.expires_at = Instant::now() - Duration::from_secs(1);
        assert!(!request.target_is_current(&root, true));
        for (key, value) in [
            ("kind", json!("writeStdin")),
            ("cwd", json!(root.parent().unwrap())),
            ("environmentId", json!("remote-env")),
            ("availableDecisions", json!(["acceptForSession"])),
            ("command", json!("x".repeat(4097))),
            ("command", json!("bad\u{1b}command")),
        ] {
            let mut bad = params.clone();
            bad[key] = value;
            assert!(command_approval_details(&root, &bad).is_none());
        }
    }

    #[test]
    fn native_bridge_tracks_the_current_step_without_command_text() {
        let mut memory = Memory::default();
        memory.threads.insert(
            "owned".into(),
            ThreadState {
                id: "owned".into(),
                status: "inProgress".into(),
                turn_id: Some("t".into()),
                ..Default::default()
            },
        );
        apply_notification(
            &mut memory,
            "item/started",
            &json!({"threadId":"owned","turnId":"t",
            "item":{"id":"i1","type":"commandExecution","command":"type secret.txt"}}),
        );
        let thread = &memory.threads["owned"];
        assert_eq!(thread.activity.as_deref(), Some("running a command"));
        assert!(thread.activity_at_ms > 0 && thread.last_event_at_ms >= thread.activity_at_ms);
        let status = serde_json::to_string(thread).unwrap();
        assert!(
            !status.contains("secret.txt"),
            "only the kind of step is kept"
        );
        apply_notification(
            &mut memory,
            "item/agentMessage/delta",
            &json!({"threadId":"owned","turnId":"t","itemId":"i2","delta":"Hello"}),
        );
        assert_eq!(
            memory.threads["owned"].activity.as_deref(),
            Some("running a command"),
            "a delta updates when it was last heard, not the step"
        );
        apply_notification(
            &mut memory,
            "item/started",
            &json!({"threadId":"owned","turnId":"t","item":{"id":"i3","type":"reasoning"}}),
        );
        assert_eq!(
            memory.threads["owned"].activity.as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn native_bridge_keeps_safe_failed_turn_notice() {
        let mut memory = Memory::default();
        memory.threads.insert(
            "owned".into(),
            ThreadState {
                id: "owned".into(),
                status: "inProgress".into(),
                turn_id: Some("t".into()),
                ..Default::default()
            },
        );
        apply_notification(
            &mut memory,
            "turn/completed",
            &json!({"threadId":"owned",
            "turn":{"id":"t","status":"failed","error":{"message":"Proxy returned 407; Bearer private-test-token"}}}),
        );
        assert_eq!(
            memory.threads["owned"].notice.as_deref(),
            Some("Proxy returned 407; Bearer [REDACTED]")
        );
        apply_notification(
            &mut memory,
            "turn/completed",
            &json!({"threadId":"owned",
            "turn":{"id":"foreign","status":"failed","error":{"message":"Wrong turn"}}}),
        );
        assert_eq!(
            memory.threads["owned"].notice.as_deref(),
            Some("Proxy returned 407; Bearer [REDACTED]")
        );
    }

    #[test]
    fn native_bridge_notifications_preserve_completion_and_owned_scope() {
        let mut memory = Memory::default();
        memory.threads.insert(
            "owned".into(),
            ThreadState {
                id: "owned".into(),
                status: "starting".into(),
                ..Default::default()
            },
        );
        apply_notification(
            &mut memory,
            "turn/started",
            &json!({"threadId":"foreign","turn":{"id":"t"}}),
        );
        assert_eq!(memory.threads.len(), 1);
        apply_notification(
            &mut memory,
            "turn/completed",
            &json!({"threadId":"owned","turn":{"id":"t","status":"completed"}}),
        );
        apply_notification(
            &mut memory,
            "turn/started",
            &json!({"threadId":"owned","turn":{"id":"t"}}),
        );
        assert_eq!(memory.threads["owned"].status, "completed");
        apply_notification(
            &mut memory,
            "turn/completed",
            &json!({"threadId":"owned","turn":{"id":"old","status":"failed"}}),
        );
        assert_eq!(memory.threads["owned"].status, "completed");
        apply_notification(
            &mut memory,
            "item/agentMessage/delta",
            &json!({"threadId":"owned","turnId":"t","itemId":"i","delta":"reply"}),
        );
        apply_notification(
            &mut memory,
            "item/completed",
            &json!({"threadId":"owned","turnId":"t","item":{"id":"i","type":"agentMessage","text":"reply complete"}}),
        );
        assert_eq!(memory.threads["owned"].answer, "reply complete");
        apply_notification(
            &mut memory,
            "item/reasoning/textDelta",
            &json!({"threadId":"owned","delta":"not exposed"}),
        );
        assert_eq!(memory.threads["owned"].answer, "reply complete");
    }
    #[test]
    fn native_bridge_unicode_output_is_bounded() {
        let text = "繁體中文".repeat(MAX_TEXT);
        let mut memory = Memory::default();
        memory.threads.insert(
            "owned".into(),
            ThreadState {
                id: "owned".into(),
                status: "inProgress".into(),
                turn_id: Some("t".into()),
                ..Default::default()
            },
        );
        apply_notification(
            &mut memory,
            "item/agentMessage/delta",
            &json!({"threadId":"owned","turnId":"t","itemId":"i","delta":text}),
        );
        assert!(memory.threads["owned"].answer.len() <= MAX_TEXT);
        assert!(memory.threads["owned"].answer_truncated);
        assert!(std::str::from_utf8(memory.threads["owned"].answer.as_bytes()).is_ok());
    }
    #[test]
    #[ignore = "requires the explicitly hash-verified native Codex test binary; no model turn is sent"]
    fn native_bridge_actual_app_server_handshake_and_revocation() {
        let executable = PathBuf::from(
            std::env::var("NATIVE_CODEX_PROBE_BIN").expect("NATIVE_CODEX_PROBE_BIN is required"),
        );
        let expected_sha256 =
            std::env::var("NATIVE_CODEX_PROBE_SHA256").expect("Native binary hash is required");
        let base = std::env::current_dir()
            .unwrap()
            .join("aiTemp/native-probe")
            .join(format!("{}", std::process::id()));
        let root = base.join("workspace");
        let home = base.join("native-home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = root.canonicalize().unwrap();
        let home = home.canonicalize().unwrap();
        let hub = Hub::default();
        hub.connect(
            &root,
            Connection {
                executable,
                expected_sha256,
                codex_home: home,
                allow_model_usage: false,
                allow_command_execution: false,
                permission_profile: default_permission_profile(),
                model: "no-model-request".into(),
                request_limit: 1,
                lifetime_seconds: 30,
                effort: None,
                context_window: None,
            },
        )
        .unwrap();
        assert_eq!(hub.initialize().unwrap()["connected"], true);
        assert!(hub
            .admit(Control {
                operation: "start".into(),
                request_id: "must-not-run".into(),
                thread_id: None,
                text: Some("Never submitted".into())
            })
            .is_err());
        assert_eq!(hub.status().unwrap()["requests_used"], 0);
        hub.cancel("workspace_policy_changed");
        let status = hub.status().unwrap();
        assert_eq!(status["connected"], false);
        assert_eq!(status["stop_reason"], "workspace_policy_changed");
        hub.disconnect();
        assert_eq!(hub.status().unwrap()["connected"], false);
        println!("PASS: actual native initialize/initialized, model consent denial before submission, zero model-control requests and owned-process revocation");
    }
}

#[cfg(test)]
#[path = "../../../aiTemp/release-verification/native_turn_fixture.rs"]
mod native_turn_fixture;

/// Consumes the remainder of an oversized line without holding it in memory.
fn skip_rest_of_line<R: BufRead>(reader: &mut R) -> std::io::Result<()> {
    let mut chunk = Vec::new();
    loop {
        chunk.clear();
        if (&mut *reader)
            .take(64 * 1024)
            .read_until(b'\n', &mut chunk)?
            == 0
        {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        if chunk.last() == Some(&b'\n') {
            return Ok(());
        }
    }
}

/// The numeric id of a JSON-RPC reply (`{"id":N,...}`) read from the start of its line. Requests
/// and notifications put "method" first or carry no top-level id, so they are not matched.
fn reply_id(prefix: &[u8]) -> Option<u64> {
    let head = &prefix[..prefix.len().min(512)];
    let valid = match std::str::from_utf8(head) {
        Ok(text) => text,
        Err(error) => std::str::from_utf8(&head[..error.valid_up_to()]).ok()?,
    };
    let rest = valid.trim_start().strip_prefix('{')?.trim_start();
    let rest = rest
        .strip_prefix("\"jsonrpc\":\"2.0\",")
        .map(str::trim_start)
        .unwrap_or(rest);
    let digits = rest.strip_prefix("\"id\":")?.trim_start();
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let id = digits[..end].parse().ok()?;
    // `{"id":N,"method":...}` is a request from the server, not a reply.
    (!digits[end..]
        .trim_start()
        .trim_start_matches(',')
        .trim_start()
        .starts_with("\"method\""))
    .then_some(id)
}

#[cfg(test)]
mod frame_tests {
    use super::{reply_id, skip_rest_of_line};

    #[test]
    fn reply_ids_are_read_only_from_top_level_replies() {
        assert_eq!(reply_id(br#"{"id":42,"result":{"output":"..."#), Some(42));
        assert_eq!(reply_id(br#"{"jsonrpc":"2.0","id":7,"result":"#), Some(7));
        assert_eq!(
            reply_id(br#"{"method":"item/completed","params":{"id":3"#),
            None
        );
        assert_eq!(
            reply_id(br#"{"id":9,"method":"item/commandExecution/requestApproval""#),
            None
        );
    }

    #[test]
    fn the_rest_of_an_oversized_line_is_skipped_and_the_next_line_kept() {
        let data = format!("{}\n{{\"id\":1}}\n", "x".repeat(300_000));
        let mut reader = std::io::BufReader::new(data.as_bytes());
        skip_rest_of_line(&mut reader).unwrap();
        let mut next = String::new();
        std::io::BufRead::read_line(&mut reader, &mut next).unwrap();
        assert_eq!(next, "{\"id\":1}\n");
        assert!(skip_rest_of_line(&mut std::io::BufReader::new(&b"no newline"[..])).is_err());
    }
}
