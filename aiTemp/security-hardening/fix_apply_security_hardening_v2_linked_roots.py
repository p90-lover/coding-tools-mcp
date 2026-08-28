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
    / "security-hardening-v2-linked-root-fix"
    / str(time.time_ns())
)

NEW_HARDEN_PATCH_DELETION = 'def harden_patch_deletion(text: str) -> str:\n    production, separator, tests = text.partition("#[cfg(test)]")\n    if "fn move_to_trash(" not in production:\n        helper = \'\'\'\nfn approved_storage_root(\n    ws: &Workspace,\n    display: &str,\n    target: &std::path::Path,\n) -> Result<PathBuf, WorkspaceError> {\n    if target.starts_with(ws.root()) {\n        return Ok(ws.root().to_path_buf());\n    }\n    let alias = display\n        .strip_prefix(\'@\')\n        .and_then(|value| value.split(\'/\').next())\n        .filter(|value| !value.is_empty())\n        .ok_or_else(WorkspaceError::path_outside_workspace)?;\n    let project = ws\n        .linked_projects()\n        .into_iter()\n        .find(|value| value.alias.eq_ignore_ascii_case(alias))\n        .ok_or_else(WorkspaceError::path_outside_workspace)?;\n    if project.read_only() {\n        return Err(WorkspaceError::Tool {\n            code: "READ_ONLY_LINKED_PROJECT",\n            message: format!("Linked project is read-only: {display}"),\n            category: "permission",\n            retryable: false,\n        });\n    }\n    let root = project\n        .root_path()\n        .canonicalize()\n        .map_err(|_| WorkspaceError::path_outside_workspace())?;\n    if !target.starts_with(&root) {\n        return Err(WorkspaceError::path_outside_workspace());\n    }\n    Ok(root)\n}\n\nfn move_to_trash(\n    storage_root: impl AsRef<std::path::Path>,\n    target: impl AsRef<std::path::Path>,\n) -> std::io::Result<std::path::PathBuf> {\n    let storage_root = storage_root.as_ref();\n    let target = target.as_ref();\n    let relative = target.strip_prefix(storage_root).map_err(|_| {\n        std::io::Error::new(\n            std::io::ErrorKind::PermissionDenied,\n            "refusing to move a path outside its approved storage root",\n        )\n    })?;\n    if relative.as_os_str().is_empty() {\n        return Err(std::io::Error::new(\n            std::io::ErrorKind::PermissionDenied,\n            "refusing to move an approved storage root",\n        ));\n    }\n    if relative.starts_with(std::path::Path::new("aiTemp").join("Trash")) {\n        return Err(std::io::Error::new(\n            std::io::ErrorKind::PermissionDenied,\n            "refusing to move an existing Trash item again",\n        ));\n    }\n    let metadata = std::fs::symlink_metadata(target)?;\n    if metadata.file_type().is_symlink() {\n        return Err(std::io::Error::new(\n            std::io::ErrorKind::PermissionDenied,\n            "refusing to move a symbolic link",\n        ));\n    }\n    let destination = storage_root\n        .join("aiTemp")\n        .join("Trash")\n        .join("deleted-files")\n        .join(uuid::Uuid::new_v4().to_string())\n        .join(relative);\n    let parent = destination.parent().ok_or_else(|| {\n        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid Trash destination")\n    })?;\n    std::fs::create_dir_all(parent)?;\n    std::fs::rename(target, &destination)?;\n    Ok(destination)\n}\n\n\'\'\'\n        marker_match = re.search(r"(?m)^(?:pub\\s+)?fn\\s+", production)\n        if not marker_match:\n            raise RuntimeError("patch.rs has no function marker for Trash helper insertion")\n        production = production[: marker_match.start()] + helper + production[marker_match.start() :]\n\n        def replace_required(before: str, after: str, label: str, expected: int = 1) -> None:\n            nonlocal production\n            count = production.count(before)\n            if count != expected:\n                raise RuntimeError(f"{label}: expected {expected} source matches, found {count}")\n            production = production.replace(before, after, expected)\n\n        replace_required(\n            \'\'\'    let mut backups: HashMap<PathBuf, Option<Vec<u8>>> = HashMap::new();\n    let mut temporary_files = HashMap::new();\n\'\'\',\n            \'\'\'    let mut backups: HashMap<PathBuf, Option<Vec<u8>>> = HashMap::new();\n    let mut temporary_files = HashMap::new();\n    let transaction_id = Uuid::new_v4().simple().to_string();\n    let mut staging_roots: HashMap<PathBuf, PathBuf> = HashMap::new();\n\'\'\',\n            "create one transaction ID and root-aware staging registry",\n        )\n\n        replace_required(\n            \'\'\'        if let Some(bytes) = content {\n            if let Some(parent) = path.parent() {\n                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;\n            }\n            let temp = path.with_file_name(format!(\n                ".{}.harness-stage-{}",\n                path.file_name().and_then(|v| v.to_str()).unwrap_or("file"),\n                Uuid::new_v4().simple()\n            ));\n            if let Err(err) = fs::write(&temp, bytes) {\n                cleanup_temporary_files(temporary_files.values());\n                restore_backups(&backups);\n                return Err(patch_failed(format!("Failed to stage file: {err}")));\n            }\n            temporary_files.insert(path.clone(), temp);\n        }\n\'\'\',\n            \'\'\'        if let Some(bytes) = content {\n            if let Some(parent) = path.parent() {\n                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;\n            }\n            let storage_root = approved_storage_root(ws, &resolved.display, &path)?;\n            let relative = path.strip_prefix(&storage_root).map_err(|_| {\n                patch_failed("Refusing to stage a path outside its approved storage root")\n            })?;\n            let staging_root = storage_root\n                .join("aiTemp")\n                .join("staging")\n                .join(&transaction_id);\n            let temp = staging_root.join(relative);\n            if let Some(parent) = temp.parent() {\n                fs::create_dir_all(parent).map_err(|err| patch_failed(err.to_string()))?;\n            }\n            staging_roots.insert(staging_root.clone(), storage_root.clone());\n            if let Err(err) = fs::write(&temp, bytes) {\n                cleanup_staging_roots(&staging_roots);\n                return Err(patch_failed(format!("Failed to stage file: {err}")));\n            }\n            temporary_files.insert(path.clone(), temp);\n        }\n\'\'\',\n            "stage each payload under its approved root",\n        )\n\n        replace_required(\n            \'\'\'        let path = resolved.path;\n        let result = if content.is_some() {\n\'\'\',\n            \'\'\'        let path = resolved.path;\n        let storage_root = approved_storage_root(ws, &resolved.display, &path)?;\n        let result = if content.is_some() {\n\'\'\',\n            "resolve the approved storage root before commit",\n        )\n\n        replace_required(\n            \'\'\'                Ok(temp) => replace_file(&temp, &path),\n\'\'\',\n            \'\'\'                Ok(temp) => replace_file(&storage_root, &temp, &path),\n\'\'\',\n            "replace from same-root staging",\n        )\n\n        replace_required(\n            \'\'\'        } else if path.exists() && path.is_file() {\n            fs::remove_file(&path)\n        } else {\n            Ok(())\n        };\n\'\'\',\n            \'\'\'        } else if path.exists() && path.is_file() {\n            move_to_trash(&storage_root, &path).map(|_| ())\n        } else {\n            Ok(())\n        };\n\'\'\',\n            "move requested deletions into the target root Trash",\n        )\n\n        replace_required(\n            \'\'\'        if let Err(err) = result {\n            cleanup_temporary_files(temporary_files.values());\n            restore_backups(&backups);\n            return Err(patch_failed(format!("Failed to write file: {err}")));\n        }\n    }\n    cleanup_temporary_files(temporary_files.values());\n\'\'\',\n            \'\'\'        if let Err(err) = result {\n            cleanup_staging_roots(&staging_roots);\n            let rollback_error = restore_backups(ws, &backups)\n                .err()\n                .map(|value| value.to_string());\n            let message = match rollback_error {\n                Some(rollback) => format!(\n                    "Failed to write file: {err}; rollback also failed: {rollback}"\n                ),\n                None => format!("Failed to write file: {err}"),\n            };\n            return Err(patch_failed(message));\n        }\n    }\n    cleanup_staging_roots(&staging_roots);\n\'\'\',\n            "make root-aware rollback recoverable",\n        )\n\n        replace_required(\n            \'\'\'fn restore_backups(backups: &HashMap<PathBuf, Option<Vec<u8>>>) {\n    for (path, data) in backups {\n        match data {\n            None => {\n                let _ = fs::remove_file(path);\n            }\n            Some(bytes) => {\n                if let Some(parent) = path.parent() {\n                    let _ = fs::create_dir_all(parent);\n                }\n                let _ = fs::write(path, bytes);\n            }\n        }\n    }\n}\n\'\'\',\n            \'\'\'fn restore_backups(\n    ws: &Workspace,\n    backups: &HashMap<PathBuf, Option<Vec<u8>>>,\n) -> std::io::Result<()> {\n    let mut first_error = None;\n    for (path, data) in backups {\n        let result = (|| -> std::io::Result<()> {\n            let display = ws.display_path(path);\n            let storage_root = approved_storage_root(ws, &display, path).map_err(|error| {\n                std::io::Error::new(std::io::ErrorKind::PermissionDenied, error.to_string())\n            })?;\n            match data {\n                None => {\n                    if path.exists() {\n                        move_to_trash(&storage_root, path).map(|_| ())\n                    } else {\n                        Ok(())\n                    }\n                }\n                Some(bytes) => {\n                    if path.exists() {\n                        move_to_trash(&storage_root, path)?;\n                    }\n                    if let Some(parent) = path.parent() {\n                        fs::create_dir_all(parent)?;\n                    }\n                    fs::write(path, bytes)\n                }\n            }\n        })();\n        if let Err(error) = result {\n            if first_error.is_none() {\n                first_error = Some(error);\n            }\n        }\n    }\n    match first_error {\n        Some(error) => Err(error),\n        None => Ok(()),\n    }\n}\n\'\'\',\n            "restore backups in each approved root without overwriting recoverable data",\n        )\n\n        replace_required(\n            \'\'\'fn replace_file(temp: &PathBuf, path: &PathBuf) -> Result<(), std::io::Error> {\n    #[cfg(windows)]\n    {\n        if path.exists() {\n            fs::remove_file(path)?;\n        }\n    }\n    fs::rename(temp, path)\n}\n\'\'\',\n            \'\'\'fn replace_file(\n    storage_root: &std::path::Path,\n    temp: &PathBuf,\n    path: &PathBuf,\n) -> Result<(), std::io::Error> {\n    if path.exists() {\n        move_to_trash(storage_root, path)?;\n    }\n    fs::rename(temp, path)\n}\n\'\'\',\n            "preserve replaced versions under the approved root",\n        )\n\n        replace_required(\n            \'\'\'fn cleanup_temporary_files<\'a>(paths: impl Iterator<Item = &\'a PathBuf>) {\n    for path in paths {\n        let _ = fs::remove_file(path);\n    }\n}\n\'\'\',\n            \'\'\'fn cleanup_staging_roots(staging_roots: &HashMap<PathBuf, PathBuf>) {\n    for (staging_root, storage_root) in staging_roots {\n        if staging_root.exists() {\n            let _ = move_to_trash(storage_root, staging_root);\n        }\n    }\n}\n\'\'\',\n            "move every root-local staging directory into its Trash",\n        )\n\n        if re.search(r"(?:std::)?fs::remove_file", production):\n            raise RuntimeError("permanent file deletion remains in patch.rs production source")\n        if "cleanup_temporary_files" in production:\n            raise RuntimeError("legacy temporary-file deletion helper remains")\n        if "path.strip_prefix(ws.root())" in production:\n            raise RuntimeError("primary-workspace-only staging remains")\n\n    result = production + (separator + tests if separator else "")\n    trash_test = \'\'\'\n    #[test]\n    fn move_to_trash_preserves_content() {\n        let root = tempfile::tempdir().expect("workspace");\n        let target = root.path().join("notes.txt");\n        std::fs::write(&target, "preserve me").expect("write fixture");\n        let destination = move_to_trash(root.path(), &target).expect("move to Trash");\n        assert!(!target.exists());\n        assert_eq!(\n            std::fs::read_to_string(&destination).expect("read Trash copy"),\n            "preserve me"\n        );\n        assert!(destination.starts_with(root.path().join("aiTemp").join("Trash")));\n    }\n\n\'\'\'\n    if "fn move_to_trash_preserves_content()" not in result:\n        if not separator:\n            raise RuntimeError("patch.rs has no test module")\n        test_marker = re.search(r"(?m)^\\s*#\\[test\\]\\s*$", result[result.index(separator) :])\n        if not test_marker:\n            raise RuntimeError("patch.rs test module has no test marker")\n        absolute = result.index(separator) + test_marker.start()\n        result = result[:absolute] + trash_test + result[absolute:]\n    return result\n'


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


