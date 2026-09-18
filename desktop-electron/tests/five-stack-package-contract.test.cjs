"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const {
  EXPECTED_INTEGRATIONS,
  REQUIRED_FIVE_STACK_ASAR_FILES,
  assertRequiredEntries,
  validateManifestObjects,
} = require("../scripts/verify-five-stack-package.cjs");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, relativePath), "utf8"));
}

test("Windows package verification requires every five-stack runtime boundary", () => {
  assert.deepEqual(REQUIRED_FIVE_STACK_ASAR_FILES, [
    "electron/main-with-provider.cjs",
    "electron/main.cjs",
    "electron/preload.cjs",
    "electron/runtime-supervisor.cjs",
    "electron/provider-bootstrap.cjs",
    "electron/provider-execution-router.cjs",
    "electron/provider-network.cjs",
    "electron/upstream-tools.cjs",
    "electron/ipc-schema.cjs",
    "vendor/upstream/five-stack.json",
    "vendor/upstream/paseo.json",
    "vendor/upstream/anneal.json",
  ]);
  assert.equal(assertRequiredEntries(REQUIRED_FIVE_STACK_ASAR_FILES), 12);
  assert.throws(
    () => assertRequiredEntries(REQUIRED_FIVE_STACK_ASAR_FILES.slice(1)),
    /FIVE_STACK_ASAR_REQUIRED_FILE_MISSING: electron\/main-with-provider\.cjs/,
  );
});

test("the packaged application includes valid pinned five-stack manifests", () => {
  const packageJson = readJson("package.json");
  const stack = readJson("vendor/upstream/five-stack.json");
  const paseo = readJson("vendor/upstream/paseo.json");
  const anneal = readJson("vendor/upstream/anneal.json");

  assert.ok(packageJson.build.files.includes("vendor/upstream/**"));
  const result = validateManifestObjects(stack, paseo, anneal);
  assert.deepEqual(result.integrations, EXPECTED_INTEGRATIONS);
  assert.equal(result.paseoCommit, paseo.commit);
  assert.equal(result.annealCommit, anneal.commit);
});
