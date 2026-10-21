"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const RELEASE_VERSION = "0.8.5";
const STALE_VERSIONS = ["0.7.0-rc.8", "0.7.0-rc.9", "0.7.0-rc.10", "0.7.0-rc.11", "0.7.0-rc.12", "0.7.0-rc.14", "0.7.0-rc.15", "0.7.0-rc.16", "0.7.0-rc.17", "0.7.0-rc.18", "0.7.0-rc.19", "0.7.0-rc.20", "0.7.0-rc.21", "0.7.0-rc.22", "0.7.0-rc.23", "0.7.0-rc.24", "0.7.0-rc.25", "0.7.0-rc.26", "0.7.0-rc.27", "0.7.0-rc.28", "0.7.0-rc.29", "0.7.0-rc.30", "0.7.0-rc.31", "0.8.0", "0.8.1", "0.8.2"];

const activeIdentityFiles = [
  "electron/product.cjs",
  "scripts/prepare-package-resources.cjs",
  "scripts/verify-package.cjs",
  "tests/product-identity.test.cjs",
  "tests/package-contents.test.cjs",
  "tests/package-resource-preparation.test.cjs",
  "tests/installer-upgrade-migration.test.cjs",
];

test("the rc.14 manifest and every active package identity use one release version", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.version, RELEASE_VERSION);

  for (const relativePath of activeIdentityFiles) {
    const source = read(relativePath);
    assert.match(source, /0\.8\.5/, `${relativePath} must declare ${RELEASE_VERSION}`);
    for (const stale of STALE_VERSIONS) {
      const escaped = stale.replaceAll(".", "\\.");
      assert.doesNotMatch(source, new RegExp(escaped), `${relativePath} still declares ${stale}`);
    }
  }
});

test("the installer migration contract names the current rc.14 release", () => {
  const source = read("tests/installer-upgrade-migration.test.cjs");
  assert.match(source, /rc\.14 keeps the stable Electron installer identity/);
  assert.match(source, /manifest\.version, "0\.8\.5"/);
});
