use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const LINKED_PROJECTS_DIR: &str = ".mcp-paths";

fn friendly_path(path: &Path) -> String {
    let raw = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(normal) = raw.strip_prefix(r"\\?\") {
            return normal.to_string();
        }
    }
    raw
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedProject {
    pub alias: String,
    pub name: String,
    pub path: String,
    pub mode: String,
}

impl LinkedProject {
    pub fn root_path(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }

    pub fn read_only(&self) -> bool {
        self.mode.eq_ignore_ascii_case("read-only")
    }
}

pub fn list_linked_projects_for_root(workspace_root: &Path) -> Vec<LinkedProject> {
    let mappings_dir = workspace_root.join(LINKED_PROJECTS_DIR);
    let Ok(entries) = fs::read_dir(mappings_dir) else {
        return Vec::new();
    };

    let mut projects = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
        })
        .filter_map(|entry| parse_mapping_file(&entry.path()))
        .collect::<Vec<_>>();

    projects.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    projects
}

pub fn quick_add_linked_project_for_root(
    workspace_root: &Path,
    selected_path: &Path,
    requested_name: Option<&str>,
) -> AppResult<LinkedProject> {
    let root = workspace_root
        .canonicalize()
        .map_err(|error| AppError::Message(format!("工作区目录不可用: {error}")))?;
    let target = selected_path
        .canonicalize()
        .map_err(|error| AppError::Message(format!("项目目录不可用: {error}")))?;

    if !target.is_dir() {
        return Err(AppError::Message("Linked project 必须是目录".into()));
    }
    if target == root {
        return Err(AppError::Message("该目录已经是当前 Workspace 根目录".into()));
    }

    let default_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Linked Project");
    let name = requested_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_name)
        .to_string();

    let base_alias = slugify(&name);
    let mappings_dir = root.join(LINKED_PROJECTS_DIR);
    fs::create_dir_all(&mappings_dir)
        .map_err(|error| AppError::Message(format!("无法创建 {LINKED_PROJECTS_DIR}: {error}")))?;

    let mut alias = base_alias.clone();
    let mut counter = 2usize;
    while mappings_dir.join(format!("{alias}.txt")).exists() {
        alias = format!("{base_alias}-{counter}");
        counter += 1;
    }

    let project = LinkedProject {
        alias: alias.clone(),
        name,
        path: friendly_path(&target),
        mode: "read-write".into(),
    };
    let mapping_path = mappings_dir.join(format!("{alias}.txt"));
    let content = format!(
        "name={}\npath={}\nmode={}\n",
        project.name, project.path, project.mode
    );
    fs::write(&mapping_path, content)
        .map_err(|error| AppError::Message(format!("无法保存 linked project mapping: {error}")))?;

    Ok(project)
}

fn parse_mapping_file(mapping_path: &Path) -> Option<LinkedProject> {
    let alias = mapping_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let text = fs::read_to_string(mapping_path).ok()?;

    let mut name: Option<String> = None;
    let mut target: Option<String> = None;
    let mut mode = "read-write".to_string();

    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            match key.trim().to_ascii_lowercase().as_str() {
                "name" if !value.is_empty() => name = Some(value.to_string()),
                "path" if !value.is_empty() => target = Some(value.to_string()),
                "mode" if value.eq_ignore_ascii_case("read-only") => mode = "read-only".into(),
                "mode" if value.eq_ignore_ascii_case("read-write") => mode = "read-write".into(),
                _ => {}
            }
        } else if target.is_none() {
            // Backward-compatible one-line format:
            // F:\ClashOfClans\Macro
            target = Some(line.to_string());
        }
    }

    let target = PathBuf::from(target?).canonicalize().ok()?;
    if !target.is_dir() {
        return None;
    }

    Some(LinkedProject {
        alias: alias.clone(),
        name: name.unwrap_or_else(|| alias.clone()),
        path: friendly_path(&target),
        mode,
    })
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "project".into()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_one_line_mapping_and_key_value_mapping() {
        let workspace = tempdir().expect("workspace");
        let external = tempdir().expect("external");
        let mappings = workspace.path().join(LINKED_PROJECTS_DIR);
        fs::create_dir_all(&mappings).expect("mappings");

        fs::write(
            mappings.join("one-line.txt"),
            external.path().to_string_lossy().as_bytes(),
        )
        .expect("one line");
        fs::write(
            mappings.join("named.txt"),
            format!(
                "name=Named Project\npath={}\nmode=read-only\n",
                external.path().display()
            ),
        )
        .expect("named");

        let projects = list_linked_projects_for_root(workspace.path());
        assert_eq!(projects.len(), 2);
        assert!(projects.iter().any(|project| project.alias == "one-line"));
        assert!(projects
            .iter()
            .any(|project| project.name == "Named Project" && project.read_only()));
    }

    #[test]
    fn quick_add_never_overwrites_an_existing_mapping() {
        let workspace = tempdir().expect("workspace");
        let external = tempdir().expect("external");

        let first = quick_add_linked_project_for_root(
            workspace.path(),
            external.path(),
            Some("CoC Macro"),
        )
        .expect("first");
        let second = quick_add_linked_project_for_root(
            workspace.path(),
            external.path(),
            Some("CoC Macro"),
        )
        .expect("second");

        assert_eq!(first.alias, "coc-macro");
        assert_eq!(second.alias, "coc-macro-2");
    }
}
