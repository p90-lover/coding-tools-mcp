"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateHealthGate } = require("../electron/update-health-gate.cjs");

/** A gate on a fake clock; `state` holds each check's answer and the settings, changed by the test. */
function gate(state) {
  let clock = 0;
  const calls = [];
  const logs = [];
  const instance = createUpdateHealthGate({
    checks: Object.fromEntries(Object.keys(state.checks).map((name) => [name, () => {
      const result = state.checks[name];
      if (result === "throw") throw new Error("broken check");
      return result;
    }])),
    timeoutMs: () => state.timeoutMs ?? 60_000,
    autoRollback: () => state.autoRollback ?? true,
    isBusy: async () => {
      if (typeof state.busy === "function") return state.busy();
      if (state.busy === "throw") throw new Error("cannot tell");
      return state.busy === true;
    },
    commit: async () => { calls.push("commit"); },
    rollBack: async (reason) => {
      calls.push(`rollback: ${reason}`);
      if (state.rollbackError) throw state.rollbackError;
      return state.rollbackResult;
    },
    logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event) },
    now: () => clock,
    setRepeat: () => ({ unref() {} }),
    clearRepeat: () => {},
  });
  return { instance, calls, logs, advance: (ms) => { clock += ms; } };
}

test("an update is kept only once every check passes", async () => {
  const state = { checks: { window: "pending", backend: "pass", agentOrchestrator: "pass" } };
  const { instance, calls, logs, advance } = gate(state);
  instance.start();
  assert.equal(await instance.tick(), null, "the window has not loaded yet");
  advance(5_000);
  state.checks.window = "pass";
  assert.equal(await instance.tick(), "committed");
  assert.deepEqual(calls, ["commit"]);
  assert.ok(logs.includes("launcher.update_health_passed"));
  assert.equal(await instance.tick(), null, "it settles once");
});

test("a version still unhealthy after the health window goes back to the previous one", async () => {
  const state = { checks: { window: "pass", backend: "pending", agentOrchestrator: "fail" } };
  const { instance, calls, advance } = gate(state);
  instance.start();
  advance(59_000);
  assert.equal(await instance.tick(), null, "still inside the window: it waits, even with a failing check");
  advance(1_000);
  assert.equal(await instance.tick(), "rolled-back");
  assert.deepEqual(calls, ["rollback: The new version did not become healthy: backend pending, agentOrchestrator fail"]);
});

test("rollback waits while a chat is working, and a busy check that cannot answer counts as busy", async () => {
  const state = { checks: { window: "fail" }, busy: true };
  const { instance, calls, logs, advance } = gate(state);
  instance.start();
  advance(120_000);
  assert.equal(await instance.tick(), null);
  state.busy = "throw";
  assert.equal(await instance.tick(), null);
  assert.equal(logs.filter((event) => event === "launcher.update_rollback_waiting").length, 1, "logged once");
  state.busy = false;
  assert.equal(await instance.tick(), "rolled-back");
  assert.equal(calls.length, 1);
});

test("with rollback off in Settings, an unhealthy version is kept, as before", async () => {
  const state = { checks: { backend: "pending" }, autoRollback: false };
  const { instance, calls, logs, advance } = gate(state);
  instance.start();
  advance(60_000);
  assert.equal(await instance.tick(), "committed");
  assert.deepEqual(calls, ["commit"]);
  assert.ok(logs.includes("launcher.update_health_kept"));
});

test("the health window is read from Settings on every check, and a check that throws counts as failing", async () => {
  const state = { checks: { window: "throw" }, timeoutMs: 600_000 };
  const { instance, calls, advance } = gate(state);
  instance.start();
  advance(120_000);
  assert.equal(await instance.tick(), null, "10 min window: not yet");
  state.timeoutMs = 60_000;
  assert.equal(await instance.tick(), "rolled-back");
  assert.match(calls[0], /window fail/);
});

test("update rollback cannot cross the health threshold without a busy read", async () => {
  const samples = [0, 59_999, 60_000], calls = [];
  let busyReads = 0;
  const instance = createUpdateHealthGate({
    checks: { window: () => "fail" }, timeoutMs: () => 60_000, autoRollback: () => true,
    isBusy: async () => { busyReads++; return true; },
    commit: async () => { calls.push("commit"); }, rollBack: async () => { calls.push("rollback"); },
    now: () => samples.shift() ?? 60_000, setRepeat: () => ({ unref() {} }), clearRepeat() {},
  });
  instance.start();
  await Promise.resolve();
  assert.deepEqual(calls, [], "the pre-threshold decision must wait even if a later clock read would cross it");
  assert.equal(await instance.tick(), null);
  assert.equal(busyReads, 1, "the next eligible decision reads busy before considering rollback");
  assert.deepEqual(calls, []);
  instance.stop();
});

test("waiting update health decisions use current health, settings and stop state", async () => {
  for (const change of ["healthy", "longer-window", "rollback-off", "stopped"]) {
    let finish, reads = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const state = { checks: { window: "fail" }, busy: () => { reads++; return pending; } };
    const { instance, calls, advance } = gate(state);
    instance.start(); advance(60_000);
    const checking = instance.tick();
    await Promise.resolve();
    assert.equal(reads, 1, change);
    if (change === "healthy") state.checks.window = "pass";
    if (change === "longer-window") state.timeoutMs = 600_000;
    if (change === "rollback-off") state.autoRollback = false;
    if (change === "stopped") instance.stop();
    finish(false);
    const commits = change === "healthy" || change === "rollback-off";
    assert.equal(await checking, commits ? "committed" : null, change);
    assert.deepEqual(calls, commits ? ["commit"] : [], change);
    instance.stop();
  }
});

