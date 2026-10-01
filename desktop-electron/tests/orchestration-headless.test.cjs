"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createOrchestrationHeadlessBridge } = require("../electron/orchestration-headless.cjs");

test("orchestration bridge reserves exact durable identities without forwarding secrets", async () => {
  const calls = [];
  const bridge = createOrchestrationHeadlessBridge({
    request: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, orchestration: { id: "run-1", planner_task_id: "planner-task" } };
    },
    registerPaseoProviders: async () => ({ ok: true }),
  });
  const stored = await bridge.reserveOrchestration({
    workspaceId: "qa", id: "run-1", taskId: "parent-task", expectedBoardRevision: 7,
    plannerPrompt: "Plan the harmless task",
    planner: { bindingId: "web", bindingGeneration: "web-gen", missionId: "planner-1", requestKey: "planner-start" },
    workers: [{ bindingId: "gemini", bindingGeneration: "gemini-gen", missionId: "worker-1", requestKey: "worker-start" }],
    reviewer: { bindingId: "web", bindingGeneration: "web-gen", missionId: "reviewer-1", requestKey: "reviewer-start" },
    ignoredCredential: "must-never-leak",
  });
  assert.equal(stored.id, "run-1");
  assert.deepEqual(calls.map((call) => call.path), ["/api/v1/execution/orchestration/reserve"]);
  assert.deepEqual(calls[0].body.planner, {
    binding_id: "web", binding_generation: "web-gen", mission_id: "planner-1", request_key: "planner-start",
  });
  assert.equal(calls[0].body.expected_board_revision, 7);
  assert.equal(JSON.stringify(calls).includes("must-never-leak"), false);
});

test("orchestration bridge reads and CAS-edits only the selected workflow task", async () => {
  const calls = [];
  const bridge = createOrchestrationHeadlessBridge({
    request: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, operation: { state: "completed", result: {
        ok: true, revision: body.tool === "workflow_list" ? 7 : 8,
        tasks: [{ id: "worker-task", title: "Gemini worker 1", description: body.arguments.change?.description ?? "" }],
      } } };
    },
    registerPaseoProviders: async () => ({ ok: true }),
  });
  const board = await bridge.readWorkflow({ workspaceId: "qa", taskId: "worker-task" });
  assert.equal(board.revision, 7);
  assert.equal(board.tasks[0].id, "worker-task");
  await bridge.updateTask({ workspaceId: "qa", taskId: "worker-task", title: "Gemini worker 1", description: "Read one file", expectedRevision: 7 });
  assert.deepEqual(calls.map((call) => call.body.tool), ["workflow_list", "workflow_update"]);
  assert.deepEqual(calls[1].body.arguments, {
    expected_revision: 7,
    change: { operation: "edit", id: "worker-task", title: "Gemini worker 1", description: "Read one file" },
  });
});

test("orchestration bridge accepts an exact workflow lookup returned as task", async () => {
  const bridge = createOrchestrationHeadlessBridge({
    request: async () => ({ ok: true, operation: { state: "completed", result: {
      ok: true, revision: 7, task: { id: "smoke-task", title: "No-tools smoke" },
    } } }),
    registerPaseoProviders: async () => ({ ok: true }),
  });
  const board = await bridge.readWorkflow({ workspaceId: "qa", taskId: "smoke-task" });
  assert.equal(board.revision, 7);
  assert.deepEqual(board.tasks, [board.task]);
});

test("orchestration bridge advances only the selected revision-checked run", async () => {
  const calls = [];
  const bridge = createOrchestrationHeadlessBridge({
    request: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, orchestration: { id: body.id, workspace_id: body.workspace_id,
        status: body.status, revision: body.expected_revision + 1 } };
    },
    registerPaseoProviders: async () => ({ ok: true }),
  });
  const updated = await bridge.updateOrchestrationStatus({ workspaceId: "qa", id: "run-1",
    expectedRevision: 3, status: "reviewing", ignoredCredential: "must-never-leak" });
  assert.equal(updated.revision, 4);
  assert.deepEqual(calls, [{
    path: "/api/v1/execution/orchestration/status",
    body: { workspace_id: "qa", id: "run-1", expected_revision: 3, status: "reviewing" },
  }]);
});
