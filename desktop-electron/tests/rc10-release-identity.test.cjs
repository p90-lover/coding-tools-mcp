"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");

test("rc.10 product and package identities are aligned", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.equal(manifest.version, "0.7.0-rc.10");
  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\.7\.0-rc\.10"/);
  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\.7\.0-rc\.10"/);
  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\.7\.0-rc\.10"/);
});

test("rc.10 exact-source runner publishes a new tag without moving frozen rc.8 or rc.9 tags", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc10.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.10/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.10/);
  assert.match(workflow, /release\/codex-router-multiprovider-0\.7\.0-rc\.8/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.8/);

  const frozen = read(".github/workflows/codex-router-multiprovider-release-rc8.yml");
  assert.match(frozen, /workflow_dispatch:/);
  assert.doesNotMatch(frozen, /\n {2}push:\n {4}branches:\n {6}- release\/codex-router-multiprovider-0\.7\.0-rc\.8/);

  const runner = read("aiTemp/rc10-release/run-windows-release.mjs");
  assert.match(runner, /releaseVersion === '0\.7\.0-rc\.10'/);
  assert.match(runner, /releaseTag === 'v0\.7\.0-rc\.10'/);
  assert.match(runner, /docs\/releases\/v0\.7\.0-rc\.10\.md/);
  assert.match(runner, /RC10_WINDOWS_RELEASE_PUBLISHED/);
  assert.doesNotMatch(runner, /force/);
});
