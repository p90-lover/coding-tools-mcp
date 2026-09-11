//! Bounded runtime-local receipts. RPC ids correlate requests, never deduplicate them.
//! No arguments, credentials or result bodies are written to disk by this store.
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const TOOL: &str = "mcp_operation_status";
pub const MAX_RECORDS: usize = 128;
pub const MAX_RESULT_BYTES: usize = 256 * 1024;
const RETENTION: Duration = Duration::from_secs(30 * 60);

pub struct OperationStore {
    runtime_id: String,
    records: Mutex<VecDeque<Record>>,
}
struct Record {
    id: String,
    request_id: Value,
    method: String,
    tool: String,
    revision: u64,
    admitted_ms: u64,
    finished_ms: Option<u64>,
    finished: Option<Instant>,
    state: &'static str,
    completion: &'static str,
    cached: Option<Vec<u8>>,
    cache_state: &'static str,
}

impl Default for OperationStore {
    fn default() -> Self {
        Self { runtime_id: uuid::Uuid::new_v4().to_string(), records: Mutex::new(VecDeque::new()) }
    }
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}
fn prune(records: &mut VecDeque<Record>) {
    // Only RAM expires. Active work is never evicted and no files are removed.
    records.retain(|r| r.finished.is_none_or(|t| t.elapsed() < RETENTION));
}
impl OperationStore {
    pub fn runtime_id(&self) -> &str { &self.runtime_id }

