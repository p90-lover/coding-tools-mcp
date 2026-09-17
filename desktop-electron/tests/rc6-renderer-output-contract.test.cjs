"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/codex-router-multiprovider-release-rc6-csc.yml",
);

function releaseWorkflow() {
  return fs.readFileSync(workflowPath, "utf8");
}

test("rc.6 release gate builds the renderer at the path inspected by the bundle contract", () => {
  const workflow = releaseWorkflow();
  const buildStep = workflow.match(
    /- name: Build and inspect production renderer in aiTemp([\s\S]*?)(?=\n      - name:|\n      - uses:)/u,
  );

  assert.ok(buildStep, "renderer build step is missing");
  assert.match(buildStep[1], /if \[ -d desktop-electron\/dist \]; then/u);
  assert.match(buildStep[1], /mv desktop-electron\/dist[\s\S]*aiTemp\/Trash/u);
  assert.match(buildStep[1], /bun run --cwd desktop-electron build/u);
  assert.match(buildStep[1], /renderer-provider-bundle\.test\.cjs/u);
});

test("rc.6 release gate retains the generated renderer and restores tracked dist", () => {
  const workflow = releaseWorkflow();

  assert.match(workflow, /generated-dist-\$GITHUB_RUN_ID/u);
  assert.match(workflow, /mv desktop-electron\/dist "\$retained"/u);
  assert.match(workflow, /git restore --source=HEAD --worktree -- desktop-electron\/dist/u);
  assert.match(workflow, /test -d "\$retained"/u);
});
