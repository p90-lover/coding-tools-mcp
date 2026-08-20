from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("apply_approval_patch.py")
spec = importlib.util.spec_from_file_location("approval_patch_base", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("unable to load base approval patcher")
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

TARGET_AFTER_COUNTS = {
    "persist runtime approval mode": 1,
    "initialize runtime approval mode": 1,
    "add approval mode TypeScript type": 1,
    "add approval mode to draft interface": 1,
    "add approval mode prop": 2,
}


def replace_occurrence_aware(path: str, before: str, after: str, label: str) -> None:
    file_path = patcher.ROOT / path
    text = file_path.read_text(encoding="utf-8")
    after_target = TARGET_AFTER_COUNTS.get(label, 1)
    after_count = text.count(after)
    before_count = text.count(before)

    if after_count >= after_target:
        print(f"already applied: {label}")
        return
    if before_count < 1:
        raise RuntimeError(
            f"{label}: expected a source match, found {before_count}; "
            f"applied matches={after_count}/{after_target}"
        )
    if label not in TARGET_AFTER_COUNTS and before_count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {before_count}")

    patcher.backup(Path(path))
    file_path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


patcher.replace_once = replace_occurrence_aware
patcher.main()

replace_occurrence_aware(
    "src-tauri/tests/call_tool_contract.rs",
    '''#[test]
fn request_permissions_is_unsupported_not_silent_grant() {
    let fx = tiny_js_fixture();
    let ctx = ctx_for(&fx.root);
    let out = invoke(
        &ctx,
        "request_permissions",
        json!({
            "tool_name": "exec_command",
            "permission": "network",
            "reason": "verify compliance denial shape",
            "arguments": {"cmd": "curl https://example.com"}
        }),
    );
    assert_err(&out);
    assert_eq!(out["error"]["code"], "ELICITATION_UNSUPPORTED");
    assert_eq!(out["status"], "unsupported");
}
''',
    '''#[test]
fn request_permissions_requires_a_live_pending_request() {
    let fx = tiny_js_fixture();
    let ctx = ctx_for(&fx.root);
    let out = invoke(
        &ctx,
        "request_permissions",
        json!({
            "request_id": "missing-or-expired-request",
            "confirm": true,
            "scope": "once"
        }),
    );
    let error = assert_err(&out);
    assert_eq!(error["error"]["code"], "INVALID_APPROVAL");
    assert_eq!(error["error"]["category"], "permission");
    assert_eq!(error["error"]["details"]["reason"], "request_missing");
}
''',
    "update missing approval request contract",
)

replace_occurrence_aware(
    "src-tauri/tests/call_tool_contract.rs",
    '''#[test]
fn request_permissions_exposes_public_schema_and_grants_in_dangerous_mode() {
    let tools = list_tools_for_profile("core");
    let tool = tools
        .iter()
        .find(|tool| tool["name"] == "request_permissions")
        .expect("request_permissions descriptor");
    let schema = &tool["inputSchema"];
    assert_eq!(
        schema["required"],
        json!(["tool_name", "permission", "reason", "arguments"])
    );
    assert!(schema["properties"]["permission"]["enum"]
        .as_array()
        .expect("permission enum")
        .contains(&json!("network")));

    let fx = tiny_js_fixture();
    let mut ctx = ctx_for(&fx.root);
    ctx.permission_mode = "dangerous".into();
    ctx.policy.permission_mode = "dangerous".into();
    let args = json!({
        "tool_name": "exec_command",
        "permission": "network",
        "reason": "verify dangerous-mode compatibility",
        "arguments": {"cmd": "curl https://example.com"}
    });
    let out = invoke(&ctx, "request_permissions", args.clone());
    let payload = assert_ok(&out);
    assert_eq!(payload["status"], "granted");
    assert_eq!(payload["constraints"]["mode"], "dangerous");
    assert_eq!(payload["constraints"]["requested"], args);
}
''',
    '''#[test]
fn request_permissions_exposes_scoped_schema_and_grants_a_pending_operation() {
    let tools = list_tools_for_profile("core");
    let tool = tools
        .iter()
        .find(|tool| tool["name"] == "request_permissions")
        .expect("request_permissions descriptor");
    let schema = &tool["inputSchema"];
    assert_eq!(schema["required"], json!(["request_id", "confirm"]));
    assert_eq!(
        schema["properties"]["scope"]["enum"],
        json!(["once", "session"])
    );

    let fx = tiny_js_fixture();
    let ctx = ctx_for(&fx.root);
    let blocked = invoke(
        &ctx,
        "exec_command",
        json!({"cmd": "rm -rf build"}),
    );
    let blocked_error = assert_err(&blocked);
    assert_eq!(blocked_error["error"]["code"], "APPROVAL_REQUIRED");
    assert_eq!(blocked_error["error"]["details"]["risk"], "destructive");
    let request_id = blocked_error["error"]["details"]["request_id"]
        .as_str()
        .expect("pending request id");

    let granted = invoke(
        &ctx,
        "request_permissions",
        json!({
            "request_id": request_id,
            "confirm": true,
            "scope": "once",
            "reason": "approve the exact destructive test operation"
        }),
    );
    let payload = assert_ok(&granted);
    assert_eq!(payload["status"], "granted");
    assert_eq!(payload["scope"], "once");
    assert_eq!(payload["risk"], "destructive");
    assert_eq!(payload["remaining_uses"], 1);
    assert!(payload["approval_token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));
}
''',
    "update scoped approval grant contract",
)
