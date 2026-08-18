use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::tools::context::ToolContext;

const MAX_TOTAL_INSTRUCTION_BYTES: usize = 32 * 1024;
const MAX_INSTRUCTION_FILE_BYTES: usize = 16 * 1024;
const MAX_INSTRUCTION_FILES: usize = 16;

const AGENT_FILE_NAMES: &[&str] = &["agents.md", "agent.md", "claude.md"];

/// Resolve bounded project instructions for the exact path/workdir addressed by a tool call.
/// The primary workspace and each approved linked project form separate instruction scopes.
pub fn for_tool(ctx: &ToolContext, tool_name: &str, args: &Value) -> Value {
    let hint = path_hint(tool_name, args);
    let candidate = candidate_path(ctx, hint.as_deref());
    let display_target = display_or_dot(ctx, &candidate);

    let Some(scope) = instruction_scope(ctx, hint.as_deref(), &candidate) else {
        return json!({
            "selection": "tool_path",
            "scope": "external",
            "root": null,
            "target": display_target,
            "files": [],
            "instructions": "",
            "truncated": false,
            "warnings": ["The addressed path is outside the primary workspace and approved linked projects; no project instruction file was loaded."]
        });
    };

    let target_dir = canonical_target_directory(&candidate, &scope.root)
        .filter(|path| path.starts_with(&scope.root))
        .unwrap_or_else(|| scope.root.clone());
    let directories = directories_between(&scope.root, &target_dir);

    let mut remaining = MAX_TOTAL_INSTRUCTION_BYTES;
    let mut files = Vec::new();
    let mut sections = Vec::new();
    let mut warnings = Vec::new();
    let mut truncated = false;

    'directories: for directory in directories {
        for path in instruction_files(&directory) {
            if files.len() >= MAX_INSTRUCTION_FILES || remaining == 0 {
                truncated = true;
                warnings.push(format!(
                    "Project instruction loading stopped at the bounded limit of {MAX_INSTRUCTION_FILES} files / {MAX_TOTAL_INSTRUCTION_BYTES} bytes."
                ));
                break 'directories;
            }

            let budget = remaining.min(MAX_INSTRUCTION_FILE_BYTES);
            match read_utf8_prefix(&path, budget) {
                Ok(read) => {
                    remaining = remaining.saturating_sub(read.bytes);
                    truncated |= read.truncated;
                    let display = display_or_dot(ctx, &path);
                    files.push(json!({
                        "path": display,
                        "bytes": read.bytes,
                        "truncated": read.truncated
                    }));
                    let suffix = if read.truncated { " [truncated]" } else { "" };
                    sections.push(format!(
                        "Project instructions from {display}{suffix}:\n{}",
                        read.content
                    ));
                }
                Err(message) => warnings.push(message),
            }
        }
    }

    json!({
        "selection": "tool_path",
        "scope": scope.label,
        "root": display_or_dot(ctx, &scope.root),
        "target": display_target,
        "files": files,
        "instructions": sections.join("\n\n"),
        "truncated": truncated,
        "warnings": warnings
    })
}

#[derive(Debug)]
struct InstructionScope {
    root: PathBuf,
    label: String,
}

