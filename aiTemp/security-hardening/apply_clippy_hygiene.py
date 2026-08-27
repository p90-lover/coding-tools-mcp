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
    / "clippy-hygiene"
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


before_test = '''    #[test]
    fn request_limits_are_bounded_and_nonzero() {
        assert!(MAX_REQUEST_BODY_BYTES > 0);
        assert!(MAX_REQUEST_BODY_BYTES <= 8 * 1024 * 1024);
        assert!((1..=32).contains(&MAX_IN_FLIGHT_REQUESTS));
        assert!((1..=5).contains(&REQUEST_QUEUE_WAIT_SECONDS));
    }
'''
after_test = '''    #[test]
    fn request_limits_are_bounded_and_nonzero() {
        let body_limit = std::hint::black_box(MAX_REQUEST_BODY_BYTES);
        let in_flight = std::hint::black_box(MAX_IN_FLIGHT_REQUESTS);
        let queue_wait = std::hint::black_box(REQUEST_QUEUE_WAIT_SECONDS);
        assert!(body_limit > 0);
        assert!(body_limit <= 8 * 1024 * 1024);
        assert!((1..=32).contains(&in_flight));
        assert!((1..=5).contains(&queue_wait));
    }
'''

for source in ("src-tauri/src/mcp/listener.rs", "src-tauri/src/actions/listener.rs"):
    replace_once(
        source,
        before_test,
        after_test,
        f"avoid constant-only assertions in {source}",
    )

replace_once(
    "src-tauri/src/tools/trash.rs",
    '''pub(crate) fn move_dir_to_recovery_trash(path: impl AsRef<Path>) -> io::Result<()> {
''',
    '''#[allow(dead_code)]
pub(crate) fn move_dir_to_recovery_trash(path: impl AsRef<Path>) -> io::Result<()> {
''',
    "retain recoverable directory helper across target-specific builds",
)


def verify() -> None:
    for source in ("src-tauri/src/mcp/listener.rs", "src-tauri/src/actions/listener.rs"):
        text = checked_file(source).read_text(encoding="utf-8")
        if "std::hint::black_box(MAX_REQUEST_BODY_BYTES)" not in text:
            raise RuntimeError(f"Clippy-safe request-limit test missing in {source}")
    trash = checked_file("src-tauri/src/tools/trash.rs").read_text(encoding="utf-8")
    if "#[allow(dead_code)]\npub(crate) fn move_dir_to_recovery_trash" not in trash:
        raise RuntimeError("directory recovery helper retention marker is missing")


verify()
print("strict-Clippy hygiene applied successfully")
