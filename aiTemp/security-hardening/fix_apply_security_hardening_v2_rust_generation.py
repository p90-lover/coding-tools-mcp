from __future__ import annotations

import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
TARGET_RELATIVE = Path("aiTemp/security-hardening/apply_security_hardening_v2.py")
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "security-hardening-v2-rust-generation-fix"
    / str(time.time_ns())
)

NEW_HARDEN_PATCH_DELETION = r'''def harden_patch_deletion(text: str) -> str:
    production, separator, tests = text.partition("#[cfg(test)]")
    if "fn move_to_trash(" not in production:
        root_expression = workspace_root_expression(production)
        helper = '''
fn move_to_trash(
    workspace_root: impl AsRef<std::path::Path>,
    target: impl AsRef<std::path::Path>,
) -> std::io::Result<std::path::PathBuf> {
    let workspace_root = workspace_root.as_ref();
    let target = target.as_ref();
    let relative = target.strip_prefix(workspace_root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move a path outside the workspace",
        )
    })?;
    if relative.as_os_str().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move the workspace root",
        ));
    }
    if relative.starts_with(std::path::Path::new("aiTemp").join("Trash")) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move an existing Trash item again",
        ));
    }
    let metadata = std::fs::symlink_metadata(target)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing to move a symbolic link",
        ));
    }
    let destination = workspace_root
        .join("aiTemp")
        .join("Trash")
        .join("deleted-files")
        .join(uuid::Uuid::new_v4().to_string())
        .join(relative);
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid Trash destination")
    })?;
    std::fs::create_dir_all(parent)?;
    std::fs::rename(target, &destination)?;
    Ok(destination)
}

'''
        marker_match = re.search(r"(?m)^(?:pub\s+)?fn\s+", production)
        if not marker_match:
            raise RuntimeError("patch.rs has no function marker for Trash helper insertion")
        production = production[: marker_match.start()] + helper + production[marker_match.start() :]

        def replace_required(before: str, after: str, label: str, expected: int = 1) -> None:
            nonlocal production
            count = production.count(before)
            if count != expected:
                raise RuntimeError(f"{label}: expected {expected} source matches, found {count}")
            production = production.replace(before, after, expected)

        replace_required(
            '''    let mut backups: HashMap<PathBuf, Option<Vec<u8>>> = HashMap::new();
    let mut temporary_files = HashMap::new();
''',
            f'''    let mut backups: HashMap<PathBuf, Option<Vec<u8>>> = HashMap::new();
    let mut temporary_files = HashMap::new();
    let staging_root = {root_expression}
        .join("aiTemp")
        .join("staging")
        .join(Uuid::new_v4().simple().to_string());
''',
            "create transaction staging root under aiTemp",
        )

        replace_required(
            '''        if let Some(bytes) = content {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;
            }
            let temp = path.with_file_name(format!(
                ".{}.harness-stage-{}",
                path.file_name().and_then(|v| v.to_str()).unwrap_or("file"),
                Uuid::new_v4().simple()
            ));
            if let Err(err) = fs::write(&temp, bytes) {
                cleanup_temporary_files(temporary_files.values());
                restore_backups(&backups);
                return Err(patch_failed(format!("Failed to stage file: {err}")));
            }
            temporary_files.insert(path.clone(), temp);
        }
''',
            '''        if let Some(bytes) = content {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;
            }
            let relative = path.strip_prefix(ws.root()).map_err(|_| {
                patch_failed("Refusing to stage a path outside the workspace")
            })?;
            let temp = staging_root.join(relative);
            if let Some(parent) = temp.parent() {
                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;
            }
            if let Err(err) = fs::write(&temp, bytes) {
                cleanup_staging_root(ws.root(), &staging_root);
                return Err(patch_failed(format!("Failed to stage file: {err}")));
            }
            temporary_files.insert(path.clone(), temp);
        }
''',
            "stage patch payloads only under aiTemp",
        )

        replace_required(
            '''                Ok(temp) => replace_file(&temp, &path),
''',
            f'''                Ok(temp) => replace_file({root_expression}, &temp, &path),
''',
            "pass workspace root to replacement",
        )

        replace_required(
            '''        } else if path.exists() && path.is_file() {
            fs::remove_file(&path)
        } else {
            Ok(())
        };
''',
            f'''        }} else if path.exists() && path.is_file() {{
            move_to_trash({root_expression}, &path).map(|_| ())
        }} else {{
            Ok(())
        }};
''',
            "move requested deletions into Trash",
        )

        replace_required(
            '''        if let Err(err) = result {
            cleanup_temporary_files(temporary_files.values());
            restore_backups(&backups);
            return Err(patch_failed(format!("Failed to write file: {err}")));
        }
    }
    cleanup_temporary_files(temporary_files.values());
''',
            f'''        if let Err(err) = result {{
            cleanup_staging_root({root_expression}, &staging_root);
            let rollback_error = restore_backups({root_expression}, &backups)
                .err()
                .map(|value| value.to_string());
            let message = match rollback_error {{
                Some(rollback) => format!(
                    "Failed to write file: {{err}}; rollback also failed: {{rollback}}"
                ),
                None => format!("Failed to write file: {{err}}"),
            }};
            return Err(patch_failed(message));
        }}
    }}
    cleanup_staging_root({root_expression}, &staging_root);
