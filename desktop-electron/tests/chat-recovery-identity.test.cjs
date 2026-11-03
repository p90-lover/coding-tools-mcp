"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

function world({ observe } = {}) {
  const input = { workspaceId: "ws", taskId: "task", runId: "run", nodeId: "lead",
    requestKey: "request", threadId: "session" };
  const card = { id: input.nodeId, role: "planner", state: "running",
    route: { harness_id: "ao:claude-code", model: "cpa/deepseek" }, settings: { revision: 1 },
    receipt: { request_key: input.requestKey, thread_id: input.threadId, status: "submitted" } };
  const mission = { id: input.runId, workspace_id: input.workspaceId, project_id: input.taskId,
    execution_mode: "single", nodes: [card] };
  const reads = [], observations = [], recoveries = [];
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => "G:/fixture/codex.exe",
    runReadFreshMs: 0,
    requestHeadless: async (endpoint, body) => {
      reads.push({ endpoint, body });
      assert.equal(endpoint, "/api/v1/ao/read", "activity and recovery must not send, restart, or grant anything");
      return { ok: true, runs: [structuredClone(mission)] };
    },
    aoHarness: {
      observe: async (session, turn) => {
        observations.push({ session, turn });
        return observe ? observe(session, turn) : { turnId: turn || "accepted-turn", turnState: "running", timeline: [] };
      },
      recover: async (session, turn) => {
        recoveries.push({ session, turn });
        return turn ? { recovery: "observed", status: "working" } : { recovery: "unavailable", status: "unknown" };
      },
    },
    confirm: async () => { throw new Error("No new grant during recovery"); },
  });
  const activity = () => workflow.call("activity", { workspaceId: input.workspaceId, runId: input.runId });
  const poll = async () => { await activity(); await new Promise(setImmediate); };
  return { input, card, mission, reads, observations, recoveries, workflow, activity, poll,
    recover: () => workflow.call("chat_recover", input) };
}

test("a cold launch's observed accepted turn is available to contentless recovery", async () => {
  const w = world();
  try {
    assert.equal((await w.recover()).recovery, "unavailable", "no guessed identity before the first observation");
    await w.poll();
    assert.equal((await w.recover()).recovery, "observed");
    assert.deepEqual(w.recoveries.at(-1), { session: "session", turn: "accepted-turn" });
    assert.equal(w.card.receipt.turn_id, undefined, "no durable receipt mutation or new disk write");
    assert.equal(w.observations.length, 1, "recovery does not introduce an observe poll");
  } finally { w.workflow.dispose(); }
});

test("later activity stays pinned to the first accepted turn rather than the newest session turn", async () => {
  const w = world();
  try {
    await w.poll();
    await w.poll();
    assert.deepEqual(w.observations, [{ session: "session", turn: undefined }, { session: "session", turn: "accepted-turn" }]);
    assert.equal((await w.recover()).status, "working");
    assert.equal(w.recoveries.at(-1).turn, "accepted-turn");
  } finally { w.workflow.dispose(); }
});

test("a queued turn is not accepted identity, but a later running observation can pin it", async () => {
  let state = "queued";
  const w = world({ observe: async () => ({ turnId: "accepted-turn", turnState: state, timeline: [] }) });
  try {
    await w.poll();
    assert.equal((await w.recover()).recovery, "unavailable");
    state = "running";
    await w.poll();
    assert.equal((await w.recover()).status, "working");
    assert.equal(w.recoveries.at(-1).turn, "accepted-turn");
  } finally { w.workflow.dispose(); }
});

for (const [name, change] of [
  ["request", w => { w.card.receipt.request_key = w.input.requestKey = "replacement-request"; }],
  ["session", w => { w.card.receipt.thread_id = w.input.threadId = "replacement-session"; }],
  ["model", w => { w.card.route.model = "other-model"; }],
  ["settings", w => { w.card.settings.revision++; }],
]) test(`a late observation cannot pin the identity of a changed ${name}`, async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const w = world({ observe: async () => { await waiting; return { turnId: "old-turn", turnState: "running", timeline: [] }; } });
  try {
    await w.activity();
    change(w);
    release();
    await new Promise(setImmediate);
    assert.equal((await w.recover()).recovery, "unavailable");
    assert.equal(w.recoveries.at(-1)?.turn, undefined);
  } finally { release(); w.workflow.dispose(); }
});

test("the activity identity does not leak into a newer run even when it reuses the session", async () => {
  const w = world();
  try {
    await w.poll();
    assert.equal((await w.recover()).status, "working");
    w.mission.id = w.input.runId = "new-run";
    w.card.receipt.request_key = w.input.requestKey = "next-request";
    assert.equal((await w.recover()).recovery, "unavailable");
    assert.equal(w.recoveries.at(-1).turn, undefined);
  } finally { w.workflow.dispose(); }
});

test("Stop wins even when the accepted identity was already cached", async () => {
  const w = world();
  try {
    await w.poll();
    w.mission.cancelled = true;
    assert.equal((await w.recover()).recovery, "unavailable");
    assert.equal(w.recoveries.length, 0, "no provider lookup after Stop");
  } finally { w.workflow.dispose(); }
});

test("an exact saved receipt takes precedence over cached activity identity", async () => {
  const w = world();
  try {
    await w.poll();
    w.card.receipt.turn_id = "receipt-turn";
    assert.equal((await w.recover()).status, "working");
    assert.equal(w.recoveries.at(-1).turn, "receipt-turn");
  } finally { w.workflow.dispose(); }
});
