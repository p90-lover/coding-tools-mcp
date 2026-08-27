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
    / "security-hardening-v2-applicator-fix"
    / str(time.time_ns())
)


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
    before = "                'features = [\"cors\", \"timeout\"] }}'\n"
    after = "                'features = [\"cors\", \"timeout\"] }'\n"

    if before not in text:
        if after in text:
            print("applicator TOML brace fix is already applied")
            return
        raise RuntimeError("reviewed malformed tower-http line was not found exactly once")
    if text.count(before) != 1:
        raise RuntimeError("malformed tower-http line is ambiguous")

    backup = BACKUP_ROOT / TARGET_RELATIVE
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text.replace(before, after, 1), encoding="utf-8")

    verified = target.read_text(encoding="utf-8")
    if before in verified or verified.count(after) != 1:
        raise RuntimeError("applicator TOML brace fix did not verify")
    print("applied reviewed one-brace TOML fix with recoverable backup")


if __name__ == "__main__":
    main()
