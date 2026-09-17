from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / ".github/workflows/codex-router-multiprovider-release-rc6-csc.yml"
TARGET = ROOT / ".github/workflows/codex-router-multiprovider-release-rc6-1-csc.yml"

old = SOURCE.read_text(encoding="utf-8")
text = old

text = text.replace(
    ".github/workflows/codex-router-multiprovider-release-rc6-csc.yml",
    ".github/workflows/codex-router-multiprovider-release-rc6-1-csc.yml",
)
text = text.replace("rc6-csc", "rc6-1-csc")
text = re.sub(r"0\.7\.0-rc\.6(?!\.\d)", "0.7.0-rc.6.1", text)
text = re.sub(r"\brc\.6(?!\.\d)", "rc.6.1", text)

anchor = """            desktop-electron/tests/provider-console-saas.test.cjs \\
"""
addition = """            desktop-electron/tests/antigravity-session-binding.test.cjs \\
            desktop-electron/tests/antigravity-provider-session.test.cjs \\
            desktop-electron/tests/provider-console-saas.test.cjs \\
"""
if "desktop-electron/tests/antigravity-session-binding.test.cjs" not in text:
    if anchor not in text:
        raise SystemExit("Missing focused release-test insertion anchor")
    text = text.replace(anchor, addition, 1)

required = [
    "release/codex-router-multiprovider-0.7.0-rc.6.1",
    "RELEASE_VERSION: '0.7.0-rc.6.1'",
    "RELEASE_TAG: v0.7.0-rc.6.1",
    "Coding.Tools_0.7.0-rc.6.1_windows_x64_setup.exe",
    ".github/workflows/codex-router-multiprovider-release-rc6-1-csc.yml",
    "docs/releases/v0.7.0-rc.6.1.md",
    "desktop-electron/tests/antigravity-session-binding.test.cjs",
    "desktop-electron/tests/antigravity-provider-session.test.cjs",
]
for value in required:
    if value not in text:
        raise SystemExit(f"Generated release workflow is missing: {value}")

for forbidden in [
    "release/codex-router-multiprovider-0.7.0-rc.6\n",
    "RELEASE_VERSION: '0.7.0-rc.6'",
    "RELEASE_TAG: v0.7.0-rc.6\n",
    "Coding.Tools_0.7.0-rc.6_windows_x64_setup.exe",
    ".github/workflows/codex-router-multiprovider-release-rc6-csc.yml",
]:
    if forbidden in text:
        raise SystemExit(f"Generated release workflow retained stale identity: {forbidden!r}")

if TARGET.exists():
    current = TARGET.read_text(encoding="utf-8")
    if current == text:
        print("RC6_1_RELEASE_WORKFLOW_ALREADY_MATERIALIZED")
        raise SystemExit(0)
    raise SystemExit("Refusing to overwrite a different rc.6.1 release workflow")

TARGET.write_text(text, encoding="utf-8")
print("RC6_1_RELEASE_WORKFLOW_MATERIALIZED")
