"""Repair the rebranded DEV-home boundary without accepting legacy homes.

The runtime intentionally resolves only CODING_TOOLS_DEV_HOME.  Adapted CLI
fixtures and public guidance must exercise that boundary instead of relying on
upstream-only environment names.  Originals are retained under Trash/.
"""
from pathlib import Path
import os
import shutil
import subprocess

run_id = os.environ["GITHUB_RUN_ID"]
trash = Path("Trash/electron-dev-home") / run_id
changes: list[Path] = []


def rewrite(path_text: str, replacements: list[tuple[str, str]]) -> None:
    path = Path(path_text)
    source = path.read_text(encoding="utf-8")
    updated = source
    applied = 0
    for old, new in replacements:
        count = updated.count(old)
        if count:
            updated = updated.replace(old, new)
            applied += count
    if updated == source:
        return
    backup = trash / path
    backup.parent.mkdir(parents=True, exist_ok=True)
    assert not backup.exists(), f"Refusing to overwrite retained original: {backup}"
    assert not path.is_symlink(), f"Refusing to rewrite symlink: {path}"
    shutil.copy2(path, backup)
    path.write_text(updated, encoding="utf-8")
    changes.append(path)
    print(f"REWROTE {path}: {applied} exact replacement(s)")


rewrite(
    "runtime-web/tests/cli.test.ts",
    [
        ("CODEX_WEB_GPT_DEV_HOME:", "CODING_TOOLS_DEV_HOME:"),
        ("CODEX_CHATGPT_WEB_DEV_HOME:", "CODING_TOOLS_DEV_HOME:"),
    ],
)
rewrite(
    "runtime-web/src/cli.ts",
    [
        (
            "use CODEX_WEB_GPT_DEV_HOME for an explicit isolated DEV profile",
            "use CODING_TOOLS_DEV_HOME for an explicit isolated DEV profile",
        ),
    ],
)

assert changes, "Expected the stale upstream DEV-home names to be present"
cli_test = Path("runtime-web/tests/cli.test.ts").read_text(encoding="utf-8")
assert "CODEX_WEB_GPT_DEV_HOME:" not in cli_test
assert "CODEX_CHATGPT_WEB_DEV_HOME:" not in cli_test
assert "CODING_TOOLS_DEV_HOME:" in cli_test
cli_source = Path("runtime-web/src/cli.ts").read_text(encoding="utf-8")
assert "use CODING_TOOLS_DEV_HOME for an explicit isolated DEV profile" in cli_source

subprocess.run(["git", "add", "--", *(str(path) for path in changes), str(trash)], check=True)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
assert not subprocess.check_output(
    ["git", "diff", "--cached", "--diff-filter=D", "--name-only"]
).strip()
print("DEV_HOME_REPAIR_PASS: public override, CLI fixtures and guidance agree; legacy homes remain non-authoritative")
