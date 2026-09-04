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
    / "codex-permission-model"
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
    if target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one reviewed match, found {count}")
    return text.replace(old, new, 1)


def update(
    relative: str,
    marker: str,
    transform: Callable[[str], str],
    label: str,
) -> None:
    target = checked_file(relative)
    source = target.read_text(encoding="utf-8")
    if marker in source:
        print(f"already applied: {label}")
        return
    updated = transform(source)
    if marker not in updated:
        raise RuntimeError(f"{label}: implementation marker missing after transform")
    backup(relative)
    target.write_text(updated, encoding="utf-8")
    print(f"applied: {label}")


def transform_policy(text: str) -> str:
    text = replace_exact(
        text,
        "use super::registry::is_allowed_tool;",
        "use super::registry::{is_allowed_tool, MUTATING_TOOLS};",
        "policy registry import",
    )
    sandbox = r'''#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "read-only" | "safe" => Self::ReadOnly,
            "danger-full-access" | "dangerous" => Self::DangerFullAccess,
            "workspace-write" | "trusted" => Self::WorkspaceWrite,
            _ => Self::WorkspaceWrite,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

fn canonical_approval_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "ask" => "ask",
        "never" => "never",
        _ => "on-request",
    }
    .to_string()
}

'''
    text = replace_exact(
        text,
        "#[derive(Debug, Clone)]\npub struct PolicySettings {",
        sandbox + "#[derive(Debug, Clone)]\npub struct PolicySettings {",
        "sandbox mode definition",
    )
    text = replace_exact(
        text,
        '''            permission_mode: "trusted".into(),
            approval_mode: "auto-workspace".into(),''',
        '''            permission_mode: "workspace-write".into(),
            approval_mode: "on-request".into(),''',
        "policy defaults",
    )
    text = replace_exact(
        text,
        '''            permission_mode: runtime.permission_mode.clone(),
            approval_mode: runtime.approval_mode.clone(),''',
        '''            permission_mode: SandboxMode::parse(&runtime.permission_mode)
                .as_str()
                .to_string(),
            approval_mode: canonical_approval_mode(&runtime.approval_mode),''',
        "runtime policy normalization",
    )
    text = replace_exact(
        text,
        '''            permission_mode: actions.permission_mode.clone(),
            approval_mode: "auto-workspace".into(),''',
        '''            permission_mode: SandboxMode::parse(&actions.permission_mode)
                .as_str()
                .to_string(),
            approval_mode: "on-request".into(),''',
        "actions policy normalization",
    )
    text = replace_exact(
        text,
        '''    pub fn network_allowed(&self) -> bool {
        self.permission_mode == "trusted" || self.permission_mode == "dangerous"
    }

    pub fn skip_permission_gates(&self) -> bool {
        self.permission_mode == "dangerous"
    }''',
        '''    pub fn sandbox_mode(&self) -> SandboxMode {
        SandboxMode::parse(&self.permission_mode)
    }

    pub fn canonical_permission_mode(&self) -> &'static str {
        self.sandbox_mode().as_str()
    }

    pub fn network_allowed(&self) -> bool {
        !matches!(self.sandbox_mode(), SandboxMode::ReadOnly)
    }

    pub fn skip_permission_gates(&self) -> bool {
        matches!(self.sandbox_mode(), SandboxMode::DangerFullAccess)
    }''',
        "canonical policy methods",
    )
    text = replace_exact(
        text,
        '''pub fn validate_tool_arguments_for_workspace(
    tool_name: &str,
    arguments: &Value,
    policy: &PolicySettings,
    workspace: Option<&Workspace>,
) -> Result<(), PolicyError> {
    match tool_name {''',
        '''pub fn validate_tool_arguments_for_workspace(
    tool_name: &str,
    arguments: &Value,
    policy: &PolicySettings,
    workspace: Option<&Workspace>,
) -> Result<(), PolicyError> {
    if matches!(policy.sandbox_mode(), SandboxMode::ReadOnly) {
        validate_read_only_sandbox(tool_name, arguments)?;
    }
    match tool_name {''',
        "read-only policy hook",
    )
    helpers = r'''fn validate_read_only_sandbox(tool_name: &str, arguments: &Value) -> Result<(), PolicyError> {
    if tool_name == "exec_command" {
        let command = arguments
            .get("cmd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if read_only_command_allowed(command) {
            return Ok(());
        }
        return Err(PolicyError(
            "READ_ONLY_SANDBOX: read-only mode permits inspection tools and only minimal non-mutating diagnostics; switch to workspace-write for commands that can change project state"
                .into(),
        ));
    }

    // Changing the relative navigation root does not write project data.
    if tool_name == "set_default_cwd" {
        return Ok(());
    }

    if MUTATING_TOOLS.contains(&tool_name) {
        return Err(PolicyError(format!(
            "READ_ONLY_SANDBOX: {tool_name} is unavailable while the sandbox is read-only"
        )));
    }
    Ok(())
}

fn read_only_command_allowed(command: &str) -> bool {
    if command.trim().is_empty()
        || has_forbidden_shell_syntax(command)
        || command_contains_external_path(command)
        || network_command_pattern().is_match(command)
        || dangerous_command_pattern().is_match(command)
        || interpreter_mutation_pattern().is_match(command)
        || elevation_command_pattern().is_match(command)
    {
        return false;
    }

    let Ok(parts) = shell_words::split(command) else {
        return false;
    };
    let Some(executable) = parts.first() else {
        return false;
    };
    let base_name = executable.rsplit(['/', '\\']).next().unwrap_or(executable);
    let stem = base_name
        .strip_suffix(".exe")
        .or_else(|| base_name.strip_suffix(".cmd"))
        .or_else(|| base_name.strip_suffix(".bat"))
        .unwrap_or(base_name)
        .to_ascii_lowercase();

    match stem.as_str() {
        "pwd" => parts.len() == 1,
        "echo" => true,
        "which" => parts.len() >= 2,
        "ls" | "dir" => {
            parts.len() == 1 || (parts.len() == 2 && parts.get(1).is_some_and(|arg| arg == "."))
        }
        _ => false,
    }
}

'''
    text = replace_exact(
        text,
        "/// Actions OpenAPI 暴露层校验：仅限制「能否调用」，不参与执行逻辑。",
        helpers + "/// Actions OpenAPI 暴露层校验：仅限制「能否调用」，不参与执行逻辑。",
        "read-only helpers",
    )
    return text


