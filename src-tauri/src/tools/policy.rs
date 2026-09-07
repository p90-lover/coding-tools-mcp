use std::collections::HashSet;
use std::path::{Component, Path};

use serde_json::Value;

use crate::tools::workspace::Workspace;
use crate::workspace::ActionsConfig;

use super::registry::{is_allowed_tool, MUTATING_TOOLS};

static NETWORK_COMMAND_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
static DANGEROUS_COMMAND_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
static INTERPRETER_MUTATION_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
static ELEVATION_COMMAND_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

const BASIC_READ_ONLY_COMMANDS: &[&str] = &[
    "pwd", "ls", "dir", "cat", "head", "tail", "grep", "find", "which", "echo",
];

const DEFAULT_ALLOWED_COMMANDS: &[&str] = &[
    "pytest",
    "python",
    "python3",
    "npm",
    "npx",
    "node",
    "pnpm",
    "yarn",
    "make",
    "mvn",
    "mvnw",
    "gradle",
    "gradlew",
    "cargo",
    "go",
    "ruff",
    "mypy",
    "eslint",
    "tsc",
    "msbuild",
    "dotnet",
    "deno",
    "bun",
    "ruby",
    "java",
    "javac",
    "cmake",
    "clang",
    "gcc",
    "g++",
    "git",
    "cmd",
    "powershell",
    "pwsh",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
            _ => Self::ReadOnly,
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
        "on-request" | "auto-workspace" => "on-request",
        _ => "ask",
    }
    .to_string()
}

#[derive(Debug, Clone)]
pub struct PolicySettings {
    pub allowed_commands: HashSet<String>,
    pub workspace_local_entries: bool,
    pub workspace_script_extensions: HashSet<String>,
    pub max_patch_bytes: usize,
    pub permission_mode: String,
    pub approval_mode: String,
    pub allow_screen_capture: bool,
}

impl Default for PolicySettings {
    fn default() -> Self {
        Self {
            allowed_commands: default_allowed_command_set(),
            workspace_local_entries: true,
            workspace_script_extensions: default_workspace_script_extension_set(),
            max_patch_bytes: 200_000,
            permission_mode: "workspace-write".into(),
            approval_mode: "on-request".into(),
            allow_screen_capture: false,
        }
    }
}

impl PolicySettings {
    pub fn from_runtime(runtime: &crate::workspace::RuntimeConfig) -> Self {
        Self {
            allowed_commands: merge_default_allowed_commands(&runtime.allowed_commands),
            workspace_local_entries: runtime.workspace_local_entries,
            workspace_script_extensions: parse_workspace_script_extensions(
                &runtime.workspace_script_extensions,
            ),
            max_patch_bytes: 200_000,
            permission_mode: SandboxMode::parse(&runtime.permission_mode)
                .as_str()
                .to_string(),
            approval_mode: canonical_approval_mode(&runtime.approval_mode),
            allow_screen_capture: runtime.allow_screen_capture,
        }
    }

    pub fn from_actions_config(actions: &ActionsConfig) -> Self {
        Self {
            allowed_commands: merge_default_allowed_commands(&actions.allowed_commands),
            workspace_local_entries: true,
            workspace_script_extensions: default_workspace_script_extension_set(),
            max_patch_bytes: actions.max_patch_bytes as usize,
            permission_mode: SandboxMode::parse(&actions.permission_mode)
                .as_str()
                .to_string(),
            approval_mode: "on-request".into(),
            allow_screen_capture: false,
        }
    }

    pub fn sandbox_mode(&self) -> SandboxMode {
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
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PolicyError(pub String);

pub fn parse_allowed_commands(configured: &str) -> HashSet<String> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return default_allowed_command_set();
    }
    let mut commands: HashSet<String> = trimmed
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    // 基础诊断命令是工作区可用性的最低保障，不应因 Actions 配置遗漏而失效。
    commands.extend(BASIC_READ_ONLY_COMMANDS.iter().map(|s| s.to_string()));
    commands
}

pub fn parse_workspace_script_extensions(configured: &str) -> HashSet<String> {
    let mut extensions = configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with('.') {
                value.to_ascii_lowercase()
            } else {
                format!(".{}", value.to_ascii_lowercase())
            }
        })
        .collect::<HashSet<_>>();
    if extensions.is_empty() {
        extensions = default_workspace_script_extension_set();
    }
    extensions
}

