//! Truthful capability metadata: only the bundled Windows snapshot tool has OS isolation.
#[path = "registry_definitions.rs"]
mod definitions;
pub use definitions::*;
use serde_json::{json, Value};
pub fn list_tools() -> Vec<Value> {
    list_tools_for_profile("full")
}
pub fn list_tools_for_profile(profile: &str) -> Vec<Value> {
    let mut tools = definitions::list_tools_for_profile(profile);
    let included = crate::tools::native_sandbox::available();
    for tool in &mut tools {
        let status = match tool["name"].as_str() {
            Some("sandbox_status") => true,
            Some("sandbox_exec") => false,
            _ => continue,
        };
        let title = if status {
            "Snapshot sandbox status"
        } else if included {
            "Offline snapshot execution (local approval required)"
        } else {
            "Snapshot execution unavailable on this platform/build"
        };
        tool["title"] = json!(title);
        tool["annotations"]["title"] = json!(title);
        tool["description"] = json!(if status {
            "Report the included helper and this exact workspace's local permission. Does not launch a process or prepare OS state. Only sandbox_exec uses this isolation; ordinary commands and GUI remain separate."
        } else if included {
            "Execute a Windows system EXE or explicitly copied input EXE in a no-network AppContainer with read-only selected input and separate writable scratch. Requires visible local approval bound to workspace, policy and helper hash. Honors shared approvals and read-only rejection. Stop/permission changes terminate owned processes; no host fallback. Not the complete Codex sandbox: OS/package-readable locations may remain readable. Does not alter or automatically import outputs into the original project."
        } else {
            "No native snapshot helper in this build. Always fails closed, without elevation, downloads, a Codex agent, or unsandboxed fallback."
        });
        tool["annotations"]["readOnlyHint"] = json!(status || !included);
        tool["annotations"]["destructiveHint"] = json!(false);
        tool["annotations"]["idempotentHint"] = json!(status || !included);
        tool["annotations"]["openWorldHint"] = json!(false);
    }
    tools
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn core_catalog_exposes_chatgpt_compatible_tools_without_unreleased_claims() {
        for p in ["core", "read-only", "advanced", "compat-readonly-all"] {
            let a = definitions::list_tools_for_profile(p);
            let b = list_tools_for_profile(p);
            assert_eq!(a.len(), b.len());
            for (old, new) in a.iter().zip(&b) {
                if !crate::tools::native_sandbox::NAMES.contains(&new["name"].as_str().unwrap()) {
                    assert_eq!(old, new);
                } else {
                    let status = new["name"] == "sandbox_status";
                    assert_eq!(
                        new["annotations"]["readOnlyHint"],
                        status || !crate::tools::native_sandbox::available()
                    );
                }
            }
        }
        assert_eq!(list_tools(), list_tools_for_profile("full"));
        for d in [
            include_str!("../../../docs/features/native-command-sandbox.md"),
            include_str!("../../../docs/features/native-sandbox-read-boundary.md"),
            include_str!("../../../native-helpers/NOTICE.md"),
        ] {
            assert!(d.contains(crate::tools::native_sandbox::RELEASE_STATUS));
        }
    }
}
