use coding_tools_mcp_desktop_lib::tools::{exec_profile::resolve, registry::input_schema};
use serde_json::json;

#[test]
fn ordinary_commands_have_no_deadline_and_no_separate_mode() {
    for args in [
        json!({}),
        json!({"timeout_ms": null}),
        json!({"timeout_ms": 0}),
    ] {
        assert_eq!(resolve(&args).unwrap().timeout_ms, None);
    }
    let duration = 14_u64 * 24 * 60 * 60 * 1000;
    assert_eq!(
        resolve(&json!({"timeout_ms": duration}))
            .unwrap()
            .timeout_ms,
        Some(duration)
    );
    assert_eq!(resolve(&json!({})).unwrap().yield_time_ms, 1000);
    assert!(resolve(&json!({"execution_profile":"long-running"})).is_err());
    let schema = input_schema("exec_command");
    assert!(schema["properties"].get("execution_profile").is_none());
    assert!(schema["properties"]["timeout_ms"].get("maximum").is_none());
    assert!(schema["properties"]["timeout_ms"]["default"].is_null());
}
