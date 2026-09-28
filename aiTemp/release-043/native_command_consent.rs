use super::*;
#[test]
fn native_command_separate_consent_contract() {
    let value = json!({"executable":"/not-executed/codex","expected_sha256":"0".repeat(64),
        "codex_home":"/not-opened/home","allow_model_usage":false,
        "allow_command_execution":true,"model":"unused","request_limit":1,"lifetime_seconds":60});
    assert!(serde_json::from_value::<Connection>(value).is_ok(),
        "COMMANDS_NEED_A_SEPARATE_LOCAL_GRANT_WITHOUT_MODEL_CONSENT");
}
