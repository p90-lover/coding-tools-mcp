//! Credential-free, non-mutating discovery checks. Never restart a tunnel to probe it.
use super::TunnelServiceKind;
use crate::error::{AppError, AppResult};
use crate::settings::AppSettings;
use serde_json::Value;
use std::time::Duration;

fn invalid(message: &str) -> AppError {
    AppError::Message(message.into())
}
pub fn public_origin(value: &str) -> AppResult<String> {
    if value.len() > 2048
        || value.contains('\\')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(invalid(
            "A public HTTPS origin without credentials or whitespace is required",
        ));
    }
    let u = url::Url::parse(value).map_err(|_| invalid("Invalid public HTTPS URL"))?;
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !matches!(u.path(), "" | "/" | "/mcp" | "/mcp/")
        || !matches!(u.host(), Some(url::Host::Domain(_)))
        || !host.contains('.')
        || host.ends_with('.')
        || [".localhost", ".local", ".internal"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return Err(invalid("Use a public HTTPS hostname with no credentials/query/fragment and no path except /mcp"));
    }
    Ok(u.origin().ascii_serialization())
}
struct PooledProbeClient {
    mode: String,
    url: String,
    created: std::time::Instant,
    client: reqwest::Client,
}
fn client(settings: &AppSettings) -> AppResult<reqwest::Client> {
    // Reuse TLS/HTTP pools, not health results. Key by proxy policy and never log
    // the URL (it may contain proxy credentials). System environment is reread
    // on a fresh client at most 60 seconds later; cached clients are bounded.
    static CLIENTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::VecDeque<PooledProbeClient>>,
    > = std::sync::OnceLock::new();
    let mode = match settings.proxy.mode.as_str() {
        "manual" => "manual",
        "system" => "system",
        _ => "none",
    };
    let url = if mode == "manual" {
        settings.proxy.url.trim()
    } else {
        ""
    };
    let mut clients = CLIENTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| invalid("Discovery client pool unavailable"))?;
    clients.retain(|entry| entry.created.elapsed() < Duration::from_secs(60));
    if let Some(entry) = clients
        .iter()
        .find(|entry| entry.mode == mode && entry.url == url)
    {
        return Ok(entry.client.clone());
    }
    let created = build_client(settings)?;
    if clients.len() >= 4 {
        clients.pop_front();
    }
    clients.push_back(PooledProbeClient {
        mode: mode.into(),
        url: url.into(),
        created: std::time::Instant::now(),
        client: created.clone(),
    });
    Ok(created)
}
fn build_client(settings: &AppSettings) -> AppResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(2))
        .pool_idle_timeout(Duration::from_secs(20))
        .pool_max_idle_per_host(3)
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true);
    match settings.proxy.mode.as_str() {
        "manual" => {
            let proxy = reqwest::Proxy::all(settings.proxy.url.trim())
                .map_err(|_| invalid("Invalid configured proxy"))?;
            b = b.no_proxy().proxy(proxy);
        }
        "system" => {}
        _ => b = b.no_proxy(),
    }
    b.build()
        .map_err(|_| invalid("Cannot create discovery probe client"))
}
async fn document(client: &reqwest::Client, url: &str) -> AppResult<Value> {
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|_| {
            invalid("Public endpoint is unreachable; the existing tunnel was not restarted")
        })?;
    if !response.status().is_success() {
        return Err(invalid(&format!(
            "Discovery returned HTTP {}; no redirects or login pages are accepted",
            response.status().as_u16()
        )));
    }
    if response.content_length().is_some_and(|n| n > 65_536) {
        return Err(invalid("Discovery response exceeds 64 KiB"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| invalid("Discovery response interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > 65_536 {
            return Err(invalid("Discovery response exceeds 64 KiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Endpoint did not return JSON discovery metadata"))
}
fn validate_mcp(v: &Value) -> AppResult<()> {
    if v["name"] != "coding-tools-mcp"
        || !v["version"].is_string()
        || !v["protocolVersion"].is_string()
    {
        return Err(invalid(
            "Public address is not this app's MCP discovery endpoint",
        ));
    }
    Ok(())
}
fn validate_authorization(origin: &str, auth: &Value) -> AppResult<()> {
    if auth["issuer"] != origin
        || auth["authorization_endpoint"] != format!("{origin}/oauth/authorize")
        || auth["token_endpoint"] != format!("{origin}/oauth/token")
    {
        return Err(invalid(
            "OAuth metadata does not match the current tunnel origin; no credentials were sent",
        ));
    }
    if auth["grant_types_supported"]
        .as_array()
        .is_none_or(|v| !v.iter().any(|s| s == "refresh_token"))
        || auth["code_challenge_methods_supported"]
            .as_array()
            .is_none_or(|v| !v.iter().any(|s| s == "S256"))
    {
        return Err(invalid(
            "OAuth discovery is missing refresh-token or S256 support",
        ));
    }
    Ok(())
}
fn validate_oauth(origin: &str, auth: &Value, resource: &Value) -> AppResult<()> {
    validate_authorization(origin, auth)?;
    if resource["resource"] != origin
        || resource["authorization_servers"]
            .as_array()
            .is_none_or(|v| v != &[Value::String(origin.into())])
    {
        return Err(invalid(
            "OAuth resource metadata does not match the current tunnel origin",
        ));
    }
    Ok(())
}
async fn probe_with_client(
    origin: &str,
    kind: TunnelServiceKind,
    oauth: bool,
    client: &reqwest::Client,
) -> AppResult<()> {
    // Three independent credential-free documents share one deadline rather
    // than paying three sequential round trips. Every identity check remains.
    let status = async {
        match kind {
            TunnelServiceKind::Mcp => {
                validate_mcp(&document(client, &format!("{origin}/mcp")).await?)
            }
            TunnelServiceKind::Actions => {
                let value = document(client, &format!("{origin}/health")).await?;
                if value["ok"] != true
                    || value["service"] != "coding-tools-actions"
                    || !value["tools_loaded"].is_u64()
                {
                    Err(invalid(
                        "Public address is not this app's Actions health endpoint",
                    ))
                } else {
                    Ok(())
                }
            }
        }
    };
    if !oauth {
        return status.await;
    }
    let auth_url = format!("{origin}/.well-known/oauth-authorization-server");
    match kind {
        TunnelServiceKind::Mcp => {
            let resource_url = format!("{origin}/.well-known/oauth-protected-resource");
            let (_, auth, resource) = tokio::try_join!(
                status,
                document(client, &auth_url),
                document(client, &resource_url)
            )?;
            validate_oauth(origin, &auth, &resource)
        }
        TunnelServiceKind::Actions => {
            let (_, auth) = tokio::try_join!(status, document(client, &auth_url))?;
            validate_authorization(origin, &auth)
        }
    }
}

pub async fn probe_public_service(
    base: &str,
    kind: TunnelServiceKind,
    oauth: bool,
    settings: &AppSettings,
) -> AppResult<()> {
    let origin = public_origin(base)?;
    // At most two public probes (six metadata requests) can be active. Busy
    // diagnostics never restart a tunnel, replay a tool or manufacture success.
    static PROBES: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let _permit = PROBES
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("Public discovery busy; existing tunnel left unchanged"))?;
    let client = client(settings)?;
    tokio::time::timeout(
        Duration::from_secs(5),
        probe_with_client(&origin, kind, oauth, &client),
    )
    .await
    .map_err(|_| invalid("Public discovery deadline exceeded; existing tunnel left unchanged"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_origin_and_oauth_identity_are_strict() {
        assert_eq!(
            public_origin("https://mcp.example.com/mcp/").unwrap(),
            "https://mcp.example.com"
        );
        for value in [
            "http://example.com",
            "https://u:secret@example.com",
            "https://127.0.0.1",
            "https://[::1]",
            "https://app.local",
            "https://app.internal",
            "https://app.local.",
            "https://example.com/mcp/mcp",
            "https://example.com/?token=a",
        ] {
            assert!(public_origin(value).is_err(), "{value}");
        }
        let origin = "https://new.example.com";
        let a = crate::auth::authorization_server_metadata(origin, None);
        let resource = crate::auth::protected_resource_metadata(origin);
        assert!(validate_oauth(origin, &a, &resource).is_ok());
        assert!(validate_oauth("https://old.example.com", &a, &resource).is_err());
        assert!(validate_mcp(&serde_json::json!({"name":"other-service","version":"1","protocolVersion":"2025-06-18"})).is_err());
    }
    #[tokio::test]
    async fn connection_probe_rejects_redirects_and_oversized_documents() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for response in [
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/never-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 65537\r\nConnection: close\r\n\r\n",
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let count = socket.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..count]).to_ascii_lowercase();
                assert!(!request.contains("authorization:") && !request.contains("cookie:"));
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2)).build().unwrap();
            assert!(document(&client, &format!("http://{addr}/mcp")).await.is_err());
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn connection_actions_probe_uses_only_routes_the_listener_exposes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected_origin = origin.clone();
        let server = tokio::spawn(async move {
            // _seen_expected_routes: parallel requests may arrive in either order.
            // Still require exactly these two routes, once each, without credentials.
            let mut expected = std::collections::HashSet::from([
                "/health",
                "/.well-known/oauth-authorization-server",
            ]);
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0u8; 512];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0 && request.len() + n <= 4096);
                    request.extend_from_slice(&buf[..n]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                assert!(headers.starts_with(&format!("get {path} http/1.1\r\n")));
                assert!(
                    expected.remove(path),
                    "Unexpected or duplicate discovery route"
                );
                assert!(!headers.contains("authorization:") && !headers.contains("cookie:"));
                let value = if path == "/health" {
                    serde_json::json!({"ok":true,"service":"coding-tools-actions","tools_loaded":42})
                } else {
                    crate::auth::authorization_server_metadata(&expected_origin, None)
                };
                let body = value.to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            assert!(expected.is_empty());
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        assert!(
            probe_with_client(&origin, TunnelServiceKind::Actions, true, &client)
                .await
                .is_ok()
        );
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[cfg(test)]
#[path = "../../../aiTemp/quicktunnel/probe_contract.rs"]
mod quick_probe_contract;
