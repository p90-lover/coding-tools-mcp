//! Private stdio transport. No raw RPC or approval channel is exposed to MCP.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{MAX_FRAME, SUPPORTED_VERSION};
use serde_json::{json, Value};

type Reply = Result<Value, String>;
type KillTree = Arc<dyn Fn(u32) + Send + Sync>;

pub struct Wire {
    child: Mutex<Child>,
    outgoing: mpsc::SyncSender<Vec<u8>>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Reply>>>,
    next: AtomicU64,
    closed: AtomicBool,
    kill_tree: KillTree,
}

fn native_command(binary: &Path, cwd: &Path) -> Command {
    let mut cmd = Command::new(binary);
    cmd.current_dir(cwd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW, not elevation.
        // Codex one-off execution reads this from the server's base Config, not
        // from a thread/start override. Select the real sandbox at both levels.
        // Setup remains a separate, explicit local action; no UAC is bypassed.
        cmd.args(["-c", "windows.sandbox=\"elevated\""]);
    }
    cmd
}

pub fn verify_version(binary: &Path, cwd: &Path, kill_tree: &KillTree) -> Result<(), String> {
    let mut child = native_command(binary, cwd)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot start the locally selected Codex executable")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(stdout) = child.stdout.take() {
                    stdout
                        .take(1025)
                        .read_to_string(&mut output)
                        .map_err(|_| "Invalid Codex version output")?;
                }
                if status.success() && output.trim() == format!("codex-cli {SUPPORTED_VERSION}") {
                    return Ok(());
                }
                return Err(format!("This integration requires the official native codex-cli {SUPPORTED_VERSION}; other versions are not silently accepted"));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err("Codex version check failed or timed out".into());
            }
        }
    }
}

impl Wire {
    pub fn spawn(
        binary: &Path,
        cwd: &Path,
        kill_tree: KillTree,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Value>), String> {
        verify_version(binary, cwd, &kill_tree)?;
        let mut child = native_command(binary, cwd)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Failed to start Codex app-server")?;
        let stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Codex stderr unavailable")?;
        let (outgoing, rx) = mpsc::sync_channel::<Vec<u8>>(32);
        let (events, incoming) = mpsc::sync_channel::<Value>(8);
        let wire = Arc::new(Self {
            child: Mutex::new(child),
            outgoing,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            kill_tree,
        });
        let weak = Arc::downgrade(&wire);
        std::thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(bytes) = rx.recv() {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    if let Some(wire) = weak.upgrade() {
                        wire.close();
                    }
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&wire);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                let read = reader
                    .by_ref()
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut frame);
                let Some(wire) = weak.upgrade() else {
                    break;
                };
                if !matches!(read, Ok(n) if n > 0 && n <= MAX_FRAME) || frame.last() != Some(&b'\n')
                {
                    wire.close();
                    break;
                }
                let Ok(message) = serde_json::from_slice::<Value>(&frame) else {
                    wire.close();
                    break;
                };
                if message.get("method").is_none() {
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        if let Ok(mut pending) = wire.pending.lock() {
                            if let Some(reply) = pending.remove(&id) {
                                let result = if message.get("error").is_some() {
                                    // Never forward arbitrary native error data (may include account/config data).
                                    Err(format!("Codex RPC rejected the request (code {}). Check the local Codex login/configuration", message.pointer("/error/code").unwrap_or(&Value::Null)))
                                } else {
                                    message
                                        .get("result")
                                        .cloned()
                                        .ok_or("Malformed Codex RPC response".into())
                                };
                                let _ = reply.try_send(result);
                            }
                        }
                    }
                } else if events.send(message).is_err() {
                    wire.close();
                    break;
                }
                if !wire.alive() {
                    break;
                }
            }
        });
        // Drain rather than retaining unbounded native diagnostics or publishing login material.
        std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut buffer = [0u8; 8192];
            while matches!(stderr.read(&mut buffer), Ok(n) if n > 0) {}
        });
        Ok((wire, incoming))
    }

    pub fn alive(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }

    pub fn send(&self, message: Value) -> Result<(), String> {
        if !self.alive() {
            return Err(
                "Native Codex disconnected; reconnect locally. Do not replay uncertain operations"
                    .into(),
            );
        }
        let mut bytes =
            serde_json::to_vec(&message).map_err(|_| "Cannot serialize Codex request")?;
        if bytes.len() > MAX_FRAME {
            return Err("Codex message exceeds the configured bound".into());
        }
        bytes.push(b'\n');
        if self.outgoing.try_send(bytes).is_err() {
            self.close();
            return Err("Native writer is unavailable or overloaded; operation state is uncertain, no automatic retry".into());
        }
        Ok(())
    }

    pub fn rpc(&self, method: &str, params: Value) -> Reply {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Codex request state unavailable")?;
            if pending.len() >= 16 {
                return Err("Too many outstanding Codex requests".into());
            }
            pending.insert(id, tx);
        }
        if let Err(error) = self.send(json!({"id":id,"method":method,"params":params})) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(result) => result,
            Err(_) => {
                self.close();
                Err("Codex RPC timed out/disconnected. Operations may have started; inspect native state before reconnecting. Nothing was automatically replayed".into())
            }
        }
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, reply) in pending.drain() {
                let _ = reply.try_send(Err("Codex connection closed".into()));
            }
        }
        if let Ok(mut child) = self.child.lock() {
            // Avoid signaling a recycled PID when the child has already exited.
            if matches!(child.try_wait(), Ok(None)) {
                (self.kill_tree)(child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
impl Drop for Wire {
    fn drop(&mut self) {
        self.close();
    }
}
