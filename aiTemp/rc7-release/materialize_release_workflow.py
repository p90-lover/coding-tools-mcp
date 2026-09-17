from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / ".github/workflows/codex-router-multiprovider-release-rc6-csc.yml"
TARGET = ROOT / ".github/workflows/codex-router-multiprovider-release-rc7.yml"
TRASH = ROOT / "aiTemp/Trash/rc7-release"

source = SOURCE.read_text(encoding="utf-8")
workflow = source
for old, new in (
    ("0.7.0-rc.6", "0.7.0-rc.7"),
    ("rc6-csc", "rc7"),
    ("rc.6", "rc.7"),
):
    workflow = workflow.replace(old, new)

product_marker = "            desktop-electron/tests/product-identity.test.cjs \\\n"
focused_contracts = (
    "            desktop-electron/tests/legacy-msi-upgrade-contract.test.cjs \\\n"
    "            desktop-electron/tests/commandcode-provider-session.test.cjs \\\n"
    "            desktop-electron/tests/rc7-full-integration-contract.test.cjs \\\n"
    "            desktop-electron/tests/rc2-paseo-anneal-network-surfaces.test.cjs \\\n"
    "            desktop-electron/tests/anneal-monitor-contract.test.cjs \\\n"
    "            desktop-electron/tests/upstream-tools.test.cjs \\\n"
    "            desktop-electron/tests/localization.test.cjs \\\n"
    "            desktop-electron/tests/orchestration-localization-layout.test.cjs \\\n"
    "            desktop-electron/tests/rc6-provider-hub-i18n-contract.test.cjs \\\n"
    "            desktop-electron/tests/rc6-ui-parity-contract.test.cjs \\\n"
)
if product_marker not in workflow:
    raise SystemExit("RC7_RELEASE_PRODUCT_TEST_MARKER_MISSING")
workflow = workflow.replace(product_marker, product_marker + focused_contracts, 1)

network_check = "          node --check desktop-electron/electron/provider-network.cjs\n"
if network_check not in workflow:
    raise SystemExit("RC7_RELEASE_PROVIDER_NETWORK_CHECK_MISSING")
workflow = workflow.replace(
    network_check,
    network_check + "          node --check desktop-electron/electron/upstream-tools.cjs\n",
    1,
)

required = (
    "release/codex-router-multiprovider-0.7.0-rc.7",
    "RELEASE_VERSION: '0.7.0-rc.7'",
    "RELEASE_TAG: v0.7.0-rc.7",
    "codex-router-multiprovider-release-rc7.yml",
    "Coding.Tools_0.7.0-rc.7_windows_x64_setup.exe",
    "docs/releases/v0.7.0-rc.7.md",
    "desktop-electron/tests/rc7-full-integration-contract.test.cjs",
    "desktop-electron/tests/rc2-paseo-anneal-network-surfaces.test.cjs",
    "desktop-electron/tests/localization.test.cjs",
    "desktop-electron/electron/upstream-tools.cjs",
    "git diff --diff-filter=D",
)
for marker in required:
    if marker not in workflow:
        raise SystemExit(f"RC7_RELEASE_REQUIRED_MARKER_MISSING:{marker}")

if re.search(r"0\.7\.0-rc\.6(?!\.\d)", workflow):
    raise SystemExit("RC7_RELEASE_STALE_VERSION_REMAINS")
if "codex-router-multiprovider-release-rc6-csc.yml" in workflow:
    raise SystemExit("RC7_RELEASE_STALE_WORKFLOW_REMAINS")

if TARGET.exists():
    current = TARGET.read_text(encoding="utf-8")
    if current == workflow:
        print("RC7_RELEASE_WORKFLOW_ALREADY_MATERIALIZED")
        print(f"SHA256 {sha256(workflow.encode()).hexdigest()}")
        raise SystemExit(0)
    TRASH.mkdir(parents=True, exist_ok=True)
    retained = TRASH / f"{TARGET.stem}-{sha256(current.encode()).hexdigest()[:12]}.yml"
    if not retained.exists():
        TARGET.replace(retained)

TARGET.parent.mkdir(parents=True, exist_ok=True)
TARGET.write_text(workflow, encoding="utf-8")
print("RC7_RELEASE_WORKFLOW_READY")
print(f"SHA256 {sha256(workflow.encode()).hexdigest()}")
print(f"LINES {len(workflow.splitlines())}")
