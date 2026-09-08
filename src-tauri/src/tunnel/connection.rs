//! Credential-free, non-mutating discovery checks. Never restart a tunnel to probe it.
use crate::error::{AppError, AppResult};
use crate::settings::AppSettings;
use super::TunnelServiceKind;
use serde_json::Value;
use std::time::Duration;

fn invalid(message: &str) -> AppError { AppError::Message(message.into()) }
pub fn public_origin(value: &str) -> AppResult<String> {
    if value.len() > 2048 || value.contains('\\') || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid("A public HTTPS origin without credentials or whitespace is required"));
    }
    let u = url::Url::parse(value).map_err(|_| invalid("Invalid public HTTPS URL"))?;
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some()
        || u.query().is_some() || u.fragment().is_some() || !matches!(u.path(), "" | "/" | "/mcp" | "/mcp/")
        || !matches!(u.host(), Some(url::Host::Domain(_))) || !host.contains('.')
        || host.ends_with('.') || [".localhost", ".local", ".internal"].iter().any(|suffix| host.ends_with(suffix)) {
        return Err(invalid("Use a public HTTPS hostname with no credentials/query/fragment and no path except /mcp"));
    }
    Ok(u.origin().ascii_serialization())
}
fn client(settings: &AppSettings) -> AppResult<reqwest::Client> {
    let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5)).connect_timeout(Duration::from_secs(2));
    match settings.proxy.mode.as_str() {
        "manual" => {
            let proxy = reqwest::Proxy::all(settings.proxy.url.trim()).map_err(|_| invalid("Invalid configured proxy"))?;
            b = b.no_proxy().proxy(proxy);
        },
        "system" => {},
        _ => b = b.no_proxy(),
    }
    b.build().map_err(|_| invalid("Cannot create discovery probe client"))
}
async fn document(client: &reqwest::Client, url: &str) -> AppResult<Value> {
    let mut response = client.get(url).header("Accept", "application/json")
        .header("Cache-Control", "no-cache").send().await
        .map_err(|_| invalid("Public endpoint is unreachable; the existing tunnel was not restarted"))?;
    if !response.status().is_success() {
        return Err(invalid(&format!("Discovery returned HTTP {}; no redirects or login pages are accepted", response.status().as_u16())));
    }
    if response.content_length().is_some_and(|n| n > 65_536) { return Err(invalid("Discovery response exceeds 64 KiB")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid("Discovery response interrupted"))? {
        if bytes.len().saturating_add(chunk.len()) > 65_536 { return Err(invalid("Discovery response exceeds 64 KiB")); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid("Endpoint did not return JSON discovery metadata"))
}
fn validate_mcp(v: &Value) -> AppResult<()> {
    if v["name"] != "coding-tools-mcp" || !v["version"].is_string() || !v["protocolVersion"].is_string() {
        return Err(invalid("Public address is not this app's MCP discovery endpoint"));
    }
    Ok(())
}
fn validate_authorization(origin: &str, auth: &Value) -> AppResult<()> {
    if auth["issuer"] != origin || auth["authorization_endpoint"] != format!("{origin}/oauth/authorize")
        || auth["token_endpoint"] != format!("{origin}/oauth/token") {
        return Err(invalid("OAuth metadata does not match the current tunnel origin; no credentials were sent"));
    }
    if auth["grant_types_supported"].as_array().is_none_or(|v| !v.iter().any(|s| s == "refresh_token"))
        || auth["code_challenge_methods_supported"].as_array().is_none_or(|v| !v.iter().any(|s| s == "S256")) {
        return Err(invalid("OAuth discovery is missing refresh-token or S256 support"));
    }
    Ok(())
}
fn validate_oauth(origin: &str, auth: &Value, resource: &Value) -> AppResult<()> {
    validate_authorization(origin, auth)?;
    if resource["resource"] != origin
        || resource["authorization_servers"].as_array().is_none_or(|v| v != &[Value::String(origin.into())]) {
        return Err(invalid("OAuth resource metadata does not match the current tunnel origin"));
    }
    Ok(())
}
async fn probe_with_client(origin: &str, kind: TunnelServiceKind, oauth: bool, client: &reqwest::Client) -> AppResult<()> {
    match kind {
        TunnelServiceKind::Mcp => validate_mcp(&document(client, &format!("{origin}/mcp")).await?)?,
        TunnelServiceKind::Actions => {
            // Actions has a small, stable health document. Its full OpenAPI schema
            // can legitimately exceed the discovery limit and is not a liveness probe.
            let v = document(client, &format!("{origin}/health")).await?;
            if v["ok"] != true || v["service"] != "coding-tools-actions" || !v["tools_loaded"].is_u64() {
                return Err(invalid("Public address is not this app's Actions health endpoint"));
            }
        }
    }
    if oauth {
        let auth = document(client, &format!("{origin}/.well-known/oauth-authorization-server")).await?;
        validate_authorization(origin, &auth)?;
        // The Actions listener does not expose MCP protected-resource discovery;
        // do not mistake the missing route for a connection failure.
        if kind == TunnelServiceKind::Mcp {
            let resource = document(client, &format!("{origin}/.well-known/oauth-protected-resource")).await?;
            validate_oauth(origin, &auth, &resource)?;
        }
    }
    Ok(())
}
pub async fn probe_public_service(base: &str, kind: TunnelServiceKind, oauth: bool, settings: &AppSettings) -> AppResult<()> {
    let origin = public_origin(base)?;
    probe_with_client(&origin, kind, oauth, &client(settings)?).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_origin_and_oauth_identity_are_strict() {
        assert_eq!(public_origin("https://mcp.example.com/mcp/").unwrap(), "https://mcp.example.com");
        for value in ["http://example.com", "https://u:secret@example.com", "https://127.0.0.1", "https://[::1]", "https://app.local", "https://app.internal", "https://app.local.", "https://example.com/mcp/mcp", "https://example.com/?token=a"] {
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
            for path in ["/health", "/.well-known/oauth-authorization-server"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0u8; 512];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0 && request.len() + n <= 4096);
                    request.extend_from_slice(&buf[..n]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") { break; }
                }
                let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
                assert!(headers.starts_with(&format!("get {path} http/1.1\r\n")));
                assert!(!headers.contains("authorization:") && !headers.contains("cookie:"));
                let value = if path == "/health" {
                    serde_json::json!({"ok":true,"service":"coding-tools-actions","tools_loaded":42})
                } else { crate::auth::authorization_server_metadata(&expected_origin, None) };
                let body = value.to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2)).build().unwrap();
        assert!(probe_with_client(&origin, TunnelServiceKind::Actions, true, &client).await.is_ok());
        tokio::time::timeout(Duration::from_secs(3), server).await.unwrap().unwrap();
    }
}
