"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const desktopRoot = path.join(repositoryRoot, "desktop-electron");
const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const packagingContract = fs.readFileSync(
  path.join(desktopRoot, "tests", "packaging-contract.test.cjs"),
  "utf8",
);

const workflows = [
  [".github/workflows/rc7-provider-updater-base-sync.yml", "synchronize"],
  [".github/workflows/rc7-provider-updater-base-sync-v2.yml", "compose-and-verify"],
];

test("rc.7 release packaging contract matches assisted legacy-MSI elevation", () => {
  assert.equal(manifest.version, "0.7.0-rc.7");
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, true);
  assert.match(packagingContract, /manifest\.build\.nsis\.allowElevation,[\s\S]*true/);
  assert.match(packagingContract, /legacy per-machine MSI/i);
});

for (const [workflowPath, jobName] of workflows) {
  test(`${workflowPath} is retained as a read-only verification gate`, () => {
    const source = fs.readFileSync(path.join(repositoryRoot, workflowPath), "utf8");
    assert.match(source, new RegExp(`\\n  ${jobName}:\\n`));
    assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
    assert.doesNotMatch(source, /contents:\s*write/);
    assert.match(source, /persist-credentials:\s*false/);
    assert.doesNotMatch(source, /persist-credentials:\s*true/);
    assert.match(source, /RC7_BASE_SYNC_RETIRED/);
    assert.match(source, /git rev-parse HEAD/);
    assert.match(source, /git diff --diff-filter=D/);
    assert.match(source, /actions\/upload-artifact/);
    assert.doesNotMatch(source, /\bgit\s+merge\b/);
    assert.doesNotMatch(source, /\bgit\s+push\b/);
    assert.doesNotMatch(source, /\bgit\s+commit\b/);
    assert.doesNotMatch(source, /\bgit\s+clean\b/);
    assert.doesNotMatch(source, /\brm\s+-rf\b/);
  });
}
