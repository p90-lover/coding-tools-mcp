"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const runner = fs.readFileSync(
  path.join(repositoryRoot, "aiTemp", "rc8-release", "run-windows-release.mjs"),
  "utf8",
);
const verifier = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "release", "verify-assets.mjs"),
  "utf8",
);

const WORKFLOW = ".github/workflows/codex-router-multiprovider-release-rc8.yml";

test("rc.8 exports its exact validation workflow into release-asset verification", () => {
  assert.match(verifier, /process\.env\.VALIDATION_WORKFLOW/);
  assert.match(
    runner,
    /VALIDATION_WORKFLOW:\s*'\.github\/workflows\/codex-router-multiprovider-release-rc8\.yml'/,
  );
  assert.ok(runner.split(WORKFLOW).length >= 4);
});
