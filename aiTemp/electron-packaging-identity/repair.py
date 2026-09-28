"""Adapt the pinned launcher packaging contract to Plan C product ownership.

The upstream installer remains checked against its pinned upstream manifest.  The
rebranded DEV profile launches the primary Coding Tools Electron application, so
its Windows registry GUID must be checked against desktop-electron/package.json.
The original adapted test is retained under Trash/ before modification.
"""
from pathlib import Path
import os
import shutil
import subprocess

path = Path("runtime-web/launcher/tests/packaging-contract.test.cjs")
source = path.read_text(encoding="utf-8")
manifest_anchor = (
    'const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));\n'
)
manifest_insert = manifest_anchor + (
    'const primaryLauncherManifest = JSON.parse(\n'
    '  fs.readFileSync(path.join(repositoryRoot, "..", "desktop-electron", "package.json"), "utf8"),\n'
    ');\n'
)
old_assertion = (
    '  assert.ok(devProfile.includes(`WINDOWS_LAUNCHER_GUID = "${manifest.build.nsis.guid}"`));'
)
new_assertion = (
    '  assert.ok(\n'
    '    devProfile.includes(\n'
    '      `WINDOWS_LAUNCHER_GUID = "${primaryLauncherManifest.build.nsis.guid}"`,\n'
    '    ),\n'
    '  );'
)

assert source.count(manifest_anchor) == 1
assert source.count(old_assertion) == 1
assert "primaryLauncherManifest" not in source
updated = source.replace(manifest_anchor, manifest_insert, 1).replace(
    old_assertion, new_assertion, 1
)

backup = (
    Path("Trash/electron-packaging-identity")
    / os.environ["GITHUB_RUN_ID"]
    / path
)
backup.parent.mkdir(parents=True, exist_ok=True)
assert not backup.exists(), f"Refusing to overwrite retained original: {backup}"
assert not path.is_symlink(), f"Refusing to rewrite symlink: {path}"
shutil.copy2(path, backup)
path.write_text(updated, encoding="utf-8")

subprocess.run(["git", "add", "--", str(path), str(backup)], check=True)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
assert not subprocess.check_output(
    ["git", "diff", "--cached", "--diff-filter=D", "--name-only"]
).strip()
print(
    "PACKAGING_IDENTITY_REPAIR_PASS: pinned installer identity retained; "
    "DEV profile now checked against the primary Coding Tools manifest"
)
