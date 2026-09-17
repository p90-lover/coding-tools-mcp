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

test("rc.6 keeps the stable Electron installer identity and enables the NSIS migration include", () => {
  assert.equal(manifest.version, "0.7.0-rc.6");
  assert.equal(manifest.build.appId, "dev.codingtools.fullharness");
  assert.equal(manifest.build.productName, "Coding Tools");
  assert.equal(manifest.build.nsis.guid, "3cb2ea96-3319-55b8-95a5-7f180a5f3ed4");
  assert.equal(manifest.build.nsis.include, "build/installer.nsh");
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
});

test("migration code is excluded from electron-builder's BUILD_UNINSTALLER pass", () => {
  const source = readInstallerInclude();
  const guardStart = source.indexOf("!ifndef BUILD_UNINSTALLER");
  const firstVariable = source.indexOf("Var LegacyDisplayName");
  const customInit = source.indexOf("!macro customInit");
  const guardEnd = source.lastIndexOf("!endif");
  assert.ok(guardStart >= 0, "missing BUILD_UNINSTALLER exclusion guard");
  assert.ok(firstVariable > guardStart, "legacy variables must be inside the installer-only guard");
  assert.ok(customInit > firstVariable, "customInit must remain inside the installer-only guard");
  assert.ok(guardEnd > customInit, "installer-only guard must close after customInit");
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
  assert.match(
    source,
    /\$\{Unless\}\s+\$\{FileExists\}\s+"\$LegacyInstallLocation\\uninstall\.exe"/,
  );
  assert.doesNotMatch(
    source,
    /IfFileExists\s+"\$LegacyInstallLocation\\uninstall\.exe"\s+\+2\s+0/,
  );
  assert.doesNotMatch(source, /RMDir\s+\/r/i);
  assert.doesNotMatch(source, /DeleteRegKey/i);
  assert.doesNotMatch(source, /Delete\s+\"?\$LOCALAPPDATA/i);
});

test("the authoritative release gate runs a real no-delete Windows old-install to reinstall migration smoke", () => {
  const workflowPath = path.resolve(
    desktopRoot,
    "..",
    ".github",
    "workflows",
    "codex-router-multiprovider-release-rc6-csc.yml",
  );
  const fixtureScriptPath = path.resolve(
    desktopRoot,
    "scripts",
    "create-legacy-uninstall-fixture.ps1",
  );
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const fixtureScript = fs.readFileSync(fixtureScriptPath, "utf8");

  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /installer-upgrade-migration\.test\.cjs/);
  assert.match(workflow, /create-legacy-uninstall-fixture\.ps1/);
  assert.match(workflow, /legacy-uninstall-fixture/i);
  assert.match(workflow, /\/S/);
  assert.match(workflow, /Coding\.Tools_0\.7\.0-rc\.6_windows_x64_setup\.exe/);
  assert.match(workflow, /CODING_TOOLS_LEGACY_TRASH_DIR/);
  assert.match(workflow, /legacyUninstallerPreserved/);
  assert.match(workflow, /git diff --diff-filter=D/);

  assert.ok(
    fixtureScript.includes("Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),
    "the Windows migration fixture must use the built-in Framework64 C# compiler",
  );
  assert.match(fixtureScript, /\/target:exe/);
  assert.match(fixtureScript, /\/out:/);
  assert.match(fixtureScript, /Wait-Process -Id/);
  assert.match(fixtureScript, /Move-Item/);
  assert.match(fixtureScript, /LEGACY_FIXTURE_READY/);
  assert.doesNotMatch(
    fixtureScript,
    /Add-Type[^\n]*OutputType\s+ConsoleApplication/,
  );
  assert.doesNotMatch(fixtureScript, /File\.Delete\(/);
});
