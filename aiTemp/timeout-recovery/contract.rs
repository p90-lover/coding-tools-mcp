use crate::mcp::{
    operation_store::{OperationStore, MAX_RECORDS, MAX_RESULT_BYTES, TOOL},
    tracked,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

fn body(id: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"fixture_effect"}})
}
fn response(id: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":{"isError":false,"structuredContent":{"ok":true,"value":"preserved"}}})
}
async fn wait_completed(store: &OperationStore, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let value = store
                .query(
                    &json!({"operation_id":id,"include_result":true}),
                    0,
                    &["fixture_effect"],
                )
                .unwrap();
            if value["operations"][0]["state"] == "completed" {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn recovery_contract_completion_and_result_survive_abandoned_waiters() {
    let store = Arc::new(OperationStore::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = events.clone();
    let log: tracked::Recorder = Arc::new(move |line| captured.lock().unwrap().push(line.into()));
    let (started, began) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let counted = calls.clone();
    let running = tokio::spawn(tracked::execute(
        store.clone(),
        body(json!(1)),
        0,
        Duration::from_secs(30),
        move || {
            started.send(()).unwrap();
            gate.recv_timeout(Duration::from_secs(3)).unwrap();
            counted.fetch_add(1, Ordering::SeqCst);
            response(json!(1))
        },
        log.clone(),
    ));
    began.await.unwrap();
    let id = store.query(&json!({}), 0, &["fixture_effect"]).unwrap()["operations"][0]
        ["operation_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        store.query(&json!({"operation_id":id}), 0, &[]).unwrap()["operations"][0]["state"],
        "running"
    );
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    let saved = wait_completed(&store, &id).await;
    assert_eq!(
        saved["operations"][0]["rpc_response"]["result"]["structuredContent"]["value"],
        "preserved"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(1), async {
        while !events
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("[rpc] completed") && line.contains(&id))
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let (release, gate) = std::sync::mpsc::channel();
    let counted = calls.clone();
    let timed = tracked::execute(
        store.clone(),
        body(json!(2)),
        0,
        Duration::from_millis(10),
        move || {
            gate.recv_timeout(Duration::from_secs(3)).unwrap();
            counted.fetch_add(1, Ordering::SeqCst);
            response(json!(2))
        },
        log,
    )
    .await;
    assert_eq!(timed.status(), axum::http::StatusCode::REQUEST_TIMEOUT);
    let header = timed.headers()["x-mcp-operation-id"]
        .to_str()
        .unwrap()
        .to_string();
    let bytes = axum::body::to_bytes(timed.into_body(), 65536)
        .await
        .unwrap();
    let error: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(error["error"]["data"]["operation_id"], header);
    assert_eq!(error["error"]["data"]["safe_to_retry"], false);
    assert_eq!(error["error"]["data"]["query_tool"], TOOL);
    assert_eq!(error["error"]["data"]["execution_cancelled"], false);
    release.send(()).unwrap();
    wait_completed(&store, &header).await;
    for _ in 0..3 {
        store
            .query(
                &json!({"operation_id":header,"include_result":true}),
                0,
                &["fixture_effect"],
            )
            .unwrap();
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "Status polling must never rerun work"
    );
    println!("RECOVERY_CONTRACT: abandoned HTTP waiter and structured 408 retain worker completion/result; lookup never reruns work");
}

#[tokio::test]
async fn recovery_contract_scope_capacity_policy_errors_and_oversize_are_honest() {
    let store = Arc::new(OperationStore::default());
    let a = store.admit(&body(json!(7)), 0).unwrap();
    store.started(&a);
    store.finish(&a, &response(json!(7)), false);
    let b = store.admit(&body(json!(7)), 0).unwrap();
    store.finish(&b, &response(json!(7)), false);
    assert_ne!(
        a, b,
        "An RPC id must not implicitly deduplicate a legitimate later call"
    );
    assert_eq!(
        store
            .query(&json!({"request_id":7}), 0, &["fixture_effect"])
            .unwrap()["operations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(store
        .query(&json!({"request_id":7,"include_result":true}), 0, &[])
        .is_err());
    assert_eq!(
        store.query(&json!({"request_id":"7"}), 0, &[]).unwrap()["found"],
        false
    );
    let denied = store
        .query(
            &json!({"operation_id":a,"include_result":true}),
            1,
            &["fixture_effect"],
        )
        .unwrap();
    assert_eq!(
        denied["operations"][0]["result_state"],
        "policy_changed_or_tool_hidden"
    );
    assert!(denied["operations"][0].get("rpc_response").is_none());
    assert!(store
        .query(&json!({"operation_id":a,"include_result":true}), 0, &[])
        .unwrap()["operations"][0]
        .get("rpc_response")
        .is_none());
    let other = OperationStore::default();
    let unknown = other
        .query(&json!({"operation_id":a}), 0, &["fixture_effect"])
        .unwrap();
    assert_eq!(unknown["found"], false);
    assert_eq!(unknown["safe_to_retry"], false);
    assert_ne!(unknown["runtime_id"], store.runtime_id());
    let huge = json!({"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"a".repeat(MAX_RESULT_BYTES+1)}]}});
    store.finish(&b, &huge, false);
    let oversized = store
        .query(
            &json!({"operation_id":b,"include_result":true}),
            0,
            &["fixture_effect"],
        )
        .unwrap();
    assert_eq!(oversized["operations"][0]["result_state"], "too_large");
    assert!(oversized["operations"][0].get("rpc_response").is_none());
    assert!(store.query(&json!({"limit":0}), 0, &[]).is_err());
    assert!(store
        .query(&json!({"include_result":"yes"}), 0, &[])
        .is_err());
    assert!(store.query(&json!({"execute":true}), 0, &[]).is_err());

    let full = OperationStore::default();
    let mut ids = Vec::new();
    for i in 0..MAX_RECORDS {
        ids.push(full.admit(&body(json!(i)), 0).unwrap());
    }
    assert!(full.admit(&body(json!(999)), 0).is_err());
    full.finish(&ids[0], &response(json!(0)), false);
    full.admit(&body(json!(999)), 0).unwrap();
    assert_eq!(
        full.query(&json!({"operation_id":ids[0]}), 0, &[]).unwrap()["found"],
        false
    );
    assert_eq!(
        full.query(&json!({"operation_id":ids[1]}), 0, &[]).unwrap()["operations"][0]["state"],
        "admitted"
    );
    let failed = tracked::execute(
        store.clone(),
        body(json!(9)),
        0,
        Duration::from_secs(2),
        || panic!("synthetic worker failure"),
        Arc::new(|_| {}),
    )
    .await;
    let failed_id = failed.headers()["x-mcp-operation-id"].to_str().unwrap();
    let failure = store
        .query(
            &json!({"operation_id":failed_id,"include_result":true}),
            0,
            &["fixture_effect"],
        )
        .unwrap();
    assert_eq!(failure["operations"][0]["state"], "worker_failed");
    assert_eq!(
        failure["operations"][0]["completion_kind"],
        "outcome_unknown"
    );
    assert_eq!(failure["safe_to_retry"], false);
    println!("RECOVERY_CONTRACT: runtime isolation, duplicate ids, policy changes, bounded cache/capacity and worker failure are explicit");
}
