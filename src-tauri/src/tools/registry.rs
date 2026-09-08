//! Keep the established catalog/schema definitions while advertising the actual
//! released capability boundary. An unavailable executor must never look ready.
#[path = "registry_definitions.rs"]
mod definitions;
pub use definitions::*;
use serde_json::{json, Value};

pub fn list_tools() -> Vec<Value> {
    list_tools_for_profile("full")
}

pub fn list_tools_for_profile(tool_profile: &str) -> Vec<Value> {
    let mut tools = definitions::list_tools_for_profile(tool_profile);
    for tool in &mut tools {
        let title = match tool["name"].as_str() {
            Some("sandbox_status") => "Native sandbox unavailable: release status",
            Some("sandbox_exec") => "Native sandbox execution unavailable",
            _ => continue,
        };
        tool["title"] = json!(title);
        tool["annotations"]["title"] = json!(title);
        tool["description"] = if tool["name"] == "sandbox_status" {
            json!("Report that the native command sandbox is withheld pending verification. This release returns available=false and cannot prepare or launch sandbox helpers. Computer-control and vision tools are separate.")
        } else {
            json!("Unavailable in this release: always rejects with NATIVE_SANDBOX_NOT_RELEASED. Do not select this tool to execute commands. No sandbox helper, elevation, or unsandboxed fallback runs. Native command isolation has not passed release verification.")
        };
        tool["annotations"]["readOnlyHint"] = json!(true);
        tool["annotations"]["destructiveHint"] = json!(false);
        tool["annotations"]["idempotentHint"] = json!(true);
        tool["annotations"]["openWorldHint"] = json!(false);
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn core_catalog_exposes_chatgpt_compatible_tools_without_unreleased_claims() {
        for profile in ["core", "read-only", "advanced", "compat-readonly-all"] {
            let expected = definitions::list_tools_for_profile(profile);
            let actual = list_tools_for_profile(profile);
            assert_eq!(expected.len(), actual.len());
            for (original, released) in expected.iter().zip(&actual) {
                if !crate::tools::native_sandbox::NAMES.contains(&released["name"].as_str().unwrap()) {
                    assert_eq!(original, released, "Unrelated tool metadata must not change");
                } else {
                    assert!(released["title"].as_str().unwrap().to_lowercase().contains("unavailable"));
                    assert_eq!(released["annotations"]["readOnlyHint"], true);
                    if released["name"] == "sandbox_exec" {
                        assert!(released["description"].as_str().unwrap().contains("NATIVE_SANDBOX_NOT_RELEASED"));
                    }
                }
            }
        }
        assert_eq!(list_tools(), list_tools_for_profile("full"));
        for document in [
            include_str!("../../../docs/features/native-command-sandbox.md"),
            include_str!("../../../docs/features/native-sandbox-read-boundary.md"),
            include_str!("../../../native-helpers/NOTICE.md"),
        ] {
            assert!(document.contains(crate::tools::native_sandbox::RELEASE_STATUS));
        }
    }
}
