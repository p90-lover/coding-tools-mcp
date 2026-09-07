//! One locally authorized Codex thread and a bounded event/approval stream.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{approval_response, EventBuffer, NativePolicy, PromptArgs, StatusArgs};
use super::transport::Wire;

struct Approval {
    native_id: Value,
    method: String,
    params: Value,
    expires: Instant,
}
struct State {
    thread: String,
    turn: Option<String>,
    busy: bool,
    started: bool,
    approvals: HashMap<String, Approval>,
    events: EventBuffer,
    requests: VecDeque<(String, String, Value)>,
    last_signal: Instant,
}

pub struct NativeSession {
    pub generation: String,
    pub fingerprint: String,
    pub policy: NativePolicy,
    pub wire: Arc<Wire>,
    state: Mutex<State>,
    operations: Mutex<()>,
    notify: Arc<dyn Fn() + Send + Sync>,
}
impl NativeSession {
    pub fn new(
        wire: Arc<Wire>,
        incoming: mpsc::Receiver<Value>,
        policy: NativePolicy,
        fingerprint: String,
        generation: String,
        notify: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        let session = Arc::new(Self {
            generation,
            fingerprint,
            policy,
            wire,
            operations: Mutex::new(()),
            notify,
            state: Mutex::new(State {
                thread: String::new(),
                turn: None,
                busy: false,
                started: false,
                approvals: HashMap::new(),
                events: EventBuffer::default(),
                requests: VecDeque::new(),
                last_signal: Instant::now() - Duration::from_secs(1),
            }),
        });
        let weak = Arc::downgrade(&session);
        std::thread::spawn(move || loop {
            // No periodic polling when there are no pending approvals. Pipe EOF wakes us.
            let wait = if let Some(session) = weak.upgrade() {
                if !session.wire.alive() {
                    break;
                }
                session
                    .state
                    .lock()
                    .ok()
                    .and_then(|s| {
                        s.approvals
                            .values()
                            .map(|a| a.expires.saturating_duration_since(Instant::now()))
                            .min()
                    })
                    .unwrap_or(Duration::from_secs(24 * 60 * 60))
            } else {
                break;
            };
            match incoming.recv_timeout(wait) {
                Ok(message) => {
                    if let Some(s) = weak.upgrade() {
                        s.receive(message);
                    } else {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(s) = weak.upgrade() {
                        let expired = s
                            .state
                            .lock()
                            .map(|state| {
                                state
                                    .approvals
                                    .values()
                                    .any(|a| a.expires <= Instant::now())
                            })
                            .unwrap_or(true);
                        if expired {
                            s.close("Local approval expired. Native connection stopped without approving it");
                            break;
                        }
                    } else {
                        break;
                    }
                }
                Err(_) => {
                    if let Some(s) = weak.upgrade() {
                        s.close("Codex disconnected. Inspect operation state before reconnecting; requests were not replayed");
                    }
                    break;
                }
            }
        });
        session
    }

    pub fn initialize(&self) -> Result<(), String> {
        self.wire.rpc("initialize", json!({"clientInfo":{"name":"coding_tools_mcp","title":"Coding Tools MCP native Codex","version":env!("CARGO_PKG_VERSION")}}))?;
        self.wire
            .send(json!({"method":"initialized","params":{}}))?;
        let response = self.wire.rpc("thread/start", self.policy.thread_params())?;
        let thread = self.policy.verify_thread(&response)?;
        self.state
            .lock()
            .map_err(|_| "Native state unavailable")?
            .thread = thread;
        self.record("native/connected", "Official Codex thread initialized. Tasks use the configured local Codex account/provider", true);
        Ok(())
    }

    fn record(&self, method: &str, text: &str, force: bool) {
        let notify = if let Ok(mut state) = self.state.lock() {
            state.events.push(method, text);
            if force || state.last_signal.elapsed() >= Duration::from_millis(250) {
                state.last_signal = Instant::now();
                true
            } else {
                false
            }
        } else {
            false
        };
        if notify {
            (self.notify)();
        }
    }

    fn receive(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if let Some(id) = message.get("id") {
            let known = approval_response(method, &params, "decline").is_ok();
            let mut accepted = false;
            if known && params.to_string().len() <= 32 * 1024 {
                if let Ok(mut state) = self.state.lock() {
                    if state.approvals.len() < 8
                        && !state.thread.is_empty()
                        && params.get("threadId").and_then(Value::as_str)
                            == Some(state.thread.as_str())
                    {
                        let key = uuid::Uuid::new_v4().to_string();
                        state.approvals.insert(
                            key,
                            Approval {
                                native_id: id.clone(),
                                method: method.into(),
                                params: params.clone(),
                                expires: Instant::now() + Duration::from_secs(300),
                            },
                        );
                        accepted = true;
                    }
                }
            }
            if accepted {
                self.record(
                    "native/approval",
                    "A native operation requires a decision in the local desktop window",
                    true,
                );
            } else {
                let _ = self.wire.send(json!({"id":id,"error":{"code":-32601,"message":"Unsupported or out-of-scope native request. No permission was granted"}}));
                self.record(
                    "native/request-rejected",
                    "An unsupported or out-of-scope native request was rejected; no auto-approval",
                    true,
                );
            }
            return;
        }
        if method == "serverRequest/resolved" {
            if let Ok(mut state) = self.state.lock() {
                state
                    .approvals
                    .retain(|_, a| params.get("requestId") != Some(&a.native_id));
            }
            (self.notify)();
            return;
        }
        let same_thread = self
            .state
            .lock()
            .map(|s| params.get("threadId").and_then(Value::as_str) == Some(s.thread.as_str()))
            .unwrap_or(false);
        if !same_thread {
            return;
        }
        if matches!(method, "turn/started" | "turn/completed") {
            if let Ok(mut state) = self.state.lock() {
                let turn = params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if method == "turn/started" {
                    state.turn = turn;
                    state.busy = true;
                } else {
                    state.turn = turn;
                    state.busy = false;
                    state.approvals.clear();
                }
            }
            self.record(
                method,
                params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("updated"),
                true,
            );
        } else if matches!(
            method,
            "item/agentMessage/delta"
                | "item/commandExecution/outputDelta"
                | "item/fileChange/outputDelta"
        ) {
            self.record(
                method,
                params.get("delta").and_then(Value::as_str).unwrap_or(""),
                false,
            );
        } else if method == "item/completed" {
            let item = &params["item"];
            let kind = item["type"].as_str().unwrap_or("item");
            // Command output and assistant text are intended task results; account/config notifications are never forwarded.
            if matches!(kind, "agentMessage" | "commandExecution" | "fileChange") {
                let text = item.get("text").and_then(Value::as_str).unwrap_or(kind);
                self.record(method, text, true);
            }
        } else if method == "error" {
            self.record(
                "native/error",
                "Codex reported a task error. Review the native session before retrying",
                true,
            );
        }
    }

    pub fn turn(&self, args: PromptArgs, continuation: bool) -> Result<Value, String> {
        let _operation = self
            .operations
            .try_lock()
            .map_err(|_| "Another native operation is being submitted")?;
        let (thread, fingerprint) = {
            let mut state = self.state.lock().map_err(|_| "Native state unavailable")?;
            let fingerprint = format!(
                "{:x}",
                Sha256::digest(format!("{continuation}:{}", args.prompt).as_bytes())
            );
            if let Some((_, previous, response)) = state
                .requests
                .iter()
                .find(|(id, _, _)| id == &args.request_id)
            {
                return if previous == &fingerprint {
                    Ok(response.clone())
                } else {
                    Err("request_id was already used for different input".into())
                };
            }
            if state.busy || !state.approvals.is_empty() {
                return Err(
                    "Native turn is active; read status or interrupt instead of replaying".into(),
                );
            }
            if state.started != continuation {
                return Err(if continuation {
                    "Use codex_start for the first turn"
                } else {
                    "This thread already started; use codex_continue with a new request_id"
                }
                .into());
            }
            state.busy = true;
            state.started = true;
            (state.thread.clone(), fingerprint)
        };
        let response = match self.wire.rpc(
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":args.prompt}]}),
        ) {
            Ok(response) => response,
            Err(error) => {
                self.close("Native turn submission failed. Do not automatically replay");
                return Err(error);
            }
        };
        let turn = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or("Codex omitted the turn ID")?;
        let output = json!({"accepted":true,"thread_id":thread,"turn_id":turn,"request_id":args.request_id,
            "execution_backend":"official_codex_app_server","policy":self.policy,
            "sandbox_managed_by":"codex","automatic_replay":false});
        {
            let mut state = self.state.lock().map_err(|_| "Native state unavailable")?;
            state.turn = Some(turn.into());
            // turn/completed can arrive before the RPC response. Never set busy=true again here.
            state
                .requests
                .push_back((args.request_id, fingerprint, output.clone()));
            while state.requests.len() > 32 {
                state.requests.pop_front();
            }
        }
        (self.notify)();
        Ok(output)
    }

    pub fn interrupt(&self) -> Result<Value, String> {
        let (thread, turn, busy) = {
            let state = self.state.lock().map_err(|_| "Native state unavailable")?;
            (state.thread.clone(), state.turn.clone(), state.busy)
        };
        if !busy {
            return Ok(json!({"interrupted":false,"reason":"no_active_turn"}));
        }
        let turn =
            turn.ok_or("Turn submission is pending; disconnect locally to stop the owned process")?;
        self.wire
            .rpc("turn/interrupt", json!({"threadId":thread,"turnId":turn}))?;
        Ok(
            json!({"interrupt_requested":true,"turn_id":turn,"note":"Observe turn/completed before starting another turn"}),
        )
    }

    pub fn approve(&self, generation: &str, request: &str, decision: &str) -> Result<(), String> {
        if generation != self.generation {
            return Err("Stale native connection; approval refused".into());
        }
        let approval = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Native approval state unavailable")?;
            let approval = state
                .approvals
                .get(request)
                .ok_or("Approval expired or already resolved")?;
            if approval.expires <= Instant::now() {
                return Err("Approval expired".into());
            }
            // Validate before consuming; no persistent policy/rule edits are accepted.
            approval_response(&approval.method, &approval.params, decision)?;
            state
                .approvals
                .remove(request)
                .ok_or("Approval already resolved")?
        };
        let result = approval_response(&approval.method, &approval.params, decision)?;
        self.wire
            .send(json!({"id":approval.native_id,"result":result}))?;
        self.record("native/approval-resolved", decision, true);
        Ok(())
    }

