"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8").replace(/\r\n/g, "\n");

test("rc.11 identity source reads stay LF-normalized on Windows checkouts", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");
  assert.equal(workflow.includes("\r"), false);
  assert.match(workflow, /\n {2}push:\n {4}branches:\n {6}- main/);
});

test("rc.11 product and package identities are aligned", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.equal(manifest.version, "0.7.0-rc.11");
  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\.7\.0-rc\.11"/);
  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\.7\.0-rc\.11"/);
  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\.7\.0-rc\.11"/);
});

test("rc.11 exact-source runner publishes a new tag without moving frozen rc.8, rc.9, or rc.10 tags", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.11/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.11/);
  assert.match(workflow, /\n {2}push:\n {4}branches:\n {6}- main/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.10/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.8/);
  assert.doesNotMatch(workflow, /\bforce\b/);

  const runner = read("aiTemp/rc11-release/run-windows-release.mjs");
  assert.match(runner, /releaseVersion === '0\.7\.0-rc\.11'/);
  assert.match(runner, /releaseTag === 'v0\.7\.0-rc\.11'/);
  assert.match(runner, /docs\/releases\/v0\.7\.0-rc\.11\.md/);
  assert.match(runner, /RC11_WINDOWS_RELEASE_PUBLISHED/);
  assert.match(runner, /branch === 'main'/);
  assert.match(runner, /npmCache = path\.join\(aiTemp, 'cache', 'npm-release-rc11'\)/);
  assert.match(runner, /npm_config_cache: npmCache/);
  assert.match(runner, /NPM_CONFIG_CACHE: npmCache/);
  assert.doesNotMatch(runner, /force/);
  assert.ok(
    workflow.includes("NPM_CONFIG_CACHE: ${{ github.workspace }}/aiTemp/cache/npm-release-rc11"),
    "rc.11 publisher must pin npm cache on the workspace drive",
  );

  const notes = read("docs/releases/v0.7.0-rc.11.md");
  assert.match(notes, /^## English$/m);
  assert.match(notes, /^## 繁體中文$/m);
  assert.match(notes, /v0\.7\.0-rc\.10/);
  assert.match(notes, /never force-moved|永遠唔會被 force-move/);
});

test("rc.11 migration waits for the installer process only and reaps leftover Coding Tools", () => {
  const migration = read("aiTemp/rc11-release/verify-windows-migration.ps1");
  assert.match(migration, /installerTimeoutMilliseconds = 45 \* 60 \* 1000/);
  assert.match(migration, /WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.match(migration, /Stop-Process/);
  assert.match(migration, /Coding Tools\.exe/);
  assert.match(migration, /'\/S', '\/currentuser'/);
  assert.doesNotMatch(migration, /Start-Process[^\n]*-Wait/);
});
