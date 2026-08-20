from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path.cwd()


def replace_once(path: str, before: str, after: str, label: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {label}")
        return
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    file_path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


def v3_is_fully_applied() -> bool:
    markers = {
        "src-tauri/src/tools/dispatch.rs": (
            "Run policy once before approval to surface only non-overridable hard",
            "Re-run the complete policy after approval.",
        ),
        "src-tauri/src/tools/approval.rs": (
            '"apply_patch" => Some(ApprovalRisk::RoutineMutation)',
            "auto_workspace_allows_transactional_patch_to_reach_patch_safety_checks",
        ),
    }
    for path, expected in markers.items():
        text = (ROOT / path).read_text(encoding="utf-8")
        if any(marker not in text for marker in expected):
            return False
    return True


def load_v2_patch() -> None:
    module_path = Path(__file__).with_name("apply_approval_patch_v2.py")
    spec = importlib.util.spec_from_file_location("approval_patch_v2", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load approval patch v2")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def main() -> None:
    if v3_is_fully_applied():
        print("approval patch v3 is already fully applied")
        return

    load_v2_patch()

    replace_once(
        "src-tauri/src/tools/approval.rs",
        '''        "apply_patch" => {
            let patch = args.get("patch").and_then(Value::as_str).unwrap_or("");
            if patch.contains("*** Delete File:")
                || patch.contains("+++ /dev/null")
                || patch.contains("--- /dev/null")
            {
                Some(ApprovalRisk::Destructive)
            } else {
                Some(ApprovalRisk::RoutineMutation)
            }
        }
''',
        '''        // Transactional patch safety, protected repository assets, and
        // special-file deletion confirmation remain enforced by patch.rs.
        // Treat ordinary workspace patches as routine so Auto Workspace mode
        // does not mask those more specific checks or ask for every file edit.
        "apply_patch" => Some(ApprovalRisk::RoutineMutation),
''',
        "keep transactional workspace patches routine",
    )

    replace_once(
        "src-tauri/src/tools/dispatch.rs",
        '''pub fn call_tool(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    let mut effective_args = apply_default_cwd(ctx, name, args);
    if name != "request_permissions" {
        if let Err(error) = ctx.approvals.preflight(
            name,
            &mut effective_args,
            &ctx.policy.approval_mode,
            &ctx.permission_mode,
        ) {
            return attach_project_instructions(
                ctx,
                name,
                &effective_args,
                tool_err(error.into_workspace_error()),
            );
        }
    }
    if let Err(e) = validate_tool_arguments_for_workspace(
        name,
        &effective_args,
        &ctx.policy,
        Some(&ctx.workspace),
    ) {
        return attach_project_instructions(ctx, name, &effective_args, policy_tool_err(e));
    }
''',
        '''pub fn call_tool(ctx: &ToolContext, name: &str, args: &Value) -> Value {
    let mut effective_args = apply_default_cwd(ctx, name, args);
    // Run policy once before approval to surface only non-overridable hard
    // boundaries such as protected paths, host scope, shell escapes, and
    // administrator elevation. A confirmation-only destructive result is the
    // soft gate handled by the scoped approval store below.
    if let Err(e) = validate_tool_arguments_for_workspace(
        name,
        &effective_args,
        &ctx.policy,
        Some(&ctx.workspace),
    ) {
        if !e
            .0
            .starts_with("DANGEROUS_OPERATION_REQUIRES_CONFIRMATION:")
        {
            return attach_project_instructions(ctx, name, &effective_args, policy_tool_err(e));
        }
    }
    if name != "request_permissions" {
        if let Err(error) = ctx.approvals.preflight(
            name,
            &mut effective_args,
            &ctx.policy.approval_mode,
            &ctx.permission_mode,
        ) {
            return attach_project_instructions(
                ctx,
                name,
                &effective_args,
                tool_err(error.into_workspace_error()),
            );
        }
    }
    // Re-run the complete policy after approval. A consumed grant injects the
    // exact-operation confirmation flag, while every hard boundary remains
    // enforced and cannot be weakened by an approval token.
    if let Err(e) = validate_tool_arguments_for_workspace(
        name,
        &effective_args,
        &ctx.policy,
        Some(&ctx.workspace),
    ) {
        return attach_project_instructions(ctx, name, &effective_args, policy_tool_err(e));
    }
''',
        "run hard policy boundaries before scoped approval",
    )

    replace_once(
        "src-tauri/src/tools/approval.rs",
        '''    #[test]
    fn ask_mode_requires_approval_for_routine_command() {
''',
        '''    #[test]
    fn auto_workspace_allows_transactional_patch_to_reach_patch_safety_checks() {
        let store = ApprovalStore::default();
        let mut args = json!({
            "patch": "--- a/src/delete-me.js\\n+++ /dev/null\\n@@\\n-delete me\\n"
        });
        store
            .preflight("apply_patch", &mut args, "auto-workspace", "trusted")
            .expect("ordinary workspace patch");
        assert!(args.get("confirm").is_none());
    }

    #[test]
    fn ask_mode_requires_approval_for_routine_command() {
''',
        "test routine transactional patch approval",
    )

    if not v3_is_fully_applied():
        raise RuntimeError("approval patch v3 completed without all safety markers")
    print("approval patch v3 applied successfully")


if __name__ == "__main__":
    main()
