"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const installerPath = path.join(desktopRoot, "build", "installer.nsh");
const updatePath = path.join(desktopRoot, "electron", "update.cjs");
const workerPath = path.join(desktopRoot, "electron", "update-worker.cjs");
const mainPath = path.join(desktopRoot, "electron", "main.cjs");

const installer = fs.readFileSync(installerPath, "utf8");
const updateSource = fs.readFileSync(updatePath, "utf8");
const workerSource = fs.readFileSync(workerPath, "utf8");
const mainSource = fs.readFileSync(mainPath, "utf8");

test("legacy NSIS and MSI migration reuse the registered old installation directory", () => {
  assert.match(installer, /!macro CaptureLegacyInstallLocation ROOT/);
  assert.match(installer, /ReadRegStr[^\n]*InstallLocation/);
  assert.match(installer, /StrCpy \$INSTDIR \$LegacyInstallLocation/);
  assert.match(installer, /Reusing legacy Coding Tools install location/);

  const migrationStart = installer.indexOf("!macro MigrateLegacyInstall ROOT VIEW");
  const capture = installer.indexOf("!insertmacro CaptureLegacyInstallLocation ${ROOT}", migrationStart);
  const providerDispatch = installer.indexOf("ReadRegDWORD $LegacyWindowsInstaller", migrationStart);
  assert.ok(
    migrationStart >= 0 && capture > migrationStart && providerDispatch > capture,
    "the old install directory must be captured before either MSI or NSIS removal",
  );
});

test("silent Windows auto-update pins NSIS to the running executable directory", () => {
  assert.match(
    updateSource,
    /installDirectory:\s*path\.dirname\(executablePath\)/,
    "the detached update job must retain the exact current installation directory",
  );
  assert.match(workerSource, /function windowsInstallerArguments\(job\)/);
  assert.match(workerSource, /args\.push\(`\/D=\$\{installDirectory\}`\)/);
  assert.match(workerSource, /spawnSync\(job\.source,\s*windowsInstallerArguments\(job\)/);
  assert.match(workerSource, /if \(require\.main === module\)/);

  const { windowsInstallerArguments } = require(workerPath);
  const installDirectory = String.raw`C:\Users\Alice Example\Apps\Coding Tools`;
  const args = windowsInstallerArguments({ installDirectory });
  assert.deepEqual(args, [
    "/S",
    "/UPDATE",
    "/CLOSEAPPLICATIONS",
    "/NORESTART",
    `/D=${installDirectory}`,
  ]);
  assert.equal(args.at(-1), `/D=${installDirectory}`, "NSIS /D must be the final argument");
  assert.throws(
    () => windowsInstallerArguments({ installDirectory: "relative\\path" }),
    /absolute install directory/i,
  );
});

test("a detected beta update opens a localized install-or-later popup before download", () => {
  assert.match(mainSource, /async function promptForAvailableUpdate\(next, \{ logger, stateStore \}\)/);
  assert.match(mainSource, /dialog\.showMessageBox\(mainWindow,/);
  assert.match(mainSource, /buttons:\s*\[copy\.installNow, copy\.later\]/);
  assert.match(mainSource, /Coding Tools beta update/);
  assert.match(mainSource, /Coding Tools 測試版更新/);
  assert.match(mainSource, /void promptForAvailableUpdate\(state, \{ logger, stateStore \}\)/);
  assert.doesNotMatch(
    mainSource,
    /maybeInstallAutomaticUpdate/,
    "automatic checks must prompt instead of silently replacing the running installation",
  );

  const promptStart = mainSource.indexOf("async function promptForAvailableUpdate");
  const promptCall = mainSource.indexOf("dialog.showMessageBox", promptStart);
  const installCall = mainSource.indexOf("updateController.beginInstall()", promptStart);
  assert.ok(promptStart >= 0 && promptCall > promptStart && installCall > promptCall);
});

test("prerelease discovery keeps a newer beta eligible for the popup", () => {
  const { compareVersions, selectCompatibleRelease } = require(updatePath);
  assert.equal(compareVersions("0.7.0-rc.9", "0.7.0-rc.8"), 1);
  assert.equal(compareVersions("0.7.0", "0.7.0-rc.9"), 1);

  const selected = selectCompatibleRelease([{
    tag_name: "v0.7.0-rc.9",
    prerelease: true,
    draft: false,
    assets: [
      {
        name: "Coding.Tools_0.7.0-rc.9_windows_x64_setup.exe",
        browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.9/Coding.Tools_0.7.0-rc.9_windows_x64_setup.exe",
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.9/SHA256SUMS.txt",
      },
    ],
  }], "win32", "x64");
  assert.equal(selected?.version, "0.7.0-rc.9");
});
