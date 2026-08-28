from __future__ import annotations

import ast
import runpy
import shutil
import time
from pathlib import Path
from typing import Any


ROOT = Path.cwd().resolve()
HELPER_RELATIVE = Path(
    "aiTemp/security-hardening/fix_apply_security_hardening_v2_linked_roots.py"
)
TARGET_RELATIVE = Path("aiTemp/security-hardening/apply_security_hardening_v2.py")
REQUIRED_MARKERS = (
    "fn approved_storage_root(",
    "let mut staging_roots: HashMap<PathBuf, PathBuf>",
    "approved_storage_root(ws, &resolved.display, &path)?",
    "cleanup_staging_roots(&staging_roots);",
    "restore_backups(ws, &backups)",
    "replace_file(&storage_root, &temp, &path)",
    "move_to_trash(&storage_root, &path).map(|_| ())",
)


def checked_repository_file(relative: Path) -> Path:
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe repository path: {relative}")
    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to use a symlinked file: {relative}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"file is missing or escapes the repository: {relative}") from error
    if not resolved.is_file():
        raise RuntimeError(f"repository path is not a regular file: {relative}")
    return resolved


def load_helper() -> dict[str, Any]:
    helper = checked_repository_file(HELPER_RELATIVE)
    namespace = runpy.run_path(str(helper))
    required = ("NEW_HARDEN_PATCH_DELETION", "generator_bounds")
    missing = [name for name in required if name not in namespace]
    if missing:
        raise RuntimeError(f"linked-root helper is missing exports: {missing}")
    return namespace


def main() -> None:
    target = checked_repository_file(TARGET_RELATIVE)
    namespace = load_helper()
    replacement = namespace["NEW_HARDEN_PATCH_DELETION"]
    bounds = namespace["generator_bounds"]
    if not isinstance(replacement, str) or not callable(bounds):
        raise RuntimeError("linked-root helper exports have unexpected types")

    text = target.read_text(encoding="utf-8")
    start, end = bounds(text)
    current = text[start:end]
    if all(marker in current for marker in REQUIRED_MARKERS):
        print("linked-root transaction generation fix is already applied")
        return
    if "path.strip_prefix(ws.root())" not in current:
        raise RuntimeError(
            "reviewed primary-workspace staging marker is missing before linked-root fix"
        )

    backup_root = (
        ROOT
        / "aiTemp"
        / "Trash"
        / "security-hardening-v2-linked-root-application"
        / str(time.time_ns())
    )
    backup = backup_root / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)

    updated = text[:start] + replacement + text[end:]
    ast.parse(updated, filename=str(target))
    target.write_text(updated, encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    verified_start, verified_end = bounds(verified)
    verified_generator = verified[verified_start:verified_end]
    missing = [marker for marker in REQUIRED_MARKERS if marker not in verified_generator]
    if missing:
        raise RuntimeError(f"linked-root generator verification is missing: {missing}")
    print("applied linked-root transaction generation fix with recoverable backup")


if __name__ == "__main__":
    main()
