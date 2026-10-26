"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const RELEASE_VERSION = JSON.parse(read("package.json")).version;
const STALE_VERSIONS = ["0.7.0-rc.8", "0.7.0-rc.9", "0.7.0-rc.10", "0.7.0-rc.11", "0.7.0-rc.12", "0.7.0-rc.14", "0.7.0-rc.15", "0.7.0-rc.16", "0.7.0-rc.17", "0.7.0-rc.18", "0.7.0-rc.19", "0.7.0-rc.20", "0.7.0-rc.21", "0.7.0-rc.22", "0.7.0-rc.23", "0.7.0-rc.24", "0.7.0-rc.25", "0.7.0-rc.26", "0.7.0-rc.27", "0.7.0-rc.28", "0.7.0-rc.29", "0.7.0-rc.30", "0.7.0-rc.31", "0.8.0", "0.8.1", "0.8.2", "0.8.24"];

const activeIdentityFiles = [
  "electron/product.cjs",
  "scripts/prepare-package-resources.cjs",
  "scripts/verify-package.cjs",
  "tests/product-identity.test.cjs",
];

test("the rc.14 manifest and every active package identity use one release version", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.version, RELEASE_VERSION);

  for (const relativePath of activeIdentityFiles) {
    const source = read(relativePath);
    const expectedVersionPattern = RELEASE_VERSION.replaceAll(".", "\\.");
    assert.match(source, new RegExp(`${expectedVersionPattern}(?![0-9])`), `${relativePath} must declare ${RELEASE_VERSION}`);
    for (const stale of STALE_VERSIONS) {
      // A whole version only: "0.8.1" must not match the current "0.8.24".
      const escaped = stale.replaceAll(".", "\\.");
      assert.doesNotMatch(source, new RegExp(`${escaped}(?![0-9])`), `${relativePath} still declares ${stale}`);
    }
  }
  for (const relativePath of ["tests/package-contents.test.cjs", "tests/package-resource-preparation.test.cjs"]) {
    assert.match(read(relativePath), /const PRODUCT_VERSION = require\("\.\.\/package\.json"\)\.version;/,
      `${relativePath} must derive its version from the package manifest`);
  }
});

test("the installer migration contract names the current rc.14 release", () => {
  const source = read("tests/installer-upgrade-migration.test.cjs");
  assert.match(source, /rc\.14 keeps the stable Electron installer identity/);
  assert.match(source, /manifest\.version, PRODUCT_IDENTITY\.version/);
  assert.match(source, /require\("\.\.\/electron\/product\.cjs"\)/);
});

test("frozen RC11/RC12 publishers require manual dispatch and exact matching source versions", () => {
  for (const rc of ["11", "12"]) {
    const file = path.resolve(desktopRoot, "..", ".github", "workflows",
      `codex-router-multiprovider-release-rc${rc}.yml`);
    const workflow = fs.readFileSync(file, "utf8");
    assert.match(workflow, /^  workflow_dispatch:\s*$/m);
    assert.doesNotMatch(workflow, /^  push:\s*$/m, "old RC publishers must not run on a new main version");
    assert.match(workflow, /Require the exact frozen RC source version/);
    assert.match(workflow, /\$manifest\.version -ne \$env:RELEASE_VERSION/);
  }
});