fn default_allowed_command_set() -> HashSet<String> {
    DEFAULT_ALLOWED_COMMANDS
        .iter()
        .map(|s| s.to_string())
        .chain(BASIC_READ_ONLY_COMMANDS.iter().map(|s| s.to_string()))
        .collect()
}

fn merge_default_allowed_commands(configured: &str) -> HashSet<String> {
    let mut commands = default_allowed_command_set();
    commands.extend(parse_allowed_commands(configured));
    commands
}

fn default_workspace_script_extension_set() -> HashSet<String> {
    [".exe", ".bat", ".cmd", ".ps1"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub fn validate_tool_arguments(
    tool_name: &str,
    arguments: &Value,
    policy: &PolicySettings,
) -> Result<(), PolicyError> {
    validate_tool_arguments_for_workspace(tool_name, arguments, policy, None)
}

pub fn validate_tool_arguments_for_workspace(
    tool_name: &str,
    arguments: &Value,
    policy: &PolicySettings,
    workspace: Option<&Workspace>,
) -> Result<(), PolicyError> {
    if matches!(policy.sandbox_mode(), SandboxMode::ReadOnly) {
        validate_read_only_sandbox(tool_name, arguments)?;
    }
    match tool_name {
        "exec_command" => validate_command_for_workspace(arguments, policy, workspace),
        "apply_patch" | "patch_check" => validate_patch(arguments, policy),
        _ => Ok(()),
    }
}

fn validate_read_only_sandbox(tool_name: &str, arguments: &Value) -> Result<(), PolicyError> {
    if tool_name == "exec_command" {
        let command = arguments
            .get("cmd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if network_command_pattern().is_match(command) {
            return Err(PolicyError(
                "Network-looking commands are blocked by READ_ONLY_SANDBOX".into(),
            ));
        }
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
    // Match exact native builtins, not paths or executable suffixes.
    let stem = executable.to_ascii_lowercase();

    match stem.as_str() {
        "pwd" => parts.len() == 1,
        "echo" => true,
        "which" => parts.len() == 2,
        "ls" | "dir" => {
            parts.len() == 1 || (parts.len() == 2 && parts.get(1).is_some_and(|arg| arg == "."))
        }
        _ => false,
    }
}

/// Actions OpenAPI 暴露层校验：仅限制「能否调用」，不参与执行逻辑。
pub fn validate_actions_exposure(tool_name: &str) -> Result<(), PolicyError> {
    if is_allowed_tool(tool_name) {
        Ok(())
    } else {
        Err(PolicyError(format!("Tool is not exposed: {tool_name}")))
    }
}

pub fn validate_command(arguments: &Value, policy: &PolicySettings) -> Result<(), PolicyError> {
    validate_command_for_workspace(arguments, policy, None)
}

pub fn validate_command_for_workspace(
    arguments: &Value,
    policy: &PolicySettings,
    workspace: Option<&Workspace>,
) -> Result<(), PolicyError> {
    let command = arguments
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or_else(|| PolicyError("exec_command requires a non-empty cmd".into()))?;
    if command.trim().is_empty() {
        return Err(PolicyError("exec_command requires a non-empty cmd".into()));
    }
    if command.len() > 4_000 {
        return Err(PolicyError("Command is too long".into()));
    }
    let filesystem_scope = arguments
        .get("filesystem_scope")
        .and_then(Value::as_str)
        .unwrap_or("workspace");
    if filesystem_scope != "workspace" {
        return Err(PolicyError(
            "EXTERNAL_EXECUTION_NOT_ALLOWED: exec_command 只允许在 Workspace 内执行".into(),
        ));
    }
    for key in ["workdir", "cwd"] {
        if let Some(workdir) = arguments.get(key).and_then(Value::as_str) {
            if let Some(workspace) = workspace {
                let resolved = workspace.resolve_existing(workdir).map_err(|_| {
                    PolicyError(
                        "workdir must stay inside the configured workspace or a linked project"
                            .into(),
                    )
                })?;
                if workspace.is_read_only_path(&resolved.path) {
                    return Err(PolicyError(
                        "read-only linked projects cannot be used as exec workdir".into(),
                    ));
                }
            } else {
                let path = Path::new(workdir);
                if path.is_absolute() || path.components().any(|part| part == Component::ParentDir)
                {
                    return Err(PolicyError(
                        "workdir must stay inside the configured workspace".into(),
                    ));
                }
            }
        }
    }
    if has_forbidden_shell_syntax(command) {
        return Err(PolicyError(
            "Shell chaining, redirection and expansion are not allowed".into(),
        ));
    }
    if elevation_command_pattern().is_match(command) {
        return Err(PolicyError(
            "ELEVATION_NOT_ALLOWED: administrator elevation is blocked for MCP tool calls".into(),
        ));
    }
    if (dangerous_command_pattern().is_match(command)
        || interpreter_mutation_pattern().is_match(command))
        && command_targets_protected_repository_asset(command)
    {
        return Err(PolicyError(
            "PROTECTED_REPOSITORY_ASSET: 禁止删除或递归清空 .git/.github".into(),
        ));
    }
    if interpreter_mutation_pattern().is_match(command) && command_contains_external_path(command) {
        return Err(PolicyError(
            "WORKSPACE_PATH_PROTECTED: workspace scope 禁止通过子进程写入 Workspace 外部路径"
                .into(),
        ));
    }
    if dangerous_command_pattern().is_match(command)
        && !arguments
            .get("confirm")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err(PolicyError(
            "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION: dangerous command requires confirm=true"
                .into(),
        ));
    }
    if !policy.skip_permission_gates()
        && network_command_pattern().is_match(command)
        && !policy.network_allowed()
    {
        return Err(PolicyError(
            "Network-looking commands are blocked in safe permission mode".into(),
        ));
    }

    let parts =
        shell_words::split(command).map_err(|_| PolicyError("Invalid command syntax".into()))?;
    if parts.is_empty() {
        return Err(PolicyError("Empty command".into()));
    }

    let executable = parts[0].trim_start_matches("./");
    let base_name = executable.rsplit(['/', '\\']).next().unwrap_or(executable);
    let stem = base_name
        .strip_suffix(".exe")
        .or_else(|| base_name.strip_suffix(".cmd"))
        .or_else(|| base_name.strip_suffix(".bat"))
        .unwrap_or(base_name);

    let workspace_entry_candidate = workspace_local_entry_exists(workspace, arguments, executable)
        || executable.contains(['/', '\\'])
        || policy
            .workspace_script_extensions
            .iter()
            .any(|extension| base_name.to_ascii_lowercase().ends_with(extension));
    if !(policy.allowed_commands.contains(stem)
        || (policy.workspace_local_entries && workspace_entry_candidate))
    {
        return Err(PolicyError(format!("Command is not allowlisted: {stem}")));
    }

    if arguments.get("env").is_some() {
        return Err(PolicyError(
            "Environment variables cannot be supplied by GPT".into(),
        ));
    }

    if let Some(timeout_ms) = arguments.get("timeout_ms").and_then(Value::as_u64) {
        if timeout_ms > 600_000 {
            return Err(PolicyError("Command timeout exceeds 10 minutes".into()));
        }
    }

    Ok(())
}

fn workspace_local_entry_exists(
    workspace: Option<&Workspace>,
    arguments: &Value,
    executable: &str,
) -> bool {
    let Some(workspace) = workspace else {
        return false;
    };
    let workdir = arguments
        .get("workdir")
        .or_else(|| arguments.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let Ok(base) = workspace.resolve_existing(workdir) else {
        return false;
    };
    let candidate = if Path::new(executable).is_absolute() {
        Path::new(executable).to_path_buf()
    } else {
        base.path.join(executable)
    };
    candidate
        .canonicalize()
        .map(|path| path.is_file() && workspace.is_safe_existing_path(&path))
        .unwrap_or(false)
}

pub fn validate_patch(arguments: &Value, policy: &PolicySettings) -> Result<(), PolicyError> {
    let patch = arguments
        .get("patch")
        .and_then(Value::as_str)
        .ok_or_else(|| PolicyError("apply_patch requires a patch".into()))?;
    if patch.trim().is_empty() {
        return Err(PolicyError("apply_patch requires a patch".into()));
    }

    if patch.len() > policy.max_patch_bytes {
        return Err(PolicyError("Patch is too large".into()));
    }

    Ok(())
}

fn has_forbidden_shell_syntax(command: &str) -> bool {
    if command.contains(['\r', '\n']) {
        return true;
    }

    let chars: Vec<char> = command.chars().collect();
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }

        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                }
            }
            Some('"') => {
                if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    quote = None;
                }
            }
            Some(_) => {}
            None => {
                if ch == '\\' {
                    escaped = true;
                } else if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                } else if matches!(ch, ';' | '&' | '|' | '>' | '<' | '`')
                    || (ch == '$'
                        && chars
                            .get(index + 1)
                            .is_some_and(|next| *next == '(' || *next == '{'))
                {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

fn network_command_pattern() -> &'static regex::Regex {
    NETWORK_COMMAND_PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(https?://|urllib\.request|requests\.|http\.client|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\bftp\b)",
        )
        .expect("valid regex")
    })
}

