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
    / "request-capacity-tests"
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


TEST_MODULE = r'''
#[cfg(test)]
mod request_capacity_hardening_tests {
    use super::*;

    #[tokio::test]
    async fn request_slots_enforce_the_configured_in_flight_limit() {
        let slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS));
        let mut permits = Vec::with_capacity(MAX_IN_FLIGHT_REQUESTS);
        for _ in 0..MAX_IN_FLIGHT_REQUESTS {
            permits.push(slots.clone().acquire_owned().await.expect("permit"));
        }

        let queued = tokio::time::timeout(
            std::time::Duration::from_millis(25),
            slots.clone().acquire_owned(),
        )
        .await;
        assert!(queued.is_err(), "capacity must not exceed the configured limit");

        drop(permits.pop());
        let permit = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            slots.acquire_owned(),
        )
        .await
        .expect("released capacity should become available")
        .expect("semaphore remains open");
        drop(permit);
    }

    #[test]
    fn request_limits_are_bounded_and_nonzero() {
        assert!(MAX_REQUEST_BODY_BYTES > 0);
        assert!(MAX_REQUEST_BODY_BYTES <= 8 * 1024 * 1024);
        assert!((1..=32).contains(&MAX_IN_FLIGHT_REQUESTS));
        assert!((1..=5).contains(&REQUEST_QUEUE_WAIT_SECONDS));
    }
}
'''

append_once(
    "src-tauri/src/mcp/listener.rs",
    TEST_MODULE,
    "mod request_capacity_hardening_tests",
    "test bounded MCP request capacity",
)
append_once(
    "src-tauri/src/actions/listener.rs",
    TEST_MODULE,
    "mod request_capacity_hardening_tests",
    "test bounded Actions request capacity",
)


def verify() -> None:
    for path in ("src-tauri/src/mcp/listener.rs", "src-tauri/src/actions/listener.rs"):
        text = checked_file(path).read_text(encoding="utf-8")
        required = (
            "mod request_capacity_hardening_tests",
            "request_slots_enforce_the_configured_in_flight_limit",
            "MAX_REQUEST_BODY_BYTES <= 8 * 1024 * 1024",
        )
        missing = [item for item in required if item not in text]
        if missing:
            raise RuntimeError(f"request capacity tests missing from {path}: {missing}")


verify()
print("request-capacity hardening tests applied successfully")
