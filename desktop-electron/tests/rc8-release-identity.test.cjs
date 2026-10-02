"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");

// Introduced for rc.8; the release version moves on, so every copy is checked against package.json.
test("product and package identities carry the package.json version", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-rc\.\d+)?$/);
  assert.ok(read("desktop-electron/electron/product.cjs").includes(`version: "${manifest.version}"`));
  assert.ok(read("desktop-electron/scripts/prepare-package-resources.cjs").includes(`PRODUCT_VERSION = "${manifest.version}"`));
  assert.ok(read("desktop-electron/scripts/verify-package.cjs").includes(`version: "${manifest.version}"`));
});

test("rc.8 exact-source runner covers the completed architecture-B stack", () => {
  const runner = read("aiTemp/rc8-release/run-windows-release.mjs");
  assert.match(runner, /releaseVersion === '0\.7\.0-rc\.8'/);
  assert.match(runner, /external-services-control-plane\.test\.cjs/);
  assert.match(runner, /five-stack-routing-completion\.test\.cjs/);
  assert.match(runner, /package-publish-boundary\.test\.cjs/);
  assert.match(runner, /RC8_WINDOWS_RELEASE_PUBLISHED/);
});