fn dangerous_command_pattern() -> &'static regex::Regex {
    DANGEROUS_COMMAND_PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(git\s+reset\s+--hard|git\s+clean\s+-[^\r\n]*f|git\s+checkout\s+--\s+\.|(^|\s)rm\s+(-[^\r\n]*r[^\r\n]*f|--recursive)|remove-item\s+[^\r\n]*-recurse|(^|\s)(rmdir|del)\s+/s\b)",
        )
        .expect("valid regex")
    })
}

fn interpreter_mutation_pattern() -> &'static regex::Regex {
    INTERPRETER_MUTATION_PATTERN.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)(shutil\.(rmtree|move)|os\.(remove|unlink|rmdir)|pathlib\.[^\s;]+\.(unlink|rename)|write_text|write_bytes|fs\.(writefile|writefilesync|unlink|rm)|set-content|out-file|new-item|files?\.(write|delete)|open\([^)]*['\"]w)"#,
        )
        .expect("valid regex")
    })
}

fn elevation_command_pattern() -> &'static regex::Regex {
    ELEVATION_COMMAND_PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(^|\s)(sudo|doas|pkexec|runas)(\s|$)|start-process[^\r\n]*-verb\s+runas",
        )
        .expect("valid regex")
    })
}

fn command_contains_external_path(command: &str) -> bool {
    let normalized = command.replace('\\', "/");
    normalized.contains("../")
        || normalized.contains("..\\")
        || regex::Regex::new(r#"(?i)(^|["'\s])/[^"]"#)
            .expect("valid regex")
            .is_match(&normalized)
        || regex::Regex::new(r"(?i)\b[A-Z]:/")
            .expect("valid regex")
            .is_match(&normalized)
}

fn command_targets_protected_repository_asset(command: &str) -> bool {
    let normalized_command = command.to_ascii_lowercase().replace('\\', "/");
    let references_protected_asset =
        normalized_command.contains(".git") || normalized_command.contains(".github");
    if !references_protected_asset {
        return false;
    }

    let mutating_operation = [
        "rm ",
        "remove-item",
        "rmdir",
        "del ",
        "unlink",
        "rmtree",
        "write_text",
        "writefile",
        "rename",
        "move",
        "checkout",
        "clean ",
    ]
    .iter()
    .any(|needle| normalized_command.contains(needle));
    if mutating_operation {
        return true;
    }

    command.split_whitespace().any(|part| {
        let token = part
            .trim_matches(|ch: char| matches!(ch, '\'' | '"' | '`' | ',' | ';'))
            .replace('\\', "/");
        let token = token.strip_prefix("./").unwrap_or(&token);
        token == ".git"
            || token.starts_with(".git/")
            || token == ".github"
            || token.starts_with(".github/")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_allowed_commands_override_defaults() {
        let actions = ActionsConfig {
            allowed_commands: "cargo,go".into(),
            ..ActionsConfig::default()
        };
        let policy = PolicySettings::from_actions_config(&actions);
        assert!(policy.allowed_commands.contains("cargo"));
        assert!(policy.allowed_commands.contains("pytest"));
    }

    #[test]
    fn trusted_mode_accepts_any_configured_workspace_script_extension() {
        let policy = PolicySettings {
            workspace_local_entries: true,
            workspace_script_extensions: parse_workspace_script_extensions(".cmd,.launcher"),
            ..PolicySettings::default()
        };
        assert!(
            validate_command(&serde_json::json!({ "cmd": "anything.launcher" }), &policy).is_ok()
        );
        assert!(validate_command(
            &serde_json::json!({ "cmd": "scripts/another-name.cmd" }),
            &policy
        )
        .is_ok());
    }

    #[test]
    fn trusted_mode_accepts_an_extensionless_workspace_entry() {
        let dir = tempfile::tempdir().expect("workspace");
        std::fs::write(dir.path().join("project-entry"), "#!/bin/sh\necho ok\n").expect("entry");
        let workspace = Workspace::new(dir.path().to_path_buf()).expect("workspace");
        assert!(validate_command_for_workspace(
            &serde_json::json!({ "cmd": "project-entry", "workdir": "." }),
            &PolicySettings::default(),
            Some(&workspace),
        )
        .is_ok());
    }

    #[test]
    fn patch_size_uses_workspace_limit() {
        let actions = ActionsConfig {
            max_patch_bytes: 10,
            ..ActionsConfig::default()
        };
        let policy = PolicySettings::from_actions_config(&actions);
        let err = validate_patch(&json!({ "patch": "01234567890" }), &policy).unwrap_err();
        assert!(err.0.contains("too large"));
    }

    #[test]
    fn basic_diagnostic_commands_are_allowed() {
        let policy = PolicySettings::default();
        for command in BASIC_READ_ONLY_COMMANDS {
            validate_command(&json!({"cmd": command}), &policy)
                .unwrap_or_else(|err| panic!("{command} should be allowed: {err}"));
        }
    }

    #[test]
    fn configured_commands_keep_basic_diagnostics() {
        let actions = ActionsConfig {
            allowed_commands: "cargo,go".into(),
            ..ActionsConfig::default()
        };
        let policy = PolicySettings::from_actions_config(&actions);
        assert!(validate_command(&json!({"cmd": "pwd"}), &policy).is_ok());
        assert!(validate_command(&json!({"cmd": "pytest"}), &policy).is_ok());
    }

    #[test]
    fn elevation_requests_are_always_blocked() {
        let policy = PolicySettings {
            permission_mode: "dangerous".into(),
            ..PolicySettings::default()
        };
        for command in [
            "sudo cargo test",
            "runas /user:Administrator cmd",
            "powershell Start-Process cmd -Verb RunAs",
        ] {
            let error = validate_command(&json!({"cmd": command, "confirm": true}), &policy)
                .expect_err("elevation must be blocked");
            assert!(error.0.contains("ELEVATION_NOT_ALLOWED"));
        }
    }

    #[test]
    fn quoted_python_code_is_not_treated_as_shell_chaining() {
        let policy = PolicySettings::default();
        assert!(validate_command(
            &json!({"cmd": "python -c \"import os; print(os.getcwd())\""}),
            &policy
        )
        .is_ok());
        assert!(validate_command(
            &json!({"cmd": "python -c \"print(1)\" && echo nope"}),
            &policy
        )
        .is_err());
        assert!(validate_command(&json!({"cmd": "echo hello > output.txt"}), &policy).is_err());
    }

    #[test]
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

        let command_error =
            validate_tool_arguments("exec_command", &json!({"cmd": "cargo test"}), &policy)
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
        assert_eq!(SandboxMode::parse("trusted").as_str(), "workspace-write");
        assert_eq!(
            SandboxMode::parse("dangerous").as_str(),
            "danger-full-access"
        );
    }
}

#[cfg(test)]
mod release_hardening_checks {
    use super::*;

    #[test]
    fn release_hardening_unknown_sandbox_is_read_only() {
        for value in ["", "workspace-writ", "invalid", "full-access"] {
            assert_eq!(
                SandboxMode::parse(value),
                SandboxMode::ReadOnly,
                "{value:?}"
            );
        }
    }
}
