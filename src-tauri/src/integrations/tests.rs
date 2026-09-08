use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn control_center_boundaries_and_lossless_board() {
    for raw in [
        "https://example.com",
        "http://localhost:3000",
        "http://127.0.0.2:3000",
        "http://user:pass@127.0.0.1:3000",
        "http://127.0.0.1:3000/tasks",
        "http://127.0.0.1:3000/?token=x",
    ] {
        assert!(endpoint(Source::Anneal, raw).is_err(), "{raw}");
    }
    assert_eq!(
        endpoint(Source::Paseo, "ws://127.0.0.1:6767")
            .unwrap()
            .path(),
        "/ws"
    );
    assert!(endpoint(Source::Anneal, "http://[::1]:3000/").is_ok());
    let mut b = board::Board::default();
    board::apply(
        &mut b,
        0,
        board::Change::Create {
            workspace_id: "w".into(),
            title: "Deliver".into(),
            description: "Spec".into(),
        },
    )
    .unwrap();
    let id = b.tasks[0].id.clone();
    assert!(board::apply(&mut b, 0, board::Change::Start { id: id.clone() }).is_err());
    board::apply(&mut b, 1, board::Change::Start { id: id.clone() }).unwrap();
    assert!(board::apply(
        &mut b,
        2,
        board::Change::RecordStep {
            id: id.clone(),
            note: " ".into()
        }
    )
    .is_err());
    for n in 0..12 {
        let r = b.revision;
        board::apply(
            &mut b,
            r,
            board::Change::RecordStep {
                id: id.clone(),
                note: format!("Operator evidence {n}"),
            },
        )
        .unwrap();
    }
    assert_eq!(b.tasks[0].state, "done");
    let r = b.revision;
    board::apply(&mut b, r, board::Change::Archive { id: id.clone() }).unwrap();
    assert_eq!(b.tasks.len(), 1);
    assert_eq!(b.tasks[0].evidence.len(), 12);
    let r = b.revision;
    board::apply(&mut b, r, board::Change::Restore { id }).unwrap();
    assert_eq!(b.tasks[0].state, "done");
    assert!(b.tasks[0]
        .evidence
        .iter()
        .all(|e| e.source == "operator_attestation"));
    assert!(
        serde_json::from_value::<board::Change>(json!({"operation":"run","provider":"codex"}))
            .is_err()
    );
    let migrated: crate::data::AppData = serde_json::from_value(json!({"profiles":[]})).unwrap();
    assert!(migrated.control_board.tasks.is_empty());
}

#[tokio::test]
async fn control_center_anneal_only_reads_fixed_board_route() {
    for redirect in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut data = vec![];
            loop {
                let mut b = [0; 1024];
                let n = sock.read(&mut b).await.unwrap();
                assert!(n > 0 && data.len() + n < 8192);
                data.extend_from_slice(&b[..n]);
                if data.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let raw = String::from_utf8(data).unwrap().to_lowercase();
            assert!(raw.starts_with("get /tasks?view=board&archived=false http/1.1\r\n"));
            assert!(raw.contains("authorization: bearer fixture-token"));
            let body=json!([{"id":"t1","name":"Review","status":"blocked","approvalGate":true,"chainIndex":2,"chainLayer":1}]).to_string();
            let response = if redirect {
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
            } else {
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())
            };
            sock.write_all(response.as_bytes()).await.unwrap();
        });
        let result = read(Source::Anneal, &url, "fixture-token").await;
        if redirect {
            assert!(result.is_err());
        } else {
            let result = result.unwrap();
            assert!(result.read_only);
            assert!(result.items[0].requires_attention);
            assert_eq!(result.items[0].chain_layer, Some(1));
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn control_center_paseo_handshake_and_correlated_read_only_rpc() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
        let hello: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocolVersion"], 1);
        ws.send(Message::Text(json!({"type":"session","message":{"type":"status","payload":{"status":"server_info","serverId":"fixture","version":"test"}}}).to_string().into())).await.unwrap();
        let request: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(request["message"]["type"], "fetch_agents_request");
        assert_eq!(request["message"]["scope"], "active");
        let mut response = json!({"type":"session","message":{"type":"fetch_agents_response","payload":{"requestId":"wrong","entries":[],"pageInfo":{"hasMore":false}}}});
        ws.send(Message::Text(response.to_string().into()))
            .await
            .unwrap();
        response["message"]["payload"]["requestId"] = request["message"]["requestId"].clone();
        response["message"]["payload"]["entries"] = json!([{"agent":{"id":"a1","title":"Existing session","provider":"codex","status":"idle","attentionReason":"permission","pendingPermissions":[]}}]);
        ws.send(Message::Text(response.to_string().into()))
            .await
            .unwrap();
        if let Ok(Some(Ok(message))) = tokio::time::timeout(Duration::from_secs(1), ws.next()).await
        {
            assert!(
                !message.is_text(),
                "No agent mutation RPC may follow the directory read"
            );
        }
    });
    let result = read(Source::Paseo, &url, "").await.unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(
        result.items[0].attention_reason.as_deref(),
        Some("permission")
    );
    assert!(result.read_only);
    server.await.unwrap();
}
