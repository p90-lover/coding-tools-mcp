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

/// Names no file tool writes into: git's own data (a `.git` directory, or a linked worktree's
/// `.git` file naming its gitdir), CI definitions, and the workspace's path mappings.
pub(crate) const PROTECTED_WRITE_NAMES: &[&str] = &[".git", ".github", ".mcp-paths"];

/// The name Windows opens for a path part, lower-cased: a `:stream` suffix names a stream of the
/// same file and trailing dots and spaces are dropped, so `.git.`, `.GIT ` and `.git::$DATA` all
/// open `.git`. Compare protected names against this, never against the raw part.
pub(crate) fn effective_name(part: &str) -> String {
    part.split(':')
        .next()
        .unwrap_or(part)
        .trim_end_matches(['.', ' '])
        .to_ascii_lowercase()
}

/// Whether a path part names one of `names` (lower-case), however it is spelled.
pub(crate) fn is_protected_name(part: &str, names: &[&str]) -> bool {
    !matches!(part, "." | "..") && names.contains(&effective_name(part).as_str())
}

/// Why Windows would open something other than what a path part names, if it would: trailing
/// dots or spaces (dropped) and `:` (an alternate data stream), always; when `device_names` is set,
/// a reserved device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, with or without an extension); and
/// when `short_names` is set, an 8.3 short name (`~` and a digit, e.g. `GIT~1`), which the file
/// system expands to a long name. The last two are also ordinary names (`file~2.txt`, and `aux.ts`
/// on Windows 11), so they are only checked where a write could reach a session root's git data.
pub(crate) fn windows_quirk(
    part: &str,
    device_names: bool,
    short_names: bool,
) -> Option<&'static str> {
    if matches!(part, "." | "..") || part.is_empty() {
        return None;
    }
    if part.ends_with(['.', ' ']) {
        return Some("a path part ends with a dot or a space");
    }
    if part.contains(':') {
        return Some("a path part names an alternate data stream");
    }
    if !device_names {
        return None;
    }
    let stem = part
        .split('.')
        .next()
        .unwrap_or(part)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let numbered = {
        let chars: Vec<char> = stem.chars().collect();
        chars.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(chars[3], '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')
    };
    if numbered
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
    {
        return Some("a path part is a reserved device name");
    }
    if short_names {
        let bytes = part.as_bytes();
        if bytes
            .windows(2)
            .any(|pair| pair[0] == b'~' && pair[1].is_ascii_digit())
        {
            return Some("a path part is an 8.3 short name");
        }
    }
    None
}

/// Refuses a path spelled with a Windows quirk (see `windows_quirk`). Device names and short names
/// are checked only for a `session_write` (a write into a session's own root). Short names are
/// checked in relative paths; an absolute path may legitimately pass through one (a short temp
/// directory), and its protected names are compared after canonicalization instead.
fn reject_windows_quirks(raw_path: &str, session_write: bool) -> WorkspaceResult<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let path = Path::new(raw_path);
    let short_names = session_write && !path.is_absolute() && !raw_path.starts_with(['\\', '/']);
    for part in path.components() {
        if let Component::Normal(name) = part {
            if let Some(reason) = windows_quirk(&name.to_string_lossy(), session_write, short_names)
            {
                return Err(WorkspaceError::Tool {
                    code: "UNSAFE_PATH_SPELLING",
                    message: format!("Path refused: {reason}: {raw_path}"),
                    category: "security",
                    retryable: false,
                });
            }
        }
    }
    Ok(())
}

/// The path an open file really is, from its handle.
#[cfg(windows)]
fn opened_path(file: &std::fs::File) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};
    let handle = HANDLE(file.as_raw_handle());
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: the handle stays open for the borrow of `file`, and the buffer is ours.
        let length = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, FILE_NAME_NORMALIZED) }
            as usize;
        if length == 0 {
            return None;
        }
        if length < buffer.len() {
            return Some(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..length],
            )));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(not(windows))]
