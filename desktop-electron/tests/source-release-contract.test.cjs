"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REQUIRED_ASAR_FILES } = require("../scripts/verify-package.cjs");

test("every required ASAR verifier entry is backed by current Electron source", () => {
  assert.ok(Array.isArray(REQUIRED_ASAR_FILES) && REQUIRED_ASAR_FILES.length > 0);
  for (const relativePath of REQUIRED_ASAR_FILES) {
    const source = path.resolve(__dirname, "..", ...relativePath.split("/"));
    assert.equal(fs.statSync(source).isFile(), true, `missing required source file: ${relativePath}`);
  }
  for (const stale of [
    "electron/migration-manager.cjs",
    "electron/rollback-manager.cjs",
    "electron/rust-core-client.cjs",
    "electron/rust-core-state.cjs",
    "electron/rust-core-supervisor.cjs",
  ]) assert.equal(REQUIRED_ASAR_FILES.includes(stale), false, `stale verifier entry: ${stale}`);
});
