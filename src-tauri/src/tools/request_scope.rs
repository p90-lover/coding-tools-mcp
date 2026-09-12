//! Request-local selection never changes listener permissions or another chat's cwd/task.
use crate::tools::{workspace::WorkspaceError, ToolContext};
use serde_json::Value;
use std::path::PathBuf;

impl ToolContext {
    pub(crate) fn scope_request(&self, name: &str, args: &Value) -> Result<Self, WorkspaceError> {
        let mut request = self.clone();
        // Board/provider IDs are not native Harness task IDs.
        if !crate::harness::tools::TOOL_NAMES.contains(&name)
            && !matches!(
                name,
                "exec_command"
                    | "apply_patch"
                    | "patch_check"
                    | "read_file"
                    | "list_files"
                    | "list_dir"
                    | "search_text"
                    | "grep_text"
                    | "grep"
                    | "git_status"
                    | "git_diff"
                    | "read_output"
                    | "write_stdin"
                    | "kill_command"
                    | "kill_session"
            )
        {
            return Ok(request);
        }
        let command_owner = if matches!(
            name,
            "write_stdin" | "read_output" | "kill_command" | "kill_session"
        ) {
            let id = args
                .get("command_id")
                .or_else(|| args.get("session_id"))
                .and_then(Value::as_str)
                .or_else(|| {
                    args.get("output_ref")
                        .and_then(Value::as_str)
                        .and_then(|reference| reference.split(':').nth(1))
                });
            match id {
                Some(id) => self.sessions.get(id)?.owner_project_root(),
                None => None,
            }
        } else {
            None
        };
        let explicit = match args.get("project_root") {
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.as_str()),
            Some(_) => {
                return Err(WorkspaceError::invalid_argument(
                    "project_root must be a nonempty approved directory",
                ))
            }
            None => None,
        };
        let selected: Option<PathBuf> = if let Some(root) = explicit {
            let resolved = self.workspace.resolve_existing(root)?;
            if !resolved.path.is_dir() {
                return Err(WorkspaceError::not_a_directory(
                    "project_root is not a directory",
                ));
            }
            if command_owner
                .as_ref()
                .is_some_and(|owner| owner != &resolved.path)
            {
                return Err(WorkspaceError::invalid_argument("project_root does not match the existing command's owner; do not change its task or relaunch it"));
            }
            request = request.with_request_cwd(resolved.path.clone());
            if matches!(name, "apply_patch" | "patch_check") {
                super::patch::request_project_root(&request, args, Some(&resolved.path))?;
            }
            Some(resolved.path)
        } else if let Some(root) = command_owner {
            if self.workspace.approved_scope_root(&root).is_none() {
                return Err(WorkspaceError::path_outside_workspace());
            }
            Some(root)
        } else if matches!(name, "apply_patch" | "patch_check") {
            Some(super::patch::request_project_root(self, args, None)?)
        } else if name == "exec_command" {
            let hint = args
                .get("workdir")
                .or_else(|| args.get("cwd"))
                .and_then(Value::as_str);
            let resolved = self
                .workspace
                .resolve_existing_at(&self.default_cwd_path(), hint.unwrap_or("."))?;
            self.workspace.approved_scope_root(&resolved.path)
        } else {
            None
        };
        if let Some(root) = selected {
            request.harness = self
                .harness
                .for_project(root)
                .map_err(|e| WorkspaceError::Tool {
                    code: e.code(),
                    message: e.to_string(),
                    category: "validation",
                    retryable: false,
                })?;
        }
        if let Some(id) = args.get("task_id") {
            let id = id.as_str().filter(|v| !v.is_empty()).ok_or_else(|| {
                WorkspaceError::invalid_argument("task_id must be a nonempty identifier")
            })?;
            request.harness =
                request
                    .harness
                    .select_task(id)
                    .map_err(|e| WorkspaceError::Tool {
                        code: e.code(),
                        message: e.to_string(),
                        category: "validation",
                        retryable: false,
                    })?;
        }
        Ok(request)
    }
}
