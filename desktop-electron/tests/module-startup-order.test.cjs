"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

test("managed apps auto-start only after the bridge is ready, not at renderer paint", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const paintCallbacks = [];
  const readyCallbacks = [];
  const originalUiOptions = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "createOriginalUiController") {
      originalUiOptions.push(node.arguments[0].getText(file));
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === "scheduleFullIpcAfterPaint") {
      paintCallbacks.push(node.arguments[0]);
    }
    if (ts.isArrowFunction(node) && node.parameters[0]?.name.getText(file) === "runtime"
      && node.body.getText(file).includes("startCatalogVerificationMonitor")) readyCallbacks.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(paintCallbacks.length > 0);
  assert.equal(readyCallbacks.length, 1);
  assert.equal(originalUiOptions.length, 1);
  assert.match(originalUiOptions[0], /resumeOnCreate:\s*false/);
  const started = [];
  const resumed = [];
  const context = {
    logger: { warn() {} }, registerIpc() {}, send() {}, startCatalogVerificationMonitor() {},
    safeRead: (_label, read) => read(),
    stateStore: { read: () => ({}), update: patch => patch },
    runtimeSupervisor: { readConfig: () => ({ mode: "full" }) },
    originalUiController: { resume: () => resumed.push(true) },
    externalServicesController: {
      snapshot: () => ({ services: [
        { id: "codex-router", enabled: true, autoStart: true },
        { id: "paseo", enabled: false, autoStart: true },
        { id: "anneal", enabled: true, autoStart: false },
      ] }),
      start: async id => { started.push(id); },
    },
  };
  for (const callback of paintCallbacks) await vm.runInNewContext(`(${callback.getText(file)})`, context)();
  assert.deepEqual(started, [], "renderer paint must not start apps before bridge initialization");
  assert.deepEqual(resumed, []);
  await vm.runInNewContext(`(${readyCallbacks[0].getText(file)})`, context)({ status: "ready" });
  assert.deepEqual(started, ["codex-router"], "only enabled auto-start services should start");
  assert.deepEqual(resumed, [true], "saved reconnect timers resume only when the bridge is ready");
});
