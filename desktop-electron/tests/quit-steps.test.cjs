"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { boundedQuitStep } = require("../electron/quit-steps.cjs");

test("a quit step that never settles is reported by name and the quit moves on", async () => {
  const timeouts = [];
  const result = await boundedQuitStep("agent-orchestrator", () => new Promise(() => {}), { ms: 20, onTimeout: (name, ms) => timeouts.push([name, ms]) });
  assert.equal(result, "timeout");
  assert.deepEqual(timeouts, [["agent-orchestrator", 20]]);
});

test("a quick step returns its value, and a failing step still throws", async () => {
  const timeouts = [];
  assert.equal(await boundedQuitStep("headless", async () => "stopped", { ms: 1000, onTimeout: () => timeouts.push(1) }), "stopped");
  await assert.rejects(boundedQuitStep("headless", async () => { throw new Error("refused"); }, { ms: 1000 }), /refused/);
  assert.equal(await boundedQuitStep("absent", () => undefined, { ms: 1000 }), undefined, "an absent service is a no-op");
  assert.deepEqual(timeouts, []);
});
