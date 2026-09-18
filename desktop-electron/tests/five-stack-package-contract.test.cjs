"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const { REQUIRED_ASAR_FILES } = require("../scripts/verify-package.cjs");

const REQUIRED_FIVE_STACK_ASAR_FILES = Object.freeze([
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, relativePath), "utf8"));
}

test("Windows package verification requires every five-stack runtime boundary", () => {
  const missing = REQUIRED_FIVE_STACK_ASAR_FILES.filter(
    (relativePath) => !REQUIRED_ASAR_FILES.includes(relativePath),
  );
  assert.deepEqual(missing, []);
});

test("the packaged application includes the pinned five-stack manifests", () => {
  const packageJson = readJson("package.json");
  const stack = readJson("vendor/upstream/five-stack.json");
  const paseo = readJson("vendor/upstream/paseo.json");
  const anneal = readJson("vendor/upstream/anneal.json");

  assert.ok(packageJson.build.files.includes("vendor/upstream/**"));
  assert.deepEqual(
    stack.integrations.map((integration) => integration.id),
    ["codex-router", "cpa-provider-hub", "commandcode-proxy", "paseo", "anneal"],
  );
  assert.equal(paseo.managed.strategy, "pinned-source");
  assert.equal(anneal.managed.strategy, "pinned-source");
});
