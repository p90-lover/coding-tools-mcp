//! Grant refusals shown in the local chat. Only fixed, credential-free reasons may escape;
//! persistence errors can contain private paths or file content and stay opaque.

pub(crate) fn message(error: Option<&str>) -> &'static str {
    match error {
        Some("AO executable identity is invalid") => {
            "AO executable identity is invalid; select the current executable before starting"
        }
        Some("AO run not found") => "AO run no longer exists in this workspace; refresh the chat",
        Some("AO run changed or has unresolved execution") => {
            "AO run revision or execution state changed; refresh the run and inspect its cards before starting"
        }
        Some("AO run has no bounded pending turns") => {
            "AO run has no eligible pending cards; inspect the run before starting"
        }
        Some("Archived tasks cannot execute; restore the mission first") => {
            "Archived tasks cannot execute; restore the mission first"
        }
        Some("Hidden tasks cannot execute; restore the mission first") => {
            "Hidden tasks cannot execute; restore the mission first"
        }
        Some("Configuration replacement is pending; no new attempt may start on the old mission") => {
            "Configuration replacement is pending; no new attempt may start on the old mission"
        }
        Some("This delayed mission has not been claimed for execution") => {
            "This delayed mission has not been claimed for execution"
        }
        Some("AO workspace changed after run grant") => {
            "AO workspace changed; refresh the workspace before starting"
        }
        Some("AO workspace path unavailable") => {
            "AO workspace folder is unavailable; restore access to the folder before starting"
        }
        Some("AO task changed after run grant") => {
            "AO task changed or was removed; refresh the chat before starting"
        }
        Some("AO clause changed after run grant") => {
            "AO task clause changed or was removed; inspect the run before starting"
        }
        Some("AO grant scope is unavailable") => {
            "AO grant scope could not be validated; inspect the run before starting"
        }
        Some("Live permission state cannot be read; execution is blocked.") => {
            "Workspace permissions are unavailable; execution stays blocked"
        }
        Some("This workspace context was removed or replaced; execution is blocked.") => {
            "Workspace context was replaced; refresh the workspace before starting"
        }
        Some("Permissions changed before this operation was submitted. Read server_info and reassess it under the current policy.") => {
            "Workspace permissions changed before the grant; refresh and reassess the run under the current policy"
        }
        Some("Approved project mappings changed during this request. Inspect state before reassessing; an already-submitted effect cannot be undone and must not be automatically replayed.") => {
            "Approved project mappings changed before the grant; inspect the workspace before starting"
        }
        Some(_) => {
            "AO grant could not be validated or saved; check the local service and task state before retrying"
        }
        None => "AO grant outcome is unknown; inspect the run before retrying",
    }
}

#[cfg(test)]
mod tests {
    use super::message;

    #[test]
    fn lifecycle_refusals_keep_their_actual_recovery_action() {
        for reason in [
            "Archived tasks cannot execute; restore the mission first",
            "Hidden tasks cannot execute; restore the mission first",
            "Configuration replacement is pending; no new attempt may start on the old mission",
            "This delayed mission has not been claimed for execution",
        ] {
            assert_eq!(message(Some(reason)), reason);
        }
    }

    #[test]
    fn revision_workspace_and_executable_failures_are_distinct() {
        let changed = message(Some("AO run changed or has unresolved execution"));
        assert!(changed.contains("revision or execution state"));
        assert!(!changed.contains("executable"));
        let workspace = message(Some("AO workspace path unavailable"));
        assert!(workspace.contains("folder is unavailable"));
        let executable = message(Some("AO executable identity is invalid"));
        assert!(executable.contains("executable identity"));
        assert_ne!(changed, workspace);
        assert_ne!(workspace, executable);
    }

    #[test]
    fn policy_failures_do_not_suggest_bypassing_permissions() {
        assert!(message(Some(
            "Live permission state cannot be read; execution is blocked."
        ))
        .contains("execution stays blocked"));
        assert!(message(Some(
            "This workspace context was removed or replaced; execution is blocked."
        ))
        .contains("refresh the workspace"));
        assert!(message(Some("Permissions changed before this operation was submitted. Read server_info and reassess it under the current policy."))
            .contains("under the current policy"));
    }

    #[test]
    fn unexpected_errors_cannot_disclose_private_content_or_match_by_substring() {
        let fallback = message(Some("unrecognized error"));
        for error in [
            "invalid data: PRIVATE_API_KEY from G:/private/profiles.json",
            "Archived tasks cannot execute; restore the mission first PRIVATE_API_KEY",
            "prefix: AO workspace path unavailable",
            "",
        ] {
            assert_eq!(message(Some(error)), fallback);
            assert!(!message(Some(error)).contains("PRIVATE_API_KEY"));
        }
        assert!(!fallback.contains("executable changed"));
    }

    #[test]
    fn worker_failure_has_an_uncertain_outcome_not_a_claimed_rejection() {
        assert!(message(None).contains("outcome is unknown"));
        assert_ne!(message(None), message(Some("unrecognized error")));
    }
}
