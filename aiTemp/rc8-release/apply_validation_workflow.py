from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "aiTemp/rc8-release/run-windows-release.mjs"

source = TARGET.read_text(encoding="utf-8")
marker = "  VALIDATION_WORKFLOW: '.github/workflows/codex-router-multiprovider-release-rc8.yml',\n"
if marker in source:
    print("RC8_VALIDATION_WORKFLOW_ALREADY_APPLIED")
    raise SystemExit(0)

anchor = "  RELEASE_TAG: releaseTag,\n"
if source.count(anchor) != 1:
    raise SystemExit(f"expected one release-tag environment anchor, found {source.count(anchor)}")
source = source.replace(anchor, anchor + marker, 1)
TARGET.write_text(source, encoding="utf-8")
print("RC8_VALIDATION_WORKFLOW_APPLIED")
