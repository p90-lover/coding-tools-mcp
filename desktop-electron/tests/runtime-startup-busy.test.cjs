"use strict";

// runtimeStartupInFlight used to keep launch's startup promise after it settled, and a settled
// promise is still truthy: localAppBusy() answered "busy" for the app's whole life, so automatic
// update installs, the update health gate's rollback and CPA's swap never ran while it was open.
// These run main.cjs's own trackRuntimeStartup, localAppBusy/appBusy and auto-installer options.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createAutoInstaller } = require("../electron/app-update.cjs");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const parts = { variables: new Map(), assignments: [] };
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "trackRuntimeStartup") parts.track = node.getText(file);
  if (ts.isVariableDeclaration(node) && ["appBusy", "localAppBusy"].includes(node.name.getText(file))) {
    parts.variables.set(node.name.getText(file), node.initializer.getText(file));
  }
  if (ts.isCallExpression(node) && node.expression.getText(file) === "createAutoInstaller") parts.autoInstall = node.arguments[0].getText(file);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.left.getText(file) === "runtimeStartupInFlight") {
    let owner = node.parent;
    while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
    parts.assignments.push(owner?.name?.text ?? "<top level>");
  }
  ts.forEachChild(node, visit);
})(file);

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

/** main.cjs's busy checks and auto-installer over an idle app with an update available. */
function fixture({ waitForChats = true } = {}) {
  const installs = [];
  const context = vm.createContext({
    runtimeStartupInFlight: null, runtimeStartups: 0, codexBridgeConnectInFlight: null,
    quitting: false, shutdownInProgress: false, exitCommitted: false,
    browserHost: { currentOperation: () => null }, runtimeHost: { currentOperation: () => null },
    agentOrchestratorUpstream: { harness: { anySessionWorking: async () => false } },
    stateStore: { read: () => ({ automaticUpdates: true, updateWaitForChats: waitForChats, updateIdleMinutes: 5 }) },
    resolveUpdateSettings: settings => settings,
    powerMonitor: { getSystemIdleTime: () => 3_600 },
    updateController: {
      getState: () => ({ status: "available", kind: "app", version: "9.9.9" }),
      beginInstall: async () => { installs.push("install"); },
    },
    logger: { info() {}, warn() {} },
  });
  vm.runInContext(parts.track, context);
  for (const [name, expression] of parts.variables) context[name] = vm.runInContext(`(${expression})`, context);
  const installer = createAutoInstaller(vm.runInContext(`(${parts.autoInstall})`, context));
  return { context, installs, installer };
}

test("only trackRuntimeStartup sets or clears the runtime startup in flight", () => {
  assert.ok(parts.track && parts.autoInstall && parts.variables.size === 2, "main.cjs still has the pieces under test");
  assert.deepEqual(parts.assignments, ["trackRuntimeStartup", "trackRuntimeStartup"],
    "a startup assigned anywhere else would never be cleared, and the app would stay busy");
});

test("a runtime startup keeps the app busy only while it runs, whether it succeeds or fails", async () => {
  for (const outcome of ["resolve", "reject"]) {
    const { context } = fixture();
    assert.equal(context.localAppBusy(), false, outcome);
    const startup = deferred();
    assert.equal(context.trackRuntimeStartup(startup.promise), startup.promise, "callers still get the startup back");
    assert.equal(context.localAppBusy(), true, `${outcome}: busy while the startup runs`);
    startup[outcome](new Error("startup failed"));
    await settled();
    assert.equal(context.runtimeStartupInFlight, null, outcome);
    assert.equal(context.localAppBusy(), false, `${outcome}: idle once the startup settled`);
    assert.equal(await context.appBusy(), false, outcome);
  }
});

test("an older startup settling leaves a newer one in flight", async () => {
  const { context } = fixture();
  const launch = deferred(), retry = deferred();
  context.trackRuntimeStartup(launch.promise);
  context.trackRuntimeStartup(retry.promise);
  launch.resolve();
  await settled();
  assert.equal(context.runtimeStartupInFlight, retry.promise);
  assert.equal(context.localAppBusy(), true);
  retry.resolve();
  await settled();
  assert.equal(context.localAppBusy(), false);
  assert.equal(context.runtimeStartups, 2, "a reconnect that awaited one can still see that another began");
});

test("automatic update installs wait for a running startup and go ahead once it settled", async () => {
  // Settings → "Wait for chats to finish" on uses appBusy(); off, only runtime work blocks.
  for (const waitForChats of [true, false]) {
    const { context, installs, installer } = fixture({ waitForChats });
    const startup = deferred();
    context.trackRuntimeStartup(startup.promise);
    assert.equal(await installer.tick(), false, `waitForChats ${waitForChats}: no install over a running startup`);
    assert.deepEqual(installs, []);
    startup.resolve();
    await settled();
    assert.equal(await installer.tick(), true, `waitForChats ${waitForChats}: the idle app installs the update`);
    assert.deepEqual(installs, ["install"]);
  }
});
