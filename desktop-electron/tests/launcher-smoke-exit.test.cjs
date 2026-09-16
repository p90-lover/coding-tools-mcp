"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { terminateLauncherSmoke } = require("../electron/smoke-exit.cjs");

test("launcher smoke cleanup force-exits only after local resources close", async () => {
  const events = [];
  await terminateLauncherSmoke({
    app: { exit(code) { events.push(`app.exit:${code}`); } },
    browserHost: { destroy() { events.push("browser.destroy"); } },
    browserControl: { async close() { events.push("control.close"); } },
    mainWindow: {
      isDestroyed() { return false; },
      destroy() { events.push("window.destroy"); },
    },
  });
  assert.deepEqual(events, [
    "browser.destroy",
    "control.close",
    "window.destroy",
    "app.exit:0",
  ]);
});

test("launcher smoke cleanup tolerates an already-destroyed window", async () => {
  const events = [];
  await terminateLauncherSmoke({
    app: { exit(code) { events.push(`app.exit:${code}`); } },
    browserHost: { destroy() { events.push("browser.destroy"); } },
    browserControl: { async close() { events.push("control.close"); } },
    mainWindow: {
      isDestroyed() { return true; },
      destroy() { events.push("unexpected-window-destroy"); },
    },
  });
  assert.deepEqual(events, ["browser.destroy", "control.close", "app.exit:0"]);
});

test("main launcher delegates packaged smoke termination to the force-exit helper", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.match(
    source,
    /const \{ terminateLauncherSmoke \} = require\("\.\/smoke-exit\.cjs"\);/,
  );
  assert.match(
    source,
    /await terminateLauncherSmoke\(\{ app, browserHost, browserControl, mainWindow \}\);/,
  );
  assert.doesNotMatch(
    source,
    /browserHost\.destroy\(\);\s+await browserControl\.close\(\);\s+mainWindow\.destroy\(\);\s+app\.quit\(\);/,
  );
});

test("packaged smoke startup failures never block on a native error dialog", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.match(
    source,
    /const LAUNCHER_SMOKE_TEST = process\.argv\.includes\("--launcher-smoke-test"\);/,
  );
  assert.match(
    source,
    /if \(!LAUNCHER_SMOKE_TEST\)\s*\{\s*dialog\.showErrorBox\("Codex Web GPT could not start", message\);\s*\}/,
  );
  assert.equal(
    (source.match(/process\.argv\.includes\("--launcher-smoke-test"\)/g) || []).length,
    1,
  );
});

test("packaged smoke validates the runtime CLI version instead of the desktop release version", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.match(
    source,
    /const \{ assertLauncherRuntimeVersion, terminateLauncherSmoke \} = require\("\.\/smoke-exit\.cjs"\);/,
  );
  assert.match(
    source,
    /assertLauncherRuntimeVersion\(\{\s*runtimeRoot: smokeRuntimeRoot,\s*result: versionResult,\s*\}\);/,
  );
  assert.doesNotMatch(
    source,
    /versionResult\.stdout\.trim\(\)\s*!==\s*app\.getVersion\(\)/,
  );
});
