from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("apply_approval_patch.py")
spec = importlib.util.spec_from_file_location("approval_patch_base", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("unable to load base approval patcher")
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

TARGET_AFTER_COUNTS = {
    "persist runtime approval mode": 1,
    "initialize runtime approval mode": 1,
    "add approval mode TypeScript type": 1,
    "add approval mode to draft interface": 1,
    "add approval mode prop": 2,
}


def replace_occurrence_aware(path: str, before: str, after: str, label: str) -> None:
    file_path = patcher.ROOT / path
    text = file_path.read_text(encoding="utf-8")
    after_target = TARGET_AFTER_COUNTS.get(label, 1)
    after_count = text.count(after)
    before_count = text.count(before)

    if after_count >= after_target:
        print(f"already applied: {label}")
        return
    if before_count < 1:
        raise RuntimeError(
            f"{label}: expected a source match, found {before_count}; "
            f"applied matches={after_count}/{after_target}"
        )
    if label not in TARGET_AFTER_COUNTS and before_count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {before_count}")

    patcher.backup(Path(path))
    file_path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"applied: {label}")


patcher.replace_once = replace_occurrence_aware
patcher.main()
