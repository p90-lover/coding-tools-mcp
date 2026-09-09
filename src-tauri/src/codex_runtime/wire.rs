//! Bounded bidirectional JSONL. Server request IDs have a separate namespace.
use super::process::OwnedProcess;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
pub const MAX_FRAME: usize = 1024 * 1024;
type Pending = HashMap<u64, mpsc::SyncSender<Value>>;
type WriteItem = (Vec<u8>, mpsc::SyncSender<bool>);
pub struct Wire {
    process: OwnedProcess,
    input: Mutex<Option<mpsc::SyncSender<WriteItem>>>,
    pending: Mutex<Pending>,
    next: AtomicU64,
    pub alive: AtomicBool,
    pub reason: Mutex<String>,
}
impl Wire {
    pub fn start(
        mut command: Command,
        notify: impl Fn(Value) + Send + Sync + 'static,
    ) -> Result<Arc<Self>, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let process = OwnedProcess::spawn(&mut command)?;
        let (mut input, output, mut errors) = process.pipes()?;
        let (tx, rx) = mpsc::sync_channel::<WriteItem>(8);
        let wire = Arc::new(Self {
            process,
            input: Mutex::new(Some(tx)),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            reason: Mutex::new(String::new()),
        });
        // A blocked child stdin must not hang Stop, initialization, or an RPC forever.
        std::thread::spawn(move || {
            while let Ok((bytes, ack)) = rx.recv() {
                let ok = input.write_all(&bytes).is_ok();
                let _ = ack.try_send(ok);
                if !ok {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut bytes = [0u8; 4096];
            while matches!(errors.read(&mut bytes),Ok(n) if n>0) {}
        });
        let weak = Arc::downgrade(&wire);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let result = reader
                    .by_ref()
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut line);
                let Some(w) = weak.upgrade() else {
                    break;
                };
                if !w.alive.load(Ordering::Acquire) {
                    break;
                }
                match result {
                    Ok(0) | Err(_) => {
                        w.stop("RUNTIME_DISCONNECTED_OUTCOME_UNKNOWN");
                        break;
                    }
                    _ => {}
                }
                if line.len() > MAX_FRAME || !line.ends_with(b"\n") {
                    w.stop("RUNTIME_FRAME_LIMIT_OUTCOME_UNKNOWN");
                    break;
                }
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    w.stop("RUNTIME_INVALID_JSON_OUTCOME_UNKNOWN");
                    break;
                };
                if !message.is_object() {
                    w.stop("RUNTIME_INVALID_ENVELOPE_OUTCOME_UNKNOWN");
                    break;
                }
                if message.get("method").is_some() {
                    if message["method"].as_str().is_none() {
                        w.stop("RUNTIME_INVALID_METHOD");
                        break;
                    }
                    notify(message);
                } else if let Some(id) = message["id"].as_u64() {
                    let sender = w.pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(sender) = sender {
                        let _ = sender.try_send(message);
                    }
                }
            }
        });
        Ok(wire)
    }
    pub fn write(&self, message: &Value) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("RUNTIME_STOPPED_OUTCOME_UNKNOWN".into());
        }
        let mut data = serde_json::to_vec(message).map_err(|_| "RUNTIME_INVALID_REQUEST")?;
        if data.len() > MAX_FRAME - 1 {
            return Err("RUNTIME_REQUEST_LIMIT".into());
        }
        data.push(b'\n');
        let (tx, rx) = mpsc::sync_channel(1);
        let sender = self
            .input
            .lock()
            .map_err(|_| "RUNTIME_LOCK_FAILED")?
            .clone()
            .ok_or("RUNTIME_STDIN_CLOSED")?;
        if sender.try_send((data, tx)).is_err() {
            self.stop("RUNTIME_WRITE_QUEUE_EXHAUSTED");
            return Err("RUNTIME_WRITE_QUEUE_EXHAUSTED".into());
        }
        if !matches!(rx.recv_timeout(Duration::from_secs(3)), Ok(true)) {
            self.stop("RUNTIME_WRITE_FAILED_OUTCOME_UNKNOWN");
            return Err("RUNTIME_WRITE_FAILED_OUTCOME_UNKNOWN".into());
        }
        Ok(())
    }
    pub fn rpc(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if id == u64::MAX {
            self.stop("RUNTIME_ID_EXHAUSTED");
            return Err("RUNTIME_ID_EXHAUSTED".into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().map_err(|_| "RUNTIME_LOCK_FAILED")?;
            if pending.len() >= 8 {
                return Err("RUNTIME_BUSY".into());
            }
            pending.insert(id, tx);
        }
        if let Err(error) = self.write(&json!({"id":id,"method":method,"params":params})) {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err(error);
        }
        let response = match rx.recv_timeout(timeout) {
            Ok(v) => v,
            Err(_) => {
                self.stop("RUNTIME_TIMEOUT_OUTCOME_UNKNOWN");
                return Err("RUNTIME_TIMEOUT_OUTCOME_UNKNOWN: do not replay this operation".into());
            }
        };
        if response.get("error").is_some() {
            return Err(format!(
                "UPSTREAM_RPC_REJECTED:{}",
                response["error"]["code"].as_i64().unwrap_or(-32000)
            ));
        }
        match response.get("result") {
            Some(result) => Ok(result.clone()),
            None => {
                self.stop("RUNTIME_INVALID_RESPONSE_OUTCOME_UNKNOWN");
                Err("RUNTIME_INVALID_RESPONSE_OUTCOME_UNKNOWN".into())
            }
        }
    }
    pub fn reply(&self, id: Value, result: Value) -> Result<(), String> {
        self.write(&json!({"id":id,"result":result}))
    }
    pub fn reject(&self, id: Value) -> Result<(), String> {
        self.write(&json!({"id":id,"error":{"code":-32601,"message":"This local client does not authorize that server request"}}))
    }
    pub fn stop(&self, reason: &str) {
        if self.alive.swap(false, Ordering::AcqRel) {
            if let Ok(mut saved) = self.reason.lock() {
                *saved = reason.into();
            }
            self.process.stop();
            if let Ok(mut input) = self.input.lock() {
                input.take();
            }
            if let Ok(mut pending) = self.pending.lock() {
                pending.clear();
            }
        }
    }
}
impl Drop for Wire {
    fn drop(&mut self) {
        self.stop("RUNTIME_CONNECTION_CLOSED");
    }
}
