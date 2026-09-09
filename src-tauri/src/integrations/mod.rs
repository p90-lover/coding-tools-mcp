//! Narrow, observation-only adapters. No provider CLI, mutation RPC or inference client.
pub mod board;
pub mod board_sync;
use crate::error::{AppError, AppResult};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
};
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 200;
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
fn err(s: &str) -> AppError {
    AppError::Message(s.into())
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Paseo,
    Anneal,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub status: String,
    pub provider: String,
    pub workspace: String,
    pub updated_at: String,
    pub pending_permissions: usize,
    pub requires_attention: bool,
    pub chain_id: Option<String>,
    pub chain_index: Option<u64>,
    pub chain_layer: Option<u64>,
    pub chain_name: Option<String>,
    pub attention_reason: Option<String>,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub source: Source,
    pub endpoint: String,
    pub checked_at: u64,
    pub read_only: bool,
    pub items: Vec<Item>,
    pub has_more: bool,
    pub server_version: Option<String>,
}
/// Literal loopback only: no DNS, redirects, proxies, embedded credentials or arbitrary paths.
pub fn endpoint(source: Source, value: &str) -> AppResult<url::Url> {
    if value.len() > 512
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || value.contains('\\')
    {
        return Err(err(
            "Use a literal loopback endpoint without whitespace or credentials",
        ));
    }
    let mut u = url::Url::parse(value).map_err(|_| err("Invalid integration endpoint"))?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(err(
            "Credentials and query parameters are not allowed in endpoint URLs",
        ));
    }
    match u.host(){Some(url::Host::Ipv4(ip)) if ip==std::net::Ipv4Addr::LOCALHOST=>{},Some(url::Host::Ipv6(ip)) if ip==std::net::Ipv6Addr::LOCALHOST=>{},_=>return Err(err("Use 127.0.0.1 or [::1]. Remote services require a user-managed secure local port forward."))}
    if u.port().is_none() {
        return Err(err("Specify the integration service port"));
    }
    match source {
        Source::Paseo if u.scheme() == "ws" && matches!(u.path(), "" | "/" | "/ws") => {
            u.set_path("/ws")
        }
        Source::Anneal if u.scheme() == "http" && matches!(u.path(), "" | "/") => u.set_path("/"),
        _ => {
            return Err(err(
                "Paseo uses ws://127.0.0.1:6767/ws; Anneal uses http://127.0.0.1:3000/",
            ))
        }
    }
    Ok(u)
}
fn text(v: &Value, key: &str, max: usize) -> String {
    v[key]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}
