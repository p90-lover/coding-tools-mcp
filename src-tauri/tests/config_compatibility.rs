use coding_tools_mcp_desktop_lib::config_compat::preview;

#[test]
fn codex_toml_is_parsed_without_activating_permissions_or_exposing_hooks() {
    let text = "approval_policy = 'never'\nsandbox_mode = 'workspace-write'\n[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = ['F:/project']\n[hooks]\ncommand = 'PRIVATE-HOOK-CONTENT'\n";
    let result = preview("codex", text).unwrap();
    assert_eq!(result["proposed"]["approval_mode"], "never");
    assert_eq!(result["proposed"]["permission_mode"], "workspace-write");
    assert_eq!(result["proposed"]["network_allowed"], false);
    assert_eq!(result["applied"], false);
    assert_eq!(result["sandbox_equivalent"], false);
    assert_eq!(result["model_calls"], false);
    assert!(!result.to_string().contains("PRIVATE-"));
    assert_eq!(
        preview("codex", text).unwrap()["source_sha256"],
        result["source_sha256"]
    );
    let unsafe_mode = preview("codex", "sandbox_mode = 'danger-full-access'").unwrap();
    assert!(unsafe_mode["proposed"]["permission_mode"].is_null());
    assert_eq!(unsafe_mode["automatic_import_blocked"], true);
    assert!(preview("codex", "SECRET = [PRIVATE-TOKEN")
        .unwrap_err()
        .find("PRIVATE")
        .is_none());
}

#[test]
fn claude_json_keeps_deny_precedence_and_refuses_unsupported_auto_bypass_translation() {
    let text = r#"{"permissions":{"defaultMode":"acceptEdits","deny":["Read(./.env)"],"ask":["Bash(git push *)"],"allow":["Read","Bash(git status *)"]},"env":{"API_KEY":"PRIVATE-TOKEN"}}"#;
    let result = preview("claude", text).unwrap();
    assert_eq!(result["proposed"]["permission_mode"], "workspace-write");
    assert_eq!(
        result["rule_order"],
        serde_json::json!(["deny", "ask", "allow"])
    );
    assert_eq!(result["rules"]["deny"], 1);
    assert_eq!(result["automatic_import_blocked"], true);
    assert!(!result.to_string().contains("PRIVATE-"));
    for mode in ["auto", "bypassPermissions"] {
        let result = preview(
            "claude",
            &format!(r#"{{"permissions":{{"defaultMode":"{mode}"}}}}"#),
        )
        .unwrap();
        assert!(result["proposed"]["permission_mode"].is_null());
        assert_eq!(result["automatic_import_blocked"], true);
    }
    assert!(preview("claude", r#"{"permissions":{"deny":"Read"}}"#).is_err());
    assert!(preview("claude", &" ".repeat(64 * 1024 + 1)).is_err());
}
