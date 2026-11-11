"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

async function world(t) {
  let clock = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => clock);
  const mission = { id: "run", workspace_id: "ws", project_id: "task", revision: 3, execution_mode: "single",
    grant: { executable_sha256: "a".repeat(64) }, nodes: [{ id: "worker", role: "worker", state: "running", parents: [],
      route: { harness_id: "ao:claude-code", model: "cpa/test-model" }, receipt: { thread_id: "session", request_key: "attempt-1" } }] };
  const attempts = [], reports = [], writes = [];
  let result = { status: "needs_input", turnId: "turn", turnState: "running", needsInput: true };
  const workflow = createAgentOrchestratorWorkflow({
    runReadFreshMs: 300,
    now: () => clock,
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    requestHeadless: async endpoint => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
      writes.push(endpoint);
      return { ok: true, run: mission };
    },
    aoHarness: { observe: async session => {
      attempts.push(clock);
      const value = typeof result === "function" ? result(session) : result;
      if (value instanceof Error) throw value;
      return value;
    } },
    onRunState: report => reports.push(report),
    confirm: async () => true,
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const tick = async (ms = 500) => { clock += ms; t.mock.timers.tick(ms); await flush(); };
  t.after(async () => {
    mission.nodes[0].state = "finished";
    workflow.dispose();
    await tick();
    t.mock.timers.reset();
  });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  await flush();
  writes.length = 0;
  return { workflow, attempts, reports, writes, mission, tick, get clock() { return clock; },
    setResult(value) { result = value; } };
}

test("failed observations back off without clearing the last confirmed need for input", async t => {
  const w = await world(t);
  for (let i = 0; i < 23; i++) await w.tick();
  assert.equal(w.reports.at(-1).attention, "needs_input");
  w.setResult(new Error("AO read timed out"));
  const before = w.attempts.length;
  for (let i = 0; i < 16; i++) await w.tick();
  assert.equal(w.reports.at(-1).attention, "needs_input", "a failed read is not evidence that input was answered");
  assert.ok(w.attempts.length - before <= 5, `outage generated ${w.attempts.length - before} reads in eight seconds`);
});

test("observation backoff is capped, clears on success and does not delay a replacement attempt", async t => {
  const w = await world(t);
  w.setResult(new Error("AO unavailable"));
  for (let i = 0; i < 100; i++) await w.tick();
  assert.ok(w.attempts.length < 12, `outage generated ${w.attempts.length} reads in fifty seconds`);
  t.diagnostic(`fifty-second outage: ${w.attempts.length} observations (unchanged main: 101)`);
  assert.deepEqual(w.writes, [], "failed reads do not fail, interrupt or relaunch an agent");
  const gaps = w.attempts.slice(1).map((at, i) => at - w.attempts[i]);
  assert.ok(gaps.some(gap => gap >= 15_000), "repeated failures reach the capped wait");
  assert.ok(gaps.every(gap => gap <= 16_000), "a recovered service is checked within the capped wait plus loop bookkeeping");
  w.mission.nodes[0].receipt.request_key = "attempt-2";
  w.setResult({ status: "needs_input", turnId: "turn-2", turnState: "running", needsInput: true });
  const before = w.attempts.length;
  await w.tick();
  assert.equal(w.attempts.length, before + 1, "a replacement attempt does not inherit its predecessor's outage wait");
  await w.tick();
  await w.tick();
  assert.ok(w.attempts.length >= before + 2, "a successful read restores normal attention polling");
});

test("a successful observation clears remembered attention and resets failure backoff on the same attempt", async t => {
  const w = await world(t);
  for (let i = 0; i < 23; i++) await w.tick();
  assert.equal(w.reports.at(-1).attention, "needs_input");
  w.setResult(new Error("AO unavailable"));
  for (let i = 0; i < 100; i++) await w.tick();
  w.setResult({ status: "working", turnId: "turn", turnState: "running" });
  const before = w.attempts.length;
  for (let i = 0; i < 33; i++) await w.tick();
  assert.ok(w.attempts.length > before, "the capped retry eventually reads recovery");
  assert.equal(w.reports.at(-1).attention, null, "only a successful observation clears the input request");
  w.setResult(new Error("second outage"));
  const recovered = w.attempts.length;
  for (let i = 0; i < 10; i++) await w.tick();
  assert.ok(w.attempts.length >= recovered + 2, "a new outage begins at the short wait, not the old maximum");
});

test("one failing node backs off without slowing a healthy sibling waiting for input", async t => {
  const w = await world(t);
  w.mission.nodes.push({ ...structuredClone(w.mission.nodes[0]), id: "healthy",
    receipt: { thread_id: "healthy", request_key: "healthy-attempt" } });
  const calls = [];
  w.setResult(session => {
    calls.push(session);
    return session === "healthy" ? { status: "needs_input", turnId: "healthy-turn", turnState: "running", needsInput: true }
      : new Error("one node unavailable");
  });
  for (let i = 0; i < 24; i++) await w.tick();
  assert.ok(calls.filter(session => session === "session").length <= 5, "only the failed node backs off");
  assert.ok(calls.filter(session => session === "healthy").length >= 20, "a healthy sibling keeps the half-second pace");
  assert.equal(w.reports.at(-1).attention, "needs_input");
  assert.deepEqual(w.writes, []);
});

test("a delayed old observation cannot block its replacement, and disposal stops retries", async t => {
  const w = await world(t);
  let reject;
  const old = new Promise((_, fail) => { reject = fail; });
  w.setResult(() => old);
  await w.tick();
  await w.tick();
  const before = w.attempts.length;
  w.mission.nodes[0].receipt.request_key = "replacement";
  w.setResult({ status: "working", turnId: "new-turn", turnState: "running" });
  await w.tick();
  assert.equal(w.attempts.length, before + 1, "an old in-flight observation does not hold the new attempt");
  reject(new Error("old attempt failed late"));
  await w.tick();
  assert.equal(w.reports.at(-1).attention, null);
  w.workflow.dispose();
  const stopped = w.attempts.length;
  for (let i = 0; i < 40; i++) await w.tick();
  assert.equal(w.attempts.length, stopped, "disposal never leaves an observation retry running");
  assert.deepEqual(w.writes, [], "a late read failure never writes an agent outcome");
});
