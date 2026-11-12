"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow, quotaResets } = require("../electron/agent-orchestrator-workflow.cjs");

const quota = "API Error 500 quota exceeded: All eligible Codex accounts have exhausted their reported quota; retry after 2026-11-13T09:29:43.000Z.";

test("quota reset notes retain the gateway's absolute retry time and existing relative resets", () => {
  assert.equal(quotaResets(quota), " (retry after 2026-11-13T09:29:43.000Z)");
  assert.equal(quotaResets("The limit resets in 5d 8h"), " (it resets in 5d 8h)");
  assert.equal(quotaResets("retry after 2026-13-99T09:29:43.000Z"), "");
  assert.equal(quotaResets("retry after 30 seconds"), "");
  assert.equal(quotaResets(null), "");
});

function world(options = {}) {
  const node = { id: "one", role: "planner", parents: [], state: "running", request_key: "key",
    route: { harness_id: "ao:claude-code", model: "cpa/test-model" },
    receipt: { thread_id: "session", request_key: "key", turn_id: "turn" } };
  const mission = { id: "run", workspace_id: "ws", revision: 1, execution_mode: "single", nodes: [node] };
  let observed = { status: "working", turnState: "running", turnId: "turn", providerFailure: quota,
    approvals: [], sessionTools: [], timeline: [], lastActivityAt: Date.now(), ...options.observed };
  const interrupted = [], terminals = [];
  let reads = 0, saves = 0;
  const workflow = createAgentOrchestratorWorkflow({
    runReadFreshMs: options.runReadFreshMs,
    setTimer: callback => { callback(); return 0; },
    aoHarness: {
      observe: async (_session, turnId) => {
        options.beforeObserve?.(++reads, { node, mission, get observed() { return observed; }, set observed(value) { observed = value; } });
        return structuredClone(observed);
      },
      interrupt: async session => {
        interrupted.push(session);
        if (options.stopError) throw new Error("interrupt refused");
        observed = { ...observed, turnState: "interrupted", status: "idle", providerFailure: undefined };
        options.afterInterrupt?.({ node, mission, get observed() { return observed; }, set observed(value) { observed = value; } });
      },
    },
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") {
        options.beforeRead?.({ node, mission });
        return { ok: true, runs: [structuredClone(mission)] };
      }
      if (endpoint === "/api/v1/ao/external/terminal") {
        if (options.failFirstSave && !saves++) throw new Error("temporary save failure");
        terminals.push(body);
        node.state = body.completed ? "finished" : "held";
        return { ok: true, run: structuredClone(mission) };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  });
  return { workflow, node, interrupted, terminals,
    look: () => workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" }) };
}

test("quota exhaustion stops the owned internal retry and saves the actual quota reset error", async () => {
  const w = world();
  await w.look();
  assert.deepEqual(w.interrupted, ["session"]);
  assert.equal(w.terminals.length, 1);
  assert.equal(w.terminals[0].completed, false);
  assert.equal(w.terminals[0].turn_id, "turn");
  assert.equal(w.terminals[0].failure, quota);
  w.workflow.dispose();
});

test("quota exhaustion does not interrupt temporary throttling, successful recovery, a tool or an approval", async () => {
  for (const observed of [
    { providerFailure: "API error 429 Too many requests. Retry after 30 seconds." },
    { providerFailure: "RESOURCE_EXHAUSTED: Quota exceeded for metric requests per minute." },
    { providerFailure: "API error 503. Trying again in 30 seconds." },
    { providerFailure: undefined, timeline: [{ kind: "message", status: "completed", text: quota }] },
    { providerFailure: undefined, error: quota },
    { approvals: [{ approval_id: "ask", kind: "permission" }], needsInput: true },
    { sessionTools: [{ timeoutMs: 300_000 }] },
    { turnId: "other" },
    { turnState: "queued" },
  ]) {
    const w = world({ observed });
    await w.look();
    assert.deepEqual(w.interrupted, [], JSON.stringify(observed));
    assert.deepEqual(w.terminals, [], "no failure is invented");
    w.workflow.dispose();
  }
});

test("quota exhaustion is rechecked before interrupting; a recovered or replaced turn is left alone", async () => {
  for (const change of [
    state => { state.observed = { ...state.observed, providerFailure: undefined }; },
    state => { state.observed = { ...state.observed, turnId: "new-turn" }; },
    state => { state.observed = { ...state.observed, needsInput: true, approvals: [{ approval_id: "ask" }] }; },
    state => { state.node.receipt.request_key = "replacement-key"; },
    state => { state.mission.cancelled = true; },
  ]) {
    const w = world({ beforeObserve: (reads, state) => { if (reads === 1) queueMicrotask(() => change(state)); } });
    await w.look();
    assert.deepEqual(w.interrupted, []);
    assert.deepEqual(w.terminals, []);
    w.workflow.dispose();
  }
});

test("quota exhaustion revalidates the attempt after interrupt, bypassing cached run reads", async () => {
  for (const change of [
    state => { state.node.receipt.request_key = "replacement-key"; },
    state => { state.mission.cancelled = true; },
    state => { state.node.state = "held"; },
  ]) {
    const w = world({ runReadFreshMs: 300, afterInterrupt: change });
    await w.look();
    assert.deepEqual(w.terminals, [], "an interruption does not let stale observations finish a replaced card");
    w.workflow.dispose();
  }
  const stale = world({ runReadFreshMs: 300, beforeObserve: (reads, state) => {
    if (reads === 1) queueMicrotask(() => { state.node.receipt.request_key = "replacement-key"; });
  } });
  await stale.look();
  assert.deepEqual(stale.interrupted, [], "the ownership check cannot reuse the observation's old cached run");
  stale.workflow.dispose();
});

test("quota exhaustion with an unconfirmed stop never saves a terminal failure", async () => {
  const w = world({ stopError: true });
  await w.look();
  assert.deepEqual(w.interrupted, ["session"]);
  assert.deepEqual(w.terminals, []);
  w.workflow.dispose();
});

test("quota exhaustion keeps its cause when recording the confirmed stop needs a retry", async () => {
  const w = world({ failFirstSave: true });
  await assert.rejects(w.look(), /temporary save failure/);
  await w.look();
  assert.equal(w.terminals[0]?.failure, quota);
  assert.deepEqual(w.interrupted, ["session"]);
  w.workflow.dispose();
});

test("quota exhaustion never overwrites a success or another turn after interrupt", async () => {
  for (const next of [{ turnState: "completed", status: "idle", answer: "recovered" }, { turnId: "new-turn" }]) {
    const w = world({ afterInterrupt: state => { state.observed = { ...state.observed, ...next }; } });
    await w.look();
    assert.ok(w.terminals.every(result => result.completed), "no quota failure is saved over success or a replacement");
    w.workflow.dispose();
  }
});
