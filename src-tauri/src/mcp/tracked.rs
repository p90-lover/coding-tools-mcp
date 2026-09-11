//! The worker owns final recording. Cancelling its HTTP waiter cannot erase it.
use super::operation_store::{OperationStore, TOOL};
use axum::{
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;

pub const HTTP_WAIT: Duration = Duration::from_secs(105);
const META_KEY: &str = "coding-tools-mcp/operation";
pub type Recorder = Arc<dyn Fn(&str) + Send + Sync>;

fn annotate(mut response: Value, id: &str, runtime: &str) -> Value {
    let receipt =
        json!({"operation_id":id,"runtime_id":runtime,"query_tool":TOOL,"safe_to_retry":false});
    if let Some(result) = response.get_mut("result").and_then(Value::as_object_mut) {
        let meta = result.entry("_meta").or_insert_with(|| json!({}));
        if let Some(meta) = meta.as_object_mut() {
            meta.insert(META_KEY.into(), receipt);
        }
    } else if let Some(error) = response.get_mut("error").and_then(Value::as_object_mut) {
        let data = error.entry("data").or_insert_with(|| json!({}));
        if let Some(data) = data.as_object_mut() {
            data.insert("operation".into(), receipt);
        }
    }
    response
}
fn http(status: StatusCode, value: Value, id: &str) -> Response {
    let mut response = (status, Json(value)).into_response();
    if let Ok(id) = HeaderValue::from_str(id) {
        response.headers_mut().insert("x-mcp-operation-id", id);
    }
    response
}
fn worker_error(request_id: &Value) -> Value {
    json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32603,"message":"RPC worker failed; inspect operation state before retrying","data":{"stage":"rpc_worker","retryable":false,"outcome":"unknown"}}})
}
struct CompletionGuard {
    store: Arc<OperationStore>,
    id: String,
    request_id: Value,
    record: Recorder,
    finished: bool,
}
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.store
                .finish(&self.id, &worker_error(&self.request_id), true);
            (self.record)(&format!(
                "[rpc] worker_failed operation_id={} id={} outcome=unknown",
                self.id, self.request_id
            ));
        }
    }
}

pub async fn execute(
    store: Arc<OperationStore>,
    body: Value,
    revision: u64,
    wait: Duration,
    work: impl FnOnce() -> Value + Send + 'static,
    record: Recorder,
) -> Response {
    let request_id = body.get("id").cloned().unwrap_or(Value::Null);
    let id = match store.admit(&body, revision) {
        Ok(id) => id,
        Err(message) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32009,"message":message,"data":{"accepted":false}}}))).into_response(),
    };
    // JSON formatting escapes caller-controlled request id, method and tool names.
    (record)(&format!(
        "[rpc] admitted operation_id={} id={} method={} tool={}",
        id,
        request_id,
        body["method"],
        body.pointer("/params/name").unwrap_or(&Value::Null)
    ));
    let mut completion = CompletionGuard {
        store: store.clone(),
        id: id.clone(),
        request_id: request_id.clone(),
        record: record.clone(),
        finished: false,
    };
    let worker = tokio::task::spawn_blocking(move || {
        completion.store.started(&completion.id);
        (completion.record)(&format!(
            "[rpc] started operation_id={} id={}",
            completion.id, completion.request_id
        ));
        let (value, failed) = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
            Ok(value) => (value, false),
            Err(_) => (worker_error(&completion.request_id), true),
        };
        let response = annotate(value, &completion.id, completion.store.runtime_id());
        completion.store.finish(&completion.id, &response, failed);
        completion.finished = true;
        // A returned command id is not a claim its child process has exited.
        (completion.record)(&format!(
            "[rpc] {} operation_id={} id={} rpc_error={} tool_error={}",
            if failed { "worker_failed" } else { "completed" },
            completion.id,
            completion.request_id,
            response.get("error").is_some(),
            response.pointer("/result/isError") == Some(&Value::Bool(true))
        ));
        response
    });
    match tokio::time::timeout(wait, worker).await {
        Ok(Ok(response)) => http(StatusCode::OK, response, &id),
        Ok(Err(_)) => http(
            StatusCode::INTERNAL_SERVER_ERROR,
            annotate(worker_error(&request_id), &id, store.runtime_id()),
            &id,
        ),
        Err(_) => {
            (record)(&format!(
                "[rpc] http_wait_expired operation_id={} id={} execution_not_cancelled=true",
                id, request_id
            ));
            http(
                StatusCode::REQUEST_TIMEOUT,
                json!({"jsonrpc":"2.0","id":request_id,"error":{
                    "code":-32008,"message":"HTTP wait expired; the accepted operation may still finish. Query its receipt; do not rerun it.",
                    "data":{"accepted":true,"operation_id":id,"runtime_id":store.runtime_id(),"query_tool":TOOL,
                        "query_arguments":{"operation_id":id,"include_result":true},"safe_to_retry":false,
                        "execution_cancelled":false,"retryable":false}
                }}),
                &id,
            )
        }
    }
}

/// Recovery has separate bounded capacity; busy execution slots cannot prevent inspection.
pub async fn query(work: impl FnOnce() -> Value + Send + 'static) -> Response {
    static READERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let permit = READERS
        .get_or_init(|| Arc::new(Semaphore::new(4)))
        .clone()
        .try_acquire_owned();
    let Ok(permit) = permit else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Operation lookup capacity reached",
        )
            .into_response();
    };
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    });
    match tokio::time::timeout(Duration::from_secs(5), worker).await {
        Ok(Ok(response)) => Json(response).into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Read-only operation lookup unavailable; no original operation was retried",
        )
            .into_response(),
    }
}
