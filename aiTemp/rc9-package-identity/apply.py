from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OLD = "0.7.0-rc.8"
NEW = "0.7.0-rc.9"

REPLACEMENTS: dict[str, tuple[tuple[str, str], ...]] = {
    "desktop-electron/electron/product.cjs": (
        (f'version: "{OLD}",', f'version: "{NEW}",'),
    ),
    "desktop-electron/scripts/prepare-package-resources.cjs": (
        (f'const PRODUCT_VERSION = "{OLD}";', f'const PRODUCT_VERSION = "{NEW}";'),
    ),
    "desktop-electron/scripts/verify-package.cjs": (
        (f'version: "{OLD}",', f'version: "{NEW}",'),
    ),
    "desktop-electron/tests/product-identity.test.cjs": (
        (f"version: '{OLD}',", f"version: '{NEW}',"),
    ),
    "desktop-electron/tests/package-contents.test.cjs": (
        (f'const PRODUCT_VERSION = "{OLD}";', f'const PRODUCT_VERSION = "{NEW}";'),
    ),
    "desktop-electron/tests/package-resource-preparation.test.cjs": (
        (f'const PRODUCT_VERSION = "{OLD}";', f'const PRODUCT_VERSION = "{NEW}";'),
    ),
    "desktop-electron/tests/installer-upgrade-migration.test.cjs": (
        (
            'test("rc.8 keeps the stable Electron installer identity and enables the NSIS migration include", () => {',
            'test("rc.9 keeps the stable Electron installer identity and enables the NSIS migration include", () => {',
        ),
        (f'assert.equal(manifest.version, "{OLD}");', f'assert.equal(manifest.version, "{NEW}");'),
    ),
}

changed: list[str] = []
for relative, replacements in REPLACEMENTS.items():
    path = ROOT / relative
    source = path.read_text(encoding="utf-8")
    updated = source
    for before, after in replacements:
        if after in updated:
            continue
        count = updated.count(before)
        if count != 1:
            raise SystemExit(f"expected one identity anchor in {relative}, found {count}: {before!r}")
        updated = updated.replace(before, after, 1)
    if updated != source:
        path.write_text(updated, encoding="utf-8")
        changed.append(relative)

for relative in REPLACEMENTS:
    source = (ROOT / relative).read_text(encoding="utf-8")
    if OLD in source:
        raise SystemExit(f"stale package identity remains in {relative}: {OLD}")
    if NEW not in source:
        raise SystemExit(f"current package identity is missing from {relative}: {NEW}")

manifest = (ROOT / "desktop-electron/package.json").read_text(encoding="utf-8")
if f'"version": "{NEW}"' not in manifest:
    raise SystemExit("desktop-electron/package.json is not on rc.9")

print("RC9_PACKAGE_IDENTITY_ALIGNED")
for relative in changed:
    print(f"CHANGED {relative}")
