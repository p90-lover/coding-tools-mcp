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
      if (state.busy === "throw") throw new Error("cannot tell");
      return state.busy === true;
    },
    commit: async () => { calls.push("commit"); },
    rollBack: async (reason) => { calls.push(`rollback: ${reason}`); },
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
