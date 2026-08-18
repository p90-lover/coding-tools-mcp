use std::error::Error;
use std::fs;
use std::path::Path;

fn replace_exact(
    text: &mut String,
    before: &str,
    after: &str,
    expected: usize,
    label: &str,
) -> Result<(), Box<dyn Error>> {
    let before_count = text.matches(before).count();
    let after_count = text.matches(after).count();

    if before_count == 0 && after_count >= expected {
        println!("already applied: {label}");
        return Ok(());
    }
    if before_count != expected {
        return Err(format!(
            "{label}: expected {expected} source match(es), found {before_count}; already-applied matches={after_count}"
        )
        .into());
    }

    *text = text.replace(before, after);
    println!("applied: {label}");
    Ok(())
}

fn patch_file(
    path: &str,
    patch: impl FnOnce(&mut String) -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let path = Path::new(path);
    let original = fs::read_to_string(path)?;
    let used_crlf = original.contains("\r\n");
    let mut normalized = original.replace("\r\n", "\n");

    patch(&mut normalized)?;

    let output = if used_crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    if output != original {
        fs::write(path, output)?;
        println!("updated {}", path.display());
    } else {
        println!("unchanged {}", path.display());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    patch_file("src-tauri/src/commands/ui_memory.rs", |text| {
        replace_exact(
            text,
            r#"fn bytes_to_mb(bytes: u64) -> f64 {
    (bytes as f64) / (1024.0 * 1024.0)
}"#,
            r#"#[cfg(windows)]
fn bytes_to_mb(bytes: u64) -> f64 {
    (bytes as f64) / (1024.0 * 1024.0)
}"#,
            1,
            "gate bytes_to_mb to Windows",
        )?;
        replace_exact(
            text,
            r#"    let outer_position = window
        .outer_position()
        .ok()
        .filter(|pos| is_sane_position(pos));
    let outer_size = window.outer_size().ok().filter(|size| is_sane_size(size));"#,
            r#"    let outer_position = window
        .outer_position()
        .ok()
        .filter(is_sane_position);
    let outer_size = window.outer_size().ok().filter(is_sane_size);"#,
            1,
            "remove redundant UI-memory closures",
        )
    })?;

    patch_file("src-tauri/src/tools/project_context.rs", |text| {
        replace_exact(
            text,
            r#"        let (alias, rest) = alias_path
            .split_once('/')
            .map(|(alias, rest)| (alias, rest))
            .unwrap_or((alias_path, ""));"#,
            r#"        let (alias, rest) = alias_path
            .split_once('/')
            .unwrap_or((alias_path, ""));"#,
            1,
            "remove project-context identity map",
        )
    })?;

    patch_file("src-tauri/src/tools/workspace.rs", |text| {
        replace_exact(
            text,
            r#"    fn canonical_existing_ancestor(path: &Path) -> Option<PathBuf> {
        let mut cursor = path;
        loop {
            if cursor.exists() || cursor.is_symlink() {
                return cursor.canonicalize().ok();
            }
            cursor = cursor.parent()?;
        }
    }"#,
            r#"    fn normalize_path_from_existing_ancestor(path: &Path) -> PathBuf {
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
    }"#,
            1,
            "normalize non-existing paths from their canonical ancestor",
        )?;
        replace_exact(
            text,
            r#"        let probe = Self::canonical_existing_ancestor(path)
            .unwrap_or_else(|| path.to_path_buf());"#,
            r#"        let probe = Self::normalize_path_from_existing_ancestor(path);"#,
            2,
            "use normalized linked-root probes",
        )?;
        replace_exact(
            text,
            r#"            let (alias, rest) = alias_path
                .split_once('/')
                .map(|(alias, rest)| (alias, rest))
                .unwrap_or((alias_path, ""));"#,
            r#"            let (alias, rest) = alias_path
                .split_once('/')
                .unwrap_or((alias_path, ""));"#,
            1,
            "remove workspace identity map",
        )?;
        replace_exact(
            text,
            r#"        let input = Path::new(raw_path);
        if input.is_absolute() {
            return Ok((
                input.to_path_buf(),
                self.linked_project_containing_path(input),
            ));
        }"#,
            r#"        let input = Path::new(raw_path);
        if input.is_absolute() {
            let candidate = Self::normalize_path_from_existing_ancestor(input);
            let project = self.linked_project_containing_path(&candidate);
            return Ok((candidate, project));
        }"#,
            1,
            "normalize absolute linked-project candidates",
        )?;
        replace_exact(
            text,
            r#"        if let Some(project) = self.linked_project_containing_path(path) {
            let root = project.root_path();
            let suffix = path
                .strip_prefix(&root)
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();"#,
            r#"        if let Some(project) = self.linked_project_containing_path(path) {
            let root = project
                .root_path()
                .canonicalize()
                .unwrap_or_else(|_| project.root_path());
            let normalized = Self::normalize_path_from_existing_ancestor(path);
            let suffix = normalized
                .strip_prefix(&root)
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();"#,
            1,
            "display linked paths from canonical roots",
        )?;
        replace_exact(
            text,
            r#"        let root = self
            .allowed_root_for_path(&candidate)
            .ok_or_else(WorkspaceError::path_outside_workspace)?;
        let relative = candidate
            .strip_prefix(root)
            .map_err(|_| WorkspaceError::path_outside_workspace())?;"#,
            r#"        let candidate = Self::normalize_path_from_existing_ancestor(&candidate);
        let root = self
            .allowed_root_for_path(&candidate)
            .ok_or_else(WorkspaceError::path_outside_workspace)?;
        let relative = candidate
            .strip_prefix(root)
            .map_err(|_| WorkspaceError::path_outside_workspace())?;"#,
            1,
            "normalize protected-write candidates before root stripping",
        )?;
        replace_exact(
            text,
            r#"#[cfg(test)]
mod linked_root_tests {"#,
            r#"#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod linked_root_tests {"#,
            1,
            "scope the existing test-module layout lint",
        )?;
        replace_exact(
            text,
            r#"        let ws = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
        assert!(ws.resolve_existing("@coc-macro/existing.txt").is_ok());
        assert!(ws
            .resolve_for_write(
                external
                    .path()
                    .join("new.txt")
                    .to_string_lossy()
                    .as_ref()
            )
            .is_ok());"#,
            r#"        let ws = Workspace::new(workspace.path().to_path_buf()).expect("workspace");
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
            .expect("linked display passes protected-path preflight");"#,
            1,
            "strengthen cross-platform linked-root regression coverage",
        )
    })?;

    Ok(())
}