def transform_approval(text: str) -> str:
    text = replace_exact(
        text,
        "use crate::tools::workspace::WorkspaceError;",
        "use crate::tools::policy::SandboxMode;\nuse crate::tools::workspace::WorkspaceError;",
        "approval sandbox import",
    )
    text = replace_exact(
        text,
        '''    pub fn parse(value: &str) -> Self {
        match value {
            "ask" => Self::Ask,
            "never" => Self::Never,
            _ => Self::AutoWorkspace,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AutoWorkspace => "auto-workspace",
            Self::Never => "never",
        }
    }''',
        '''    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "ask" => Self::Ask,
            "never" => Self::Never,
            "on-request" | "auto-workspace" => Self::AutoWorkspace,
            _ => Self::AutoWorkspace,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AutoWorkspace => "on-request",
            Self::Never => "never",
        }
    }''',
        "canonical approval mode",
    )
    text = replace_exact(
        text,
        '"suggestion": "Change Approval mode to Ask or Auto approve workspace operations"',
        '"suggestion": "Change Approval mode to on-request, then approve the scoped operation"',
        "approval denial suggestion",
    )
    text = replace_exact(
        text,
        '''        // Dangerous mode skips only this soft approval layer. The normal policy
        // still executes afterwards and keeps protected paths, host scope, and
        // elevation requests blocked.
        if permission_mode == "dangerous" {''',
        '''        // danger-full-access skips only this soft approval layer. The normal
        // policy still executes afterwards and keeps protected paths, host scope,
        // and elevation requests blocked. The legacy "dangerous" alias is accepted.
        if matches!(
            SandboxMode::parse(permission_mode),
            SandboxMode::DangerFullAccess
        ) {''',
        "full-access approval alias",
    )
    text = text.replace(
        "Treat ordinary workspace patches as routine so Auto Workspace mode",
        "Treat ordinary workspace patches as routine so on-request mode",
        1,
    )
    return text


def transform_context(text: str) -> str:
    occurrences = text.count('"trusted".into(),')
    if occurrences != 2:
        raise RuntimeError(
            f"context canonical defaults: expected two reviewed matches, found {occurrences}"
        )
    text = text.replace('"trusted".into(),', '"workspace-write".into(),')
    text = replace_exact(
        text,
        '''        permission_mode: String,
        harness_root: PathBuf,
    ) -> Self {
        let root = workspace.root().to_path_buf();
        Self {''',
        '''        _permission_mode: String,
        harness_root: PathBuf,
    ) -> Self {
        let root = workspace.root().to_path_buf();
        let permission_mode = policy.canonical_permission_mode().to_string();
        Self {''',
        "context permission normalization",
    )
    return text


def transform_model(text: str) -> str:
    text = replace_exact(
        text,
        '''fn default_permission_mode() -> String {
    "trusted".to_string()
}''',
        '''fn default_permission_mode() -> String {
    "workspace-write".to_string()
}''',
        "workspace permission default",
    )
    text = replace_exact(
        text,
        '''fn default_approval_mode() -> String {
    "auto-workspace".to_string()
}''',
        '''fn default_approval_mode() -> String {
    "on-request".to_string()
}''',
        "workspace approval default",
    )
    return text


