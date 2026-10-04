//! Native permission IDs and effective policy acknowledgement; no substitute sandbox.
use serde_json::{json, Value};

pub(super) fn profile_id_valid(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id != ":ao-default"
        && id.trim() == id
        && !id.chars().any(char::is_control)
}

pub(super) fn selection_valid(policy: Option<&str>, reviewer: Option<&str>) -> bool {
    policy.is_none_or(|value| matches!(value, "on-request" | "never"))
        && reviewer.is_none_or(|value| matches!(value, "user" | "auto_review"))
        && !(reviewer == Some("auto_review") && policy == Some("never"))
}

pub(super) fn require_allowed(
    metadata: &Value,
    profile: &str,
    policy: &str,
    reviewer: &str,
    model: &str,
) -> Result<(), String> {
    if !metadata["profiles"].as_array().is_some_and(|profiles| {
        profiles
            .iter()
            .any(|entry| entry["id"] == profile && entry["allowed"] == true)
    }) {
        return Err(format!(
            "Native permission profile {profile} is unavailable or denied by managed policy"
        ));
    }
    if let Some(policies) = metadata["requirements"]["allowedApprovalPolicies"].as_array() {
        if !policies.iter().any(|allowed| allowed == policy) {
            return Err(format!(
                "Native approval policy {policy} is denied by managed policy"
            ));
        }
    }
    if metadata["requirements"]["autoReview"]["requiredOnModels"]
        .as_array()
        .is_some_and(|models| models.iter().any(|required| required == model))
        && reviewer != "auto_review"
    {
        return Err("Managed policy requires automatic review for this model".into());
    }
    Ok(())
}

pub(super) fn effective_policy(
    value: &Value,
    profile: &str,
    policy: &str,
    reviewer: &str,
    explicit: bool,
) -> Result<Value, String> {
    if value["activePermissionProfile"]["id"].as_str() != Some(profile)
        || (explicit
            && (value["approvalPolicy"] != policy || value["approvalsReviewer"] != reviewer))
    {
        return Err("Native runtime did not acknowledge the exact selected permission profile, approval policy and reviewer; no turn submitted".into());
    }
    Ok(
        json!({"permission_profile":profile,"approval_policy":value["approvalPolicy"],"approvals_reviewer":value["approvalsReviewer"],"active_permission_profile":value["activePermissionProfile"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_policy_rejects_substitution_and_managed_denial() {
        let metadata = json!({"profiles":[{"id":":workspace","allowed":true},{"id":":danger-full-access","allowed":false}],"requirements":{"allowedApprovalPolicies":["on-request"]}});
        assert!(
            require_allowed(&metadata, ":workspace", "on-request", "auto_review", "gpt").is_ok()
        );
        assert!(require_allowed(
            &metadata,
            ":danger-full-access",
            "on-request",
            "user",
            "gpt"
        )
        .is_err());
        assert!(require_allowed(&metadata, "custom", "on-request", "user", "gpt").is_err());
        assert!(require_allowed(&metadata, ":workspace", "never", "user", "gpt").is_err());
        let value = json!({"activePermissionProfile":{"id":":workspace"},"approvalPolicy":"on-request","approvalsReviewer":"auto_review"});
        assert!(effective_policy(&value, ":workspace", "on-request", "auto_review", true).is_ok());
        assert!(effective_policy(&value, ":workspace", "on-request", "user", true).is_err());
        assert!(effective_policy(&value, ":read-only", "on-request", "auto_review", true).is_err());
        assert!(!selection_valid(Some("never"), Some("auto_review")));
    }
}
