use serde_json::json;

use super::{mcp_protected_resource_metadata, protected_resource_metadata};

#[test]
fn mcp_metadata_identifies_the_path_qualified_resource() {
    let metadata = mcp_protected_resource_metadata("https://mcp.example/");
    assert_eq!(metadata["resource"], json!("https://mcp.example/mcp"));
    assert_eq!(
        metadata["authorization_servers"],
        json!(["https://mcp.example"])
    );
    assert!(metadata.get("scopes_supported").is_none());
}

#[test]
fn origin_metadata_keeps_the_origin_resource_identifier() {
    let metadata = protected_resource_metadata("https://mcp.example/");
    assert_eq!(metadata["resource"], json!("https://mcp.example"));
    assert_eq!(
        metadata["authorization_servers"],
        json!(["https://mcp.example"])
    );
}

#[test]
fn listener_routes_the_path_derived_location_to_the_mcp_metadata_handler() {
    let source = include_str!("../../src-tauri/src/mcp/listener.rs");
    assert!(source.contains("get(oauth_mcp_protected_resource_metadata)"));
    assert!(source.contains("Json(mcp_protected_resource_metadata(&resolve_oauth_base("));
}

#[test]
fn bearer_challenge_advertises_the_path_derived_metadata_location() {
    let source = include_str!("../../src-tauri/src/mcp/transport.rs");
    assert!(source.contains(
        "{}/.well-known/oauth-protected-resource/mcp\\\", scope=\\\"mcp\\\""
    ));
    assert!(!source.contains(
        "{}/.well-known/oauth-protected-resource\\\", scope=\\\"mcp\\\""
    ));
}
