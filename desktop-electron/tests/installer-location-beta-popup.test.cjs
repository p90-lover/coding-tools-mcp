const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.join(__dirname, "..");
const repositoryRoot = path.join(desktopRoot, "..");
const electronRoot = path.join(desktopRoot, "electron");
const updateSource = fs.readFileSync(path.join(electronRoot, "update.cjs"), "utf8");
const workerSource = fs.readFileSync(path.join(electronRoot, "update-worker.cjs"), "utf8");
const mainSource = fs.readFileSync(path.join(electronRoot, "main.cjs"), "utf8");
const installerSource = fs.readFileSync(path.join(desktopRoot, "build", "installer.nsh"), "utf8");
const migrationAcceptanceSource = fs.readFileSync(
  path.join(repositoryRoot, "aiTemp", "rc7-release", "verify-windows-migration.ps1"),
  "utf8",
);

test("Windows detached updater preserves the running installation directory", () => {
  assert.match(
    updateSource,
    /installDirectory:\s*path\.dirname\(executablePath\)/,
    "the verified job must carry the existing executable directory into the detached worker",
  );
  assert.match(workerSource, /function windowsInstallerArguments\(job\)/);
  assert.match(workerSource, /"\/UPDATE"/);
  assert.match(workerSource, /"\/CLOSEAPPLICATIONS"/);
  assert.match(workerSource, /"\/NORESTART"/);
  assert.match(workerSource, /args\.push\(`\/D=\$\{installDirectory\}`\)/);
  assert.match(
    workerSource,
    /spawnSync\(job\.source,\s*windowsInstallerArguments\(job\)/,
    "the worker must use the directory-preserving NSIS arguments",
  );
  assert.match(workerSource, /if \(require\.main === module\)/);

  const { windowsInstallerArguments } = require("../electron/update-worker.cjs");
  const installDirectory = String.raw`C:\Users\Alice Example\Apps\Coding Tools`;
  const args = windowsInstallerArguments({ installDirectory });
  assert.deepEqual(args, [
    "/S",
    "/UPDATE",
    "/CLOSEAPPLICATIONS",
    "/NORESTART",
    `/D=${installDirectory}`,
  ]);
  assert.equal(args.at(-1), `/D=${installDirectory}`, "NSIS requires /D to be the final argument");
});

test("the installer retains the matched legacy install directory before removing old files", () => {
  assert.match(installerSource, /!macro CaptureLegacyInstallLocation ROOT/);
  assert.match(installerSource, /ReadRegStr \$LegacyInstallLocation \$\{ROOT\} "\$LegacyRegistryKey" "InstallLocation"/);
  assert.match(installerSource, /StrCpy \$INSTDIR \$LegacyInstallLocation/);
  assert.match(installerSource, /DetailPrint "Reusing legacy Coding Tools install location: \$INSTDIR"/);
  const capture = installerSource.indexOf("!insertmacro CaptureLegacyInstallLocation ${ROOT}");
  const remove = installerSource.indexOf("!insertmacro RemoveLegacyNsis ${ROOT} ${VIEW}");
  assert.ok(capture >= 0 && remove > capture, "the old directory must be captured before legacy removal");

  assert.match(migrationAcceptanceSource, /legacyLocationReused = \$true/);
  assert.match(migrationAcceptanceSource, /current install location changed from legacy path/i);
});

test("automatic prerelease discovery opens an install-or-later popup", () => {
  assert.match(mainSource, /async function promptForAvailableUpdate\(next, \{ logger, stateStore \}\)/);
  assert.match(mainSource, /stateStore\.read\(\)\.automaticUpdates !== true/);
  assert.match(mainSource, /dialog\.showMessageBox\(mainWindow,/);
  assert.match(mainSource, /buttons:\s*\[copy\.installNow, copy\.later\]/);
  assert.match(mainSource, /void promptForAvailableUpdate\(state, \{ logger, stateStore \}\)/);
  assert.doesNotMatch(
    mainSource,
    /maybeInstallAutomaticUpdate/,
    "automatic checks must ask before replacing the running installation",
  );
});

test("a newer beta remains eligible for the automatic update prompt", () => {
  const { compareVersions, selectCompatibleRelease } = require("../electron/update.cjs");
  assert.equal(compareVersions("0.7.0-rc.8", "0.7.0-rc.7"), 1);
  const selected = selectCompatibleRelease([{
    tag_name: "v0.7.0-rc.8",
    prerelease: true,
    draft: false,
    assets: [
      {
        name: "Coding.Tools_0.7.0-rc.8_windows_x64_setup.exe",
        browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.8/Coding.Tools_0.7.0-rc.8_windows_x64_setup.exe",
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.8/SHA256SUMS.txt",
      },
    ],
  }], "win32", "x64");
  assert.equal(selected?.version, "0.7.0-rc.8");
});
