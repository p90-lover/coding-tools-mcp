from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd().resolve()
SOURCE = ROOT / "aiTemp" / "security-hardening" / "prepare_final_rc2.sh"
RUNTIME = ROOT / "aiTemp" / "runtime" / "security-hardening" / "prepare_final_rc2.sh"


def checked_source() -> Path:
    if SOURCE.is_symlink():
        raise RuntimeError("refusing to read RC2 preparation through a symlink")
    resolved = SOURCE.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise RuntimeError("RC2 preparation source is not a regular file")
    return resolved


text = checked_source().read_text(encoding="utf-8")
command = "python aiTemp/security-hardening/apply_auth_and_write_queue_limits.py\n"
marker = "python aiTemp/security-hardening/apply_clippy_hygiene.py\n"
if command not in text:
    count = text.count(marker)
    if count != 1:
        raise RuntimeError(f"expected one Clippy-hygiene command, found {count}")
    text = text.replace(marker, marker + command, 1)

assertions = '''grep -q 'MAX_IN_FLIGHT_AUTH_REQUESTS' src-tauri/src/mcp/listener.rs
grep -q 'MAX_IN_FLIGHT_AUTH_REQUESTS' src-tauri/src/actions/listener.rs
test "$(grep -c 'acquire_oauth_slot(&state).await' src-tauri/src/mcp/listener.rs)" -ge 3
test "$(grep -c 'acquire_oauth_slot(&state).await' src-tauri/src/actions/listener.rs)" -ge 3
grep -q 'Actions mutating request queue is temporarily full' src-tauri/src/actions/listener.rs
'''
assertion_marker = "if grep -q 'stable_oauth_client_id(' src-tauri/src/runtime/supervisor.rs; then\n"
if assertions not in text:
    count = text.count(assertion_marker)
    if count != 1:
        raise RuntimeError(f"expected one source-assertion boundary, found {count}")
    text = text.replace(assertion_marker, assertions + assertion_marker, 1)

focused_test = "  cargo test --locked oauth_capacity_hardening_tests -- --nocapture\n"
test_marker = "  cargo test --locked request_capacity_hardening_tests -- --nocapture\n"
if focused_test not in text:
    count = text.count(test_marker)
    if count != 1:
        raise RuntimeError(f"expected one request-capacity test command, found {count}")
    text = text.replace(test_marker, test_marker + focused_test, 1)

RUNTIME.parent.mkdir(parents=True, exist_ok=True)
if RUNTIME.is_symlink() or RUNTIME.parent.is_symlink():
    raise RuntimeError("refusing to write runtime RC2 preparation through a symlink")
resolved_parent = RUNTIME.parent.resolve(strict=True)
resolved_parent.relative_to(ROOT)
RUNTIME.write_text(text, encoding="utf-8")
RUNTIME.chmod(0o700)

verified = RUNTIME.read_text(encoding="utf-8")
required = (
    "apply_auth_and_write_queue_limits.py",
    "oauth_capacity_hardening_tests",
    "Actions mutating request queue is temporarily full",
    "acquire_oauth_slot(&state).await",
)
missing = [item for item in required if item not in verified]
if missing:
    raise RuntimeError(f"runtime RC2 preparation is incomplete: {missing}")

print(RUNTIME)
