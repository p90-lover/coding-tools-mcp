"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const installerPath = path.join(desktopRoot, "build", "installer.nsh");
const updatePath = path.join(desktopRoot, "electron", "update.cjs");
const workerPath = path.join(desktopRoot, "electron", "update-worker.cjs");
const promptPath = path.join(desktopRoot, "electron", "update-prompt.cjs");
const mainPath = path.join(desktopRoot, "electron", "main.cjs");

const installer = fs.readFileSync(installerPath, "utf8");
const updateSource = fs.readFileSync(updatePath, "utf8");
const workerSource = fs.readFileSync(workerPath, "utf8");
const mainSource = fs.readFileSync(mainPath, "utf8");

test("legacy NSIS and MSI migration preserve one validated old installation directory", () => {
  assert.match(installer, /Var LegacyInstallLocationCaptured/);
  assert.match(installer, /!macro CaptureLegacyInstallLocation ROOT/);
  assert.match(installer, /ReadRegStr[^\n]*InstallLocation/);
  assert.match(installer, /StrCpy \$INSTDIR \$LegacyInstallLocationCaptured/);
  assert.match(installer, /multiple legacy installations use different locations/i);

  const captureCalls = installer.match(/!insertmacro CaptureLegacyInstallLocation \$\{ROOT\}/g) ?? [];
  assert.equal(
    captureCalls.length,
    2,
    "both legacy MSI and legacy NSIS paths must capture and reuse the old location",
  );
});

test("silent Windows auto-update pins NSIS to the directory of the running executable", () => {
  assert.match(
    updateSource,
    /installDirectory:\s*path\.dirname\(executablePath\)/,
    "the update job must retain the exact current installation directory",
  );
  assert.match(workerSource, /function windowsInstallerArguments\(job\)/);
  assert.match(workerSource, /\/D=\$\{installDirectory\}/);
  assert.match(workerSource, /spawnSync\(job\.source,\s*windowsInstallerArguments\(job\)/);

  const helperStart = workerSource.indexOf("function windowsInstallerArguments(job)");
  const silentArgument = workerSource.indexOf('"/S"', helperStart);
  const destinationArgument = workerSource.indexOf("/D=${installDirectory}", helperStart);
  assert.ok(helperStart >= 0 && silentArgument > helperStart && destinationArgument > silentArgument);
  assert.ok(
    workerSource.indexOf("return", destinationArgument) > destinationArgument,
    "NSIS /D must remain the final installer argument",
  );
});

test("stable and beta updates expose a localized native install prompt before downloading", () => {
  assert.equal(fs.existsSync(promptPath), true, "missing native update prompt policy module");
  const { isPrereleaseVersion, updatePromptOptions } = require(promptPath);

  assert.equal(isPrereleaseVersion("0.7.0-rc.9"), true);
  assert.equal(isPrereleaseVersion("0.7.0"), false);
  assert.throws(() => updatePromptOptions({ version: "not-a-version", language: "en" }), /invalid/i);

  const english = updatePromptOptions({ version: "0.7.0-rc.9", language: "en" });
  assert.match(english.title, /beta|prerelease/i);
  assert.match(english.message, /0\.7\.0-rc\.9/);
  assert.deepEqual(english.buttons.length, 2);
  assert.equal(english.defaultId, 0);
  assert.equal(english.cancelId, 1);

  const traditional = updatePromptOptions({ version: "0.7.0-rc.9", language: "zh-TW" });
  assert.match(traditional.title, /Beta|測試|預覽/);
  assert.match(traditional.detail, /安裝|更新/);

  assert.match(mainSource, /async function promptAvailableUpdate/);
  assert.match(mainSource, /updatePromptOptions\(\{/);
  assert.match(mainSource, /dialog\.showMessageBox/);
  assert.match(mainSource, /promptedUpdateVersions/);

  const promptStart = mainSource.indexOf("async function promptAvailableUpdate");
  const promptCall = mainSource.indexOf("dialog.showMessageBox", promptStart);
  const installCall = mainSource.indexOf("updateController.beginInstall()", promptStart);
  assert.ok(promptStart >= 0 && promptCall > promptStart && installCall > promptCall);
});
