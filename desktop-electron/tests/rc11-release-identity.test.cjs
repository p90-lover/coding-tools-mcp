"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");

test("rc.11 release history remains immutable and non-publishing", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");
  const notes = read("docs/releases/v0.7.0-rc.11.md");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.11/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.11/);
  assert.match(workflow, /workflow_dispatch/);
  assert.doesNotMatch(workflow, /publish-v0\.6\.0-rc\.1/);
  assert.doesNotMatch(workflow, /git push[^\n]*--force/);
  assert.match(notes, /Coding Tools v0\.7\.0-rc\.11/);
});
