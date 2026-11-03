use std::fs;
use std::io::{Read, Write};
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
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
        })
        .filter_map(|entry| parse_mapping_file(&entry.path()))
        .collect::<Vec<_>>();

    projects.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.alias.cmp(&b.alias))
    });
    projects
}

pub fn quick_add_linked_project_for_root(
    workspace_root: &Path,
    selected_path: &Path,
    requested_name: Option<&str>,
) -> AppResult<LinkedProject> {
    let mut mappings = MappingEdit::default();
    let project = mappings.add(workspace_root, selected_path, requested_name)?;
    if let Err(error) = mappings.apply() {
        return Err(mappings.rollback(error));
    }
    Ok(project)
}

fn prepare_linked_project(
    workspace_root: &Path,
    selected_path: &Path,
    requested_name: Option<&str>,
    reserved: &[MappingChange],
) -> AppResult<(LinkedProject, PathBuf, Vec<u8>)> {
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
        return Err(AppError::Message(
            "该目录已经是当前 Workspace 根目录".into(),
        ));
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

    if name.contains(['\r', '\n']) || friendly_path(&target).contains(['\r', '\n']) {
        return Err(AppError::Message(
            "Linked project names and paths cannot contain newlines".into(),
        ));
    }
    let base_alias = slugify(&name);
    let mappings_dir = root.join(LINKED_PROJECTS_DIR);
    let mut alias = base_alias.clone();
    let mut counter = 2usize;
    while mappings_dir.join(format!("{alias}.txt")).try_exists()?
        || reserved
            .iter()
            .any(|change| change.path == mappings_dir.join(format!("{alias}.txt")))
    {
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
    Ok((project, mapping_path, content.into_bytes()))
}

/// Unlinks `alias` from this workspace root by deleting its `.mcp-paths/<alias>.txt` mapping
/// record. Only the mapping record is removed; the linked folder itself is never touched.
/// Returns whether a mapping record was found.
pub fn remove_linked_project_mapping(workspace_root: &Path, alias: &str) -> AppResult<bool> {
    let mut mappings = MappingEdit::default();
    let removed = mappings.remove(workspace_root, alias)?;
    if let Err(error) = mappings.apply() {
        return Err(mappings.rollback(error));
    }
    Ok(removed)
}

fn mapping_paths(workspace_root: &Path, alias: &str) -> AppResult<Vec<PathBuf>> {
    let alias = alias.trim();
    if alias.is_empty() || alias.contains(['/', '\\']) || alias.chars().any(char::is_control) {
        return Err(AppError::Message("Linked project alias is invalid".into()));
    }
    let mappings_dir = workspace_root.join(LINKED_PROJECTS_DIR);
    let Ok(entries) = fs::read_dir(&mappings_dir) else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let is_mapping = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
            && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem.trim() == alias);
        if is_mapping {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

const MAX_MAPPING_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

struct MappingSnapshot {
    bytes: Vec<u8>,
    metadata: fs::Metadata,
}

struct MappingChange {
    path: PathBuf,
    before: Option<MappingSnapshot>,
    content: Vec<u8>,
    applied: bool,
    written: usize,
    version: Option<fs::Metadata>,
}

/// A failure journal for the editor's mapping files, retained until the profile save succeeds.
/// It does not provide crash recovery or serialize external mapping writers.
#[derive(Default)]
pub(crate) struct MappingEdit {
    changes: Vec<MappingChange>,
    snapshot_bytes: usize,
}

impl MappingEdit {
    pub(crate) fn add(
        &mut self,
        root: &Path,
        target: &Path,
        name: Option<&str>,
    ) -> AppResult<LinkedProject> {
        let (project, path, content) = prepare_linked_project(root, target, name, &self.changes)?;
        self.changes.push(MappingChange {
            path,
            before: None,
            content,
            applied: false,
            written: 0,
            version: None,
        });
        Ok(project)
    }

    pub(crate) fn remove(&mut self, root: &Path, alias: &str) -> AppResult<bool> {
        let paths = mapping_paths(root, alias)?;
        let found = !paths.is_empty();
        for path in paths {
            if self.changes.iter().any(|change| change.path == path) {
                continue;
            }
            let before =
                read_mapping_snapshot(&path, MAX_MAPPING_SNAPSHOT_BYTES - self.snapshot_bytes)?;
            self.snapshot_bytes += before.bytes.len();
            self.changes.push(MappingChange {
                path,
                before: Some(before),
                content: Vec::new(),
                applied: false,
                written: 0,
                version: None,
            });
        }
        Ok(found)
    }

    pub(crate) fn apply(&mut self) -> AppResult<()> {
        for change in &mut self.changes {
            if let Some(before) = &change.before {
                require_mapping_version(&change.path, &before.bytes, &before.metadata)?;
                fs::remove_file(&change.path)?;
                change.applied = true;
            } else {
                fs::create_dir_all(change.path.parent().expect("mapping parent"))?;
                // Reservation is atomic: never truncate an alias created since planning.
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&change.path)?;
                change.applied = true;
                let result = (|| -> std::io::Result<()> {
                    while change.written < change.content.len() {
                        match file.write(&change.content[change.written..]) {
                            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                            Ok(count) => change.written += count,
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    Ok(())
                })();
                // Keep the actual prefix, including when a later write fails.
                change.version = file.metadata().ok();
                result?;
                if change.version.is_none() {
                    return Err(AppError::Message(
                        "Could not identify the new mapping file".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub(crate) fn rollback(self, original: AppError) -> AppError {
        let mut failures = Vec::new();
        for change in self
            .changes
            .into_iter()
            .rev()
            .filter(|change| change.applied)
        {
            let result = (|| -> AppResult<()> {
                if let Some(before) = change.before {
                    // A foreign recreation wins; never overwrite it with our snapshot.
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&change.path)?;
                    file.write_all(&before.bytes)?;
                    file.set_permissions(before.metadata.permissions())?;
                } else {
                    let version = change
                        .version
                        .ok_or_else(|| AppError::Message("new file ownership is unknown".into()))?;
                    require_mapping_version(
                        &change.path,
                        &change.content[..change.written],
                        &version,
                    )?;
                    fs::remove_file(&change.path)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                failures.push(format!("{}: {error}", change.path.display()));
            }
        }
        if failures.is_empty() {
            original
        } else {
            AppError::Message(format!(
                "{original}; mapping rollback incomplete: {}; reload before retry",
                failures.join("; ")
            ))
        }
    }
}

fn read_mapping_snapshot(path: &Path, limit: usize) -> AppResult<MappingSnapshot> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(AppError::Message(
            "Mapping is no longer a regular file".into(),
        ));
    }
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > limit as u64 {
        return Err(AppError::Message(
            "Mapping rollback snapshot exceeds 8 MiB".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(AppError::Message(
            "Mapping rollback snapshot exceeds 8 MiB".into(),
        ));
    }
    Ok(MappingSnapshot { bytes, metadata })
}

fn require_mapping_version(path: &Path, bytes: &[u8], metadata: &fs::Metadata) -> AppResult<()> {
    let current = read_mapping_snapshot(path, bytes.len())?;
    let same = current.bytes == bytes
        && current.metadata.len() == metadata.len()
        && current.metadata.modified().ok() == metadata.modified().ok()
        && current.metadata.created().ok() == metadata.created().ok()
        && current.metadata.permissions().readonly() == metadata.permissions().readonly();
    #[cfg(unix)]
    let same = {
        use std::os::unix::fs::MetadataExt;
        same && current.metadata.dev() == metadata.dev()
            && current.metadata.ino() == metadata.ino()
            && current.metadata.mode() == metadata.mode()
    };
    if !same {
        return Err(AppError::Message(
            "Mapping changed concurrently; preserving its current contents".into(),
        ));
    }
    Ok(())
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

    fn mapping_fixture() -> tempfile::TempDir {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/linked-mapping-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    #[test]
    fn mapping_edit_rolls_back_first_add_when_later_creation_fails() {
        let fixture = mapping_fixture();
        let root = fixture.path().join("root");
        let target = fixture.path().join("target");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&target).unwrap();
        let mut mappings = MappingEdit::default();
        mappings.add(&root, &target, Some("first")).unwrap();
        mappings.add(&root, &target, Some("second")).unwrap();
        let directory = root.join(LINKED_PROJECTS_DIR);
        // A real IO failure after the first creation, with no injected writer.
        fs::create_dir_all(directory.join("second.txt")).unwrap();
        let error = mappings.apply().unwrap_err();
        let error = mappings.rollback(error).to_string();
        assert!(!error.contains("rollback incomplete"), "{error}");
        assert!(!directory.join("first.txt").exists());
        assert!(directory.join("second.txt").is_dir());
        assert!(target.is_dir());
    }

    #[test]
    fn mapping_edit_preserves_foreign_records_during_rollback() {
        let fixture = mapping_fixture();
        let target = fixture.path().join("target");
        fs::create_dir(&target).unwrap();
        let existing =
            quick_add_linked_project_for_root(fixture.path(), &target, Some("old")).unwrap();
        let directory = fixture.path().join(LINKED_PROJECTS_DIR);
        let mut mappings = MappingEdit::default();
        mappings.add(fixture.path(), &target, Some("new")).unwrap();
        mappings.remove(fixture.path(), &existing.alias).unwrap();
        mappings.apply().unwrap();
        fs::write(directory.join("old.txt"), b"foreign recreated record").unwrap();
        fs::write(directory.join("new.txt"), b"foreign changed record").unwrap();
        let error = mappings
            .rollback(AppError::Message("profile save failed".into()))
            .to_string();
        assert!(error.contains("profile save failed"), "{error}");
        assert!(error.contains("rollback incomplete"), "{error}");
        assert!(error.contains("reload before retry"), "{error}");
        assert_eq!(
            fs::read(directory.join("old.txt")).unwrap(),
            b"foreign recreated record"
        );
        assert_eq!(
            fs::read(directory.join("new.txt")).unwrap(),
            b"foreign changed record"
        );
    }

    #[test]
    fn mapping_edit_restores_exact_bytes_and_permissions() {
        let fixture = mapping_fixture();
        let directory = fixture.path().join(LINKED_PROJECTS_DIR);
        fs::create_dir(&directory).unwrap();
        let path = directory.join(" custom.TXT");
        let bytes = b"# keep this comment\r\nmode=read-only\r\npath=unchanged\r\n";
        fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        }
        let permissions = fs::metadata(&path).unwrap().permissions();
        let mut mappings = MappingEdit::default();
        mappings.remove(fixture.path(), "custom").unwrap();
        mappings.apply().unwrap();
        assert!(!path.exists());
        let error = mappings.rollback(AppError::Message("save failed".into()));
        assert_eq!(error.to_string(), "save failed");
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().readonly(),
            permissions.readonly()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode(),
                permissions.mode()
            );
        }
    }

    #[test]
    fn mapping_edit_rejects_oversized_snapshot_before_writing() {
        let fixture = mapping_fixture();
        let directory = fixture.path().join(LINKED_PROJECTS_DIR);
        fs::create_dir(&directory).unwrap();
        let path = directory.join("large.txt");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_MAPPING_SNAPSHOT_BYTES as u64 + 1)
            .unwrap();
        let mut mappings = MappingEdit::default();
        assert!(mappings.remove(fixture.path(), "large").is_err());
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            MAX_MAPPING_SNAPSHOT_BYTES as u64 + 1
        );
    }

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

        let first =
            quick_add_linked_project_for_root(workspace.path(), external.path(), Some("CoC Macro"))
                .expect("first");
        let second =
            quick_add_linked_project_for_root(workspace.path(), external.path(), Some("CoC Macro"))
                .expect("second");

        assert_eq!(first.alias, "coc-macro");
        assert_eq!(second.alias, "coc-macro-2");
    }
}