fn instruction_scope(
    ctx: &ToolContext,
    raw_hint: Option<&str>,
    candidate: &Path,
) -> Option<InstructionScope> {
    if let Some(raw) = raw_hint {
        let normalized = raw.replace('\\', "/");
        if let Some(alias_path) = normalized.strip_prefix('@') {
            let alias = alias_path.split('/').next().unwrap_or("");
            if let Some(project) = ctx
                .workspace
                .linked_projects()
                .into_iter()
                .find(|project| project.alias.eq_ignore_ascii_case(alias))
            {
                if let Ok(root) = project.root_path().canonicalize() {
                    return Some(InstructionScope {
                        root,
                        label: format!("@{}", project.alias),
                    });
                }
            }
            return None;
        }
    }

    let probe = canonical_existing_ancestor(candidate).unwrap_or_else(|| candidate.to_path_buf());
    if probe.starts_with(ctx.workspace.root()) {
        return Some(InstructionScope {
            root: ctx.workspace.root().to_path_buf(),
            label: "workspace".into(),
        });
    }

    let mut matches = ctx
        .workspace
        .linked_projects()
        .into_iter()
        .filter_map(|project| {
            let root = project.root_path().canonicalize().ok()?;
            probe.starts_with(&root).then_some((root, project.alias))
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|(root, _)| std::cmp::Reverse(root.components().count()));
    matches
        .into_iter()
        .next()
        .map(|(root, alias)| InstructionScope {
            root,
            label: format!("@{alias}"),
        })
}

fn path_hint(tool_name: &str, args: &Value) -> Option<String> {
    let string = |name: &str| {
        args.get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let first_array_string = |name: &str| {
        args.get(name).and_then(Value::as_array).and_then(|items| {
            items.iter().find_map(|item| {
                item.as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
        })
    };

    match tool_name {
        "read_file" | "list_dir" | "list_files" | "search_text" | "grep_text" | "grep"
        | "git_status" | "git_log" | "git_blame" | "view_image" | "set_default_cwd" => {
            string("path")
        }
        "exec_command" => string("workdir").or_else(|| string("cwd")),
        "git_diff" => string("path").or_else(|| first_array_string("paths")),
        "git_show" => string("path").or_else(|| first_array_string("paths")),
        "apply_patch" | "patch_check" => args
            .get("patch")
            .and_then(Value::as_str)
            .and_then(first_patch_path),
        _ => None,
    }
}

fn first_patch_path(patch: &str) -> Option<String> {
    for line in patch.lines() {
        for prefix in [
            "*** Add File: ",
            "*** Update File: ",
            "*** Delete File: ",
            "+++ b/",
            "--- a/",
        ] {
            if let Some(path) = line.trim_end_matches('\r').strip_prefix(prefix) {
                let path = path.trim();
                if !path.is_empty() && path != "/dev/null" {
                    return Some(path.replace('\\', "/"));
                }
            }
        }
    }
    None
}

fn candidate_path(ctx: &ToolContext, raw_hint: Option<&str>) -> PathBuf {
    let base = ctx.workspace.root().to_path_buf();
    let Some(raw) = raw_hint.map(str::trim).filter(|value| !value.is_empty()) else {
        return base;
    };
    let normalized = raw.replace('\\', "/");
    if let Some(alias_path) = normalized.strip_prefix('@') {
        let (alias, rest) = alias_path.split_once('/').unwrap_or((alias_path, ""));
        if let Some(project) = ctx
            .workspace
            .linked_projects()
            .into_iter()
            .find(|project| project.alias.eq_ignore_ascii_case(alias))
        {
            return if rest.is_empty() {
                project.root_path()
            } else {
                project
                    .root_path()
                    .join(rest.replace('/', std::path::MAIN_SEPARATOR_STR))
            };
        }
    }

    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(raw.replace('/', std::path::MAIN_SEPARATOR_STR))
    }
}

fn canonical_target_directory(candidate: &Path, fallback_root: &Path) -> Option<PathBuf> {
    let existing = canonical_existing_ancestor(candidate)?;
    let directory = if existing.is_dir() {
        existing
    } else {
        existing.parent()?.to_path_buf()
    };
    if directory.starts_with(fallback_root) {
        Some(directory)
    } else {
        None
    }
}

fn canonical_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut cursor = path;
    loop {
        if cursor.exists() || cursor.is_symlink() {
            return cursor.canonicalize().ok();
        }
        cursor = cursor.parent()?;
    }
}

fn directories_between(root: &Path, target: &Path) -> Vec<PathBuf> {
    let mut directories = vec![root.to_path_buf()];
    let Ok(relative) = target.strip_prefix(root) else {
        return directories;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if let Component::Normal(part) = component {
            current.push(part);
            directories.push(current.clone());
        }
    }
    directories
}

fn instruction_files(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            AGENT_FILE_NAMES
                .contains(&name.as_str())
                .then_some(entry.path())
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let priority = match name.as_str() {
            "agents.md" => 0,
            "agent.md" => 1,
            "claude.md" => 2,
            _ => 3,
        };
        (priority, name)
    });
    paths
}

struct ReadPrefix {
    content: String,
    bytes: usize,
    truncated: bool,
}

