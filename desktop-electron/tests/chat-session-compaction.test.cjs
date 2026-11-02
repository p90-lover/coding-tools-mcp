"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

function fixture(harness = "ao:codex") {
  const calls = [];
  const run = { id: "run-1", workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", cancelled: false,
    nodes: [{ id: "lead", state: "finished", route: { harness_id: harness }, receipt: { thread_id: "session-1" } }] };
  const world = { runs: [run], settled: false, calls, run };
  world.workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: world.runs };
      if (endpoint === "/api/v1/ao/harness/compact") return { ok: true, status: body.status ? world.settled ? "completed" : "compacting" : "in_progress" };
      throw new Error(`Compaction must not edit a task or invoke a summarizer: ${endpoint}`);
    },
    aoHarness: {
      compact: async id => { calls.push({ compact: id }); await world.compactGate; return { compactedAt: "earlier" }; },
      compactionStatus: async (id, before) => {
        assert.equal(id, "session-1"); assert.equal(before, "earlier");
        return { status: world.settled ? "completed" : "in_progress" };
      },
    },
    fetchImpl: async () => { throw new Error("No separate model request is allowed"); },
  });
  return world;
}

test("/compact uses the owned AO session, and acceptance is not completion", async () => {
  const world = fixture();
  const started = await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  assert.equal(started.status, "in_progress");
  assert.deepEqual(world.calls.find(call => call.compact), { compact: "session-1" });
  const pending = await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true });
  assert.equal(pending.status, "in_progress");
  await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /already.*compact/i);
  await assert.rejects(world.workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "next" }), /still running|compact/i);
  world.settled = true;
  assert.equal((await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true })).status, "completed");
  assert.equal(world.calls.filter(call => call.compact).length, 1);
});

test("native compaction uses the run/node boundary, never a caller-supplied thread", async () => {
  const world = fixture("codex-native");
  const args = { workspaceId: "ws-1", taskId: "task-1", threadId: "someone-elses-thread" };
  assert.equal((await world.workflow.call("compact_chat", args)).status, "in_progress");
  const request = world.calls.find(call => call.endpoint === "/api/v1/ao/harness/compact");
  assert.deepEqual(request.body, { workspace_id: "ws-1", run_id: "run-1", node_id: "lead", status: false });
  world.settled = true;
  assert.equal((await world.workflow.call("compact_chat", { ...args, status: true })).status, "completed");
});

test("compaction refuses busy, missing and team sessions without any model call", async () => {
  for (const change of [world => { world.run.nodes[0].state = "running"; }, world => { world.run.nodes[0].receipt = null; },
    world => { world.run.execution_mode = "team"; }, world => { world.runs = []; }]) {
    const world = fixture(); change(world);
    await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /progress|session|single|chat/i);
    assert.equal(world.calls.some(call => call.compact), false);
  }
});

test("an unacknowledged start cannot complete from an earlier compaction timestamp", async () => {
  const world = fixture();
  let release;
  world.compactGate = new Promise(resolve => { release = resolve; });
  world.settled = true;
  const starting = world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true })).status, "in_progress");
  release(); await starting;
  world.workflow.dispose();
});

test("foreign-workspace runs never authorize compaction", async () => {
  const world = fixture();
  world.run.workspace_id = "other";
  await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /live agent session/);
  assert.equal(world.calls.some(call => call.compact), false);
});

test("late compaction results cannot follow a replaced chat session", async () => {
  const world = fixture();
  await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  world.run.nodes[0].receipt.thread_id = "replacement";
  await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true }), /changed|replaced/i);
});