''',
            "make commit rollback root-aware and recoverable",
        )

        replace_required(
            '''fn restore_backups(backups: &HashMap<PathBuf, Option<Vec<u8>>>) {
    for (path, data) in backups {
        match data {
            None => {
                let _ = fs::remove_file(path);
            }
            Some(bytes) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(path, bytes);
            }
        }
    }
}
''',
            '''fn restore_backups(
    workspace_root: &std::path::Path,
    backups: &HashMap<PathBuf, Option<Vec<u8>>>,
) -> std::io::Result<()> {
    let mut first_error = None;
    for (path, data) in backups {
        let result = match data {
            None => {
                if path.exists() {
                    move_to_trash(workspace_root, path).map(|_| ())
                } else {
                    Ok(())
                }
            }
            Some(bytes) => (|| {
                if path.exists() {
                    move_to_trash(workspace_root, path)?;
                }
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(path, bytes)
            })(),
        };
        if let Err(error) = result {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
''',
            "restore transaction backups without overwriting recoverable data",
        )

        replace_required(
            '''fn replace_file(temp: &PathBuf, path: &PathBuf) -> Result<(), std::io::Error> {
    #[cfg(windows)]
    {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    fs::rename(temp, path)
}
''',
            '''fn replace_file(
    workspace_root: &std::path::Path,
    temp: &PathBuf,
    path: &PathBuf,
) -> Result<(), std::io::Error> {
    if path.exists() {
        move_to_trash(workspace_root, path)?;
    }
    fs::rename(temp, path)
}
''',
            "preserve replaced file versions on every platform",
        )

        replace_required(
            '''fn cleanup_temporary_files<'a>(paths: impl Iterator<Item = &'a PathBuf>) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}
''',
            '''fn cleanup_staging_root(
    workspace_root: &std::path::Path,
    staging_root: &std::path::Path,
) {
    if staging_root.exists() {
        let _ = move_to_trash(workspace_root, staging_root);
    }
}
''',
            "move transaction staging into Trash instead of deleting it",
        )

        if re.search(r"(?:std::)?fs::remove_file", production):
            raise RuntimeError("permanent file deletion remains in patch.rs production source")
        if "cleanup_temporary_files" in production:
            raise RuntimeError("legacy temporary-file deletion helper remains")

    result = production + (separator + tests if separator else "")
    trash_test = '''
    #[test]
    fn move_to_trash_preserves_content() {
        let root = tempfile::tempdir().expect("workspace");
        let target = root.path().join("notes.txt");
        std::fs::write(&target, "preserve me").expect("write fixture");
        let destination = move_to_trash(root.path(), &target).expect("move to Trash");
        assert!(!target.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read Trash copy"),
            "preserve me"
        );
        assert!(destination.starts_with(root.path().join("aiTemp").join("Trash")));
    }

'''
    if "fn move_to_trash_preserves_content()" not in result:
        if not separator:
            raise RuntimeError("patch.rs has no test module")
        test_marker = re.search(r"(?m)^\s*#\[test\]\s*$", result[result.index(separator) :])
        if not test_marker:
            raise RuntimeError("patch.rs test module has no test marker")
        absolute = result.index(separator) + test_marker.start()
        result = result[:absolute] + trash_test + result[absolute:]
    return result
'''


def checked_target() -> Path:
    if TARGET_RELATIVE.is_absolute() or ".." in TARGET_RELATIVE.parts:
        raise RuntimeError("unsafe applicator path")
    candidate = ROOT / TARGET_RELATIVE
    if candidate.is_symlink():
        raise RuntimeError("refusing to modify a symlinked applicator")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError("applicator is missing or escapes the repository") from error
    if not resolved.is_file():
        raise RuntimeError("applicator is not a regular file")
    return resolved


def main() -> None:
    target = checked_target()
    text = target.read_text(encoding="utf-8")
    original = text

    old_timeout = "TimeoutLayer::new(Duration::from_secs(120))"
    new_timeout = '''TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    Duration::from_secs(120),
                )'''
    old_count = text.count(old_timeout)
    new_count = text.count(new_timeout)
    if old_count == 2:
        text = text.replace(old_timeout, new_timeout)
    elif old_count == 0 and new_count == 2:
        print("listener timeout generation fix is already applied")
    else:
        raise RuntimeError(
            f"unexpected listener timeout source state: old={old_count}, new={new_count}"
        )

    start_marker = "def harden_patch_deletion(text: str) -> str:\n"
    end_marker = "\n\nCONTRACT_TEST = r'''"
    if "cleanup_staging_root" not in text:
        start = text.find(start_marker)
        end = text.find(end_marker, start)
        if start < 0 or end < 0:
            raise RuntimeError("unable to locate the reviewed patch-deletion generator")
        text = text[:start] + NEW_HARDEN_PATCH_DELETION + text[end:]
    else:
        print("transactional patch generation fix is already applied")

    if text == original:
        print("Rust generation fixes are already applied")
        return

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text, encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    required = (
        "TimeoutLayer::with_status_code(",
        "cleanup_staging_root",
        '.join("staging")',
        "restore_backups({root_expression}, &backups)",
        "move_to_trash({root_expression}, &path).map(|_| ())",
    )
    for marker in required:
        if marker not in verified:
            raise RuntimeError(f"Rust generation fix verification is missing: {marker}")
    if old_timeout in verified:
        raise RuntimeError("deprecated timeout generation remains")
    if "remove_pattern = re.compile" in verified:
        raise RuntimeError("broad permanent-deletion regex remains")
    print("applied reviewed Rust generation fixes with recoverable backup")


if __name__ == "__main__":
    main()
