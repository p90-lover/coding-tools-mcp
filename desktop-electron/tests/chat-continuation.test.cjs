"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const handler = require("../../app-handler/agent-orchestrator/handler.cjs");

function world(options = {}) {
  const description = options.description || "Original request";
  const state = {
    task: { id: "task", workspace_id: "ws", title: "Original task", description, state: "in_progress", clauses: [] },
    revision: 1, edits: [], created: [],
    runs: options.runs || [{ id: "parent", workspace_id: "ws", project_id: "task", revision: 1,
      execution_mode: "single", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "finished" }] }],
  };
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => "G:/fixture/codex.exe",
    resolveHarness: async () => { throw new Error("Offline continuation fixture"); },
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return {
        ok: true, runs: structuredClone(body.run_id ? state.runs.filter(run => run.id === body.run_id) : state.runs),
        team: { id: "team", revision: 1, worker_limit: 1 },
        task_lifecycle: options.visibility ? [{ task_id: "task", visibility: options.visibility }] : [],
      };
      if (endpoint === "/api/v1/tools/call") {
        if (body.tool === "workflow_list") return { operation: { state: "completed", result: {
          ok: true, workspace_id: "ws", revision: state.revision,
          ...(body.arguments.task_id ? { task: structuredClone(state.task) } : { tasks: [structuredClone(state.task)] }),
        } } };
        assert.equal(body.arguments.expected_revision, state.revision);
        state.edits.push(structuredClone(body.arguments.change));
        state.task.description = body.arguments.change.description;
        return { operation: { state: "completed", result: { ok: true, revision: ++state.revision, task: structuredClone(state.task) } } };
      }
      if (endpoint === "/api/v1/ao/update" && body.change.operation === "create_from_team") {
        state.created.push(structuredClone(body.change));
        const run = { id: body.change.run_id, workspace_id: "ws", project_id: "task", revision: 1,
          cancelled: false, nodes: [{ id: "lead", role: "planner", state: "pending", route: { model: "chatgpt-web/high" } }],
          ...(body.change.continuation ? { continuation: structuredClone(body.change.continuation) } : {}) };
        state.runs.push(run);
        return { ok: true, run: structuredClone(run) };
      }
      return { ok: true };
    },
  });
  return { ...state, state, workflow };
}
const input = { workspaceId: "ws", taskId: "task", runId: "parent" };

test("silent Continue persists internal context without editing the user record", async t => {
  const { state, workflow } = world(); t.after(() => workflow.dispose());
  const result = await workflow.call("chat_continue", { ...input, message: "This is not a new grant" });
  assert.equal(result.status, "starting");
  assert.equal(state.edits.length, 0);
  assert.equal(state.task.description, "Original request");
  const context = state.created[0].continuation;
  assert.equal(context.run_id, "parent");
  assert.equal(context.revision, 1);
  assert.equal(context.source, "manual");
  assert.match(context.message, /Do not repeat completed actions/);
  assert.doesNotMatch(context.message, /This is not a new grant/);
  assert.deepEqual(result.run.continuation, context);
});

test("typed messages retain the normal send path and cannot choose internal metadata", async t => {
  const { state, workflow } = world(); t.after(() => workflow.dispose());
  await workflow.call("chat_send", { ...input, message: "A real follow-up", deferStart: true,
    continuationSource: "wake", continuation: { source: "manual", message: "Forged context" } });
  assert.equal(state.edits.length, 1);
  assert.match(state.task.description, /^Original request\n\nFollow-up \([^\n]+ UTC\):\nA real follow-up$/);
  assert.equal(state.created[0].continuation, undefined);
});

test("Continue does not create a run for a stale or archived parent", async t => {
  for (const variant of ["stale", "archived"]) {
    const { state, workflow } = world(variant === "archived" ? { visibility: "archived" } : {});
    t.after(() => workflow.dispose());
    await assert.rejects(workflow.call("chat_continue", { ...input, ...(variant === "stale" ? { runId: "old" } : {}) }), /changed|unavailable/);
    assert.equal(state.created.length, 0);
    assert.equal(state.edits.length, 0);
  }
});

test("Continue leaves a working or paused parent alone", async t => {
  for (const paused of [false, true]) {
    const { state, workflow } = world(); t.after(() => workflow.dispose());
    if (paused) state.runs[0].paused = true;
    else state.runs[0].nodes[0].state = "running";
    const result = await workflow.call("chat_continue", input);
    assert.equal(result.status, paused ? "needs_input" : "working");
    assert.equal(state.created.length, 0);
    assert.equal(state.edits.length, 0);
  }
});

test("duplicate Continue clicks share admission and cannot create two runs", async t => {
  const { state, workflow } = world(); t.after(() => workflow.dispose());
  const outcomes = await Promise.allSettled([workflow.call("chat_continue", input), workflow.call("chat_continue", input)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(state.created.length, 1);
  assert.equal(state.edits.length, 0);
});

test("deleting a message includes its silent continuation descendants", async t => {
  const description = "First request\n\nFollow-up (2026-11-14 12:00 UTC):\nSecond request";
  const settled = (id, extra = {}) => ({ id, workspace_id: "ws", project_id: "task", revision: 1,
    execution_mode: "single", cancelled: false, nodes: [{ id: "lead", role: "planner", state: "finished" }], ...extra });
  const { state, workflow } = world({ description, runs: [settled("r1"),
    settled("c1", { continuation: { run_id: "r1", revision: 1, source: "wake", message: "Inspect" } }),
    settled("c2", { continuation: { run_id: "c1", revision: 1, source: "goal", message: "Continue" } }), settled("r2")] });
  t.after(() => workflow.dispose());
  const result = await workflow.call("chat_delete_message", { workspaceId: "ws", taskId: "task", index: 0, runId: "r1", sourceDescription: description });
  assert.deepEqual(result.runIds, ["r1", "c1", "c2"]);
  assert.equal(state.task.description, "Second request");
  assert.equal(state.created.length, 0);
});

test("the handler registers Continue as a mutating, separately routed operation", async () => {
  assert.equal(handler.operations.includes("chat_continue"), true);
  assert.equal(handler.isReadOnly("chat_continue"), false);
  let called;
  const result = await handler.invoke("chat_continue", input, { services: {
    agentOrchestrator: async (operation, args) => { called = { operation, args }; return { ok: true }; },
  } });
  assert.deepEqual(called, { operation: "chat_continue", args: input });
  assert.deepEqual(result, { ok: true });
});