test("update rollback can defer before handoff without retiring the health check", async () => {
  const state = { checks: { window: "fail" }, rollbackResult: false };
  const { instance, calls, advance } = gate(state);
  instance.start(); advance(60_000);
  assert.equal(await instance.tick(), null);
  state.rollbackResult = true;
  assert.equal(await instance.tick(), "rolled-back");
  assert.equal(calls.length, 2);
  assert.equal(await instance.tick(), null);
});

test("update rollback never repeats an attempt that throws after its handoff", async () => {
  const state = { checks: { window: "fail" }, rollbackError: new Error("handoff already accepted") };
  const { instance, calls, advance } = gate(state);
  instance.start(); advance(60_000);
  await assert.rejects(instance.tick(), /handoff already accepted/);
  assert.equal(await instance.tick(), null);
  assert.equal(calls.length, 1);
});

/** Actual main-process callbacks, with fake app/worker/quit endpoints and a manual gate clock. */
function mainRollbackFixture() {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const variables = new Map();
  let optionsSource;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ["appBusy", "localAppBusy"].includes(node.name.getText(file))) {
      variables.set(node.name.getText(file), node.initializer.getText(file));
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === "createUpdateHealthGate") {
      optionsSource = node.arguments[0].getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(optionsSource);
  const calls = [], modes = [], logs = [];
  let clock = 0, readBusy = async () => false, quit = async () => ({ ok: true });
  const runtime = { operation: null, currentOperation() { return this.operation; } };
  const context = vm.createContext({
    browserHost: null, runtimeHost: runtime, runtimeStartupInFlight: null, codexBridgeConnectInFlight: null,
    quitting: false, shutdownInProgress: false, exitCommitted: false,
    rendererLoaded: false, mainWindow: { isDestroyed: () => false, webContents: { isCrashed: () => false } },
    headlessHost: { control: {} },
    agentOrchestratorUpstream: { snapshot: () => ({ state: "ready" }), harness: {
      anySessionWorking: options => { modes.push(options); return readBusy(options); },
    } },
    stateStore: { read: () => ({ updateHealthMinutes: 1, updateAutoRollback: true }) },
    resolveUpdateSettings: value => value,
    installRoot: "G:/unused-rollback-fixture", app: { getVersion: () => "fixture", exit: code => calls.push(`exit:${code}`) },
    logger: { info() {}, warn: (event, detail) => logs.push([event, detail]) },
    handOffUpdateRecovery: () => { calls.push("handoff"); return true; },
    requestQuit: () => { calls.push("quit"); return quit(); },
    commit: async () => { calls.push("commit"); },
  });
  for (const [name, expression] of variables) context[name] = vm.runInContext(`(${expression})`, context);
  const options = vm.runInContext(`(${optionsSource})`, context);
  const instance = createUpdateHealthGate({ ...options, now: () => clock,
    setRepeat: () => ({ unref() {} }), clearRepeat() {} });
  instance.start();
  return { context, runtime, calls, modes, logs, options, instance,
    advance: ms => { clock += ms; }, readBusy: fn => { readBusy = fn; }, quit: fn => { quit = fn; } };
}

test("update rollback rechecks local work admitted during the native busy read", async () => {
  const fixture = mainRollbackFixture();
  let finish;
  fixture.readBusy(() => new Promise(resolve => { finish = resolve; }));
  fixture.advance(60_000);
  const checking = fixture.instance.tick();
  await Promise.resolve();
  assert.equal(typeof finish, "function");
  fixture.runtime.operation = "runtime-setup";
  finish(false);
  assert.equal(await checking, null);
  assert.deepEqual(fixture.calls, []);
  fixture.instance.stop();
});

test("update rollback checks current local admission before writing a handoff", async () => {
  const fixture = mainRollbackFixture();
  for (const blocker of ["runtime", "quitting", "shutdownInProgress", "exitCommitted"]) {
    if (blocker === "runtime") fixture.runtime.operation = "runtime-setup";
    else fixture.context[blocker] = true;
    assert.equal(await fixture.options.rollBack("unhealthy"), false, blocker);
    assert.deepEqual(fixture.calls, [], blocker);
    fixture.runtime.operation = null;
    fixture.context.quitting = fixture.context.shutdownInProgress = fixture.context.exitCommitted = false;
  }
  assert.notEqual(await fixture.options.rollBack("unhealthy"), false);
  assert.deepEqual(fixture.calls, ["handoff", "quit"]);
  fixture.instance.stop();
});

test("update rollback never forces a busy or unknown quit refusal or repeats an accepted handoff", async () => {
  for (const outcome of ["runtime", "working", "unknown", "missing-upstream", "idle"]) {
    const fixture = mainRollbackFixture();
    fixture.readBusy(async options => {
      if (!options) return false;
      assert.equal(options.start, false, "the post-refusal read must never start AO");
      if (outcome === "unknown") throw new Error("activity unavailable");
      return outcome === "working";
    });
    fixture.quit(async () => {
      if (outcome === "runtime") fixture.runtime.operation = "runtime-setup";
      if (outcome === "missing-upstream") fixture.context.agentOrchestratorUpstream = null;
      return { ok: false, message: "quit refused" };
    });
    fixture.advance(60_000);
    assert.equal(await fixture.instance.tick(), "rolled-back", outcome);
    assert.deepEqual(fixture.calls, outcome === "idle" ? ["handoff", "quit", "exit:1"] : ["handoff", "quit"], outcome);
    if (["working", "unknown", "idle"].includes(outcome)) assert.equal(fixture.modes.length, 2, outcome);
    assert.equal(await fixture.instance.tick(), null);
    assert.equal(fixture.calls.filter(call => call === "handoff").length, 1, outcome);
  }
});
