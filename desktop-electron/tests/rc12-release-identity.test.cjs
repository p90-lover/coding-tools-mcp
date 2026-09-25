"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8").replace(/\r\n/g, "\n");

test("rc.12 identity source reads stay LF-normalized on Windows checkouts", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc12.yml");
  assert.equal(workflow.includes("\r"), false);
  assert.match(workflow, /\n {2}push:\n {4}branches:\n {6}- main/);
});

test("current product and package identities are aligned at rc.14", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.equal(manifest.version, "0.7.0-rc.14");
  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\.7\.0-rc\.14"/);
  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\.7\.0-rc\.14"/);
  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\.7\.0-rc\.14"/);
});

test("rc.12 exact-source runner publishes a new tag without moving frozen rc.8, rc.9, rc.10, or rc.11 tags", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc12.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.12/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.12/);
  assert.match(workflow, /\n {2}push:\n {4}branches:\n {6}- main/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.11/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.10/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.8/);
  assert.doesNotMatch(workflow, /\bforce\b/);

  const runner = read("aiTemp/rc12-release/run-windows-release.mjs");
  assert.match(runner, /releaseVersion === '0\.7\.0-rc\.12'/);
  assert.match(runner, /releaseTag === 'v0\.7\.0-rc\.12'/);
  assert.match(runner, /docs\/releases\/v0\.7\.0-rc\.12\.md/);
  assert.match(runner, /RC12_WINDOWS_RELEASE_PUBLISHED/);
  assert.match(runner, /branch === 'main'/);
  assert.match(runner, /npmCache = path\.join\(aiTemp, 'cache', 'npm-release-rc12'\)/);
  assert.match(runner, /npm_config_cache: npmCache/);
  assert.match(runner, /NPM_CONFIG_CACHE: npmCache/);
  assert.doesNotMatch(runner, /force/);
  assert.ok(
    workflow.includes("NPM_CONFIG_CACHE: ${{ github.workspace }}/aiTemp/cache/npm-release-rc12"),
    "rc.12 publisher must pin npm cache on the workspace drive",
  );

  const notes = read("docs/releases/v0.7.0-rc.12.md");
  assert.match(notes, /^## English$/m);
  assert.match(notes, /^## 繁體中文$/m);
  assert.match(notes, /v0\.7\.0-rc\.11/);
  assert.match(notes, /never force-moved|永遠唔會被 force-move/);
});

test("rc.12 migration waits for the installer process only and reaps leftover Coding Tools", () => {
  const migration = read("aiTemp/rc12-release/verify-windows-migration.ps1");
  assert.match(migration, /installerTimeoutMilliseconds = 45 \* 60 \* 1000/);
  assert.match(migration, /WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.match(migration, /Stop-Process/);
  assert.match(migration, /Coding Tools\.exe/);
  assert.match(migration, /'\/S', '\/currentuser'/);
  assert.doesNotMatch(migration, /Start-Process[^\n]*-Wait/);
});

test("rc.12 leftover killer matches installer process names only", () => {
  const migration = read("aiTemp/rc12-release/verify-windows-migration.ps1");
  assert.match(migration, /\$keep\[\$PID\] = \$true/);
  assert.match(migration, /Name -ne 'pwsh\.exe'/);
  assert.doesNotMatch(migration, /CommandLine -like '\*Coding\.Tools_\*setup\*'/);
});

test("rc.12 smokes the migrated install instead of a second silent NSIS upgrade", () => {
  const runner = read("aiTemp/rc12-release/run-windows-release.mjs");
  const smoke = runner.indexOf("packaged launcher smoke");
  const migration = runner.indexOf("retained NSIS and MSI migration acceptance");
  assert.ok(migration >= 0, "missing migration gate");
  assert.ok(smoke > migration, "smoke must run after the single migration install");
  assert.match(runner, /CODING_TOOLS_WINDOWS_INSTALL_DONE: '1'/);
  const smokeScript = read("desktop-electron/scripts/smoke-package.cjs");
  assert.match(smokeScript, /CODING_TOOLS_WINDOWS_INSTALL_DONE/);
  assert.match(smokeScript, /run\(installer, \["\/S", "\/currentuser"\]/);
});
