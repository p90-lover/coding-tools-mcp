"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

test("the Windows package includes the verified Keysmith release and license", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
  assert.ok(manifest.build.extraResources.some((entry) =>
    entry.from === "assets/keysmith" && entry.to === "codex-keysmith"));

  const bundle = path.join(desktopRoot, "assets", "keysmith");
  const script = fs.readFileSync(path.join(bundle, "codex-instruct-v0.6.0.py"));
  assert.equal(crypto.createHash("sha256").update(script).digest("hex"),
    "837ec25713851a2fb6d8646dd078ee03a2e23fe17b19e97e093cedb02349979d");
  assert.match(fs.readFileSync(path.join(bundle, "LICENSE"), "utf8"), /Permission is hereby granted/);
});
