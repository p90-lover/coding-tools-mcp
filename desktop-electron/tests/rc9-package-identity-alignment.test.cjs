"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const RELEASE_VERSION = "0.7.0-rc.11";
const STALE_VERSIONS = ["0.7.0-rc.8", "0.7.0-rc.9", "0.7.0-rc.10"];

const activeIdentityFiles = [
  "electron/product.cjs",
  "scripts/prepare-package-resources.cjs",
  "scripts/verify-package.cjs",
  "tests/product-identity.test.cjs",
  "tests/package-contents.test.cjs",
  "tests/package-resource-preparation.test.cjs",
  "tests/installer-upgrade-migration.test.cjs",
];

test("the rc.11 manifest and every active package identity use one release version", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.version, RELEASE_VERSION);

  for (const relativePath of activeIdentityFiles) {
    const source = read(relativePath);
    assert.match(source, /0\.7\.0-rc\.11/, `${relativePath} must declare ${RELEASE_VERSION}`);
    for (const stale of STALE_VERSIONS) {
      const escaped = stale.replaceAll(".", "\\.");
      assert.doesNotMatch(source, new RegExp(escaped), `${relativePath} still declares ${stale}`);
    }
  }
});

test("the installer migration contract names the current rc.11 release", () => {
  const source = read("tests/installer-upgrade-migration.test.cjs");
  assert.match(source, /rc\.11 keeps the stable Electron installer identity/);
  assert.match(source, /manifest\.version, "0\.7\.0-rc\.11"/);
});
