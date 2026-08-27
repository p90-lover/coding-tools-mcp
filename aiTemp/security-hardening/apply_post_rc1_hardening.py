from __future__ import annotations

import hashlib
import runpy
import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
REVIEWED_SCRIPT = (
    ROOT
    / "aiTemp"
    / "security-hardening"
    / "reviewed"
    / "apply_post_rc1_hardening.py"
)
REVIEWED_BLOB_SHA1 = "4afaa1510dff2828be86c90881486cf4c96993ff"
ACTIONS_LISTENER_PATH = Path("src-tauri/src/actions/listener.rs")
TOOLS_MODULE_PATH = Path("src-tauri/src/tools/mod.rs")
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "security-hardening"
    / "v0.3.1-source-compatibility"
    / str(time.time_ns())
)


def checked_regular_file(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise RuntimeError(f"refusing to use a symlink for {label}: {path}")
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"{label} is missing or escapes the repository: {path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"{label} is not a regular file: {path}")
    return resolved


def backup(path: Path, label: str) -> Path:
    source = checked_regular_file(ROOT / path, label)
    target = BACKUP_ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return source


def git_blob_sha1(payload: bytes) -> str:
    header = f"blob {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload, usedforsecurity=False).hexdigest()


def adapt_reviewed_rustfmt_shape() -> None:
    target = checked_regular_file(ROOT / ACTIONS_LISTENER_PATH, "Actions listener")
    text = target.read_text(encoding="utf-8")
    formatted = "    extract::{Form, Path, Query, State},\n"
    reviewed = "        extract::{Form, Path, Query, State},\n"

    if reviewed in text:
        print("already adapted: reviewed Actions import indentation")
        return
    if text.count(formatted) != 1:
        raise RuntimeError(
            "Actions import shape drifted; expected exactly one rustfmt-normalized source marker"
        )

    target = backup(ACTIONS_LISTENER_PATH, "Actions listener")
    target.write_text(text.replace(formatted, reviewed, 1), encoding="utf-8")
    print("adapted: reviewed Actions import indentation with recoverable backup")


def run_reviewed_applicator() -> None:
    reviewed = checked_regular_file(REVIEWED_SCRIPT, "reviewed hardening applicator")
    payload = reviewed.read_bytes()
    actual = git_blob_sha1(payload)
    if actual != REVIEWED_BLOB_SHA1:
        raise RuntimeError(
            f"reviewed hardening applicator hash mismatch: expected {REVIEWED_BLOB_SHA1}, got {actual}"
        )
    runpy.run_path(str(reviewed), run_name="__main__")


def repair_reviewed_module_visibility() -> None:
    target = checked_regular_file(ROOT / TOOLS_MODULE_PATH, "tools module")
    text = target.read_text(encoding="utf-8")
    invalid = "pub pub(crate) mod trash;\nmod workspace;\n"
    corrected = "pub(crate) mod trash;\npub mod workspace;\n"

    if corrected in text:
        print("already repaired: Trash visibility with public workspace API")
        return
    if text.count(invalid) != 1:
        raise RuntimeError(
            "tools module visibility drifted; expected exactly one reviewed composite marker"
        )

    target = backup(TOOLS_MODULE_PATH, "tools module")
    target.write_text(text.replace(invalid, corrected, 1), encoding="utf-8")
    print("repaired: Trash visibility while preserving public workspace API")


adapt_reviewed_rustfmt_shape()
run_reviewed_applicator()
repair_reviewed_module_visibility()
