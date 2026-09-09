//! MCP HTTP compatibility at the transport boundary. Never changes tool authorization.
use super::{mcp_discovery, require_mcp_auth, ListenerState};
use axum::extract::State;
use axum::http::{
    header::{ACCEPT, ALLOW, WWW_AUTHENTICATE},
    HeaderMap, HeaderValue, StatusCode,
};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

/// Keep the desktop's legacy JSON health probe, but do not impersonate an SSE stream.
pub(super) async fn get_handler(
    State(state): State<ListenerState>,
    headers: HeaderMap,
) -> Response {
    let wants_stream = headers
        .get_all(ACCEPT)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(','))
        .any(|h| {
            h.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        });
    if wants_stream {
        if let Some(response) = require_mcp_auth(&state, &headers) {
            return response;
        }
        return (StatusCode::METHOD_NOT_ALLOWED, [(ALLOW, "POST")]).into_response();
    }
    mcp_discovery().await
}

/// Only the desktop-configured origin is accepted here, never Host/Forwarded headers.
pub(super) fn oauth_challenge(mut response: Response, server_url: &str) -> Response {
    if response.status() != StatusCode::UNAUTHORIZED {
        return response;
    }
    let challenge = format!(
        "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\", scope=\"mcp\"",
        server_url.trim_end_matches('/')
    );
    let Ok(value) = HeaderValue::from_str(&challenge) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "OAuth discovery configuration is invalid",
        )
            .into_response();
    };
    response.headers_mut().insert(WWW_AUTHENTICATE, value);
    response
}

/// A notification is a one-way message, not a JSON `null` RPC response.
/// Reject invalid envelopes before dispatch so an id-less tools/call cannot execute.
pub(super) fn early_response(body: &Value) -> Option<Response> {
    let method = body.get("method").and_then(Value::as_str);
    let valid = body.is_object()
        && body["jsonrpc"] == "2.0"
        && method.is_some_and(|s| !s.is_empty())
        && body.get("params").is_none_or(Value::is_object)
        && body.get("result").is_none()
        && body.get("error").is_none();
    if valid && body.get("id").is_none() && method.is_some_and(|m| m.starts_with("notifications/"))
    {
        return Some(StatusCode::ACCEPTED.into_response());
    }
    if valid
        && body
            .get("id")
            .is_some_and(|id| id.is_string() || id.is_i64() || id.is_u64())
    {
        return None;
    }
    Some((StatusCode::BAD_REQUEST, Json(json!({"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid MCP request envelope"}}))).into_response())
}

fn protocol_error(code: i64, message: &str, data: Value) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"jsonrpc":"2.0","error":{"code":code,"message":message,"data":data}})),
    )
        .into_response()
}
pub(super) fn validate_protocol_headers(headers: &HeaderMap, body: &Value) -> Option<Response> {
    const MODERN: &str = "2026-07-28";
    const SUPPORTED: &[&str] = &[MODERN, "2025-11-25", "2025-06-18"];
    let body_version = body
        .pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion")
        .and_then(Value::as_str);
    let header_version = headers
        .get("mcp-protocol-version")
        .and_then(|v| v.to_str().ok());
    for version in [body_version, header_version].into_iter().flatten() {
        if !SUPPORTED.contains(&version) {
            return Some(protocol_error(
                -32022,
                "Unsupported protocol version",
                json!({"supported":SUPPORTED,"requested":version}),
            ));
        }
    }
    if let (Some(body_version), Some(header_version)) = (body_version, header_version) {
        if body_version != header_version {
            return Some(protocol_error(
                -32020,
                "MCP protocol header/body mismatch",
                json!({"header":header_version,"body":body_version}),
            ));
        }
    }
    if body_version == Some(MODERN) || header_version == Some(MODERN) {
        if body_version != Some(MODERN) || header_version != Some(MODERN) {
            return Some(protocol_error(
                -32020,
                "Modern MCP requires matching protocol metadata and header",
                json!({"expected":MODERN}),
            ));
        }
        let method = body.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(method_header) = headers.get("mcp-method").and_then(|v| v.to_str().ok()) else {
            return Some(protocol_error(
                -32020,
                "Modern MCP requires Mcp-Method",
                json!({"method":method}),
            ));
        };
        if method_header != method {
            return Some(protocol_error(
                -32020,
                "Mcp-Method header/body mismatch",
                json!({"header":method_header,"body":method}),
            ));
        }
        if method == "tools/call" {
            let name = body
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(name_header) = headers.get("mcp-name").and_then(|v| v.to_str().ok()) else {
                return Some(protocol_error(
                    -32020,
                    "Modern tools/call requires Mcp-Name",
                    json!({"name":name}),
                ));
            };
            if name_header != name {
                return Some(protocol_error(
                    -32020,
                    "Mcp-Name header/body mismatch",
                    json!({"header":name_header,"body":name}),
                ));
            }
        }
    }
    None
}

#[cfg(test)]
mod connection_repair_tests {
    include!("../../../aiTemp/connection-tests/http.rs");
}
