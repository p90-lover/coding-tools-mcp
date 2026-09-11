//! Catalog visibility evidence, not client registration or authorization.
//! Reads only static definitions and a caller's already captured live-policy snapshot.
use super::{registry, ToolContext};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn describe(profile: &str) -> Value {
    let tools = registry::list_tools_for_profile(profile);
    let all = registry::list_tools_for_profile("full");
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    let hidden: Vec<&str> = all
        .iter()
        .filter_map(|t| t["name"].as_str())
        .filter(|n| !names.contains(n))
        .collect();
    let read_only = tools
        .iter()
        .filter(|t| t["annotations"]["readOnlyHint"] == true)
        .count();
    // The metadata digest depends on schemas and annotations, not grants or policy mode.
    let bytes = serde_json::to_vec(&tools).expect("tool metadata is JSON");
    json!({
        "profile":registry::normalize_tool_profile(profile),
        "registered_count":all.len(),"advertised_count":tools.len(),
        "advertised_names":names,"hidden_by_profile":hidden,
        "read_only_hint_count":read_only,"write_hint_count":tools.len()-read_only,
        "catalog_sha256":format!("{:x}",Sha256::digest(&bytes)),
        "catalog_bytes":bytes.len(),
        "advertised_but_unavailable":tools.iter().filter_map(|t| t["name"].as_str())
            .filter(|n| *n == "sandbox_exec" && !crate::tools::native_sandbox::available()).collect::<Vec<_>>(),
        "client_loaded_tools":Value::Null,
        "client_registration_verified":false,
        "visibility_grants_execution":false,
        "note":"This is server-side catalog evidence. ChatGPT's saved metadata, selected connection and approved actions are separate. Unimplemented capabilities are not hidden registered tools."
    })
}

pub fn describe_current(ctx: &ToolContext) -> Value {
    let mut report = describe(&ctx.tool_profile);
    report["policy_revision"] = json!(ctx.policy_revision);
    report["permission_mode"] = json!(ctx.permission_mode);
    report["screen_capture_allowed"] = json!(ctx.policy.allow_screen_capture);
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn catalog_exposure_counts_fingerprint_and_unknown_client_are_honest() {
        let full = describe("full");
        assert_eq!(full, describe("advanced"));
        assert!(full["hidden_by_profile"].as_array().unwrap().is_empty());
        assert_eq!(full["advertised_count"], full["registered_count"]);
        assert_eq!(full["registered_count"], 71);
        assert_eq!(describe("core")["advertised_count"], 58);
        assert_eq!(describe("read-only")["advertised_count"], 42);
        assert!(!describe("read-only")["advertised_names"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n == "sandbox_exec"));
        assert_eq!(
            full["advertised_but_unavailable"]
                .as_array()
                .unwrap()
                .is_empty(),
            crate::tools::native_sandbox::available()
        );
        assert!(full["advertised_names"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n == "workflow_update"));
        for profile in ["core", "read-only", "advanced", "compat-readonly-all"] {
            let report = describe(profile);
            let actual = registry::list_tools_for_profile(profile);
            assert_eq!(report["advertised_count"], actual.len());
            assert_eq!(
                report["advertised_names"],
                Value::Array(actual.iter().map(|t| t["name"].clone()).collect())
            );
            assert_eq!(
                report["registered_count"].as_u64().unwrap(),
                report["advertised_count"].as_u64().unwrap()
                    + report["hidden_by_profile"].as_array().unwrap().len() as u64
            );
            assert!(report["client_loaded_tools"].is_null());
            assert_eq!(report["client_registration_verified"], false);
            assert_eq!(report["visibility_grants_execution"], false);
        }
        let core = describe("core");
        assert!(
            core["advertised_count"].as_u64().unwrap() < full["advertised_count"].as_u64().unwrap()
        );
        assert!(core["hidden_by_profile"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n == "start_task"));
        assert_ne!(core["catalog_sha256"], full["catalog_sha256"]);
    }

    #[test]
    fn catalog_exposure_live_profile_matches_rpc_without_restart_or_privilege_escalation() {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/catalog-exposure")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let ctx = Arc::new(ToolContext::for_test(root.clone(), root.join("harness")).unwrap());
        let mut policy = ctx.for_request().unwrap().policy;
        policy.permission_mode = "read-only".into();
        super::super::live_policy::commit_updates(
            vec![(ctx.clone(), policy.clone(), "core".into())],
            || Ok(()),
        )
        .unwrap();
        let core = describe_current(&ctx.for_request().unwrap());
        super::super::live_policy::commit_updates(
            vec![(ctx.clone(), policy, "full".into())],
            || Ok(()),
        )
        .unwrap();
        let full = describe_current(&ctx.for_request().unwrap());
        let list = crate::mcp::server::handle_request(
            &ctx,
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        );
        assert_eq!(
            full["advertised_count"],
            list["result"]["tools"].as_array().unwrap().len()
        );
        assert_eq!(full["permission_mode"], "read-only");
        assert_eq!(full["screen_capture_allowed"], false);
        assert_ne!(core["catalog_sha256"], full["catalog_sha256"]);
        let info = crate::mcp::server::handle_request(
            &ctx,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"server_info","arguments":{}}}),
        );
        assert_eq!(info["result"]["structuredContent"]["tool_catalog"], full);
        let denied = crate::mcp::server::handle_request(
            &ctx,
            &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"apply_patch","arguments":{"patch":"*** Begin Patch\n*** Add File: must-not-exist.txt\n+denied\n*** End Patch\n"}}}),
        );
        assert_eq!(denied["result"]["isError"], true);
        assert!(!root.join("must-not-exist.txt").exists());
        let mut writable = ctx.for_request().unwrap().policy;
        writable.permission_mode = "workspace-write".into();
        super::super::live_policy::commit_updates(
            vec![(ctx.clone(), writable, "advanced".into())],
            || Ok(()),
        )
        .unwrap();
        let after = describe_current(&ctx.for_request().unwrap());
        assert_eq!(
            after["catalog_sha256"], full["catalog_sha256"],
            "Permission-only changes must not change tool definitions"
        );
        println!("CATALOG_EVIDENCE {}", json!({"core":core,"full":full}));
    }
}
