//! Bounded read-only adapters for pinned Paseo and Anneal wire contracts.
//! No subprocess, agent creation, prompt sending, runner, or external write method.
use super::{failure, Provider};
use crate::error::AppResult;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};
const LIMIT: usize = 2 * 1024 * 1024;

pub(super) fn normalize_endpoint(provider: Provider, raw: &str) -> AppResult<String> {
    if raw.len() > 2048
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
        || raw.contains('\\')
    {
        return Err(failure(
            "Use a loopback endpoint without whitespace or credentials.",
        ));
    }
    let mut u = url::Url::parse(raw).map_err(|_| failure("Invalid integration endpoint."))?;
    let local = match u.host() {
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    let schema = match provider {
        Provider::Paseo => u.scheme() == "ws",
        Provider::Anneal => u.scheme() == "http",
    };
    if !local
        || !schema
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.port_or_known_default() == Some(0)
    {
        return Err(failure("Use a literal loopback address (127.0.0.1 or [::1]); relay, remote, credential and redirect URLs are not accepted."));
    }
    match provider {
        Provider::Paseo => {
            if !matches!(u.path(), "/" | "/ws" | "/ws/") {
                return Err(failure("Paseo must use its /ws endpoint."));
            }
            u.set_path("/ws");
        }
        Provider::Anneal => {
            if !matches!(u.path(), "/" | "/api" | "/api/") {
                return Err(failure(
                    "Anneal must use its API origin or the web server's /api proxy.",
                ));
            }
            let p = u.path().trim_end_matches('/').to_string();
            u.set_path(&p);
        }
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}
fn text(v: &Value, key: &str, max: usize) -> String {
    v[key].as_str().unwrap_or("").chars().take(max).collect()
}
fn required(v: &Value, key: &str) -> AppResult<String> {
    let t = v[key]
        .as_str()
        .ok_or_else(|| failure("Upstream returned an incompatible directory record."))?;
    if t.is_empty() || t.len() > 240 {
        return Err(failure(
            "Upstream returned an invalid directory identifier.",
        ));
    }
    Ok(t.to_string())
}
fn parse_paseo(v: &Value, request_id: &str) -> AppResult<Value> {
    if v["type"] != "fetch_agents_response" || v["payload"]["requestId"] != request_id {
        return Err(failure("Unexpected Paseo response."));
    }
    let rows = v["payload"]["entries"]
        .as_array()
        .ok_or_else(|| failure("Paseo directory shape is incompatible."))?;
    if rows.len() > 200 {
        return Err(failure("Paseo returned too many directory rows."));
    }
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let a = &row["agent"];
        let id = required(a, "id")?;
        if !seen.insert(id.clone()) {
            return Err(failure("Paseo returned duplicate directory identifiers."));
        }
        items.push(json!({"id":id,"title":text(a,"title",240),"provider":text(a,"provider",80),"model":text(a,"model",120),"status":text(a,"status",60),"path":text(a,"cwd",1024),"created_at":text(a,"createdAt",80)}));
    }
    let page = &v["payload"]["pageInfo"];
    if !page["hasMore"].is_boolean() {
        return Err(failure("Paseo pagination metadata missing."));
    }
    let next = page["nextCursor"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if next.as_ref().is_some_and(|s| s.len() > 2048) || (page["hasMore"] == true && next.is_none())
    {
        return Err(failure("Paseo pagination cursor is invalid."));
    }
    Ok(json!({"source":"paseo","items":items,"has_more":page["hasMore"],"next_cursor":next}))
}
pub(super) async fn paseo(endpoint: &str, token: &str, cursor: Option<String>) -> AppResult<Value> {
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| failure("Paseo connection request invalid."))?;
    if !token.is_empty() {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            format!("paseo.bearer.{token}")
                .parse()
                .map_err(|_| failure("Invalid Paseo password format."))?,
        );
    }
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(LIMIT);
    config.max_frame_size = Some(LIMIT);
    let (mut socket, _) = tokio_tungstenite::connect_async_with_config(
        request,
        Some(config),
        false,
    )
    .await
    .map_err(|_| {
        failure("Cannot connect to Paseo. Check the running daemon, /ws URL and session password.")
    })?;
    let request_id = uuid::Uuid::new_v4().to_string();
    socket.send(Message::Text(json!({"type":"hello","clientId":format!("coding-tools-observer-{request_id}"),"clientType":"cli","protocolVersion":1,"capabilities":{"voice":false,"pushNotifications":false,"explicit_event_subscriptions":true,"selective_agent_timeline":true,"all_providers":true}}).to_string().into())).await.map_err(|_|failure("Paseo handshake failed."))?;
    let mut requested = false;
    for _ in 0..64 {
        let frame = socket
            .next()
            .await
            .ok_or_else(|| failure("Paseo closed the connection."))?
            .map_err(|_| failure("Paseo response could not be read within the size limit."))?;
        match frame {
            Message::Text(s) => {
                let msg: Value = serde_json::from_str(&s)
                    .map_err(|_| failure("Paseo returned malformed JSON."))?;
                let m = &msg["message"];
                if msg["type"] != "session" {
                    continue;
                }
                if !requested
                    && m["type"] == "status"
                    && m["payload"]["status"] == "server_info"
                    && m["payload"]["serverId"].is_string()
                {
                    let mut page = json!({"limit":100});
                    if let Some(ref c) = cursor {
                        page["cursor"] = json!(c);
                    }
                    socket.send(Message::Text(json!({"type":"session","message":{"type":"fetch_agents_request","requestId":request_id,"page":page}}).to_string().into())).await.map_err(|_|failure("Paseo directory request failed."))?;
                    requested = true;
                } else if requested
                    && m["type"] == "fetch_agents_response"
                    && m["payload"]["requestId"] == request_id
                {
                    let result = parse_paseo(m, &request_id)?;
                    // Drop closes the transport; no unsubscribe/state mutation is needed.
                    return Ok(result);
                } else if m["type"] == "rpc_error" && m["payload"]["requestId"] == request_id {
                    return Err(failure("Paseo refused the read-only directory request."));
                }
            }
            Message::Ping(bytes) => {
                socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| failure("Paseo keepalive failed."))?;
            }
            Message::Close(_) => {
                return Err(failure("Paseo closed the connection; verify the password."))
            }
            _ => {}
        }
    }
    Err(failure(
        "Paseo sent too many unrelated frames. No agent action was submitted.",
    ))
}
async fn get_document(client: &reqwest::Client, url: &str, token: &str) -> AppResult<Value> {
    let mut req = client
        .get(url)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-store");
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let mut response = req
        .send()
        .await
        .map_err(|_| failure("Cannot reach Anneal. Check its API/proxy and token."))?;
    if !response.status().is_success() {
        return Err(failure(&format!(
            "Anneal returned HTTP {}. No redirects or writes were attempted.",
            response.status().as_u16()
        )));
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(failure(
            "Anneal response exceeded 2 MiB. Use a smaller project scope.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure("Anneal response interrupted."))?
    {
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            return Err(failure("Anneal response exceeded 2 MiB."));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        failure("Anneal endpoint did not return JSON. Use the API origin or /api proxy.")
    })
}
fn parse_anneal(v: &Value) -> AppResult<Value> {
    let rows = v
        .as_array()
        .ok_or_else(|| failure("Anneal board contract is incompatible."))?;
    if rows.len() > 2000 {
        return Err(failure(
            "Anneal returned more than 2,000 tasks. Narrow the upstream board.",
        ));
    }
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let id = required(row, "id")?;
        if !seen.insert(id.clone()) {
            return Err(failure("Anneal returned duplicate task identifiers."));
        }
        let status = required(row, "status")?;
        let name = text(row, "displayName", 240);
        let name = if name.is_empty() {
            text(row, "name", 240)
        } else {
            name
        };
        if name.is_empty() {
            return Err(failure("Anneal task is missing its name."));
        }
        // Unknown statuses remain explicitly Unknown; never infer successful completion.
        let status = if ["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"].contains(&status.as_str()) {
            status
        } else {
            "UNKNOWN".into()
        };
        let chain = &row["chainAggregate"];
        items.push(json!({"id":id,"title":name,"status":status,"chain_id":text(row,"chainId",128),"chain_name":text(row,"chainName",240),"chain_status":text(chain,"status",60),"chain_progress":{"position":row["chainProgress"]["position"].as_u64(),"done":row["chainProgress"]["done"].as_u64(),"total":row["chainProgress"]["total"].as_u64()},"assignee":text(&row["assigneeAgent"],"title",120),"review_gate":row["approvalGate"].as_bool().unwrap_or(false),"failure_reason":text(row,"failureReason",1024),"updated_at":text(row,"updatedAt",80)}));
    }
    Ok(json!({"source":"anneal","items":items,"has_more":false,"next_cursor":null}))
}
pub(super) async fn anneal(endpoint: &str, token: &str) -> AppResult<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| failure("Cannot create Anneal observer."))?;
    parse_anneal(&get_document(&client, &format!("{endpoint}/tasks?view=board"), token).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn center_paseo_wire_only_sends_hello_and_directory_read() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let hello: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(hello["type"], "hello");
            assert_eq!(hello["capabilities"]["voice"], false);
            ws.send(Message::Text(json!({"type":"session","message":{"type":"status","payload":{"status":"server_info","serverId":"fixture"}}}).to_string().into())).await.unwrap();
            let read: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(read["message"]["type"], "fetch_agents_request");
            ws.send(Message::Text(json!({"type":"session","message":{"type":"fetch_agents_response","payload":{"requestId":read["message"]["requestId"],"entries":[{"agent":{"id":"one","title":"Existing session","status":"idle","provider":"codex","cwd":"/project"}}],"pageInfo":{"hasMore":false,"nextCursor":null,"prevCursor":null}}}}).to_string().into())).await.unwrap();
        });
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            paseo(&format!("ws://{addr}/ws"), "", None),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["items"][0]["title"], "Existing session");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn center_anneal_read_only_contract_rejects_remote_and_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for s in [
            "http://example.com",
            "http://127.0.0.1@evil.test",
            "http://localhost:3000",
            "http://127.0.0.1:3000/api/tasks",
            "http://127.0.0.1:3000/?token=x",
        ] {
            assert!(normalize_endpoint(Provider::Anneal, s).is_err());
        }
        assert_eq!(
            normalize_endpoint(Provider::Paseo, "ws://127.0.0.1:6767/").unwrap(),
            "ws://127.0.0.1:6767/ws"
        );
        for redirected in [false, true] {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = l.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut s, _) = l.accept().await.unwrap();
                let mut b = [0u8; 4096];
                let n = s.read(&mut b).await.unwrap();
                let r = String::from_utf8_lossy(&b[..n]);
                assert!(r.starts_with("GET /tasks?view=board HTTP/1.1"));
                assert!(!r.to_lowercase().contains("authorization:"));
                let body = r#"[{"id":"one","displayName":"Real task","status":"REVIEW","approvalGate":true}]"#;
                let response = if redirected {
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())
                };
                s.write_all(response.as_bytes()).await.unwrap();
            });
            let result = anneal(&format!("http://{addr}"), "").await;
            assert_eq!(result.is_err(), redirected);
            if let Ok(v) = result {
                assert_eq!(v["items"][0]["status"], "REVIEW");
            }
            server.await.unwrap();
        }
    }
}
