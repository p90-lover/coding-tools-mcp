//! Allowlisted original-function RPCs/POSTs. Observation snapshots stay in mod.rs.
use super::{endpoint, err, Source};
use crate::error::AppResult;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const ALLOWED_PASEO: &[&str] = &[
    "send_agent_message_request",
    "resume_agent_request",
    "cancel_agent_request",
    "archive_agent_request",
    "agent_permission_response",
    "create_agent_request",
];
const ALLOWED_ANNEAL_POST: &[&str] = &[
    "/tasks/{id}/start",
    "/tasks/{id}/retry",
    "/tasks/{id}/archive",
    "/tasks/{id}/unarchive",
    "/tasks/{id}/chain/hold",
    "/tasks/{id}/chain/resume",
    "/inbox/messages/{id}/decision",
    "/inbox/messages/{id}/reply",
    "/inbox/messages/{id}/close",
];

#[derive(Clone, Deserialize, Serialize, Debug)]
pub struct ActRequest {
    pub source: String,
    pub op: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub behavior: String,
}

#[derive(Clone, Serialize, Debug)]
pub struct ActResult {
    pub ok: bool,
    pub op: String,
    pub detail: String,
}

#[cfg(test)]
pub fn allowed_paseo_ops() -> &'static [&'static str] {
    ALLOWED_PASEO
}

#[cfg(test)]
pub fn allowed_anneal_posts() -> &'static [&'static str] {
    ALLOWED_ANNEAL_POST
}

fn token(value: &str, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err(err(&format!("{label} is required")));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        return Err(err(&format!("{label} contains unsupported characters")));
    }
    Ok(trimmed.into())
}

fn bounded_text(value: &str, max: usize, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(err(&format!("{label} is required")));
    }
    if trimmed.len() > max || trimmed.chars().any(char::is_control) {
        return Err(err(&format!(
            "{label} is too long or contains control characters"
        )));
    }
    Ok(trimmed.into())
}

fn request_id(raw: &str) -> String {
    if raw.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        raw.trim().chars().take(200).collect()
    }
}

pub async fn act(endpoint_raw: &str, credential: &str, req: ActRequest) -> AppResult<ActResult> {
    match req.source.as_str() {
        "paseo" => paseo_act(endpoint_raw, credential, req).await,
        "anneal" => anneal_act(endpoint_raw, credential, req).await,
        _ => Err(err("Unknown integration source")),
    }
}

async fn paseo_act(raw: &str, credential: &str, req: ActRequest) -> AppResult<ActResult> {
    let op = match req.op.as_str() {
        "send" => "send_agent_message_request",
        "resume" => "resume_agent_request",
        "cancel" => "cancel_agent_request",
        "archive" => "archive_agent_request",
        "permission" => "agent_permission_response",
        "create" => "create_agent_request",
        other => other,
    };
    if !ALLOWED_PASEO.contains(&op) {
        return Err(err(
            "Paseo operation is not in the original-function allowlist",
        ));
    }
    let rid = request_id(&req.request_id);
    let message = match op {
        "send_agent_message_request" => json!({
            "type": op,
            "requestId": rid,
            "agentId": token(&req.agent_id, "agent id")?,
            "text": bounded_text(&req.text, 8192, "message")?,
        }),
        "resume_agent_request" => json!({
            "type": op,
            "requestId": rid,
            "handle": {
                "provider": token(&req.provider, "provider")?,
                "sessionId": token(&req.session_id, "session id")?,
            }
        }),
        "cancel_agent_request" | "archive_agent_request" => json!({
            "type": op,
            "requestId": rid,
            "agentId": token(&req.agent_id, "agent id")?,
        }),
        "agent_permission_response" => {
            let behavior = req.behavior.trim();
            if behavior != "allow" && behavior != "deny" {
                return Err(err("Permission behavior must be allow or deny"));
            }
            json!({
                "type": op,
                "agentId": token(&req.agent_id, "agent id")?,
                "requestId": token(&req.request_id, "permission request id")?,
                "response": { "behavior": behavior }
            })
        }
        "create_agent_request" => json!({
            "type": op,
            "requestId": rid,
            "config": {
                "provider": token(&req.provider, "provider")?,
                "cwd": bounded_text(&req.cwd, 1024, "cwd")?,
            },
            "initialPrompt": bounded_text(&req.text, 8192, "prompt")?,
        }),
        _ => {
            return Err(err(
                "Paseo operation is not in the original-function allowlist",
            ))
        }
    };
    let expected = match op {
        "send_agent_message_request" => "send_agent_message_response",
        "resume_agent_request" => "resume_agent_response",
        "cancel_agent_request" => "cancel_agent_response",
        "archive_agent_request" => "archive_agent_response",
        "agent_permission_response" => "agent_permission_resolved",
        "create_agent_request" => "create_agent_response",
        _ => "rpc_error",
    };
    paseo_rpc(raw, credential, message, &rid, expected).await
}

