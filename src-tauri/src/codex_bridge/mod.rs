//! Explicitly opted-in native Codex App Server sessions. No hidden model calls or RPC proxy.
mod process;
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
    time::{Duration, Instant},
};

pub const PROTOCOL_SOURCE: &str = "721f46a07ab48f00b5e7cdbf2efb78b993d100de";
const MAX_FRAME: usize = 512 * 1024;
const MAX_TEXT: usize = 64 * 1024;
const MAX_THREADS: usize = 4;
const MAX_LEDGER: usize = 64;
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub executable: PathBuf,
    pub expected_sha256: String,
    pub codex_home: PathBuf,
    pub allow_model_usage: bool,
    pub model: String,
    pub request_limit: u32,
    pub lifetime_seconds: u64,
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
}
#[derive(Default)]
struct Memory {
    threads: BTreeMap<String, ThreadState>,
    ledger: BTreeMap<String, (String, Option<Value>)>,
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
    started: Instant,
    live: AtomicBool,
    ready: AtomicBool,
    next_id: AtomicU64,
    process: Mutex<OwnedProcess>,
    outgoing: SyncSender<Value>,
    pending: Mutex<BTreeMap<u64, SyncSender<Result<Value>>>>,
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
fn checked_options(root: &Path, mut options: Connection) -> Result<Connection> {
    if !options.executable.is_absolute()
        || !options.codex_home.is_absolute()
        || !(1..=20).contains(&options.request_limit)
        || !(30..=900).contains(&options.lifetime_seconds)
        || !token(&options.model)
        || options.expected_sha256.len() != 64
        || !options
            .expected_sha256
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err(
            "Use absolute native paths, a SHA-256, model ID, 1–20 requests and 30–900 seconds"
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
    if let Some((before, result)) = memory.ledger.get(&request.request_id) {
        if before != &fingerprint {
            return Err("request_id already belongs to different arguments".into());
        }
        Ok(Some(result.clone().unwrap_or_else(
            || json!({"state":"pending","request_id":request.request_id,"replayed":false}),
        )))
    } else {
        if !live || !ready {
            return Err(
                "Native connection is stopped or not initialized; do not replay an unknown outcome"
                    .into(),
            );
        }
        if memory.ledger.len() >= MAX_LEDGER {
            return Err("Connection request ledger is full; no request submitted".into());
        }
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
            if memory.requests_used >= options.request_limit {
                return Err("Local model-request limit reached".into());
            }
            memory.requests_used += 1;
        }
        memory
            .ledger
            .insert(request.request_id.clone(), (fingerprint, None));
        Ok(None)
    }
}

impl Hub {
    /// Local desktop admission only. Caller must hold the listener's current policy fence.
    /// Returns before the handshake; a later policy change can cancel the provisional child.
    pub fn connect(&self, root: &Path, options: Connection) -> Result<()> {
        let options = checked_options(root, options)?;
        let mut current = lock(&self.current)?;
        if current.is_some() {
            return Err("Disconnect the existing native session before reconnecting".into());
        }
        let temp = options.codex_home.join("aiTemp");
        std::fs::create_dir_all(&temp).map_err(|_| "Cannot prepare dedicated aiTemp directory")?;
        let mut command = Command::new(&options.executable);
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
            if let Some(v) = std::env::var_os(key) {
                command.env(key, v);
            }
        }
        command
            .env("CODEX_HOME", &options.codex_home)
            .env("TMPDIR", &temp)
            .env("TMP", &temp)
            .env("TEMP", &temp)
            .env("OTEL_SDK_DISABLED", "true")
            .env("DO_NOT_TRACK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
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
            started: Instant::now(),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            process: Mutex::new(process),
            outgoing: tx,
            pending: Mutex::new(BTreeMap::new()),
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
                if result.is_err()
                    || line.is_empty()
                    || line.len() > MAX_FRAME
                    || line.last() != Some(&b'\n')
                {
                    bridge.stop("native_output_disconnected_or_frame_limit");
                    break;
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
        let weak = Arc::downgrade(&bridge);
        let lifetime = bridge.options.lifetime_seconds;
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
                json!({"connected":false,"model_usage_enabled":false,"implementation":"native_app_server_opt_in",
                "protocol_source":PROTOCOL_SOURCE,"native_sandbox_verified":false}),
            );
        };
        let memory = lock(&bridge.memory)?;
        Ok(
            json!({"connected":bridge.live.load(Ordering::SeqCst)&&bridge.ready.load(Ordering::SeqCst),
            "model_usage_enabled":bridge.live.load(Ordering::SeqCst)&&bridge.options.allow_model_usage,
            "native_identity":memory.native_identity,"executable_sha256":bridge.options.expected_sha256,
            "model":bridge.options.model,"requests_used":memory.requests_used,"request_limit":bridge.options.request_limit,
            "seconds_remaining":bridge.options.lifetime_seconds.saturating_sub(bridge.started.elapsed().as_secs()),
            "stop_reason":memory.stop_reason,"threads":memory.threads.values().map(|t|json!({"id":t.id,"status":t.status,"turn_id":t.turn_id})).collect::<Vec<_>>(),
            "requested_sandbox":"read-only","native_sandbox_verified":false,"protocol_source":PROTOCOL_SOURCE,
            "storage":"bounded_bridge_memory; native runtime and provider retention are separate",
            "limits_note":"Request count and lifetime are not a token, cost or native subagent budget"}),
        )
    }
    pub fn read(&self, id: &str) -> Result<Value> {
        let bridge = self.bridge()?;
        let memory = lock(&bridge.memory)?;
        let thread = memory
            .threads
            .get(id)
            .ok_or("Thread is not owned by this listener connection")?;
        serde_json::to_value(thread).map_err(|_| "Cannot serialize native thread state".into())
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
                entry.1 = Some(stored.clone());
            }
        }
        // Return the exact stored result on both the first call and retry, including failures.
        Ok(stored)
    }
}
impl Bridge {
    fn enqueue(&self, value: Value) -> Result<()> {
        if self.started.elapsed() >= Duration::from_secs(self.options.lifetime_seconds) {
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
        if let Ok(mut process) = self.process.lock() {
            process.stop();
        }
    }
    fn receive(&self, value: Value) {
        if let Some(method) = value["method"].as_str() {
            if value.get("id").is_some() {
                // No server-supplied command or permission request becomes a local approval.
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
                        thread.notice=Some("Native permission or unsupported human-input request was declined; use the local Codex UI for unsupported interactions".into());
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
                        eprintln!("Isolated bridge RPC error: {}", bounded(&value["error"].to_string(), 2048));
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
    fn control(&self, request: &Control) -> Result<Value> {
        if !self.live.load(Ordering::SeqCst) {
            return Err("Native consent was revoked before submission".into());
        }
        let id = if request.operation == "start" {
            // Named permissions replace removed readOnly.access in native 0.153.4.
            // A fresh profile avoids inheriting another configured profile's rules.
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock unavailable")?
                .as_nanos();
            let profile = format!("coding_tools_readonly_{}_{nonce}", std::process::id());
            let value = self.rpc("thread/start", json!({"cwd":self.root,"model":self.options.model,
                "permissions":profile,
                "config":{"permissions":{(profile.clone()):{
                    "filesystem":{":root":"deny",":minimal":"read",":workspace_roots":{".":"read"}},
                    "network":{"enabled":false}}}},
                "approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true,
                "developerInstructions":"Work only on the explicitly requested task. Never delete files; use Trash for unwanted files and aiTemp for temporary files. Do not change permissions or use unsandboxed fallbacks. Explain evidence and uncertainty. Do not launch extra agents unless explicitly requested."}))?;
            if value["activePermissionProfile"]["id"].as_str() != Some(profile.as_str()) {
                self.stop("native_permission_profile_mismatch");
                return Err("Native runtime did not confirm the requested read-only profile; no turn submitted".into());
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
                // Unsubscribe removes no saved files. The shared process is stopped on local
                // disconnect/expiry; no native thread archive/delete method is exposed.
                self.rpc("thread/unsubscribe", json!({"threadId":id}))?;
                if let Some(thread) = lock(&self.memory)?.threads.get_mut(&id) {
                    thread.status = "closed".into();
                }
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
            _ => self.rpc(
                "turn/start",
                json!({"threadId":id,"input":[{"type":"text","text":request.text}],
                // Inherit the confirmed thread-scoped profile; never reset it to legacy broad reads.
                "cwd":self.root,"model":self.options.model,"approvalPolicy":"on-request"}),
            ),
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
    match method {
        "turn/started" => {
            if let Some(turn) = params["turn"]["id"].as_str().filter(|s| token(s)) {
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
                    || thread.status == "starting"
                    || thread.status == "compacting"
                {
                    thread.turn_id = Some(turn.into());
                    thread.status = match params["turn"]["status"].as_str() {
                        Some("completed") => "completed",
                        Some("interrupted") => "interrupted",
                        _ => "failed",
                    }
                    .into();
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
        "item/completed" if params["item"]["type"] == "contextCompaction" => {
            if thread.status == "compacting" {
                thread.status = "idle".into();
            }
        }
        "thread/compacted" => {
            if thread.status == "compacting" {
                thread.status = "idle".into();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            model: "fixture".into(),
            request_limit: 1,
            lifetime_seconds: 30,
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
                model: "no-model-request".into(),
                request_limit: 1,
                lifetime_seconds: 30,
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