fn opened_path(_file: &std::fs::File) -> Option<PathBuf> {
    None
}

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
    pub fn code(&self) -> &'static str {
        match self {
            Self::Tool { code, .. } | Self::ToolDetails { code, .. } => code,
        }
    }

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
    linked_snapshot: Option<Vec<LinkedProject>>,
    /// Only the root itself is in scope: no `.mcp-paths` links and no explicit external reads.
    isolated: bool,
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
        Ok(Self {
            root,
            linked_snapshot: None,
            isolated: false,
        })
    }

    /// A workspace of the root alone: reads stay inside it like writes, and `.mcp-paths` mappings
    /// in the tree link nothing (an agent's own worktree could hold the user's mappings, or write
    /// new ones from its shell).
    ///
    /// Paths are resolved (links followed) before they are opened, so a directory swapped for a
    /// junction in between could redirect the open. Reads re-check the opened handle
    /// (`verify_opened`). Writes resolve their target again just before staging and renaming,
    /// which narrows but does not close that window. Swapping needs a process running in the tree
    /// while the call runs; for a chat session that is only a terminal command, which is opt-in
    /// and confirmed by the user each time.
    pub fn isolated(root: PathBuf) -> WorkspaceResult<Self> {
        let mut workspace = Self::new(root)?;
        workspace.isolated = true;
        workspace.linked_snapshot = Some(Vec::new());
        Ok(workspace)
    }

    fn listed_links(&self) -> Vec<LinkedProject> {
        if self.isolated {
            return Vec::new();
        }
        list_linked_projects_for_root(&self.root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn approved_scope_root(&self, path: &Path) -> Option<PathBuf> {
        self.allowed_root_for_path(path)
    }

    pub fn root_display(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    pub fn linked_projects(&self) -> Vec<LinkedProject> {
        self.linked_snapshot
            .clone()
            .unwrap_or_else(|| self.listed_links())
    }

    pub fn request_snapshot(&self) -> Self {
        Self {
            root: self.root.clone(),
            linked_snapshot: Some(self.listed_links()),
            isolated: self.isolated,
        }
    }

    pub fn roots_revision(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(self.root.to_string_lossy().as_bytes());
        for project in self.linked_projects() {
            for value in [&project.alias, &project.name, &project.path, &project.mode] {
                hash.update((value.len() as u64).to_le_bytes());
                hash.update(value.as_bytes());
            }
        }
        format!("{:x}", hash.finalize())
    }

    pub fn ensure_roots_current(&self) -> WorkspaceResult<()> {
        if self
            .linked_snapshot
            .as_ref()
            .is_some_and(|roots| *roots != self.listed_links())
        {
            return Err(WorkspaceError::Tool {code:"WORKSPACE_ROOTS_CHANGED",message:"Approved project mappings changed during this request. Inspect state before reassessing; an already-submitted effect cannot be undone and must not be automatically replayed.".into(),category:"permission",retryable:false});
        }
        Ok(())
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
        reject_windows_quirks(raw_path, false)
    }

    /// `reject_unsafe_text` for a path a tool writes: in a session's own root (see `isolated`)
    /// device names and 8.3 short names are refused too, so no write reaches git's own data, or a
    /// device, by another name. Elsewhere such names are ordinary files.
    pub fn reject_unsafe_write_text(&self, raw_path: &str) -> WorkspaceResult<()> {
        self.reject_unsafe_text(raw_path)?;
        if self.isolated {
            reject_windows_quirks(raw_path, true)?;
        }
        Ok(())
    }

    pub fn resolve_existing(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {
        self.resolve_existing_at(&self.root, raw_path)
    }

    /// Read paths retain the existing explicit-absolute-path behavior.
    /// `@alias/...` is additionally resolved through `.mcp-paths`.
    pub fn resolve_read_path(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {
        self.ensure_roots_current()?;
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
        if self.isolated
            || alias_address
            || (!explicit_external && candidate.starts_with(&self.root))
        {
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
        self.ensure_roots_current()?;
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
        self.ensure_roots_current()?;
        self.reject_unsafe_write_text(raw_path)?;
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
        // Keep new linked targets in the same canonical spelling as their root.
        // On Windows linked mappings intentionally show D:\... while canonical
        // storage roots use the verbatim prefix. Existing targets were already
        // canonicalized above; new targets need their existing ancestor resolved.
        let candidate = Self::normalize_path_from_existing_ancestor(&candidate);
        self.ensure_inside_workspace(&candidate, &candidate)?;
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
        self.reject_unsafe_write_text(raw_path)?;
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
        self.reject_unsafe_write_text(raw_path)?;
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
        // Every part, by the name the file system opens (any case, trailing dots, streams): a
        // nested repository's or worktree's `.git` is as much git's own as the root's.
        let protected = relative.components().any(|part| match part {
            Component::Normal(name) => {
                is_protected_name(&name.to_string_lossy(), PROTECTED_WRITE_NAMES)
            }
            _ => false,
        });
        if protected {
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
        reject_windows_quirks(raw_path, false)
    }

    /// Whether this is a session's own root alone (see `isolated`).
    pub fn is_isolated(&self) -> bool {
        self.isolated
    }

    /// For a session's own root: re-checks, through the open handle, that a file a tool opened is
    /// still inside the root. A directory swapped for a junction or link between resolving the
    /// path and opening it is caught here (on Windows from the handle's final path; elsewhere the
    /// path is resolved again, which narrows the window but does not close it).
    pub fn verify_opened(&self, file: &std::fs::File, path: &Path) -> WorkspaceResult<()> {
        if !self.isolated {
            return Ok(());
        }
        let actual = opened_path(file)
            .or_else(|| path.canonicalize().ok())
            .ok_or_else(WorkspaceError::path_outside_workspace)?;
        if self.allowed_root_for_path(&actual).is_none() {
            return Err(WorkspaceError::symlink_escape());
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
    fn an_isolated_root_has_no_links_and_no_external_reads() {
        let workspace = tempdir().expect("workspace");
        let external = tempdir().expect("external");
        add_mapping(workspace.path(), "coc-macro", external.path(), "read-write");
        fs::write(external.path().join("existing.txt"), "ok").expect("existing");
        fs::write(workspace.path().join("inside.txt"), "ok").expect("inside");
        let outside = external.path().join("existing.txt");

        let open = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
        assert!(open.resolve_read_path(&outside.to_string_lossy()).is_ok());
        let ws = Workspace::isolated(workspace.path().to_path_buf()).expect("workspace");
        assert!(ws.linked_projects().is_empty());
        assert!(ws.request_snapshot().linked_projects().is_empty());
        assert!(ws.request_snapshot().ensure_roots_current().is_ok());
        assert!(ws.resolve_existing("@coc-macro/existing.txt").is_err());
        assert!(ws.resolve_read_path(&outside.to_string_lossy()).is_err());
        assert!(ws.resolve_read_path("inside.txt").is_ok());
        assert!(ws
            .resolve_for_write(&external.path().join("new.txt").to_string_lossy())
            .is_err());
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

#[cfg(test)]
mod path_spelling_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn protected_names_match_whatever_name_the_file_system_opens() {
        for part in [
            ".git",
            ".GIT",
            ".git.",
            ".git ",
            ".git. .",
            ".git::$DATA",
            ".Github.",
            ".mcp-paths ",
        ] {
            assert!(is_protected_name(part, PROTECTED_WRITE_NAMES), "{part}");
        }
        for part in [".gitignore", ".git.bak", "git", ".githubx", ".", ".."] {
            assert!(!is_protected_name(part, PROTECTED_WRITE_NAMES), "{part}");
        }
    }

    #[test]
    fn windows_quirks_are_named() {
        for part in [".git.", ".git ", "a.", "b ", ".git::$DATA", "x:y", "PRN "] {
            assert!(windows_quirk(part, false, false).is_some(), "{part}");
        }
        for part in [
            "CON",
            "con",
            "nul.txt",
            "Aux.tar.gz",
            "aux.ts",
            "con.go",
            "COM1",
            "lpt9.log",
            "COM0",
            "conin$",
        ] {
            assert!(windows_quirk(part, true, false).is_some(), "{part}");
            assert!(
                windows_quirk(part, false, false).is_none(),
                "{part}: a device name only matters for a session write"
            );
        }
        assert!(windows_quirk("GIT~1", true, true).is_some());
        assert!(windows_quirk("GITHUB~2.TXT", true, true).is_some());
        assert!(windows_quirk("file~2.txt", true, true).is_some());
        assert!(
            windows_quirk("GIT~1", true, false).is_none(),
            "absolute paths and reads skip it"
        );
        for part in [
            "src",
            ".git",
            "console.log",
            "nullable.rs",
            "COM10",
            "LPT",
            "a~b",
            ".",
            "..",
        ] {
            assert!(windows_quirk(part, true, true).is_none(), "{part}");
        }
    }

    #[test]
    fn writes_into_git_data_are_refused_in_any_case_and_at_any_depth() {
        let workspace = tempdir().expect("workspace");
        fs::create_dir_all(workspace.path().join(".git")).expect("git dir");
        fs::create_dir_all(workspace.path().join("nested").join(".git")).expect("nested git");
        let ws = Workspace::isolated(workspace.path().to_path_buf()).expect("workspace");
        for target in [
            ".git/config",
            ".GIT/config",
            ".Github/workflows/ci.yml",
            "nested/.git/config",
            "nested/.Git/hooks/pre-commit",
            ".mcp-paths/x.txt",
        ] {
            let denied = ws.resolve_for_write(target).expect_err(target);
            assert_eq!(denied.code(), "PROTECTED_PATH", "{target}");
        }
        assert!(ws.resolve_for_write("src/main.rs").is_ok());
        assert!(ws.resolve_for_write(".gitignore").is_ok());
    }

    #[test]
    fn a_file_is_checked_again_through_its_open_handle() {
        let workspace = tempdir().expect("workspace");
        let outside = tempdir().expect("outside");
        fs::write(workspace.path().join("inside.txt"), "in").expect("inside");
        fs::write(outside.path().join("secret.txt"), "out").expect("outside");
        let ws = Workspace::isolated(workspace.path().to_path_buf()).expect("workspace");
        let inside = ws.root().join("inside.txt");
        let opened = fs::File::open(&inside).expect("open inside");
        assert!(ws.verify_opened(&opened, &inside).is_ok());
        // As if a directory on the resolved path had been swapped for a junction before the open.
        let swapped = fs::File::open(outside.path().join("secret.txt")).expect("open outside");
        if cfg!(windows) {
            assert_eq!(
                ws.verify_opened(&swapped, &inside).unwrap_err().code(),
                "SYMLINK_ESCAPE"
            );
        }
        let open = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
        assert!(
            open.verify_opened(&swapped, &inside).is_ok(),
            "only a session root is limited"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_spellings_of_git_data_are_refused_for_reads_and_writes() {
        let workspace = tempdir().expect("workspace");
        fs::create_dir_all(workspace.path().join(".git")).expect("git dir");
        fs::write(workspace.path().join(".git").join("config"), "[core]\n").expect("config");
        fs::write(workspace.path().join("a.txt"), "a").expect("file");
        let ws = Workspace::isolated(workspace.path().to_path_buf()).expect("workspace");
        for target in [
            ".git./config",
            ".git /config",
            ".git::$INDEX_ALLOCATION/config",
            ".git:stream",
            "GIT~1/config",
            ".github./workflows/ci.yml",
            "a.txt.",
            "a.txt ",
            "a.txt::$DATA",
            "CON",
            "nul.txt",
            "src/COM1.rs",
            "LPT1",
        ] {
            let write = ws.resolve_for_write(target).expect_err(target);
            assert!(
                matches!(write.code(), "UNSAFE_PATH_SPELLING" | "PROTECTED_PATH"),
                "{target}: {}",
                write.code()
            );
        }
        // Reads refuse only the spellings that are never an ordinary name.
        for target in [
            ".git./config",
            ".git /config",
            ".git::$INDEX_ALLOCATION/config",
            ".git:stream",
            ".github./workflows/ci.yml",
            "a.txt.",
            "a.txt ",
            "a.txt::$DATA",
        ] {
            assert!(ws.resolve_existing(target).is_err(), "{target}");
            assert!(ws.resolve_read_path(target).is_err(), "{target}");
        }
        // An absolute short name still lands on the canonical `.git`, and is refused by name.
        let short = workspace.path().join("GIT~1").join("config");
        if short.exists() {
            let denied = ws
                .resolve_for_write(&short.to_string_lossy())
                .expect_err("short name of .git");
            assert_eq!(denied.code(), "PROTECTED_PATH");
        }
        assert!(ws.resolve_read_path("a.txt").is_ok());
    }

    #[test]
    fn short_and_device_like_names_are_refused_only_for_session_writes() {
        let workspace = tempdir().expect("workspace");
        let names: Vec<&str> = ["file~2.txt", "foo.~1~", "aux.ts", "con.go"]
            .into_iter()
            .filter(|name| fs::write(workspace.path().join(name), "x").is_ok())
            .collect();
        assert!(names.contains(&"file~2.txt") && names.contains(&"foo.~1~"));
        let open = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
        let session = Workspace::isolated(workspace.path().to_path_buf()).expect("workspace");
        for name in &names {
            for ws in [&open, &session] {
                assert!(ws.resolve_existing(name).is_ok(), "{name}");
                assert!(ws.resolve_read_path(name).is_ok(), "{name}");
            }
            assert!(open.resolve_for_write(name).is_ok(), "{name}");
            if cfg!(windows) {
                assert_eq!(
                    session.resolve_for_write(name).unwrap_err().code(),
                    "UNSAFE_PATH_SPELLING",
                    "{name}"
                );
            }
        }
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

pub fn wrap_mcp_tool_result(tool_name: &str, args: &Value, mut structured: Value) -> Value {
    let is_error = structured.get("ok").and_then(Value::as_bool) == Some(false);
    // computer_* observations and compare_images' optional diff picture carry an image only sometimes.
    let computer_image = (tool_name.starts_with("computer_") || tool_name == "compare_images")
        && structured.get("base64").and_then(Value::as_str).is_some();
    let image_result = computer_image
        || (matches!(
            tool_name,
            "view_image" | "capture_screenshot" | "capture_window"
        ) && args
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or("mcp_image")
            == "mcp_image"
            && !is_error);
    let content = if image_result {
        let data = structured
            .as_object_mut()
            .and_then(|object| {
                object.remove("data_url");
                object.remove("base64")
            })
            .unwrap_or(Value::Null);
        let mime = structured
            .get("mime_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        if data.as_str().is_none_or(str::is_empty)
            || !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            )
        {
            return wrap_tool_result(tool_err_code(
                "INVALID_IMAGE_RESULT",
                "Image tool did not return a valid image payload",
                "runtime",
            ));
        }
        vec![
            json!({"type": "image", "data": data, "mimeType": mime}),
            json!({"type": "text", "text": structured.to_string()}),
        ]
    } else {
        vec![json!({"type": "text", "text": structured.to_string()})]
    };
    json!({"content": content, "structuredContent": structured, "isError": is_error})
}
