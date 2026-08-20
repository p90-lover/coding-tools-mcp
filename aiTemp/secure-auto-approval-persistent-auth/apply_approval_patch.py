from __future__ import annotations

import re
import shutil
from pathlib import Path

ROOT = Path.cwd()
BACKUP_ROOT = ROOT / "aiTemp" / "Trash" / "secure-auto-approval-persistent-auth" / "approval-source-before"


def backup(path: Path) -> None:
    target = BACKUP_ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copy2(ROOT / path, target)


def replace_once(path: str, before: str, after: str, label: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    if after in text and before not in text:
        print(f"already applied: {label}")
        return
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    backup(Path(path))
    file_path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count == 0 and replacement in text:
        print(f"already applied: {label}")
        return
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {count}")
    backup(Path(path))
    file_path.write_text(updated, encoding="utf-8")
    print(f"applied: {label}")


def main() -> None:
    replace_once(
        "src-tauri/src/tools/mod.rs",
        "pub mod context;\n",
        "pub mod approval;\npub mod context;\n",
        "export approval module",
    )

    replace_once(
        "src-tauri/src/tools/context.rs",
        "use crate::harness::Harness;\nuse crate::tools::policy::PolicySettings;\n",
        "use crate::harness::Harness;\nuse crate::tools::approval::ApprovalStore;\nuse crate::tools::policy::PolicySettings;\n",
        "import ApprovalStore",
    )
    replace_once(
        "src-tauri/src/tools/context.rs",
        "    pub policy: PolicySettings,\n    pub tool_profile: String,\n",
        "    pub policy: PolicySettings,\n    pub approvals: ApprovalStore,\n    pub tool_profile: String,\n",
        "add approval store to ToolContext",
    )
    replace_once(
        "src-tauri/src/tools/context.rs",
        "            policy,\n            tool_profile: crate::tools::registry::normalize_tool_profile(&tool_profile).into(),\n",
        "            policy,\n            approvals: ApprovalStore::default(),\n            tool_profile: crate::tools::registry::normalize_tool_profile(&tool_profile).into(),\n",
        "initialize approval store",
    )

    replace_once(
        "src-tauri/src/tools/policy.rs",
        "static INTERPRETER_MUTATION_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();\n",
        "static INTERPRETER_MUTATION_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();\nstatic ELEVATION_COMMAND_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();\n",
        "add elevation pattern cache",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "    pub max_patch_bytes: usize,\n    pub permission_mode: String,\n",
        "    pub max_patch_bytes: usize,\n    pub permission_mode: String,\n    pub approval_mode: String,\n",
        "add approval mode to policy settings",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "            max_patch_bytes: 200_000,\n            permission_mode: \"trusted\".into(),\n",
        "            max_patch_bytes: 200_000,\n            permission_mode: \"trusted\".into(),\n            approval_mode: \"auto-workspace\".into(),\n",
        "default auto-workspace approval",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "            max_patch_bytes: 200_000,\n            permission_mode: runtime.permission_mode.clone(),\n",
        "            max_patch_bytes: 200_000,\n            permission_mode: runtime.permission_mode.clone(),\n            approval_mode: runtime.approval_mode.clone(),\n",
        "load runtime approval mode",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "            max_patch_bytes: actions.max_patch_bytes as usize,\n            permission_mode: actions.permission_mode.clone(),\n",
        "            max_patch_bytes: actions.max_patch_bytes as usize,\n            permission_mode: actions.permission_mode.clone(),\n            approval_mode: \"auto-workspace\".into(),\n",
        "set Actions approval mode",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "    if has_forbidden_shell_syntax(command) {\n        return Err(PolicyError(\n            \"Shell chaining, redirection and expansion are not allowed\".into(),\n        ));\n    }\n",
        "    if has_forbidden_shell_syntax(command) {\n        return Err(PolicyError(\n            \"Shell chaining, redirection and expansion are not allowed\".into(),\n        ));\n    }\n    if elevation_command_pattern().is_match(command) {\n        return Err(PolicyError(\n            \"ELEVATION_NOT_ALLOWED: administrator elevation is blocked for MCP tool calls\".into(),\n        ));\n    }\n",
        "hard-block elevation requests",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "fn interpreter_mutation_pattern() -> &'static regex::Regex {\n    INTERPRETER_MUTATION_PATTERN.get_or_init(|| {\n        regex::Regex::new(\n            r#\"(?i)(shutil\\.(rmtree|move)|os\\.(remove|unlink|rmdir)|pathlib\\.[^\\s;]+\\.(unlink|rename)|write_text|write_bytes|fs\\.(writefile|writefilesync|unlink|rm)|set-content|out-file|new-item|files?\\.(write|delete)|open\\([^)]*['\\\"]w)\"#,\n        )\n        .expect(\"valid regex\")\n    })\n}\n",
        "fn interpreter_mutation_pattern() -> &'static regex::Regex {\n    INTERPRETER_MUTATION_PATTERN.get_or_init(|| {\n        regex::Regex::new(\n            r#\"(?i)(shutil\\.(rmtree|move)|os\\.(remove|unlink|rmdir)|pathlib\\.[^\\s;]+\\.(unlink|rename)|write_text|write_bytes|fs\\.(writefile|writefilesync|unlink|rm)|set-content|out-file|new-item|files?\\.(write|delete)|open\\([^)]*['\\\"]w)\"#,\n        )\n        .expect(\"valid regex\")\n    })\n}\n\nfn elevation_command_pattern() -> &'static regex::Regex {\n    ELEVATION_COMMAND_PATTERN.get_or_init(|| {\n        regex::Regex::new(\n            r\"(?i)(^|\\s)(sudo|doas|pkexec|runas)(\\s|$)|start-process[^\\r\\n]*-verb\\s+runas\",\n        )\n        .expect(\"valid regex\")\n    })\n}\n",
        "define elevation command pattern",
    )
    replace_once(
        "src-tauri/src/tools/policy.rs",
        "    #[test]\n    fn quoted_python_code_is_not_treated_as_shell_chaining() {\n",
        "    #[test]\n    fn elevation_requests_are_always_blocked() {\n        let policy = PolicySettings {\n            permission_mode: \"dangerous\".into(),\n            ..PolicySettings::default()\n        };\n        for command in [\n            \"sudo cargo test\",\n            \"runas /user:Administrator cmd\",\n            \"powershell Start-Process cmd -Verb RunAs\",\n        ] {\n            let error = validate_command(&json!({\"cmd\": command, \"confirm\": true}), &policy)\n                .expect_err(\"elevation must be blocked\");\n            assert!(error.0.contains(\"ELEVATION_NOT_ALLOWED\"));\n        }\n    }\n\n    #[test]\n    fn quoted_python_code_is_not_treated_as_shell_chaining() {\n",
        "test elevation hard block",
    )

    replace_once(
        "src-tauri/src/workspace/model.rs",
        "    #[serde(default = \"default_permission_mode\")]\n    pub permission_mode: String,\n    #[serde(default)]\n    pub runtime_command: String,\n",
        "    #[serde(default = \"default_permission_mode\")]\n    pub permission_mode: String,\n    #[serde(default = \"default_approval_mode\")]\n    pub approval_mode: String,\n    #[serde(default)]\n    pub runtime_command: String,\n",
        "persist runtime approval mode",
    )
    replace_once(
        "src-tauri/src/workspace/model.rs",
        "fn default_permission_mode() -> String {\n    \"trusted\".to_string()\n}\n",
        "fn default_permission_mode() -> String {\n    \"trusted\".to_string()\n}\n\nfn default_approval_mode() -> String {\n    \"auto-workspace\".to_string()\n}\n",
        "define approval mode default",
    )
    replace_once(
        "src-tauri/src/workspace/model.rs",
        "            permission_mode: default_permission_mode(),\n            runtime_command: String::new(),\n",
        "            permission_mode: default_permission_mode(),\n            approval_mode: default_approval_mode(),\n            runtime_command: String::new(),\n",
        "initialize runtime approval mode",
    )

    replace_once(
        "src/lib/types.ts",
        "  permission_mode: string;\n  runtime_command?: string;\n",
        "  permission_mode: string;\n  approval_mode?: string;\n  runtime_command?: string;\n",
        "add approval mode TypeScript type",
    )

    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "    permissionMode: string;\n    allowedCommands: string;\n",
        "    permissionMode: string;\n    approvalMode: string;\n    allowedCommands: string;\n",
        "add approval mode to draft interface",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "    permissionMode: string;\n    allowedCommands: string;\n",
        "    permissionMode: string;\n    approvalMode: string;\n    allowedCommands: string;\n",
        "add approval mode prop",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "  const PERMISSION_MODE_OPTIONS = [\n",
        "  const APPROVAL_MODE_OPTIONS = [\n    { value: \"auto-workspace\", label: \"类似 Codex：自动批准 Workspace 操作\" },\n    { value: \"ask\", label: \"每次变更都询问\" },\n    { value: \"never\", label: \"不询问；敏感操作直接拒绝\" },\n  ] as const;\n\n  const PERMISSION_MODE_OPTIONS = [\n",
        "add approval options",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "  let { toolProfile, permissionMode, allowedCommands, workspaceLocalEntries, workspaceScriptExtensions, onSave }: Props = $props();\n\n  let draftProfile = $state(\"full\");\n  let draftMode = $state(\"trusted\");\n",
        "  let { toolProfile, permissionMode, approvalMode, allowedCommands, workspaceLocalEntries, workspaceScriptExtensions, onSave }: Props = $props();\n\n  let draftProfile = $state(\"full\");\n  let draftMode = $state(\"trusted\");\n  let draftApprovalMode = $state(\"auto-workspace\");\n",
        "initialize approval draft",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "    draftProfile !== toolProfile || draftMode !== permissionMode || draftCommands !== allowedCommands || draftLocalEntries !== workspaceLocalEntries || draftExtensions !== workspaceScriptExtensions,\n",
        "    draftProfile !== toolProfile || draftMode !== permissionMode || draftApprovalMode !== approvalMode || draftCommands !== allowedCommands || draftLocalEntries !== workspaceLocalEntries || draftExtensions !== workspaceScriptExtensions,\n",
        "track approval mode dirty state",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "    draftMode = permissionMode;\n    draftCommands = allowedCommands;\n",
        "    draftMode = permissionMode;\n    draftApprovalMode = approvalMode || \"auto-workspace\";\n    draftCommands = allowedCommands;\n",
        "sync approval mode prop",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "      await onSave({ toolProfile: draftProfile, permissionMode: draftMode, allowedCommands: draftCommands.trim(), workspaceLocalEntries: draftLocalEntries, workspaceScriptExtensions: draftExtensions.trim() });\n",
        "      await onSave({ toolProfile: draftProfile, permissionMode: draftMode, approvalMode: draftApprovalMode, allowedCommands: draftCommands.trim(), workspaceLocalEntries: draftLocalEntries, workspaceScriptExtensions: draftExtensions.trim() });\n",
        "save approval mode",
    )
    replace_once(
        "src/lib/components/RuntimePolicyForm.svelte",
        "  <label class=\"grid gap-1\">\n    <span class=\"text-xs text-[var(--color-text-muted)]\">权限模式</span>\n",
        "  <label class=\"grid gap-1\">\n    <span class=\"text-xs text-[var(--color-text-muted)]\">批准模式</span>\n    <select\n      class=\"rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm\"\n      bind:value={draftApprovalMode}\n    >\n      {#each APPROVAL_MODE_OPTIONS as option}\n        <option value={option.value}>{option.label}</option>\n      {/each}\n    </select>\n  </label>\n  <p class=\"text-xs text-[var(--color-text-muted)]\">\n    自动批准只适用于已批准 Workspace 内的常规命令与事务式 patch。网络、删除及敏感解释器写入会改用 request_permissions；系统管理员提升、受保护路径及 Workspace 外写入仍会硬性拒绝。\n  </p>\n  <label class=\"grid gap-1\">\n    <span class=\"text-xs text-[var(--color-text-muted)]\">权限模式</span>\n",
        "render approval selector",
    )

    replace_once(
        "src/routes/workspace/[id]/+page.svelte",
        "        permission_mode: draft.permissionMode,\n        allowed_commands: draft.allowedCommands,\n",
        "        permission_mode: draft.permissionMode,\n        approval_mode: draft.approvalMode,\n        allowed_commands: draft.allowedCommands,\n",
        "save workspace approval mode",
    )
    replace_once(
        "src/routes/workspace/[id]/+page.svelte",
        "                permissionMode={profile.runtime.permission_mode}\n                allowedCommands={profile.runtime.allowed_commands ?? \"\"}\n",
        "                permissionMode={profile.runtime.permission_mode}\n                approvalMode={profile.runtime.approval_mode ?? \"auto-workspace\"}\n                allowedCommands={profile.runtime.allowed_commands ?? \"\"}\n",
        "pass approval mode to policy form",
    )

    replace_once(
        "src-tauri/src/tools/dispatch.rs",
        "pub fn call_tool(ctx: &ToolContext, name: &str, args: &Value) -> Value {\n    let effective_args = apply_default_cwd(ctx, name, args);\n    if let Err(e) = validate_tool_arguments_for_workspace(\n",
        "pub fn call_tool(ctx: &ToolContext, name: &str, args: &Value) -> Value {\n    let mut effective_args = apply_default_cwd(ctx, name, args);\n    if name != \"request_permissions\" {\n        if let Err(error) = ctx.approvals.preflight(\n            name,\n            &mut effective_args,\n            &ctx.policy.approval_mode,\n            &ctx.permission_mode,\n        ) {\n            return attach_project_instructions(\n                ctx,\n                name,\n                &effective_args,\n                tool_err(error.into_workspace_error()),\n            );\n        }\n    }\n    if let Err(e) = validate_tool_arguments_for_workspace(\n",
        "run approval preflight before policy",
    )
    regex_once(
        "src-tauri/src/tools/dispatch.rs",
        r'        "request_permissions" => \{.*?\n        \}\n        _ => \{',
        '''        "request_permissions" => {
            let request_id = effective_args
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkspaceError::invalid_argument("request_id is required"));
            match request_id {
                Ok(request_id) => {
                    let scope = effective_args
                        .get("scope")
                        .and_then(Value::as_str)
                        .unwrap_or("once");
                    let confirmed = effective_args
                        .get("confirm")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    ctx.approvals
                        .grant(request_id, scope, confirmed)
                        .map(tool_ok)
                        .map_err(|error| error.into_workspace_error())
                }
                Err(error) => Err(error),
            }
        }
        _ => {''',
        "implement request_permissions grants",
    )
    replace_once(
        "src-tauri/src/tools/dispatch.rs",
        "    let protected = err.0.strip_prefix(\"PROTECTED_REPOSITORY_ASSET: \");\n    let code = if protected.is_some() {\n        \"PROTECTED_REPOSITORY_ASSET\"\n    } else if dangerous.is_some() {\n",
        "    let protected = err.0.strip_prefix(\"PROTECTED_REPOSITORY_ASSET: \");\n    let elevation = err.0.strip_prefix(\"ELEVATION_NOT_ALLOWED: \");\n    let code = if protected.is_some() {\n        \"PROTECTED_REPOSITORY_ASSET\"\n    } else if elevation.is_some() {\n        \"ELEVATION_NOT_ALLOWED\"\n    } else if dangerous.is_some() {\n",
        "map elevation policy error",
    )
    replace_once(
        "src-tauri/src/tools/dispatch.rs",
        "    let message = protected.or(dangerous).unwrap_or(&err.0).to_string();\n",
        "    let message = protected.or(elevation).or(dangerous).unwrap_or(&err.0).to_string();\n",
        "select elevation policy message",
    )

    replace_once(
        "src-tauri/src/tools/registry.rs",
        "        \"Apply a patch envelope transactionally inside the workspace.\",\n        false,\n        true,\n        false,\n",
        "        \"Apply a patch envelope transactionally inside the workspace. Sensitive deletions require a scoped approval grant.\",\n        false,\n        false,\n        false,\n",
        "correct apply_patch annotations",
    )
    replace_once(
        "src-tauri/src/tools/registry.rs",
        "        \"Run a bounded command in the workspace. The result returns canonical command_id and command:<id>:stdout|stderr output refs, plus legacy session aliases; completed output remains readable for a bounded reconnect window.\",\n        false,\n        true,\n        true,\n",
        "        \"Run a bounded workspace command. Routine commands auto-run in auto-workspace mode; sensitive network or destructive operations require request_permissions.\",\n        false,\n        false,\n        false,\n",
        "correct exec_command annotations",
    )
    replace_once(
        "src-tauri/src/tools/registry.rs",
        "        \"Request a scoped permission grant for dangerous runtime operations.\",\n        true,\n        false,\n        false,\n",
        "        \"Approve a short-lived, argument-bound sensitive operation request.\",\n        false,\n        true,\n        true,\n",
        "mark request_permissions as sensitive",
    )
    replace_once(
        "src-tauri/src/tools/registry.rs",
        "                \"reason\": { \"type\": \"string\", \"default\": \"\" }\n            },\n            \"required\": [\"patch\"],\n",
        "                \"reason\": { \"type\": \"string\", \"default\": \"\" },\n                \"approval_token\": { \"type\": \"string\", \"minLength\": 1 }\n            },\n            \"required\": [\"patch\"],\n",
        "allow approval token for apply_patch",
    )
    replace_once(
        "src-tauri/src/tools/registry.rs",
        "                \"reason\": { \"type\": \"string\", \"default\": \"\" }\n            },\n            \"required\": [\"cmd\"],\n",
        "                \"reason\": { \"type\": \"string\", \"default\": \"\" },\n                \"approval_token\": { \"type\": \"string\", \"minLength\": 1 }\n            },\n            \"required\": [\"cmd\"],\n",
        "allow approval token for exec_command",
    )
    regex_once(
        "src-tauri/src/tools/registry.rs",
        r'        "request_permissions" => json!\(\{.*?\n        \}\),\n        "set_default_cwd"',
        '''        "request_permissions" => json!({
            "type": "object",
            "properties": {
                "request_id": { "type": "string", "minLength": 1 },
                "scope": {
                    "type": "string",
                    "enum": ["once", "session"],
                    "default": "once"
                },
                "confirm": { "type": "boolean", "default": false },
                "reason": { "type": "string", "default": "" }
            },
            "required": ["request_id", "confirm"],
            "additionalProperties": false
        }),
        "set_default_cwd"''',
        "replace request_permissions schema",
    )

    print("approval patch applied successfully")


if __name__ == "__main__":
    main()