async fn paseo_rpc(
    raw: &str,
    credential: &str,
    message: Value,
    request_id: &str,
    expected: &str,
) -> AppResult<ActResult> {
    let u = endpoint(Source::Paseo, raw)?;
    let origin = u.to_string();
    let mut request = origin
        .clone()
        .into_client_request()
        .map_err(|_| err("Invalid Paseo connection"))?;
    if !credential.is_empty() {
        if !credential
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        {
            return Err(err(
                "Paseo password must be valid WebSocket subprotocol token characters",
            ));
        }
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            format!("paseo.bearer.{credential}")
                .parse()
                .map_err(|_| err("Invalid Paseo credential encoding"))?,
        );
    }
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_BYTES);
    config.max_frame_size = Some(MAX_BYTES);
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        let (mut ws, _) = connect_async_with_config(request, Some(config), true)
            .await
            .map_err(|_| err("Paseo is not reachable. Check the daemon port; no agent was started."))?;
        ws.send(Message::Text(json!({"type":"hello","clientId":format!("coding-tools-actor-{}",uuid::Uuid::new_v4()),"clientType":"cli","protocolVersion":1,"capabilities":{"voice":false,"pushNotifications":false,"explicit_event_subscriptions":true,"selective_agent_timeline":true,"all_providers":true}}).to_string().into()))
            .await
            .map_err(|_| err("Paseo handshake failed"))?;
        let mut sent = false;
        for _ in 0..64 {
            let frame = ws
                .next()
                .await
                .ok_or_else(|| err("Paseo closed the connection; check its password"))?
                .map_err(|_| err("Paseo protocol or frame size was rejected"))?;
            match frame {
                Message::Text(raw) => {
                    let v: Value =
                        serde_json::from_str(&raw).map_err(|_| err("Paseo returned invalid JSON"))?;
                    if v["type"] != "session" {
                        continue;
                    }
                    let m = &v["message"];
                    if !sent
                        && m["payload"]["status"] == "server_info"
                        && m["payload"]["serverId"].is_string()
                    {
                        ws.send(Message::Text(
                            json!({"type":"session","message": message}).to_string().into(),
                        ))
                        .await
                        .map_err(|_| err("Paseo action request failed"))?;
                        sent = true;
                        continue;
                    }
                    if sent && m["type"] == "rpc_error" && m["payload"]["requestId"] == request_id {
                        return Ok(ActResult {
                            ok: false,
                            op: message["type"].as_str().unwrap_or("paseo").into(),
                            detail: m["payload"]["message"]
                                .as_str()
                                .unwrap_or("Paseo refused the request")
                                .chars()
                                .take(300)
                                .collect(),
                        });
                    }
                    if sent
                        && (m["type"] == expected
                            || m["payload"]["requestId"] == request_id
                            || (expected == "agent_permission_resolved"
                                && m["type"] == "agent_permission_resolved"))
                    {
                        return Ok(ActResult {
                            ok: true,
                            op: message["type"].as_str().unwrap_or("paseo").into(),
                            detail: format!("{expected} received"),
                        });
                    }
                }
                Message::Ping(p) => {
                    ws.send(Message::Pong(p))
                        .await
                        .map_err(|_| err("Paseo connection ended"))?;
                }
                Message::Close(_) => return Err(err("Paseo closed the action connection")),
                _ => {}
            }
        }
        Err(err("Paseo did not return a matching action response"))
    })
    .await;
    result.map_err(|_| err("Paseo action timed out"))?
}