fn read_utf8_prefix(path: &Path, budget: usize) -> Result<ReadPrefix, String> {
    let file = File::open(path).map_err(|error| {
        format!(
            "Could not read project instruction file {}: {error}",
            path.display()
        )
    })?;
    let mut bytes = Vec::with_capacity(budget.saturating_add(1));
    file.take(budget.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            format!(
                "Could not read project instruction file {}: {error}",
                path.display()
            )
        })?;

    let truncated = bytes.len() > budget;
    bytes.truncate(budget);
    let content = match std::str::from_utf8(&bytes) {
        Ok(value) => value.to_string(),
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .unwrap_or_default()
                .to_string()
        }
        Err(_) => {
            return Err(format!(
                "Skipped non-UTF-8 project instruction file: {}",
                path.display()
            ))
        }
    };
    let used = content.len();
    Ok(ReadPrefix {
        content,
        bytes: used,
        truncated,
    })
}

fn display_or_dot(ctx: &ToolContext, path: &Path) -> String {
    let display = ctx.workspace.display_path(path);
    if display.is_empty() {
        ".".into()
    } else {
        display
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::tempdir;

    use crate::tools::ToolContext;

    use super::for_tool;

    #[test]
    fn loads_root_and_nested_instruction_files_for_the_addressed_path() {
        let workspace = tempdir().expect("workspace");
        let harness = tempdir().expect("harness");
        fs::create_dir_all(workspace.path().join("src/nested")).expect("nested");
        fs::write(workspace.path().join("AGENTS.md"), "root rule").expect("root instructions");
        fs::write(workspace.path().join("src/AgEnT.Md"), "nested rule")
            .expect("nested instructions");
        fs::write(workspace.path().join("src/nested/code.rs"), "fn main() {}").expect("source");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");

        let context = for_tool(&ctx, "read_file", &json!({"path": "src/nested/code.rs"}));
        assert_eq!(context["scope"], "workspace");
        assert_eq!(context["files"].as_array().expect("files").len(), 2);
        let instructions = context["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("root rule"));
        assert!(instructions.contains("nested rule"));
    }

    #[test]
    fn linked_project_paths_use_the_linked_projects_own_instructions() {
        let workspace = tempdir().expect("workspace");
        let linked = tempdir().expect("linked");
        let harness = tempdir().expect("harness");
        fs::create_dir_all(workspace.path().join(".mcp-paths")).expect("mappings");
        fs::write(
            workspace.path().join(".mcp-paths/linked.txt"),
            format!(
                "name=Linked\npath={}\nmode=read-write\n",
                linked.path().display()
            ),
        )
        .expect("mapping");
        fs::write(workspace.path().join("AGENTS.md"), "workspace rule")
            .expect("workspace instructions");
        fs::write(linked.path().join("CLAUDE.md"), "linked rule").expect("linked instructions");
        fs::write(linked.path().join("code.py"), "print('ok')").expect("linked source");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");

        let context = for_tool(&ctx, "read_file", &json!({"path": "@linked/code.py"}));
        assert_eq!(context["scope"], "@linked");
        let instructions = context["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("linked rule"));
        assert!(!instructions.contains("workspace rule"));
    }

    #[test]
    fn unknown_linked_alias_does_not_fall_back_to_workspace_instructions() {
        let workspace = tempdir().expect("workspace");
        let harness = tempdir().expect("harness");
        fs::write(workspace.path().join("AGENTS.md"), "workspace-only rule")
            .expect("workspace instructions");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");

        let context = for_tool(&ctx, "read_file", &json!({"path": "@missing/code.py"}));
        assert_eq!(context["scope"], "external");
        assert_eq!(context["instructions"], "");
    }

    #[test]
    fn external_read_paths_do_not_load_unapproved_instruction_files() {
        let workspace = tempdir().expect("workspace");
        let external = tempdir().expect("external");
        let harness = tempdir().expect("harness");
        fs::write(external.path().join("AGENTS.md"), "external secret rule")
            .expect("external instructions");
        fs::write(external.path().join("file.txt"), "value").expect("external file");
        let ctx =
            ToolContext::for_test(workspace.path().to_path_buf(), harness.path().to_path_buf())
                .expect("context");

        let context = for_tool(
            &ctx,
            "read_file",
            &json!({"path": external.path().join("file.txt").display().to_string()}),
        );
        assert_eq!(context["scope"], "external");
        assert_eq!(context["instructions"], "");
    }
}
