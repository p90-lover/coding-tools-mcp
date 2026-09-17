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

test("strips NODE_OPTIONS before launching a packaged application", async () => {
  const directory = testDirectory("node-options");
  const markerPath = path.join(directory, "ready.json");
  const result = await runPackagedLauncherProcess({
    command: process.execPath,
    args: ["-e", [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.SMOKE_MARKER, JSON.stringify({",
      "nodeOptions: Object.hasOwn(process.env, 'NODE_OPTIONS') ? process.env.NODE_OPTIONS : null,",
      "preserved: process.env.SMOKE_PRESERVED",
      "}) + '\\n');",
    ].join("")],
    cwd: directory,
    env: {
      ...process.env,
      NODE_OPTIONS: "--definitely-invalid-node-option",
      SMOKE_MARKER: markerPath,
      SMOKE_PRESERVED: "yes",
    },
    markerPath,
    timeoutMs: 5_000,
    exitGraceMs: 100,
    pollIntervalMs: 20,
  });
  assert.equal(result.marker.nodeOptions, null);
  assert.equal(result.marker.preserved, "yes");
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

test("packaged smoke uses the canonical Coding Tools profile paths", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, "desktop-electron", "scripts", "smoke-package.cjs"),
    "utf8",
  );
  assert.match(source, /\bCODING_TOOLS_HOME\s*:/);
  assert.match(source, /\bCODING_TOOLS_LAUNCHER_DATA_DIR\s*:/);
  assert.match(
    source,
    /fatalLogPath:\s*path\.join\(env\.CODING_TOOLS_LAUNCHER_DATA_DIR,\s*"logs",\s*"launcher-fatal\.log"\)/,
  );
});
