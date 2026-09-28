from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "scripts/release/verify-source-scope.mjs"

source = TARGET.read_text(encoding="utf-8")
new_marker = "const assistedLegacyMigration = nsis.allowElevation === true"
if new_marker in source:
    print("RC8_SOURCE_SCOPE_ELEVATION_ALREADY_APPLIED")
    raise SystemExit(0)

old_block = '''  if (nsis.allowElevation !== false) {
    add(errors, 'NSIS_ELEVATION_MISMATCH', 'Windows installer must not request elevation (allowElevation=false)');
  }
'''
new_block = '''  const assistedLegacyMigration = nsis.allowElevation === true
    && nsis.perMachine === false
    && nsis.oneClick === false
    && nsis.include === 'build/installer.nsh'
    && nsis.deleteAppDataOnUninstall === false;
  if (nsis.allowElevation !== false && !assistedLegacyMigration) {
    add(
      errors,
      'NSIS_ELEVATION_MISMATCH',
      'Windows installer elevation is allowed only for the bounded legacy NSIS/MSI migration include',
    );
  }
'''
if source.count(old_block) != 1:
    raise SystemExit(f"expected one elevation anchor, found {source.count(old_block)}")
source = source.replace(old_block, new_block, 1)

old_fact = '''      allowElevation: nsis.allowElevation,
      upstream: {
'''
new_fact = '''      allowElevation: nsis.allowElevation,
      assistedLegacyMigration,
      upstream: {
'''
if source.count(old_fact) != 1:
    raise SystemExit(f"expected one facts anchor, found {source.count(old_fact)}")
source = source.replace(old_fact, new_fact, 1)

TARGET.write_text(source, encoding="utf-8")
print("RC8_SOURCE_SCOPE_ELEVATION_APPLIED")
