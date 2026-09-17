"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
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

test("rc.7 keeps the stable Electron installer identity and enables the NSIS migration include", () => {
  assert.equal(manifest.version, "0.7.0-rc.7");
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
    /!define LEGACY_UNINSTALL_ROOT "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"/,
  );
  assert.match(source, /!define LEGACY_PRODUCT_NAME "Coding Tools MCP"/);
  assert.match(source, /EnumRegKey[^\n]*LEGACY_UNINSTALL_ROOT/);
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

test("the authoritative release workflow delegates to the exact-source Windows migration gate", () => {
  const workflowPath = path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "codex-router-multiprovider-release-rc7.yml",
  );
  const releaseRunnerPath = path.join(
    repositoryRoot,
    "aiTemp",
    "rc7-release",
    "run-windows-release.mjs",
  );
  const migrationRunnerPath = path.join(
    repositoryRoot,
    "aiTemp",
    "rc7-release",
    "verify-windows-migration.ps1",
  );
  const fixtureScriptPath = path.join(
    desktopRoot,
    "scripts",
    "create-legacy-uninstall-fixture.ps1",
  );

  const workflow = fs.readFileSync(workflowPath, "utf8");
  const releaseRunner = fs.readFileSync(releaseRunnerPath, "utf8");
  const migrationRunner = fs.readFileSync(migrationRunnerPath, "utf8");
  const fixtureScript = fs.readFileSync(fixtureScriptPath, "utf8");

  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /run-windows-release\.mjs/);
  assert.match(workflow, /verify-windows-migration\.ps1/);
  assert.match(
    workflow,
    /concurrency:[\s\S]*?cancel-in-progress:\s*true/,
    "a newer rc.7 source must cancel stale Windows release runs",
  );

  assert.match(releaseRunner, /installer-upgrade-migration\.test\.cjs/);
  assert.match(releaseRunner, /verify-windows-migration\.ps1/);
  assert.ok(
    releaseRunner.includes("Coding.Tools_${releaseVersion}_windows_x64_setup.exe"),
    "the exact-source release runner must derive the rc.7 Windows installer filename",
  );
  assert.match(releaseRunner, /--diff-filter=D/);

  assert.match(migrationRunner, /create-legacy-uninstall-fixture\.ps1/);
  assert.match(migrationRunner, /legacy-uninstall-fixture/i);
  assert.match(migrationRunner, /'\/S', '\/currentuser'/);
  assert.match(migrationRunner, /CODING_TOOLS_LEGACY_TRASH_DIR/);
  assert.match(migrationRunner, /legacyUninstallerPreserved/);
  assert.match(migrationRunner, /RC7_WINDOWS_MIGRATION_ACCEPTANCE_OK/);

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

test("renderer verification uses an isolated aiTemp output before the package build", () => {
  const releaseRunnerPath = path.join(
    repositoryRoot,
    "aiTemp",
    "rc7-release",
    "run-windows-release.mjs",
  );
  const releaseRunner = fs.readFileSync(releaseRunnerPath, "utf8");

  assert.match(
    releaseRunner,
    /const verificationRenderer = path\.join\(aiTemp, 'rc7-release', 'renderer-dist', sourceSha\);/,
    "verification renderer output must be isolated under aiTemp and source-scoped",
  );
  assert.match(
    releaseRunner,
    /\['x', 'vite', 'build', '--outDir', verificationRenderer, '--emptyOutDir', 'false'\]/,
    "verification renderer must use a dedicated non-emptying Vite output",
  );
  assert.match(
    releaseRunner,
    /CODING_TOOLS_RENDERER_DIST:\s*verificationRenderer/,
    "the bundle contract must inspect the isolated verification renderer",
  );
  assert.doesNotMatch(
    releaseRunner,
    /run\('bun', \['run', 'build:renderer'\]/,
    "the release runner must not build desktop-electron/dist before package:win",
  );
});