fn anneal_path(op: &str, id: &str) -> AppResult<(&'static str, Value)> {
    let id = token(id, "id")?;
    match op {
        "start" => Ok((
            "/tasks/{id}/start",
            json!({"path": format!("/tasks/{id}/start"), "body": {}}),
        )),
        "retry" => Ok((
            "/tasks/{id}/retry",
            json!({"path": format!("/tasks/{id}/retry"), "body": {}}),
        )),
        "archive" => Ok((
            "/tasks/{id}/archive",
            json!({"path": format!("/tasks/{id}/archive"), "body": {}}),
        )),
        "unarchive" => Ok((
            "/tasks/{id}/unarchive",
            json!({"path": format!("/tasks/{id}/unarchive"), "body": {}}),
        )),
        "hold" => Ok((
            "/tasks/{id}/chain/hold",
            json!({"path": format!("/tasks/{id}/chain/hold"), "body": {"requestId": uuid::Uuid::new_v4().to_string()}}),
        )),
        "resume" => Ok((
            "/tasks/{id}/chain/resume",
            json!({"path": format!("/tasks/{id}/chain/resume"), "body": {"requestId": uuid::Uuid::new_v4().to_string()}}),
        )),
        "inbox_decision" => Ok((
            "/inbox/messages/{id}/decision",
            json!({"path": format!("/inbox/messages/{id}/decision"), "body": {"decision": "approve", "requestId": uuid::Uuid::new_v4().to_string()}}),
        )),
        "inbox_reply" => Ok((
            "/inbox/messages/{id}/reply",
            json!({"path": format!("/inbox/messages/{id}/reply"), "body": {"body": "", "requestId": uuid::Uuid::new_v4().to_string()}}),
        )),
        "inbox_close" => Ok((
            "/inbox/messages/{id}/close",
            json!({"path": format!("/inbox/messages/{id}/close"), "body": {"requestId": uuid::Uuid::new_v4().to_string()}}),
        )),
        _ => Err(err(
            "Anneal operation is not in the original-function allowlist",
        )),
    }
}

async fn anneal_act(raw: &str, credential: &str, req: ActRequest) -> AppResult<ActResult> {
    let id = if req.op.starts_with("inbox_") {
        req.message_id.clone()
    } else {
        req.task_id.clone()
    };
    let (pattern, spec) = anneal_path(&req.op, &id)?;
    if !ALLOWED_ANNEAL_POST.contains(&pattern) {
        return Err(err(
            "Anneal operation is not in the original-function allowlist",
        ));
    }
    let mut body = spec["body"].clone();
    if req.op == "inbox_decision" {
        body["decision"] = bounded_text(&req.text, 8000, "decision")?.into();
    }
    if req.op == "inbox_reply" {
        body["body"] = bounded_text(&req.text, 8000, "reply")?.into();
    }
    let path = spec["path"].as_str().unwrap();
    anneal_post(raw, credential, path, body)
        .await
        .map(|detail| ActResult {
            ok: true,
            op: req.op,
            detail,
        })
}

pub async fn anneal_post(
    raw: &str,
    credential: &str,
    path: &str,
    body: Value,
) -> AppResult<String> {
    let mut u = endpoint(Source::Anneal, raw)?;
    u.set_path(path);
    u.set_query(None);
    let c = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| err("Cannot initialize Anneal adapter"))?;
    let mut request = c.post(u).header("Accept", "application/json").json(&body);
    if !credential.is_empty() {
        request = request.bearer_auth(credential);
    }
    let response = tokio::time::timeout(Duration::from_secs(8), request.send())
        .await
        .map_err(|_| err("Anneal action timed out"))?
        .map_err(|_| err("Anneal is not reachable; no runner was started."))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(err(&format!(
            "Anneal returned HTTP {}. {}",
            status.as_u16(),
            text.chars()
                .filter(|c| !c.is_control())
                .take(180)
                .collect::<String>()
        )));
    }
    Ok(format!("HTTP {} at {}", status.as_u16(), path))
}

pub async fn anneal_inbox(raw: &str, credential: &str) -> AppResult<Value> {
    let mut u = endpoint(Source::Anneal, raw)?;
    u.set_path("/inbox/messages");
    u.set_query(None);
    let c = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| err("Cannot initialize Anneal adapter"))?;
    let mut request = c.get(u).header("Accept", "application/json");
    if !credential.is_empty() {
        request = request.bearer_auth(credential);
    }
    let response = request
        .send()
        .await
        .map_err(|_| err("Anneal inbox is not reachable"))?;
    if !response.status().is_success() {
        return Err(err(&format!(
            "Anneal inbox returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| err("Anneal inbox interrupted"))?;
    if bytes.len() > MAX_BYTES {
        return Err(err("Anneal inbox exceeds the observation limit"));
    }
    serde_json::from_slice(&bytes).map_err(|_| err("Anneal inbox did not return JSON"))
}

pub fn web_ui_probe_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|_| err("Cannot initialize web UI probe"))
}

pub async fn probe_web_ui(raw: &str) -> bool {
    let Ok(u) = super::lease::parse_web_ui(raw) else {
        return false;
    };
    let Ok(client) = web_ui_probe_client() else {
        return false;
    };
    let mut probe = u.clone();
    probe.set_fragment(None);
    matches!(client.get(probe).send().await, Ok(r) if r.status().as_u16() < 500)
}
