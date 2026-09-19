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
const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));

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
    "the old install directory must be captured before MSI or NSIS removal",
  );
});

test("silent Windows update pins NSIS to the running executable directory", () => {
  assert.match(updateSource, /installDirectory:\s*path\.dirname\(executablePath\)/);
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
  assert.equal(args.at(-1), `/D=${installDirectory}`);
  assert.throws(
    () => windowsInstallerArguments({ installDirectory: "relative\\path" }),
    /must be absolute/i,
  );
});

test("a discovered prerelease prompts Install Now or Later before download", () => {
  assert.match(mainSource, /async function promptForAvailableUpdate\(next, \{ logger, stateStore \}\)/);
  assert.match(mainSource, /dialog\.showMessageBox\(mainWindow,/);
  assert.match(mainSource, /buttons:\s*\[copy\.installNow, copy\.later\]/);
  assert.match(mainSource, /Coding Tools beta update/);
  assert.match(mainSource, /Coding Tools 測試版更新/);
  assert.match(mainSource, /void promptForAvailableUpdate\(state, \{ logger, stateStore \}\)/);
  assert.doesNotMatch(mainSource, /maybeInstallAutomaticUpdate/);

  const promptStart = mainSource.indexOf("async function promptForAvailableUpdate");
  const promptCall = mainSource.indexOf("dialog.showMessageBox", promptStart);
  const installCall = mainSource.indexOf("updateController.beginInstall()", promptStart);
  assert.ok(promptStart >= 0 && promptCall > promptStart && installCall > promptCall);
});

test("current prerelease discovery keeps a newer beta eligible", () => {
  const { compareVersions, selectCompatibleRelease } = require(updatePath);
  const current = manifest.version;
  const older = current.replace(/\.\d+$/u, (value) => {
    const previous = Math.max(0, Number(value.slice(1)) - 1);
    return `.${String(previous).padStart(value.length - 1, "0")}`;
  });
  assert.equal(compareVersions(current, older), 1);
  assert.equal(compareVersions("0.7.0", current), 1);

  const installerName = `Coding.Tools_${current}_windows_x64_setup.exe`;
  const selected = selectCompatibleRelease([{
    tag_name: `v${current}`,
    prerelease: true,
    draft: false,
    assets: [
      {
        name: installerName,
        browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${current}/${installerName}`,
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${current}/SHA256SUMS.txt`,
      },
    ],
  }], "win32", "x64");
  assert.equal(selected?.version, current);
});

test("the current-main successor retains every tracked file", () => {
  const workflow = fs.readFileSync(
    path.resolve(desktopRoot, "..", ".github", "workflows", "rc11-install-location-beta-update.yml"),
    "utf8",
  );
  assert.match(workflow, /git diff --diff-filter=D/);
  assert.match(workflow, /test -z/);
  assert.match(workflow, /rc11-install-location-beta-update\.test\.cjs/);
});
