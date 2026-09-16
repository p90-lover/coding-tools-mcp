"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertLauncherRuntimeVersion,
  terminateLauncherSmoke,
} = require("../electron/smoke-exit.cjs");

let fixtureSequence = 0;

function createRuntimeFixture(version) {
  const runtimeRoot = path.resolve(
    "aiTemp",
    "Trash",
    "launcher-smoke-exit-tests",
    `runtime-${process.pid}-${Date.now()}-${fixtureSequence++}`,
  );
  const appRoot = path.join(runtimeRoot, "app");
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, "package.json"),
    `${JSON.stringify({ name: "codex-chatgpt-web", version }, null, 2)}\n`,
  );
  return runtimeRoot;
}

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

test("launcher smoke accepts the runtime CLI's own package version", () => {
  const runtimeRoot = createRuntimeFixture("5.0.6");
  assert.equal(assertLauncherRuntimeVersion({
    runtimeRoot,
    result: { status: 0, stdout: "5.0.6\n", stderr: "" },
  }), "5.0.6");
});

test("launcher smoke rejects a CLI version that differs from packaged runtime metadata", () => {
  const runtimeRoot = createRuntimeFixture("5.0.6");
  assert.throws(
    () => assertLauncherRuntimeVersion({
      runtimeRoot,
      result: { status: 0, stdout: "0.7.0-rc.1\n", stderr: "" },
    }),
    (error) => {
      assert.match(error.message, /expected="5\.0\.6"/);
      assert.match(error.message, /stdout="0\.7\.0-rc\.1"/);
      return true;
    },
  );
});

test("main launcher delegates packaged smoke termination to the force-exit helper", () => {
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
