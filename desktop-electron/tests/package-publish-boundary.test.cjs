"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packager = fs.readFileSync(path.join(root, "scripts", "package.cjs"), "utf8");

test("Electron packaging explicitly disables electron-builder publishing and update-provider autodetection", () => {
  assert.equal(
    manifest.build.publish,
    null,
    "build.publish must be null so electron-builder does not infer GitHub update metadata from CI tokens",
  );
  assert.match(packager, /"--publish",\s*\n\s*"never"/);
});

test("the electron-builder child process never receives GitHub release credentials", () => {
  assert.match(packager, /delete env\.GH_TOKEN;/);
  assert.match(packager, /delete env\.GITHUB_TOKEN;/);
  assert.ok(
    packager.indexOf("delete env.GITHUB_TOKEN;") < packager.indexOf("function runChecked"),
    "release credentials must be removed before electron-builder is spawned",
  );
});
