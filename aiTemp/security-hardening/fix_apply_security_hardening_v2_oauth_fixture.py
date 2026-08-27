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
    / "security-hardening-v2-oauth-fixture-fix"
    / str(time.time_ns())
)

OLD_ASSERTION = '        assert!(oauth.client_id_allowed("client"));\n'
NEW_ASSERTION = '        assert!(oauth.client_id_allowed("chatgpt-client-test"));\n'


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
    old_count = text.count(OLD_ASSERTION)
    new_count = text.count(NEW_ASSERTION)

    if old_count == 0 and new_count == 1:
        print("OAuth fixture client-ID fix is already applied")
        return
    if old_count != 1 or new_count != 0:
        raise RuntimeError(
            "unexpected OAuth fixture assertion state: "
            f"old={old_count}, new={new_count}"
        )

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)

    target.write_text(text.replace(OLD_ASSERTION, NEW_ASSERTION, 1), encoding="utf-8")
    verified = target.read_text(encoding="utf-8")
    if OLD_ASSERTION in verified or verified.count(NEW_ASSERTION) != 1:
        raise RuntimeError("OAuth fixture client-ID fix did not verify")

    print("applied OAuth fixture client-ID fix with recoverable backup")


if __name__ == "__main__":
    main()
