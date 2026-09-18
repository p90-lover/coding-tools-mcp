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

test("rc.8 retains generated renderer output before restoring the exact tracked source tree", () => {
  assert.match(runner, /const rendererDist = path\.join\(root, 'desktop-electron', 'dist'\);/);
  assert.match(runner, /const retainedRenderer = path\.join\(trash, 'generated-renderer', sourceSha\);/);
  assert.match(runner, /fs\.renameSync\(rendererDist, retainedRenderer\);/);
  assert.match(
    runner,
    /run\('git', \['restore', '--source=HEAD', '--worktree', '--', 'desktop-electron\/dist'\]/,
  );
  const packageBuild = runner.indexOf("label: 'Windows package build'");
  const retainBuild = runner.indexOf("const rendererDist = path.join(root, 'desktop-electron', 'dist');");
  const cleanGate = runner.indexOf("requireCleanTrackedSource();");
  assert.ok(packageBuild >= 0 && retainBuild > packageBuild && cleanGate > retainBuild);
});
