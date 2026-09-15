use serde_json::Value;

use super::oauth::protected_resource_metadata;

/// RFC 9728 derives the metadata resource identifier from the path-qualified
/// protected resource. The authorization server remains the trusted origin.
pub(crate) fn mcp_protected_resource_metadata(base_url: &str) -> Value {
    let base = base_url.trim_end_matches('/');
    let mut metadata = protected_resource_metadata(base);
    metadata["resource"] = Value::String(format!("{base}/mcp"));
    metadata
}
