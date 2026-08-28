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
    if "NEW_HARDEN_PATCH_DELETION" not in namespace:
        raise RuntimeError("linked-root helper is missing NEW_HARDEN_PATCH_DELETION")
    return namespace


def top_level_functions(text: str) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    parsed = ast.parse(text, filename=str(TARGET_RELATIVE))
    return {
        node.name: node
        for node in parsed.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def function_bounds(text: str, name: str) -> tuple[int, int]:
    functions = top_level_functions(text)
    node = functions.get(name)
    if node is None or node.end_lineno is None:
        raise RuntimeError(f"unable to locate complete top-level function: {name}")
    offsets = [0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    return offsets[node.lineno - 1], offsets[node.end_lineno]


def main() -> None:
    target = checked_repository_file(TARGET_RELATIVE)
    namespace = load_helper()
    replacement = namespace["NEW_HARDEN_PATCH_DELETION"]
    if not isinstance(replacement, str):
        raise RuntimeError("linked-root helper replacement has an unexpected type")

    text = target.read_text(encoding="utf-8")
    original_functions = set(top_level_functions(text))
    start, end = function_bounds(text, "harden_patch_deletion")
    current = text[start:end]
    if all(marker in current for marker in REQUIRED_MARKERS):
        print("linked-root transaction generation fix is already applied")
        return
    if "path.strip_prefix(ws.root())" not in current:
        raise RuntimeError(
            "reviewed primary-workspace staging marker is missing before linked-root fix"
        )

    replacement = replacement.rstrip("\n") + "\n"
    updated = text[:start] + replacement + text[end:]
    updated_functions = set(top_level_functions(updated))
    lost_functions = sorted(original_functions - updated_functions)
    if lost_functions:
        raise RuntimeError(
            f"linked-root replacement would remove top-level functions: {lost_functions}"
        )
    updated_start, updated_end = function_bounds(updated, "harden_patch_deletion")
    updated_generator = updated[updated_start:updated_end]
    missing = [marker for marker in REQUIRED_MARKERS if marker not in updated_generator]
    if missing:
        raise RuntimeError(f"linked-root generator verification is missing: {missing}")

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
    target.write_text(updated, encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    verified_functions = set(top_level_functions(verified))
    lost_after_write = sorted(original_functions - verified_functions)
    if lost_after_write:
        raise RuntimeError(
            f"linked-root write lost top-level functions: {lost_after_write}"
        )
    print("applied linked-root transaction generation fix with recoverable backup")


if __name__ == "__main__":
    main()