def transform_types(text: str) -> str:
    return replace_exact(
        text,
        '    permission_mode: "trusted",',
        '    permission_mode: "workspace-write",',
        "frontend actions permission default",
    )


def transform_runtime_form(text: str) -> str:
    text = replace_exact(
        text,
        '''  const APPROVAL_MODE_OPTIONS = [
    { value: "auto-workspace", label: "类似 Codex：自动批准 Workspace 操作" },
    { value: "ask", label: "每次变更都询问" },
    { value: "never", label: "不询问；敏感操作直接拒绝" },
  ] as const;''',
        '''  const APPROVAL_MODE_OPTIONS = [
    { value: "on-request", label: "按需批准（Codex）" },
    { value: "never", label: "从不批准" },
  ] as const;''',
        "runtime approval options",
    )
    text = replace_exact(
        text,
        '''  const PERMISSION_MODE_OPTIONS = [
    { value: "trusted", label: "受信任" },
    { value: "safe", label: "安全受限" },
    { value: "dangerous", label: "完全放开" },
  ] as const;''',
        '''  const PERMISSION_MODE_OPTIONS = [
    { value: "read-only", label: "只读（Codex）" },
    { value: "workspace-write", label: "工作区写入（Codex）" },
    { value: "danger-full-access", label: "完全访问（Codex）" },
  ] as const;

  function normalizePermissionMode(value: string): string {
    if (value === "safe" || value === "read-only") return "read-only";
    if (value === "dangerous" || value === "danger-full-access") {
      return "danger-full-access";
    }
    return "workspace-write";
  }

  function normalizeApprovalMode(value: string): string {
    return value === "never" ? "never" : "on-request";
  }''',
        "runtime sandbox options",
    )
    text = replace_exact(
        text,
        '''  let draftMode = $state("trusted");
  let draftApprovalMode = $state("auto-workspace");''',
        '''  let draftMode = $state("workspace-write");
  let draftApprovalMode = $state("on-request");''',
        "runtime canonical draft defaults",
    )
    text = replace_exact(
        text,
        '''    draftProfile !== toolProfile || draftMode !== permissionMode || draftApprovalMode !== approvalMode || draftCommands !== allowedCommands || draftLocalEntries !== workspaceLocalEntries || draftExtensions !== workspaceScriptExtensions,''',
        '''    draftProfile !== toolProfile || draftMode !== normalizePermissionMode(permissionMode) || draftApprovalMode !== normalizeApprovalMode(approvalMode) || draftCommands !== allowedCommands || draftLocalEntries !== workspaceLocalEntries || draftExtensions !== workspaceScriptExtensions,''',
        "runtime canonical dirty comparison",
    )
    text = replace_exact(
        text,
        '''    draftMode = permissionMode;
    draftApprovalMode = approvalMode || "auto-workspace";''',
        '''    draftMode = normalizePermissionMode(permissionMode);
    draftApprovalMode = normalizeApprovalMode(approvalMode);''',
        "runtime legacy value normalization",
    )
    text = replace_exact(
        text,
        "    自动批准只适用于已批准 Workspace 内的常规命令与事务式 patch。网络、删除及敏感解释器写入会改用 request_permissions；系统管理员提升、受保护路径及 Workspace 外写入仍会硬性拒绝。",
        "    on-request 会自动执行已批准 Workspace 内的常规变更；网络、删除及敏感解释器写入会改用 request_permissions。never 会直接拒绝这些敏感操作。",
        "runtime approval explanation",
    )
    text = replace_exact(
        text,
        "    Workspace 本地入口按当前工作目录解析；系统命令与脚本类型均可按项目配置。当前执行边界仍为 policy_only。",
        "    read-only 会阻止项目修改及大部分命令；workspace-write 允许 Workspace 内写入；danger-full-access 只跳过软批准。管理员提升、受保护仓库路径及 Workspace 外写入仍会硬性拒绝；当前执行边界仍为 policy_only，并非操作系统级 sandbox。",
        "runtime sandbox explanation",
    )
    return text


