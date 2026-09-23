"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let quitSource;
const listeners = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "requestQuit") quitSource = node.getText(file);
  if (ts.isCallExpression(node) && /^app\.(on|once)$/.test(node.expression.getText(file))
    && node.arguments[0]?.text === "before-quit") listeners.push(node.arguments[1].getText(file));
  ts.forEachChild(node, visit);
}
visit(file);

function fixture({ active = null, failCleanup = false } = {}) {
  const disposed = [];
  const nativeStops = [];
  const quits = [];
  const controller = name => ({ dispose() {
    disposed.push(name);
    if (failCleanup && name === "external") throw new Error("Owned process cleanup failed");
  } });
  const context = vm.createContext({
    shutdownInProgress: false, exitCommitted: false, quitting: false,
    runtimeHost: { currentOperation: () => active },
    browserHost: { currentOperation: () => null, persistSession: async () => {}, destroy() {} },
    runtimeSupervisor: { shutdown: async () => { nativeStops.push("runtime"); } },
    headlessHost: { shutdown: async () => {} }, browserControl: { close: async () => {} },
    stopCatalogVerificationMonitor() {}, updateController: { stopPeriodicChecks() {} },
    managedBootstrapController: controller("bootstrap"), originalUiController: controller("visuals"),
    externalServicesController: controller("external"), upstreamToolController: controller("upstream"),
    showMainWindow() {}, publishOperation() {}, app: { quit: () => quits.push(true) },
  });
  const quit = vm.runInContext(`(${quitSource})`, context);
  let result;
  context.requestQuit = () => (result = quit());
  return { disposed, nativeStops, quits, quit, async beforeQuit() {
    let prevented = 0;
    for (const listener of listeners) vm.runInContext(`(${listener})`, context)({ preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1);
    return result;
  } };
}

test("rejected app quit does not dispose integrations before the active-operation guard", async () => {
  const f = fixture({ active: "mcp-setup" });
  const result = await f.beforeQuit();
  assert.equal(result.ok, false);
  assert.deepEqual(f.disposed, []);
  assert.deepEqual(f.nativeStops, []);
  assert.deepEqual(f.quits, []);
});

test("accepted app quit disposes each integration controller once", async () => {
  const f = fixture();
  const result = await f.beforeQuit();
  assert.equal(result.ok, true);
  assert.deepEqual(f.disposed, ["bootstrap", "visuals", "external", "upstream"]);
  assert.equal(f.quits.length, 1);
});

test("module cleanup failure leaves the native bridge running and refuses exit", async () => {
  const f = fixture({ failCleanup: true });
  const result = await f.quit();
  assert.equal(result.ok, false);
  assert.match(result.message, /Owned process cleanup failed/);
  assert.deepEqual(f.nativeStops, []);
  assert.deepEqual(f.quits, []);
});
