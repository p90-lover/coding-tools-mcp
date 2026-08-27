from __future__ import annotations

import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "security-hardening"
    / "trash-boundary-completion"
    / str(time.time_ns())
)


def checked_file(path: str) -> Path:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe source path: {path}")
    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {path}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"source path is missing or escapes the repository: {path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"source path is not a regular file: {path}")
    return resolved


def replace_once(path: str, before: str, after: str, label: str) -> None:
    target = checked_file(path)
    text = target.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {label}")
        return
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    backup = BACKUP_ROOT / Path(path)
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


def append_once(path: str, addition: str, sentinel: str, label: str) -> None:
    target = checked_file(path)
    text = target.read_text(encoding="utf-8")
    if sentinel in text:
        print(f"already applied: {label}")
        return
    backup = BACKUP_ROOT / Path(path)
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n", encoding="utf-8")
    print(f"applied: {label}")


replace_once(
    "src-tauri/src/tools/trash.rs",
    '''    let trash_root = root.join("aiTemp").join("Trash");
    if canonical.starts_with(&trash_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to recursively move recovery Trash",
        ));
    }
    let relative = canonical.strip_prefix(&root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "source escaped its recovery root",
        )
    })?;
''',
    '''    let trash_root = root.join("aiTemp").join("Trash");
    if canonical.starts_with(&trash_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to recursively move recovery Trash",
        ));
    }
    if trash_root.starts_with(&canonical) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to move a parent of recovery Trash",
        ));
    }
    let relative = canonical.strip_prefix(&root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "source escaped its recovery root",
        )
    })?;
    if relative.components().next().is_some_and(|component| {
        component.as_os_str() == std::ffi::OsStr::new(".git")
    }) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to move Git internals into recovery Trash",
        ));
    }
''',
    "protect recovery Trash parents and Git internals",
)

replace_once(
    "src-tauri/src/tools/trash.rs",
    '''    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "recovery destination has no parent")
    })?;
    fs::create_dir_all(parent)?;
    fs::rename(&canonical, destination)
}

fn recovery_root(source: &Path) -> io::Result<PathBuf> {
''',
    '''    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "recovery destination has no parent")
    })?;
    ensure_no_symlink_components(&root, parent)?;
    fs::create_dir_all(parent)?;
    let resolved_parent = parent.canonicalize()?;
    if !resolved_parent.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "recovery destination escaped the workspace",
        ));
    }
    fs::rename(&canonical, destination)
}

fn ensure_no_symlink_components(root: &Path, destination: &Path) -> io::Result<()> {
    let relative = destination.strip_prefix(root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "recovery destination is outside the workspace",
        )
    })?;
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "recovery destination contains a symlink",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn recovery_root(source: &Path) -> io::Result<PathBuf> {
''',
    "reject symlinked or escaping recovery destinations",
)

append_once(
    "src-tauri/src/tools/trash.rs",
    r'''
#[cfg(test)]
mod boundary_completion_tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "coding-tools-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn git_internal_file_is_rejected_even_without_policy_layer() {
        let workspace = root("trash-git-internal");
        fs::create_dir_all(workspace.join(".git")).expect("git directory");
        let config = workspace.join(".git").join("config");
        fs::write(&config, "protected").expect("fixture");

        let error = move_file_to_recovery_trash(&config).expect_err("Git internals must fail");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(config).expect("still present"), "protected");
    }

    #[test]
    fn ai_temp_parent_of_trash_is_rejected() {
        let workspace = root("trash-parent");
        fs::create_dir_all(workspace.join(".git")).expect("git directory");
        let ai_temp = workspace.join("aiTemp");
        fs::create_dir_all(&ai_temp).expect("aiTemp fixture");
        fs::write(ai_temp.join("artifact.txt"), "preserve").expect("fixture");

        let error = move_dir_to_recovery_trash(&ai_temp).expect_err("aiTemp must fail");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(ai_temp.join("artifact.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_ai_temp_destination_is_rejected() {
        use std::os::unix::fs::symlink;

        let workspace = root("trash-destination-symlink");
        let outside = root("trash-destination-outside");
        fs::create_dir_all(workspace.join(".git")).expect("git directory");
        fs::create_dir_all(&outside).expect("outside directory");
        symlink(&outside, workspace.join("aiTemp")).expect("aiTemp symlink");
        let source = workspace.join("notes.txt");
        fs::write(&source, "preserve").expect("fixture");

        let error = move_file_to_recovery_trash(&source).expect_err("symlink must fail");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(source.exists());
        assert!(fs::read_dir(outside).expect("outside remains readable").next().is_none());
    }
}
''',
    "mod boundary_completion_tests",
    "test independent Trash boundary defenses",
)


def verify() -> None:
    text = checked_file("src-tauri/src/tools/trash.rs").read_text(encoding="utf-8")
    required = (
        "trash_root.starts_with(&canonical)",
        "refusing to move Git internals into recovery Trash",
        "fn ensure_no_symlink_components(",
        "recovery destination escaped the workspace",
        "mod boundary_completion_tests",
    )
    missing = [item for item in required if item not in text]
    if missing:
        raise RuntimeError(f"Trash boundary completion failed: {missing}")


verify()
print("recoverable Trash boundary completion applied successfully")
