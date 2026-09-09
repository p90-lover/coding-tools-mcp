//! Explicit legacy handshake compatibility; never echo an unimplemented future revision.
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const LATEST: &str = "2025-11-25";
pub const SUPPORTED: &[&str] = &["2025-03-26", "2025-06-18", LATEST];

pub fn requested(params: &Value) -> Option<&str> {
    params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .filter(|v| {
            v.len() == 10
                && v.bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
        })
}
pub fn negotiate(params: &Value) -> Result<&'static str, Value> {
    let proposed = requested(params).ok_or_else(|| {
        json!({"code":-32602,
        "message":"initialize.params.protocolVersion must be a protocol date"})
    })?;
    Ok(SUPPORTED
        .iter()
        .copied()
        .find(|v| *v == proposed)
        .unwrap_or(LATEST))
}

/// Required after initialization. A missing header retains the specified legacy default.
pub fn http_version_error(headers: &HeaderMap) -> Option<Response> {
    let values = headers.get_all("mcp-protocol-version");
    if values.iter().count() > 1
        || values
            .iter()
            .any(|v| !v.to_str().is_ok_and(|s| SUPPORTED.contains(&s)))
    {
        return Some(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"jsonrpc":"2.0","error":{
            "code":-32600,"message":"Unsupported or ambiguous MCP-Protocol-Version",
            "data":{"supported":SUPPORTED,"initialize_required":true}}})),
            )
                .into_response(),
        );
    }
    None
}

/// Hash only the actual tool definitions, never grants, tokens, or the policy revision.
pub fn catalog_metadata(tools: &[Value], profile: &str) -> Result<Value, Value> {
    let bytes = serde_json::to_vec(tools)
        .map_err(|_| json!({"code":-32603,"message":"Cannot encode tool catalog"}))?;
    Ok(
        json!({"coding-tools-mcp/catalogSha256":format!("{:x}",Sha256::digest(bytes)),
        "coding-tools-mcp/toolProfile":profile,"coding-tools-mcp/toolCount":tools.len(),
        "coding-tools-mcp/clientApprovalRequiredForChanges":true}),
    )
}
