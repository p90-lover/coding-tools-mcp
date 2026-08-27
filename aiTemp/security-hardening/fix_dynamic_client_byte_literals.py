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
    / "dynamic-client-byte-literal-fix"
    / str(time.time_ns())
)
TARGET_PATH = "src-tauri/src/auth/oauth_flow.rs"


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


target = checked_file(TARGET_PATH)
text = target.read_text(encoding="utf-8")
replacement = "            byte.is_ascii_graphic()\n                && !matches!(byte, b'&' | b'=' | b'<' | b'>' | 0x22 | 0x27)\n"
start_marker = "            byte.is_ascii_graphic()\n                && !matches!(byte, "
start = text.find(start_marker)
if start < 0:
    if replacement in text:
        print("already applied: use unambiguous dynamic-client byte literals")
        raise SystemExit(0)
    raise RuntimeError("dynamic-client validation expression is missing")
end = text.find("\n", start + len(start_marker))
if end < 0:
    raise RuntimeError("dynamic-client validation expression is incomplete")
current = text[start : end + 1]
if current != replacement:
    backup = BACKUP_ROOT / TARGET_PATH
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text[:start] + replacement + text[end + 1 :], encoding="utf-8")
    print("applied: use unambiguous dynamic-client byte literals")

verified = target.read_text(encoding="utf-8")
if replacement not in verified:
    raise RuntimeError("dynamic-client byte-literal repair did not persist")
if "b'''" in verified:
    raise RuntimeError("invalid apostrophe byte literal remains")
print("dynamic-client byte-literal repair verified")
