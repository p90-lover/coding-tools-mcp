use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use thiserror::Error;

use crate::workspace::linked_projects::{list_linked_projects_for_root, LinkedProject};

pub const DEFAULT_EXCLUDED_NAMES: &[&str] = &[
    ".git",
    ".mcp-paths",
    ".reference",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
];

#[derive(Debug, Clone)]
pub struct ResolvedPath {
    pub display: String,
    pub path: PathBuf,
    pub existed: bool,
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("{message}")]
    Tool {
        code: &'static str,
        message: String,
        category: &'static str,
        retryable: bool,
    },
    #[error("{message}")]
    ToolDetails {
        code: &'static str,
        message: String,
        category: &'static str,
        retryable: bool,
        details: Value,
    },
}

impl WorkspaceError {
    pub fn message(&self) -> String {
        match self {
            Self::Tool { message, .. } | Self::ToolDetails { message, .. } => message.clone(),
        }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::Tool {
            code: "INVALID_ARGUMENT",
            message: message.into(),
            category: "validation",
            retryable: false,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::Tool {
            code: "NOT_FOUND",
            message: message.into(),
            category: "not_found",
            retryable: false,
        }
    }

    pub fn absolute_path_denied() -> Self {
        Self::Tool {
            code: "ABSOLUTE_PATH_DENIED",
            message: "Absolute paths are denied.".into(),
            category: "security",
            retryable: false,
        }
    }

    pub fn path_outside_workspace() -> Self {
        Self::Tool {
            code: "PATH_OUTSIDE_WORKSPACE",
            message: "Path escapes the configured workspace.".into(),
            category: "security",
            retryable: false,
        }
    }

    pub fn symlink_escape() -> Self {
        Self::Tool {
            code: "SYMLINK_ESCAPE",
            message: "Path escapes the configured workspace.".into(),
            category: "security",
            retryable: false,
        }
    }

    pub fn not_a_directory(message: impl Into<String>) -> Self {
        Self::Tool {
            code: "NOT_A_DIRECTORY",
            message: message.into(),
            category: "validation",
            retryable: false,
        }
    }

    pub fn to_error_value(&self) -> Value {
        match self {
            Self::Tool {
                code,
                message,
                category,
                retryable,
            } => json!({
                "code": code,
                "message": message,
                "category": category,
                "retryable": retryable,
                "details": {}
            }),
            Self::ToolDetails {
                code,
                message,
                category,
                retryable,
                details,
            } => json!({
                "code": code,
                "message": message,
                "category": category,
                "retryable": retryable,
                "details": details
            }),
        }
    }
}

pub type WorkspaceResult<T> = Result<T, WorkspaceError>;

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn new(root: PathBuf) -> WorkspaceResult<Self> {
        let root = root
            .canonicalize()
            .map_err(|_| WorkspaceError::invalid_argument("Workspace root must exist"))?;
        if !root.is_dir() {
            return Err(WorkspaceError::invalid_argument(
                "Workspace root must be a directory",
            ));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn root_display(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    pub fn linked_projects(&self) -> Vec<LinkedProject> {
        list_linked_projects_for_root(&self.root)
    }

    fn linked_project_by_alias(&self, alias: &str) -> Option<LinkedProject> {
        self.linked_projects()
            .into_iter()
            .find(|project| project.alias.eq_ignore_ascii_case(alias))
    }

    fn normalize_path_from_existing_ancestor(path: &Path) -> PathBuf {
        let mut cursor = path;
        let mut suffix = Vec::new();

        while !cursor.exists() && !cursor.is_symlink() {
            let Some(name) = cursor.file_name() else {
                return path.to_path_buf();
            };
            suffix.push(name.to_os_string());
            let Some(parent) = cursor.parent() else {
                return path.to_path_buf();
            };
            cursor = parent;
        }

        let Ok(mut normalized) = cursor.canonicalize() else {
            return path.to_path_buf();
        };
        for component in suffix.iter().rev() {
            normalized.push(component);
        }
        normalized
    }

    fn linked_project_containing_path(&self, path: &Path) -> Option<LinkedProject> {
        let probe = Self::normalize_path_from_existing_ancestor(path);
        self.linked_projects().into_iter().find(|project| {
            project
                .root_path()
                .canonicalize()
                .map(|root| probe.starts_with(root))
                .unwrap_or(false)
        })
    }

    fn allowed_root_for_path(&self, path: &Path) -> Option<PathBuf> {
        let probe = Self::normalize_path_from_existing_ancestor(path);
        if probe.starts_with(&self.root) {
            return Some(self.root.clone());
        }
        self.linked_project_containing_path(path)
            .and_then(|project| project.root_path().canonicalize().ok())
    }

    fn candidate_from_raw(
        &self,
        base: &Path,
        raw_path: &str,
    ) -> WorkspaceResult<(PathBuf, Option<LinkedProject>)> {
        let normalized = raw_path.replace('\\', "/");
        if let Some(alias_path) = normalized.strip_prefix('@') {
            let (alias, rest) = alias_path.split_once('/').unwrap_or((alias_path, ""));
            if alias.trim().is_empty() {
                return Err(WorkspaceError::invalid_argument(
                    "Linked project alias cannot be empty",
                ));
            }
            let project = self.linked_project_by_alias(alias).ok_or_else(|| {
                WorkspaceError::not_found(format!("Linked project not found: @{alias}"))
            })?;
            let candidate = if rest.is_empty() {
                project.root_path()
            } else {
                project
                    .root_path()
                    .join(rest.replace('/', std::path::MAIN_SEPARATOR_STR))
            };
            return Ok((candidate, Some(project)));
        }

        let input = Path::new(raw_path);
        if input.is_absolute() {
            let candidate = Self::normalize_path_from_existing_ancestor(input);
            let project = self.linked_project_containing_path(&candidate);
            return Ok((candidate, project));
        }

        Ok((
            base.join(raw_path.replace('/', std::path::MAIN_SEPARATOR_STR)),
            None,
        ))
    }

    pub fn display_path(&self, path: &Path) -> String {
        if path.starts_with(&self.root) {
            return relative_display(&self.root, path);
        }
        if let Some(project) = self.linked_project_containing_path(path) {
            let root = project
                .root_path()
                .canonicalize()
                .unwrap_or_else(|_| project.root_path());
            let normalized = Self::normalize_path_from_existing_ancestor(path);
            let suffix = normalized
                .strip_prefix(&root)
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if suffix.is_empty() {
                return format!("@{}", project.alias);
            }
            return format!("@{}/{}", project.alias, suffix);
        }
        relative_display(&self.root, path)
    }

    pub fn reject_unsafe_text(&self, raw_path: &str) -> WorkspaceResult<()> {
        if raw_path.is_empty() {
            return Err(WorkspaceError::invalid_argument(
                "Path must be a non-empty string",
            ));
        }
        if raw_path.contains('\0') {
            return Err(WorkspaceError::invalid_argument("Path contains a NUL byte"));
        }
        for part in Path::new(raw_path).components() {
            if matches!(part, Component::ParentDir) {
                return Err(WorkspaceError::path_outside_workspace());
            }
        }
        Ok(())
    }

    pub fn resolve_existing(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {
        self.resolve_existing_at(&self.root, raw_path)
    }

    /// Read paths retain the existing explicit-absolute-path behavior.
    /// `@alias/...` is additionally resolved through `.mcp-paths`.
    pub fn resolve_read_path(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {
        let raw = if raw_path.is_empty() { "." } else { raw_path };
        self.validate_read_text(raw)?;
        let alias_address = raw.replace('\\', "/").starts_with('@');
        let input = Path::new(raw);
        let candidate = if alias_address {
            self.candidate_from_raw(&self.root, raw)?.0
        } else if input.is_absolute() {
            input.to_path_buf()
        } else {
            self.root
                .join(raw.replace('/', std::path::MAIN_SEPARATOR_STR))
        };
        let resolved = candidate
            .canonicalize()
            .map_err(|_| WorkspaceError::not_found(format!("Path not found: {raw}")))?;
        let explicit_external = input.is_absolute()
            || input
                .components()
                .any(|part| matches!(part, Component::ParentDir));
        if alias_address || (!explicit_external && candidate.starts_with(&self.root)) {
            self.ensure_inside_workspace(&candidate, &resolved)?;
        }
        Ok(ResolvedPath {
            display: self.display_path(&resolved),
            path: resolved,
            existed: true,
        })
    }

    pub fn resolve_existing_at(
        &self,
        base: &Path,
        raw_path: &str,
    ) -> WorkspaceResult<ResolvedPath> {
        let raw = if raw_path.is_empty() { "." } else { raw_path };
        self.reject_unsafe_text(raw)?;
        let base = self.validate_base(base)?;
        let (candidate, _) = self.candidate_from_raw(&base, raw)?;
        let resolved = candidate
            .canonicalize()
            .map_err(|_| WorkspaceError::not_found(format!("Path not found: {raw}")))?;
        self.ensure_inside_workspace(&candidate, &resolved)?;
        Ok(ResolvedPath {
            display: self.display_path(&resolved),
            path: resolved,
            existed: true,
        })
    }

    pub fn resolve_for_write(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {
        self.reject_unsafe_text(raw_path)?;
        self.reject_protected_write_path(raw_path)?;
        let pure = Path::new(raw_path);
        if pure.file_name().is_none() || raw_path == "." || raw_path == ".." {
            return Err(WorkspaceError::invalid_argument("Invalid write target"));
        }

        let (candidate, project) = self.candidate_from_raw(&self.root, raw_path)?;
        if project.as_ref().is_some_and(LinkedProject::read_only)
            || self
                .linked_project_containing_path(&candidate)
                .is_some_and(|value| value.read_only())
        {
            return Err(WorkspaceError::Tool {
                code: "READ_ONLY_LINKED_PROJECT",
                message: format!("Linked project is read-only: {raw_path}"),
                category: "permission",
                retryable: false,
            });
        }

        if candidate.exists() || candidate.is_symlink() {
            let resolved = candidate
                .canonicalize()
                .map_err(|_| WorkspaceError::not_found(format!("Path not found: {raw_path}")))?;
            self.ensure_inside_workspace(&candidate, &resolved)?;
            return Ok(ResolvedPath {
                display: self.display_path(&resolved),
                path: resolved,
                existed: true,
            });
        }

        let parent = candidate
            .parent()
            .ok_or_else(|| WorkspaceError::invalid_argument("Invalid write target"))?;
        let resolved_parent = if parent.exists() {
            parent
                .canonicalize()
                .map_err(|_| WorkspaceError::not_found("Parent directory not found"))?
        } else {
            self.ensure_parent_chain(parent)?;
            parent.to_path_buf()
        };
        if self.allowed_root_for_path(&resolved_parent).is_none() {
            return Err(WorkspaceError::path_outside_workspace());
        }
        Ok(ResolvedPath {
            display: self.display_path(&candidate),
            path: candidate,
            existed: false,
        })
    }

    fn ensure_parent_chain(&self, parent: &Path) -> WorkspaceResult<()> {
        let mut cursor = parent;
        while !cursor.exists() {
            if cursor.parent() == Some(cursor) {
                break;
            }
            cursor = cursor.parent().unwrap_or(cursor);
        }
        if cursor.exists() {
            let resolved = cursor
                .canonicalize()
                .map_err(|_| WorkspaceError::not_found("Parent directory not found"))?;
            if self.allowed_root_for_path(&resolved).is_none() {
                return Err(WorkspaceError::path_outside_workspace());
            }
        }
        Ok(())
    }

    fn validate_base(&self, base: &Path) -> WorkspaceResult<PathBuf> {
        let resolved = base
            .canonicalize()
            .map_err(|_| WorkspaceError::not_found("Base path not found"))?;
        if !resolved.is_dir() {
            return Err(WorkspaceError::not_a_directory("Base is not a directory"));
        }
        if self.allowed_root_for_path(&resolved).is_none() {
            return Err(WorkspaceError::path_outside_workspace());
        }
        Ok(resolved)
    }

    fn ensure_inside_workspace(&self, candidate: &Path, resolved: &Path) -> WorkspaceResult<()> {
        if self.allowed_root_for_path(resolved).is_none() {
            if candidate.is_symlink() {
                return Err(WorkspaceError::symlink_escape());
            }
            return Err(WorkspaceError::path_outside_workspace());
        }
        Ok(())
    }

    pub fn reject_write_symlink(&self, raw_path: &str) -> WorkspaceResult<()> {
        self.reject_unsafe_text(raw_path)?;
        let (candidate, project) = self.candidate_from_raw(&self.root, raw_path)?;
        if project.as_ref().is_some_and(LinkedProject::read_only)
            || self
                .linked_project_containing_path(&candidate)
                .is_some_and(|value| value.read_only())
        {
            return Err(WorkspaceError::Tool {
                code: "READ_ONLY_LINKED_PROJECT",
                message: format!("Linked project is read-only: {raw_path}"),
                category: "permission",
                retryable: false,
            });
        }
        if candidate.is_symlink() {
            return Err(WorkspaceError::symlink_escape());
        }
        Ok(())
    }

    pub fn reject_protected_write_path(&self, raw_path: &str) -> WorkspaceResult<()> {
        self.reject_unsafe_text(raw_path)?;
        let (candidate, project) = self.candidate_from_raw(&self.root, raw_path)?;
        if project.as_ref().is_some_and(LinkedProject::read_only)
            || self
                .linked_project_containing_path(&candidate)
                .is_some_and(|value| value.read_only())
        {
            return Err(WorkspaceError::Tool {
                code: "READ_ONLY_LINKED_PROJECT",
                message: format!("Linked project is read-only: {raw_path}"),
                category: "permission",
                retryable: false,
            });
        }
        let candidate = Self::normalize_path_from_existing_ancestor(&candidate);
        let root = self
            .allowed_root_for_path(&candidate)
            .ok_or_else(WorkspaceError::path_outside_workspace)?;
        let relative = candidate
            .strip_prefix(root)
            .map_err(|_| WorkspaceError::path_outside_workspace())?;
        let first = relative.components().find_map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        });
        if first
            .as_deref()
            .is_some_and(|value| matches!(value, ".git" | ".github" | ".mcp-paths"))
        {
            return Err(WorkspaceError::Tool {
                code: "PROTECTED_PATH",
                message: format!("禁止普通文件操作写入受保护目录: {raw_path}"),
                category: "security",
                retryable: false,
            });
        }
        Ok(())
    }

    fn validate_read_text(&self, raw_path: &str) -> WorkspaceResult<()> {
        if raw_path.contains('\0') {
            return Err(WorkspaceError::invalid_argument("Path contains a NUL byte"));
        }
        Ok(())
    }

    pub fn is_ignored_path(
        &self,
        path: &Path,
        include_hidden: bool,
        include_ignored: bool,
    ) -> bool {
        let Some(scan_root) = self.allowed_root_for_path(path) else {
            // Explicit external read paths keep the prior behavior.
            return false;
        };
        let Ok(scan_path) = path.strip_prefix(scan_root) else {
            return false;
        };
        let parts: Vec<String> = scan_path
            .components()
            .filter_map(|part| match part {
                Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if !include_hidden {
            for part in &parts {
                if part.starts_with('.') && part != "." {
                    return true;
                }
            }
        }
        if !include_ignored {
            for part in &parts {
                if DEFAULT_EXCLUDED_NAMES.contains(&part.as_str()) {
                    return true;
                }
            }
        }
        false
    }

    pub fn is_safe_existing_path(&self, path: &Path) -> bool {
        path.canonicalize()
            .map(|resolved| self.allowed_root_for_path(&resolved).is_some())
            .unwrap_or(false)
    }

    pub fn is_read_only_path(&self, path: &Path) -> bool {
        path.canonicalize()
            .ok()
            .and_then(|resolved| self.linked_project_containing_path(&resolved))
            .is_some_and(|project| project.read_only())
    }

    pub fn is_safe_read_path(&self, path: &Path) -> bool {
        path.exists() || path.is_symlink()
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod linked_root_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn add_mapping(workspace: &Path, alias: &str, external: &Path, mode: &str) {
        let mappings = workspace.join(".mcp-paths");
        fs::create_dir_all(&mappings).expect("mappings");
        fs::write(
            mappings.join(format!("{alias}.txt")),
            format!("name={alias}\npath={}\nmode={mode}\n", external.display()),
        )
        .expect("mapping");
    }

    #[test]
    fn linked_root_accepts_alias_and_approved_absolute_write_targets() {
        let workspace = tempdir().expect("workspace");
        let external = tempdir().expect("external");
        let outside = tempdir().expect("outside");
        add_mapping(workspace.path(), "coc-macro", external.path(), "read-write");
        fs::write(external.path().join("existing.txt"), "ok").expect("existing");

        let ws = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
        assert!(ws.resolve_existing("@coc-macro/existing.txt").is_ok());
        let write_target = external.path().join("new.txt");
        let resolved = ws
            .resolve_for_write(write_target.to_string_lossy().as_ref())
            .expect("linked absolute write");
        assert_eq!(
            resolved.path,
            external
                .path()
                .canonicalize()
                .expect("canonical external")
                .join("new.txt")
        );
        assert_eq!(resolved.display, "@coc-macro/new.txt");
        ws.reject_protected_write_path(&resolved.display)
            .expect("linked display passes protected-path preflight");

        let denied = ws
            .resolve_for_write(
                outside
                    .path()
                    .join("blocked.txt")
                    .to_string_lossy()
                    .as_ref(),
            )
            .expect_err("outside path must be blocked");
        assert_eq!(denied.to_error_value()["code"], "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn read_only_linked_root_rejects_writes() {
        let workspace = tempdir().expect("workspace");
        let external = tempdir().expect("external");
        add_mapping(workspace.path(), "reference", external.path(), "read-only");

        let ws = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
        let denied = ws
            .resolve_for_write("@reference/new.txt")
            .expect_err("read-only mapping must reject writes");
        assert_eq!(denied.to_error_value()["code"], "READ_ONLY_LINKED_PROJECT");
    }
}

pub fn relative_display(root: &Path, path: &Path) -> String {
    let display = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
    #[cfg(windows)]
    {
        if let Some(unc) = display.strip_prefix("//?/UNC/") {
            return format!("//{unc}");
        }
        if let Some(normal) = display.strip_prefix("//?/") {
            return normal.to_string();
        }
    }
    display
}

pub fn tool_ok(mut value: Value) -> Value {
    if value.get("ok").is_none() {
        value
            .as_object_mut()
            .expect("tool result object")
            .insert("ok".into(), Value::Bool(true));
    }
    value
}

pub fn tool_err(error: WorkspaceError) -> Value {
    json!({
        "ok": false,
        "status": "error",
        "summary": error.message(),
        "error": error.to_error_value()
    })
}

pub fn tool_err_code(
    code: &'static str,
    message: impl Into<String>,
    category: &'static str,
) -> Value {
    let message = message.into();
    json!({
        "ok": false,
        "status": "error",
        "summary": message.clone(),
        "error": {
            "code": code,
            "message": message,
            "category": category,
            "retryable": false,
            "details": {}
        }
    })
}

pub fn wrap_tool_result(structured: Value) -> Value {
    wrap_mcp_tool_result("", &serde_json::json!({}), structured)
}

pub fn wrap_mcp_tool_result(tool_name: &str, args: &Value, structured: Value) -> Value {
    let is_error = structured.get("ok").and_then(Value::as_bool) == Some(false);
    let content = if tool_name == "view_image"
        && args
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or("mcp_image")
            == "mcp_image"
        && !is_error
    {
        vec![json!({
            "type": "image",
            "data": structured.get("base64").and_then(Value::as_str).unwrap_or(""),
            "mimeType": structured
                .get("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
        })]
    } else {
        vec![json!({
            "type": "text",
            "text": structured.to_string()
        })]
    };
    json!({
        "content": content,
        "structuredContent": structured,
        "isError": is_error
    })
}
