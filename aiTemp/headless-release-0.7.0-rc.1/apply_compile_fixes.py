"""Materialize the verified headless-service compile repair for v0.7.0-rc.1.

The failed Windows release run 34962618356 is the RED evidence. This script
applies only the previously verified dispatcher, shutdown ownership, boxed
Axum response, and cross-platform warning fixes. The original source is
retained under Trash before replacement; no path is deleted.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path.cwd()
SOURCE = ROOT / "rust-core/coding-tools-headless/src/lib.rs"
EVIDENCE = ROOT / "aiTemp/evidence/headless-release-repair"
EXPECTED_STALE_BLOB = "f1e5a2ed27bf0b53ceea74d737d56a2025cfa80a"


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def replace_once(text: str, old: str, new: str, label: str) -> tuple[str, bool]:
    if new in text:
        return text, False
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected exactly one {label} pattern, found {count}")
    return text.replace(old, new, 1), True


original = SOURCE.read_text(encoding="utf-8")
initial_blob = git("hash-object", str(SOURCE.relative_to(ROOT)))
patched = original
changed = False

replacements = [
    (
        "tools::call_tool_mcp(&context, &tool, &arguments)",
        "tools::dispatch::call_tool_mcp(&context, &tool, &arguments)",
        "canonical MCP dispatcher",
    ),
    (
        "use tokio::sync::{oneshot, Notify};",
        "use tokio::sync::Notify;",
        "unused oneshot import",
    ),
    (
        "fn restrict_file(path: &Path) -> Result<(), String> {\n    #[cfg(unix)]",
        "fn restrict_file(path: &Path) -> Result<(), String> {\n    #[cfg(not(unix))]\n    let _ = path;\n    #[cfg(unix)]",
        "cross-platform restrict_file parameter use",
    ),
    (
        "fn auth(headers: &HeaderMap, state: &ServiceState) -> Result<(), Response> {",
        "fn auth(headers: &HeaderMap, state: &ServiceState) -> Result<(), Box<Response>> {",
        "boxed authentication error type",
    ),
    (
        ".map_err(|status| json_error(status, \"UNAUTHORIZED\", \"A valid local control token is required\"))",
        ".map_err(|status| {\n            Box::new(json_error(\n                status,\n                \"UNAUTHORIZED\",\n                \"A valid local control token is required\",\n            ))\n        })",
        "boxed authentication response",
    ),
    (
        "fn admit(state: &ServiceState, kind: &str) -> Result<RequestLease, Response> {",
        "fn admit(state: &ServiceState, kind: &str) -> Result<RequestLease, Box<Response>> {",
        "boxed admission error type",
    ),
    (
        "        json_error(status, \"HEADLESS_NOT_ACCEPTING\", message)\n    })",
        "        Box::new(json_error(status, \"HEADLESS_NOT_ACCEPTING\", message))\n    })",
        "boxed admission response",
    ),
    (
        "        let join = tokio::spawn(async move {\n            let app = router(state);",
        "        let service_shutdown_tx = shutdown_tx.clone();\n        let join = tokio::spawn(async move {\n            let app = router(state);",
        "shutdown sender clone",
    ),
    (
        "            let reason = shutdown_tx\n                .borrow()",
        "            let reason = service_shutdown_tx\n                .borrow()",
        "shutdown sender readback",
    ),
]

for old, new, label in replacements:
    patched, applied = replace_once(patched, old, new, label)
    changed = changed or applied

for old, new in (
    ("        return response;\n", "        return *response;\n"),
    ("        Err(response) => return response,\n", "        Err(response) => return *response,\n"),
):
    if old in patched:
        patched = patched.replace(old, new)
        changed = True

EVIDENCE.mkdir(parents=True, exist_ok=True)
(EVIDENCE / "initial-blob.txt").write_text(f"{initial_blob}\n", encoding="utf-8")

if changed:
    if initial_blob != EXPECTED_STALE_BLOB:
        raise RuntimeError(
            f"refusing to patch unexpected source blob {initial_blob}; "
            f"expected {EXPECTED_STALE_BLOB}"
        )
    backup = (
        ROOT
        / "Trash/headless-release-0.7.0-rc.1"
        / os.environ.get("GITHUB_RUN_ID", "local")
        / "rust-core/coding-tools-headless/src/lib.rs"
    )
    backup.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists() or SOURCE.is_symlink():
        raise RuntimeError(f"refusing to overwrite retained source: {backup}")
    shutil.copy2(SOURCE, backup)
    SOURCE.write_text(patched, encoding="utf-8")
    subprocess.run(
        ["rustfmt", "--edition", "2021", "--config", "skip_children=true", str(SOURCE)],
        cwd=ROOT,
        check=True,
    )
    (EVIDENCE / "retained-source.txt").write_text(
        f"{backup.relative_to(ROOT).as_posix()}\n", encoding="utf-8"
    )
else:
    print("HEADLESS_RELEASE_REPAIR: source already materialized")

subprocess.run(["git", "diff", "--check"], cwd=ROOT, check=True)
removed = git("diff", "--diff-filter=D", "--name-only")
if removed:
    raise RuntimeError(f"file deletions are forbidden: {removed}")
final_blob = git("hash-object", str(SOURCE.relative_to(ROOT)))
(EVIDENCE / "final-blob.txt").write_text(f"{final_blob}\n", encoding="utf-8")
print(
    "HEADLESS_RELEASE_REPAIR: canonical dispatcher, cloned shutdown sender, "
    "boxed Axum errors, clean imports, and Windows warning fix; original retained"
)