def generator_bounds(text: str) -> tuple[int, int]:
    start_marker = "def harden_patch_deletion(text: str) -> str:\n"
    end_marker = "\n\nCONTRACT_TEST = r" + "'''"
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if start < 0 or end < 0:
        raise RuntimeError("unable to locate the reviewed patch-deletion generator")
    return start, end


def main() -> None:
    target = checked_target()
    text = target.read_text(encoding="utf-8")
    start, end = generator_bounds(text)
    current_generator = text[start:end]

    already_applied = (
        "fn approved_storage_root(" in current_generator
        and "cleanup_staging_roots" in current_generator
        and "restore_backups(ws, &backups)" in current_generator
        and "path.strip_prefix(ws.root())" not in current_generator
    )
    if already_applied:
        print("linked-root transaction generation fix is already applied")
        return

    if "path.strip_prefix(ws.root())" not in current_generator:
        raise RuntimeError(
            "expected primary-workspace-only staging marker is missing from "
            "the patch-deletion generator; run the reviewed Rust generation fixer first"
        )

    text = text[:start] + NEW_HARDEN_PATCH_DELETION + text[end:]

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text, encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    verified_start, verified_end = generator_bounds(verified)
    verified_generator = verified[verified_start:verified_end]
    required = (
        "fn approved_storage_root(",
        "let mut staging_roots: HashMap<PathBuf, PathBuf>",
        "approved_storage_root(ws, &resolved.display, &path)?",
        "cleanup_staging_roots(&staging_roots);",
        "restore_backups(ws, &backups)",
        "replace_file(&storage_root, &temp, &path)",
        "move_to_trash(&storage_root, &path).map(|_| ())",
    )
    for marker in required:
        if marker not in verified_generator:
            raise RuntimeError(f"linked-root generation verification is missing: {marker}")
    forbidden = (
        "path.strip_prefix(ws.root())",
        "cleanup_staging_root(",
        "cleanup_temporary_files",
    )
    for marker in forbidden:
        if marker in verified_generator:
            raise RuntimeError(f"obsolete transaction generation remains: {marker}")
    print("applied linked-root transaction generation fix with recoverable backup")


if __name__ == "__main__":
    main()
