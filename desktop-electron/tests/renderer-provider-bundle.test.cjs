"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const assets = path.join(root, "dist", "assets");

test("packaged renderer selects Provider Hub and project-scoped update copy", () => {
  const scripts = fs.readdirSync(assets)
    .filter((name) => /^index-.*\.js$/u.test(name))
    .sort();
  assert.equal(scripts.length, 1, `expected one renderer entry script, got ${scripts.join(", ")}`);
  const bundle = fs.readFileSync(path.join(assets, scripts[0]), "utf8");
  assert.match(bundle, /data-provider-account-summary/);
  assert.match(bundle, /Refresh accounts/);
  assert.match(bundle, /Coding Tools v/);
  assert.doesNotMatch(bundle, /coding-tools-provider-instances-v1/);
});
