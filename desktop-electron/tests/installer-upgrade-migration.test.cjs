"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(desktopRoot, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const includePath = path.join(desktopRoot, "build", "installer.nsh");

function readInstallerInclude() {
  assert.equal(
    fs.existsSync(includePath),
    true,
    "the Windows package must ship build/installer.nsh for legacy upgrade migration",
  );
  return fs.readFileSync(includePath, "utf8");
}

test("rc.5 keeps the stable Electron installer identity and enables the NSIS migration include", () => {
  assert.equal(manifest.version, "0.7.0-rc.5");
  assert.equal(manifest.build.appId, "dev.codingtools.fullharness");
  assert.equal(manifest.build.productName, "Coding Tools");
  assert.equal(manifest.build.nsis.guid, "3cb2ea96-3319-55b8-95a5-7f180a5f3ed4");
  assert.equal(manifest.build.nsis.include, "build/installer.nsh");
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
});

test("the installer detects the exact legacy Tauri uninstall identity in every registry view", () => {
  const source = readInstallerInclude();
  assert.match(
    source,
    /Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Coding Tools MCP/,
  );
  assert.match(source, /ReadRegStr[^\n]*\$\{ROOT\}/);
  for (const root of ["HKCU", "HKLM"]) {
    for (const view of ["64", "32"]) {
      assert.ok(
        source.includes(`!insertmacro MigrateLegacyInstall ${root} ${view}`),
        `missing ${root} ${view}-bit legacy migration invocation`,
      );
    }
  }
  assert.match(source, /SetRegView 32/);
  assert.match(source, /SetRegView 64/);
  assert.match(source, /DisplayName/);
  assert.match(source, /Coding Tools MCP/);
  assert.match(source, /UninstallString/);
  assert.match(source, /InstallLocation/);
});

test("legacy removal is silent, bounded, fail-closed, and preserves application data", () => {
  const source = readInstallerInclude();
  assert.match(source, /!macro customInit/);
  assert.match(source, /ExecWait[^\n]*\/S/);
  assert.match(source, /Sleep 500/);
  assert.match(source, /LegacyWaitCount >= 60/);
  assert.match(source, /legacy uninstall failed/i);
  assert.match(source, /Abort/);
  assert.match(source, /ReadRegStr[^\n]*UninstallString/);
  assert.doesNotMatch(source, /RMDir\s+\/r/i);
  assert.doesNotMatch(source, /DeleteRegKey/i);
  assert.doesNotMatch(source, /Delete\s+\"?\$LOCALAPPDATA/i);
});

test("the release gate runs a real Windows old-install to reinstall migration smoke", () => {
  const workflowPath = path.resolve(
    desktopRoot,
    "..",
    ".github",
    "workflows",
    "v0.7-installer-upgrade-migration.yml",
  );
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /installer-upgrade-migration\.test\.cjs/);
  assert.match(workflow, /legacy-uninstall-fixture/i);
  assert.match(workflow, /\/S/);
  assert.match(workflow, /Coding\.Tools_0\.7\.0-rc\.5_windows_x64_setup\.exe/);
  assert.match(workflow, /git diff --diff-filter=D/);
});
