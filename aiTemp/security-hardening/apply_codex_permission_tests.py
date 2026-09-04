from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Callable

ROOT = Path.cwd().resolve()
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "codex-permission-tests"
    / str(time.time_ns())
)


def checked_file(relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"unsafe repository path: {relative}")
    candidate = ROOT / path
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {relative}")
    resolved = candidate.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise RuntimeError(f"not a regular file: {relative}")
    return resolved


def backup(relative: str) -> None:
    source = checked_file(relative)
    target = BACKUP_ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def update(relative: str, transform: Callable[[str], str], label: str) -> None:
    target = checked_file(relative)
    source = target.read_text(encoding="utf-8")
    updated = transform(source)
    if updated == source:
        print(f"already applied: {label}")
        return
    backup(relative)
    target.write_text(updated, encoding="utf-8")
    print(f"applied: {label}")


def append_rust_test(text: str, marker: str, block: str) -> str:
    if marker in text:
        return text
    if "#[cfg(test)]\nmod tests {" not in text:
        raise RuntimeError("reviewed Rust test module marker not found")
    stripped = text.rstrip()
    if not stripped.endswith("}"):
        raise RuntimeError("reviewed Rust file does not end with a test-module brace")
    return f"{stripped[:-1].rstrip()}\n\n{block.rstrip()}\n}}\n"


def canonicalize_exec_environment_contract(text: str) -> str:
    old = '    assert_eq!(payload["permission_mode"], "trusted");'
    new = '    assert_eq!(payload["permission_mode"], "workspace-write");'
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            "expected exactly one legacy check_exec_environment permission assertion, "
            f"found {count}"
        )
    return text.replace(old, new, 1)


POLICY_TESTS = r'''    #[test]
    fn codex_permission_read_only_blocks_workspace_mutation() {
        let policy = PolicySettings {
            permission_mode: "read-only".into(),
            ..PolicySettings::default()
        };
        let patch = json!({
            "patch": "*** Begin Patch\n*** Add File: blocked.txt\n+blocked\n*** End Patch"
        });
        let patch_error = validate_tool_arguments("apply_patch", &patch, &policy)
            .expect_err("read-only sandbox must reject patches");
        assert!(patch_error.0.contains("READ_ONLY_SANDBOX"));

        let command_error = validate_tool_arguments(
            "exec_command",
            &json!({"cmd": "cargo test"}),
            &policy,
        )
        .expect_err("read-only sandbox must reject mutating commands");
        assert!(command_error.0.contains("READ_ONLY_SANDBOX"));

        validate_tool_arguments("exec_command", &json!({"cmd": "pwd"}), &policy)
            .expect("read-only diagnostics remain available");
    }

    #[test]
    fn codex_permission_canonical_sandbox_names_are_enforced() {
        let workspace = PolicySettings {
            permission_mode: "workspace-write".into(),
            ..PolicySettings::default()
        };
        assert!(workspace.network_allowed());
        assert!(!workspace.skip_permission_gates());

        let full = PolicySettings {
            permission_mode: "danger-full-access".into(),
            ..PolicySettings::default()
        };
        assert!(full.network_allowed());
        assert!(full.skip_permission_gates());

        assert_eq!(SandboxMode::parse("safe").as_str(), "read-only");
        assert_eq!(
            SandboxMode::parse("trusted").as_str(),
            "workspace-write"
        );
        assert_eq!(
            SandboxMode::parse("dangerous").as_str(),
            "danger-full-access"
        );
    }
'''

APPROVAL_TEST = r'''    #[test]
    fn codex_permission_on_request_uses_canonical_name() {
        assert_eq!(ApprovalMode::parse("on-request").as_str(), "on-request");
        assert_eq!(
            ApprovalMode::parse("auto-workspace").as_str(),
            "on-request"
        );
    }
'''

UI_TEST = r'''
test("Codex permission controls use canonical sandbox and approval values", async () => {
  const runtime = await read("src/lib/components/RuntimePolicyForm.svelte");
  const actions = await read("src/lib/components/ActionsPolicyForm.svelte");
  const types = await read("src/lib/types.ts");

  for (const source of [runtime, actions]) {
    assert.match(source, /value:\s*"read-only"/);
    assert.match(source, /value:\s*"workspace-write"/);
    assert.match(source, /value:\s*"danger-full-access"/);
    assert.doesNotMatch(source, /value:\s*"(?:safe|trusted|dangerous)"/);
  }
  assert.match(runtime, /value:\s*"on-request"/);
  assert.match(runtime, /value:\s*"never"/);
  assert.doesNotMatch(runtime, /value:\s*"auto-workspace"/);
  assert.match(runtime, /value === "safe" \|\| value === "read-only"/);
  assert.match(runtime, /value === "dangerous" \|\| value === "danger-full-access"/);
  assert.match(types, /permission_mode:\s*"workspace-write"/);
});
'''


def ensure_ui_contract(text: str) -> str:
    marker = 'test("Codex permission controls use canonical sandbox and approval values"'
    if marker not in text:
        return f"{text.rstrip()}\n{UI_TEST}"

    start = text.index(marker)
    end_marker = "\n});"
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError("existing Codex permission UI contract is unterminated")
    end += len(end_marker)
    return f"{text[:start]}{UI_TEST.strip()}{text[end:]}"


update(
    "src-tauri/src/tools/policy.rs",
    lambda text: append_rust_test(
        text,
        "fn codex_permission_read_only_blocks_workspace_mutation()",
        POLICY_TESTS,
    ),
    "add Codex sandbox behavior and legacy migration tests",
)
update(
    "src-tauri/src/tools/approval.rs",
    lambda text: append_rust_test(
        text,
        "fn codex_permission_on_request_uses_canonical_name()",
        APPROVAL_TEST,
    ),
    "add canonical approval-name test",
)
update(
    "src-tauri/tests/call_tool_contract.rs",
    canonicalize_exec_environment_contract,
    "require canonical workspace-write policy metadata",
)
update(
    "tests/security-hardening-contract.test.mjs",
    ensure_ui_contract,
    "add or repair Codex permission UI contract",
)

print("Codex permission RED tests and compatibility contracts applied with recoverable backups")
