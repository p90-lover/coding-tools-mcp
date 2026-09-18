"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");

test("frozen rc.10 publisher keeps its tag identity and cannot auto-publish", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc10.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.10/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.10/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n {2}push:\n {4}branches:/);

  const runner = read("aiTemp/rc10-release/run-windows-release.mjs");
  assert.match(runner, /releaseVersion === '0\.7\.0-rc\.10'/);
  assert.match(runner, /releaseTag === 'v0\.7\.0-rc\.10'/);
  assert.match(runner, /docs\/releases\/v0\.7\.0-rc\.10\.md/);
  assert.match(runner, /RC10_WINDOWS_RELEASE_PUBLISHED/);
  assert.doesNotMatch(runner, /force/);
});
