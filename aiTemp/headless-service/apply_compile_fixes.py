"""Apply focused compile repairs after RED evidence has been loaded.

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
replacements = [
    (
        "tools::call_tool_mcp(&context, &tool, &arguments)",
        "tools::dispatch::call_tool_mcp(&context, &tool, &arguments)",
        "canonical dispatcher",
    ),
    (
        "use tokio::sync::{oneshot, Notify};",
        "use tokio::sync::Notify;",
        "unused oneshot import",
    ),
    (
        "        let join = tokio::spawn(async move {\n            let app = router(state);",
        "        let service_shutdown_tx = shutdown_tx.clone();\n        let join = tokio::spawn(async move {\n            let app = router(state);",
        "shutdown sender ownership",
    ),
    (
        "            let reason = shutdown_tx\n                .borrow()",
        "            let reason = service_shutdown_tx\n                .borrow()",
        "shutdown sender readback",
    ),
    (
        "fn auth(headers: &HeaderMap, state: &ServiceState) -> Result<(), Response> {",
        "fn auth(headers: &HeaderMap, state: &ServiceState) -> Result<(), Box<Response>> {",
        "boxed authentication error",
    ),
    (
        ".map_err(|status| json_error(status, \"UNAUTHORIZED\", \"A valid local control token is required\"))",
        ".map_err(|status| {\n            Box::new(json_error(\n                status,\n                \"UNAUTHORIZED\",\n                \"A valid local control token is required\",\n            ))\n        })",
        "boxed authentication response",
    ),
    (
        "fn admit(state: &ServiceState, kind: &str) -> Result<RequestLease, Response> {",
        "fn admit(state: &ServiceState, kind: &str) -> Result<RequestLease, Box<Response>> {",
        "boxed admission error",
    ),
    (
        "        json_error(status, \"HEADLESS_NOT_ACCEPTING\", message)\n    })",
        "        Box::new(json_error(status, \"HEADLESS_NOT_ACCEPTING\", message))\n    })",
        "boxed admission response",
    ),
]

updated = text
changed = False
for old, new, label in replacements:
    if new in updated:
        continue
    count = updated.count(old)
    if count != 1:
        raise RuntimeError(f"expected one {label} pattern, found {count}")
    updated = updated.replace(old, new, 1)
    changed = True

for old, new in [
    ("        return response;\n", "        return *response;\n"),
    ("        Err(response) => return response,\n", "        Err(response) => return *response,\n"),
]:
    if old in updated:
        updated = updated.replace(old, new)
        changed = True

if changed:
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
    path.write_text(updated, encoding="utf-8")
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
print(
    "HEADLESS_COMPILE_REPAIRS: canonical dispatcher, bounded shutdown sender, "
    "boxed error responses and clean imports; original retained"
)
