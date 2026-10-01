"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

test("managed apps and original UI start at renderer paint even if Codex bridge is unavailable", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const paintCallbacks = [];
  const originalUiOptions = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "createOriginalUiController") {
      originalUiOptions.push(node.arguments[0].getText(file));
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === "scheduleFullIpcAfterPaint") {
      paintCallbacks.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(paintCallbacks.length > 0);
  assert.equal(originalUiOptions.length, 1);
  assert.match(originalUiOptions[0], /resumeOnCreate:\s*false/);
  const started = [];
  const resumed = [];
  const context = {
    logger: { warn() {} }, registerIpc() {}, send() {}, LAUNCHER_SMOKE_TEST: false,
    stateStore: { read: () => ({}) },
    safeRead: (_label, read) => read(),
    originalUiController: { resume: () => resumed.push(true) },
    externalServicesController: {
      snapshot: () => ({ services: [
        { id: "codex-router", enabled: true, autoStart: true },
        { id: "cpa", enabled: true, autoStart: false, managedInstall: { state: "installed" } },
        { id: "paseo", enabled: false, autoStart: true },
        { id: "anneal", enabled: true, autoStart: false },
      ] }),
      start: async id => { started.push(id); },
    },
  };
  for (const callback of paintCallbacks) await vm.runInNewContext(`(${callback.getText(file)})`, context)();
  assert.deepEqual(started, ["codex-router", "cpa"]);
  assert.deepEqual(resumed, [true]);

  started.length = 0;
  resumed.length = 0;
  context.LAUNCHER_SMOKE_TEST = true;
  for (const callback of paintCallbacks) await vm.runInNewContext(`(${callback.getText(file)})`, context)();
  assert.deepEqual(started, [], "smoke launch must not start managed services");
  assert.deepEqual(resumed, [], "smoke launch must not resume original UI sessions");
});
