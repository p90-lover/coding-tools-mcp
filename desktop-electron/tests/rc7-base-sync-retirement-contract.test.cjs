"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");

const workflows = [
  {
    label: "legacy provider-updater base sync",
    path: ".github/workflows/rc7-provider-updater-base-sync.yml",
    job: "synchronize",
    evidenceRoot: "aiTemp/rc7-provider-updater-sync/evidence",
  },
  {
    label: "legacy provider-updater current-base union",
    path: ".github/workflows/rc7-provider-updater-base-sync-v2.yml",
    job: "compose-and-verify",
    evidenceRoot: "aiTemp/rc7-provider-updater-union/evidence",
  },
];

for (const workflow of workflows) {
  test(`${workflow.label} is retained as a read-only current-state verification gate`, () => {
    const source = fs.readFileSync(path.join(repositoryRoot, workflow.path), "utf8");

    assert.match(source, new RegExp(`\\n  ${workflow.job}:\\n`));
    assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
    assert.doesNotMatch(source, /contents:\s*write/);
    assert.match(source, /persist-credentials:\s*false/);
    assert.doesNotMatch(source, /persist-credentials:\s*true/);

    assert.match(source, /RC7_BASE_SYNC_RETIRED/);
    assert.ok(
      source.includes(workflow.evidenceRoot),
      `${workflow.path} must retain evidence under ${workflow.evidenceRoot}`,
    );
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
