"""Apply the focused compile repair after RED evidence has been loaded.

The existing source is retained under Trash before replacement. No path is
removed and no result-unknown operation is replayed.
"""
from pathlib import Path
import os
import shutil
import subprocess

root = Path.cwd()
path = root / "rust-core/coding-tools-headless/src/lib.rs"
text = path.read_text(encoding="utf-8")
old = "tools::call_tool_mcp(&context, &tool, &arguments)"
new = "tools::dispatch::call_tool_mcp(&context, &tool, &arguments)"

if new not in text:
    if text.count(old) != 1:
        raise RuntimeError(f"expected one headless dispatcher call, found {text.count(old)}")
    backup = (
        root
        / "Trash/headless-service-0.6.0"
        / os.environ.get("GITHUB_RUN_ID", "local")
        / "rust-core/coding-tools-headless/src/lib.rs"
    )
    backup.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists() or path.is_symlink():
        raise RuntimeError(f"refusing to overwrite retained source: {backup}")
    shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    subprocess.run(
        ["git", "add", "--", str(path.relative_to(root)), str(backup.relative_to(root))],
        check=True,
    )

subprocess.run(
    ["rustfmt", "--edition", "2021", "--config", "skip_children=true", str(path)],
    check=True,
)
subprocess.run(["git", "add", "--", str(path.relative_to(root))], check=True)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
removed = subprocess.check_output(
    ["git", "diff", "--cached", "--diff-filter=D", "--name-only"], text=True
).strip()
if removed:
    raise RuntimeError(f"deletions are forbidden: {removed}")
print("HEADLESS_DISPATCH_REPAIR: canonical dispatcher selected; original retained")
