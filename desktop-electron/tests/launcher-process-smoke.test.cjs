"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runPackagedLauncherProcess } = require("../scripts/launcher-process-smoke.cjs");

const repositoryRoot = path.resolve(__dirname, "..", "..");

function testDirectory(label) {
  const directory = path.join(
    repositoryRoot,
    "aiTemp",
    "Trash",
    "launcher-process-smoke-tests",
    `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

test("accepts a verified readiness marker and reaps a launcher that stays resident", async () => {
  const directory = testDirectory("ready-resident");
  const markerPath = path.join(directory, "ready.json");
  const result = await runPackagedLauncherProcess({
    command: process.execPath,
    args: ["-e", [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.SMOKE_MARKER, JSON.stringify({ok:true}) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("")],
    cwd: directory,
    env: { ...process.env, SMOKE_MARKER: markerPath },
    markerPath,
    timeoutMs: 5_000,
    exitGraceMs: 100,
    pollIntervalMs: 20,
  });
  assert.equal(result.marker.ok, true);
  assert.equal(result.forcedTermination, true);
});

test("reports bounded child diagnostics when the launcher exits before readiness", async () => {
  const directory = testDirectory("early-exit");
  const markerPath = path.join(directory, "ready.json");
  await assert.rejects(
    runPackagedLauncherProcess({
      command: process.execPath,
      args: ["-e", "console.error('SMOKE_CHILD_FAILED'); process.exit(7);"],
      cwd: directory,
      env: process.env,
      markerPath,
      timeoutMs: 5_000,
      exitGraceMs: 100,
      pollIntervalMs: 20,
    }),
    (error) => {
      assert.match(error.message, /exited before writing its readiness marker/);
      assert.match(error.message, /SMOKE_CHILD_FAILED/);
      assert.match(error.message, /\"code\":7/);
      return true;
    },
  );
});
