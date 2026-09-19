"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");

test("rc.12 product, package, and browser/network fixes are aligned", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.equal(manifest.version, "0.7.0-rc.12");
  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\.7\.0-rc\.12"/);
  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\.7\.0-rc\.12"/);
  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\.7\.0-rc\.12"/);
  assert.match(read("desktop-electron/tests/browser-surface-ipc.test.cjs"), /stale main process hides and restores/);
  assert.match(read("desktop-electron/tests/network-proxy-localization.test.cjs"), /Traditional Chinese/);
});

test("rc.12 publishes a new immutable tag without rewriting rc.11", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc12.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.12/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.12/);
  assert.match(workflow, /aiTemp\/rc12-release\/run-windows-release\.mjs/);
  assert.match(workflow, /browser-surface-ipc\.test\.cjs/);
  assert.match(workflow, /network-proxy-localization\.test\.cjs/);
  assert.doesNotMatch(workflow, /git push[^\n]*--force/);

  const historical = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");
  assert.match(historical, /RELEASE_TAG: v0\.7\.0-rc\.11/);
  assert.doesNotMatch(historical, /publish-v0\.6\.0-rc\.1/);
});