fn optional(v: &Value, key: &str) -> Option<String> {
    let s = text(v, key, 200);
    (!s.is_empty()).then_some(s)
}
fn item(v: &Value, source: Source) -> AppResult<Item> {
    let id = text(v, "id", 200);
    if id.is_empty() {
        return Err(err(
            "Integration returned a record without an ID; unsupported schema",
        ));
    }
    let status = text(v, "status", 80);
    if status.is_empty() {
        return Err(err(
            "Integration returned a record without a state; unsupported schema",
        ));
    }
    let paseo = source == Source::Paseo;
    // Anneal approvalGate is configuration, not a pending-approval signal.
    // REVIEW and a current waiting-inbox phase indicate operator attention.
    let task_state = status.to_ascii_uppercase();
    let requires_attention = v["requiresAttention"].as_bool().unwrap_or(false)
        || (!paseo
            && (matches!(
                task_state.as_str(),
                "REVIEW" | "BLOCKED" | "FAILED" | "ERROR"
            ) || (task_state == "DOING" && v["latestRun"]["phase"] == "waiting-inbox")));
    Ok(Item {
        id,
        title: if paseo {
            text(v, "title", 300)
        } else {
            let n = text(v, "displayName", 300);
            if n.is_empty() {
                text(v, "name", 300)
            } else {
                n
            }
        },
        status,
        provider: if paseo {
            text(v, "provider", 100)
        } else {
            text(&v["assigneeAgent"], "model", 100)
        },
        workspace: if paseo {
            text(v, "cwd", 1024)
        } else {
            text(v, "chainName", 300)
        },
        updated_at: text(v, "updatedAt", 100),
        pending_permissions: v["pendingPermissions"]
            .as_array()
            .map_or(0, |a| a.len().min(1000)),
        requires_attention,
        chain_id: optional(v, "chainId"),
        chain_index: v["chainIndex"].as_u64(),
        chain_layer: v["chainLayer"].as_u64(),
        chain_name: optional(v, "chainName"),
        attention_reason: optional(v, "attentionReason"),
    })
}
fn unique_ids(items: &[Item]) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    if items.iter().any(|v| !seen.insert(v.id.as_str())) {
        return Err(err(
            "Duplicate record IDs in integration response; snapshot rejected",
        ));
    }
    Ok(())
}
pub async fn read(source: Source, raw: &str, credential: &str) -> AppResult<Snapshot> {
    let _permit = SLOTS
        .try_acquire()
        .map_err(|_| err("Two integration checks are already in progress"))?;
    let u = endpoint(source, raw)?;
    if credential.len() > 4096 || credential.chars().any(char::is_control) {
        return Err(err("Invalid integration credential"));
    }
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        match source {
            Source::Paseo => paseo(u, credential).await,
            Source::Anneal => anneal(u, credential).await,
        }
    })
    .await;
    result.map_err(|_| err("Integration timed out. Existing agents and tasks were not changed."))?
}
async fn anneal(mut u: url::Url, credential: &str) -> AppResult<Snapshot> {
    let origin = u.to_string();
    u.set_path("/tasks");
    u.set_query(Some("view=board&archived=false"));
    let c = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| err("Cannot initialize read-only adapter"))?;
    let mut request = c.get(u).header("Accept", "application/json");
    if !credential.is_empty() {
        request = request.bearer_auth(credential);
    }
    let mut response = request.send().await.map_err(|_| {
        err("Anneal is not reachable. Start/configure its API separately; no runner was started.")
    })?;
    if !response.status().is_success() {
        return Err(err(&format!(
            "Anneal returned HTTP {}. Check the API port and operator token.",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(err("Anneal response exceeds the 2 MiB observation limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| err("Anneal response interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(err("Anneal response exceeds the observation limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| err("Anneal did not return JSON board data"))?;
    let rows = value.as_array().ok_or_else(|| {
        err("Unsupported Anneal board schema; expected the board projection array")
    })?;
    let items = rows
        .iter()
        .take(MAX_ROWS)
        .map(|v| item(v, Source::Anneal))
        .collect::<AppResult<Vec<_>>>()?;
    unique_ids(&items)?;
    Ok(Snapshot {
        source: Source::Anneal,
        endpoint: origin,
        checked_at: now(),
        read_only: true,
        items,
        has_more: rows.len() > MAX_ROWS,
        server_version: None,
    })
}
async fn paseo(u: url::Url, credential: &str) -> AppResult<Snapshot> {
    let origin = u.to_string();
    let mut request = origin
        .clone()
        .into_client_request()
        .map_err(|_| err("Invalid Paseo connection"))?;
    if !credential.is_empty() {
        // Paseo authenticates the socket through its bearer subprotocol, not URL query strings.
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
    let (mut ws, _) = connect_async_with_config(request, Some(config), true)
        .await
        .map_err(|_| err("Paseo is not reachable. Check the daemon port; no agent was started."))?;
    // These are the ONLY application messages this adapter can send.
    ws.send(Message::Text(json!({"type":"hello","clientId":format!("coding-tools-observer-{}",uuid::Uuid::new_v4()),"clientType":"cli","protocolVersion":1,"capabilities":{"voice":false,"pushNotifications":false,"explicit_event_subscriptions":true,"selective_agent_timeline":true,"all_providers":true}}).to_string().into())).await.map_err(|_|err("Paseo handshake failed"))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut sent = false;
    let mut version = None;
    let mut total = 0usize;
    for _ in 0..64 {
        let frame = ws
            .next()
            .await
            .ok_or_else(|| err("Paseo closed the connection; check its password"))?
            .map_err(|_| err("Paseo protocol or frame size was rejected"))?;
        match frame {
            Message::Text(raw) => {
                total = total.saturating_add(raw.len());
                if total > MAX_BYTES * 2 {
                    return Err(err("Paseo observation traffic limit reached"));
                }
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
                    version = optional(&m["payload"], "version");
                    ws.send(Message::Text(json!({"type":"session","message":{"type":"fetch_agents_request","requestId":request_id,"scope":"active","page":{"limit":MAX_ROWS}}}).to_string().into())).await.map_err(|_|err("Paseo read request failed"))?;
                    sent = true;
                }
                if sent && m["type"] == "rpc_error" && m["payload"]["requestId"] == request_id {
                    return Err(err("Paseo refused the read-only session directory request"));
                }
                if sent
                    && m["type"] == "fetch_agents_response"
                    && m["payload"]["requestId"] == request_id
                {
                    let rows = m["payload"]["entries"]
                        .as_array()
                        .ok_or_else(|| err("Unsupported Paseo directory schema"))?;
                    let items = rows
                        .iter()
                        .take(MAX_ROWS)
                        .map(|r| item(&r["agent"], Source::Paseo))
                        .collect::<AppResult<Vec<_>>>()?;
                    unique_ids(&items)?;
                    let has_more = rows.len() > MAX_ROWS
                        || m["payload"]["pageInfo"]["hasMore"]
                            .as_bool()
                            .unwrap_or(false);
                    // Dropping the socket does not archive or stop any external agent.
                    return Ok(Snapshot {
                        source: Source::Paseo,
                        endpoint: origin,
                        checked_at: now(),
                        read_only: true,
                        items,
                        has_more,
                        server_version: version,
                    });
                }
            }
            Message::Ping(p) => {
                ws.send(Message::Pong(p))
                    .await
                    .map_err(|_| err("Paseo connection ended"))?;
            }
            Message::Close(_) => return Err(err("Paseo closed the observation connection")),
            _ => {}
        }
    }
    Err(err(
        "Paseo response limit reached before a matching directory response",
    ))
}
#[cfg(test)]
mod tests;