def transform_actions_form(text: str) -> str:
    text = replace_exact(
        text,
        '''  const PERMISSION_MODE_OPTIONS = [
    { value: "trusted", label: "受信任" },
    { value: "safe", label: "安全受限" },
    { value: "dangerous", label: "完全放开" },
  ] as const;''',
        '''  const PERMISSION_MODE_OPTIONS = [
    { value: "read-only", label: "只读（Codex）" },
    { value: "workspace-write", label: "工作区写入（Codex）" },
    { value: "danger-full-access", label: "完全访问（Codex）" },
  ] as const;

  function normalizePermissionMode(value: string): string {
    if (value === "safe" || value === "read-only") return "read-only";
    if (value === "dangerous" || value === "danger-full-access") {
      return "danger-full-access";
    }
    return "workspace-write";
  }''',
        "actions sandbox options",
    )
    text = replace_exact(
        text,
        '  let draftMode = $state("trusted");',
        '  let draftMode = $state("workspace-write");',
        "actions canonical draft default",
    )
    text = replace_exact(
        text,
        '''      draftMode !== permissionMode,''',
        '''      draftMode !== normalizePermissionMode(permissionMode),''',
        "actions canonical dirty comparison",
    )
    text = replace_exact(
        text,
        '''    draftMode = permissionMode;''',
        '''    draftMode = normalizePermissionMode(permissionMode);''',
        "actions legacy value normalization",
    )
    text = replace_exact(
        text,
        "    作用于 Actions gateway 的 exec_command 白名单与 apply_patch 大小限制。",
        "    作用于 Actions gateway 的命令与 patch 边界。read-only 禁止修改；workspace-write 允许 Workspace 内变更；danger-full-access 仍不会绕过管理员提升、受保护仓库路径或 Workspace 外写入的硬性拒绝。",
        "actions sandbox explanation",
    )
    return text


def transform_dispatch(text: str) -> str:
    text = replace_exact(
        text,
        '''    let protected = err.0.strip_prefix("PROTECTED_REPOSITORY_ASSET: ");
    let elevation = err.0.strip_prefix("ELEVATION_NOT_ALLOWED: ");
    let code = if protected.is_some() {''',
        '''    let protected = err.0.strip_prefix("PROTECTED_REPOSITORY_ASSET: ");
    let elevation = err.0.strip_prefix("ELEVATION_NOT_ALLOWED: ");
    let read_only = err.0.strip_prefix("READ_ONLY_SANDBOX: ");
    let code = if read_only.is_some() {
        "READ_ONLY_SANDBOX"
    } else if protected.is_some() {''',
        "read-only error code",
    )
    text = replace_exact(
        text,
        '''    let message = protected
        .or(elevation)
        .or(dangerous)''',
        '''    let message = read_only
        .or(protected)
        .or(elevation)
        .or(dangerous)''',
        "read-only error message",
    )
    text = replace_exact(
        text,
        '''    let (reason, suggestion) = if dangerous.is_some() {
        (
            "confirmation_required",
            "为危险操作补充 confirm=true，确认后再重试",
        )''',
        '''    let (reason, suggestion) = if read_only.is_some() {
        (
            "read_only_sandbox",
            "改用读取工具，或将 Sandbox mode 切换为 workspace-write",
        )
    } else if dangerous.is_some() {
        (
            "confirmation_required",
            "为危险操作补充 confirm=true，确认后再重试",
        )''',
        "read-only error guidance",
    )
    return text


def transform_registry(text: str) -> str:
    return replace_exact(
        text,
        "Run a bounded workspace command. Routine commands auto-run in auto-workspace mode; sensitive network or destructive operations require request_permissions.",
        "Run a bounded workspace command. Routine commands auto-run in on-request mode; sensitive network or destructive operations require request_permissions.",
        "registry approval description",
    )


update(
    "src-tauri/src/tools/policy.rs",
    "pub enum SandboxMode",
    transform_policy,
    "Codex-compatible sandbox policy",
)
update(
    "src-tauri/src/tools/approval.rs",
    'Self::AutoWorkspace => "on-request"',
    transform_approval,
    "Codex-compatible approval policy",
)
update(
    "src-tauri/src/tools/context.rs",
    "let permission_mode = policy.canonical_permission_mode().to_string();",
    transform_context,
    "canonical permission context",
)
update(
    "src-tauri/src/workspace/model.rs",
    '"workspace-write".to_string()',
    transform_model,
    "canonical workspace defaults",
)
update(
    "src/lib/types.ts",
    'permission_mode: "workspace-write"',
    transform_types,
    "canonical frontend defaults",
)
update(
    "src/lib/components/RuntimePolicyForm.svelte",
    '{ value: "on-request", label: "按需批准（Codex）" }',
    transform_runtime_form,
    "Codex runtime permission controls",
)
update(
    "src/lib/components/ActionsPolicyForm.svelte",
    '{ value: "danger-full-access", label: "完全访问（Codex）" }',
    transform_actions_form,
    "Codex Actions permission controls",
)
update(
    "src-tauri/src/tools/dispatch.rs",
    'let read_only = err.0.strip_prefix("READ_ONLY_SANDBOX: ");',
    transform_dispatch,
    "structured read-only policy errors",
)
update(
    "src-tauri/src/tools/registry.rs",
    "Routine commands auto-run in on-request mode",
    transform_registry,
    "canonical approval description",
)

print("Codex-compatible permission model applied with recoverable backups")