    pub fn admit(&self, body: &Value, revision: u64) -> Result<String, String> {
        let request_id = body.get("id").ok_or("Missing RPC id")?;
        if !(request_id.is_i64() || request_id.is_u64() || request_id.as_str().is_some_and(|s| s.len() <= 256)) {
            return Err("RPC id must be an integer or a string of at most 256 bytes".into());
        }
        let method = body.get("method").and_then(Value::as_str).ok_or("Missing method")?;
        let tool = body.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
        if method.len() > 128 || tool.len() > 128 { return Err("RPC method/tool name exceeds 128 bytes".into()); }
        let mut records = self.records.lock().map_err(|_| "Operation store is unavailable")?;
        prune(&mut records);
        if records.len() >= MAX_RECORDS {
            let oldest_terminal = records.iter().position(|r| r.finished.is_some());
            if let Some(index) = oldest_terminal { records.remove(index); }
            else { return Err("Operation tracking capacity reached; no new operation was started".into()); }
        }
        let id = format!("{}:{}", self.runtime_id, uuid::Uuid::new_v4());
        records.push_back(Record {
            id: id.clone(), request_id: request_id.clone(), method: method.into(), tool: tool.into(), revision,
            admitted_ms: now_ms(), finished_ms: None, finished: None, state: "admitted", completion: "pending",
            cached: None, cache_state: "pending",
        });
        Ok(id)
    }
    pub fn started(&self, id: &str) {
        if let Ok(mut records) = self.records.lock() {
            if let Some(r) = records.iter_mut().find(|r| r.id == id) { r.state = "running"; }
        }
    }
    pub fn finish(&self, id: &str, response: &Value, worker_failed: bool) {
        // Serialize through a capped writer: an image/large response cannot make
        // an unbounded extra allocation merely to test the cache size.
        let mut bytes = CappedBytes(Vec::new());
        let fits = serde_json::to_writer(&mut bytes, response).is_ok();
        if let Ok(mut records) = self.records.lock() {
            if let Some(r) = records.iter_mut().find(|r| r.id == id) {
                r.state = if worker_failed { "worker_failed" } else { "completed" };
                r.completion = if worker_failed { "outcome_unknown" }
                    else if response.get("error").is_some() { "rpc_error" }
                    else if response.pointer("/result/isError") == Some(&Value::Bool(true)) { "tool_error" }
                    else { "returned" };
                r.cached = fits.then_some(bytes.0);
                r.cache_state = if fits { "available" } else { "too_large" };
                r.finished_ms = Some(now_ms());
                r.finished = Some(Instant::now());
            }
        }
    }
    pub fn query(&self, args: &Value, revision: u64, permitted: &[&str]) -> Result<Value, String> {
        let object = args.as_object().ok_or("Arguments must be an object")?;
        if object.keys().any(|k| !matches!(k.as_str(), "operation_id" | "request_id" | "include_result" | "limit")) {
            return Err("Unknown operation query argument".into());
        }
        let id = match object.get("operation_id") {
            None => None,
            Some(v) => Some(v.as_str().filter(|s| !s.is_empty() && s.len() <= 73).ok_or("Invalid operation_id")?),
        };
        let request_id = object.get("request_id");
        if request_id.is_some_and(|v| !(v.is_i64() || v.is_u64() || v.as_str().is_some_and(|s| s.len() <= 256))) {
            return Err("request_id must be an integer or a string of at most 256 bytes".into());
        }
        if id.is_some() && request_id.is_some() { return Err("Use operation_id OR request_id, not both".into()); }
        let include_result = match object.get("include_result") {
            None => false,
            Some(v) => v.as_bool().ok_or("include_result must be a boolean")?,
        };
        if include_result && id.is_none() { return Err("include_result requires an exact operation_id".into()); }
        let limit = match object.get("limit") {
            None => 10,
            Some(v) => v.as_u64().filter(|n| (1..=20).contains(n)).ok_or("limit must be 1..20")? as usize,
        };
        let mut records = self.records.lock().map_err(|_| "Operation store is unavailable")?;
        prune(&mut records);
        let matches: Vec<Value> = records.iter().rev()
            .filter(|r| id.is_none_or(|id| id == r.id) && request_id.is_none_or(|wanted| wanted == &r.request_id))
            .take(limit).map(|r| {
                let allowed = r.revision == revision && (r.method != "tools/call" || permitted.contains(&r.tool.as_str()));
                let cache_state = if !allowed { "policy_changed_or_tool_hidden" } else { r.cache_state };
                let mut row = json!({
                    "operation_id":r.id,"request_id":r.request_id,"method":r.method,"tool_name":r.tool,
                    "state":r.state,"completion_kind":r.completion,"admitted_at_ms":r.admitted_ms,"finished_at_ms":r.finished_ms,
                    "result_state":cache_state,"safe_to_retry":false,
                    "completion_is_dispatch_only":true
                });
                if include_result && allowed {
                    if let Some(bytes) = r.cached.as_ref() {
                        // Bytes were generated from a Value, not from an untrusted external JSON stream.
                        if let Ok(response) = serde_json::from_slice::<Value>(bytes) { row["rpc_response"] = response; }
                    }
                }
                row
            }).collect();
        Ok(json!({
            "ok":true,"runtime_id":self.runtime_id,"found":!matches.is_empty(),"operations":matches,
            "retention":{"scope":"this MCP listener instance","max_records":MAX_RECORDS,"max_result_bytes":MAX_RESULT_BYTES,"max_terminal_age_seconds":RETENTION.as_secs(),"results_persisted_to_disk":false},
            "safe_to_retry":false,
            "note":"Read-only lookup; never reruns an operation. Missing/expired/restarted records mean UNKNOWN, not never executed. RPC ids are not idempotency keys. Completed means tool dispatch returned; a returned command/task may still run. Results may be unavailable after policy changes or size limits."
        }))
    }
}
struct CappedBytes(Vec<u8>);
impl Write for CappedBytes {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() > MAX_RESULT_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::other("result cache limit"));
        }
        self.0.extend_from_slice(buffer);
        Ok(buffer.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

pub fn input_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{
        "operation_id":{"type":"string","minLength":1,"maxLength":73,"description":"Server-generated ID from timeout data, response metadata or request log."},
        "request_id":{"type":["string","integer"],"description":"Original JSON-RPC id; may match more than one operation. Never an idempotency key."},
        "include_result":{"type":"boolean","default":false,"description":"Return bounded cached RPC response only for an exact operation_id and unchanged live policy."},
        "limit":{"type":"integer","minimum":1,"maximum":20,"default":10}
    }})
}
pub fn output_schema() -> Value {
    // Additional shared project_instructions/error properties are valid on all tools.
    json!({"type":"object","required":["ok"],"properties":{
        "ok":{"type":"boolean"},"runtime_id":{"type":"string"},"found":{"type":"boolean"},
        "safe_to_retry":{"const":false},"note":{"type":"string"},"retention":{"type":"object"},
        "operations":{"type":"array","maxItems":20,"items":{"type":"object","required":["operation_id","request_id","state","completion_kind","result_state","safe_to_retry"],"properties":{
            "operation_id":{"type":"string"},"request_id":{"type":["string","integer"]},
            "state":{"enum":["admitted","running","completed","worker_failed"]},
            "completion_kind":{"enum":["pending","returned","rpc_error","tool_error","outcome_unknown"]},
            "result_state":{"enum":["pending","available","too_large","policy_changed_or_tool_hidden"]},
            "safe_to_retry":{"const":false},"rpc_response":{"type":"object"}
        }}}
    }})
}