    pub fn snapshot(&self, args: StatusArgs, local: bool) -> Result<Value, String> {
        let state = self.state.lock().map_err(|_| "Native state unavailable")?;
        let mut value = state
            .events
            .page(args.cursor, args.max_events.unwrap_or(16));
        if let Some(obj) = value.as_object_mut() {
            obj.insert("connected".into(), json!(self.wire.alive()));
            obj.insert("generation".into(), json!(self.generation));
            obj.insert("thread_id".into(), json!(state.thread));
            obj.insert("turn_id".into(), json!(state.turn));
            obj.insert("busy".into(), json!(state.busy));
            obj.insert("started".into(), json!(state.started));
            obj.insert(
                "waiting_for_local_approval".into(),
                json!(!state.approvals.is_empty()),
            );
            obj.insert("policy".into(), json!(self.policy));
            obj.insert("backend".into(), json!("official_codex_app_server"));
            if local {
                let approvals: Vec<Value> = state.approvals.iter().filter(|(_,a)| a.expires > Instant::now()).map(|(id,a)| json!({
                    "request_id":id,"method":a.method,"params":a.params,"expires_in_seconds":a.expires.saturating_duration_since(Instant::now()).as_secs()
                })).collect();
                obj.insert("approvals".into(), json!(approvals));
            }
        }
        Ok(value)
    }
    pub fn close(&self, reason: &str) {
        self.wire.close();
        if let Ok(mut state) = self.state.lock() {
            state.busy = false;
            state.approvals.clear();
        }
        self.record("native/disconnected", reason, true);
    }
}
