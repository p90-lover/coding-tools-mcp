"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const manifest = require("../package.json");
const { artifactNameFor, macBundlePaths } = require("../scripts/smoke-artifact-contract.cjs");

test("resolves native package names and macOS bundle paths from the active Electron contract", () => {
  const common = { template: manifest.build.artifactName, version: manifest.version, arch: "x64" };
  assert.equal(
    artifactNameFor({ ...common, os: "win", extension: "exe" }),
    `Coding.Tools_${manifest.version}_win_x64.exe`,
  );
  assert.equal(
    artifactNameFor({ ...common, os: "mac", extension: "zip" }),
    `Coding.Tools_${manifest.version}_mac_x64.zip`,
  );
  assert.equal(
    artifactNameFor({ ...common, os: "linux", extension: "AppImage" }),
    `Coding.Tools_${manifest.version}_linux_x64.AppImage`,
  );
  const stage = path.join("tmp", "smoke-stage");
  const paths = macBundlePaths({ stage, productName: manifest.build.productName });
  assert.equal(paths.appBundle, path.join(stage, "Coding Tools.app"));
  assert.equal(paths.executable, path.join(stage, "Coding Tools.app", "Contents", "MacOS", "Coding Tools"));
});
