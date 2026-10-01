"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFiveStackControlPlane } = require("../electron/five-stack-control-plane.cjs");

test("Paseo dispatches Gemini workers serially from owned Web GPT planner output", async () => {
  const record = {
    id: "run-qa", workspace_id: "qa", task_id: "parent-task", planner_task_id: "planner-task",
    planner_binding_id: "web-binding", planner_binding_generation: "web-gen",
    planner_mission_id: "run-qa-planner", planner_request_key: "run-qa-planner-start",
    worker_binding_ids: ["gemini-binding", "gemini-binding"],
    worker_binding_generations: ["gemini-gen", "gemini-gen"],
    worker_mission_ids: ["run-qa-worker-1", "run-qa-worker-2"],
    worker_task_ids: ["worker-task-1", "worker-task-2"],
    worker_request_keys: ["run-qa-worker-1-start", "run-qa-worker-2-start"],
    reviewer_binding_id: "web-binding", reviewer_binding_generation: "web-gen",
    reviewer_task_id: "reviewer-task", reviewer_mission_id: "run-qa-reviewer",
    reviewer_request_key: "run-qa-reviewer-start", status: "planning", revision: 1,
  };
  const bindings = [
    { id: "web-binding", generation: "web-gen", workspace_id: "qa", engine: "paseo",
      provider: "chatgpt-web", account_id: "web-account", model: "chatgpt-web/high", route_id: null,
      enabled: true, connected: true, current_scope_valid: true },
    { id: "gemini-binding", generation: "gemini-gen", workspace_id: "qa", engine: "paseo",
      provider: "cliproxyapi-antigravity", account_id: "cpa-account", model: "gemini-3.8-flash-high", route_id: null,
      enabled: true, connected: true, current_scope_valid: true },
  ];
  const tasks = new Map([
    ["worker-task-1", { id: "worker-task-1", title: "Gemini worker 1", description: "" }],
    ["worker-task-2", { id: "worker-task-2", title: "Gemini worker 2", description: "" }],
  ]);
  const replies = new Map();
  const starts = [];
  const statuses = [];
  let nextPhase = "failed";
  let boardRevision = 7;
  const control = createFiveStackControlPlane({
    readExecution: async () => ({ ok: true, execution: { orchestrations: [record], bindings, missions: [] } }),
    readWorkflow: async ({ taskId }) => ({ revision: boardRevision, tasks: [tasks.get(taskId)] }),
    updateTask: async ({ taskId, description, expectedRevision }) => {
      assert.equal(expectedRevision, boardRevision);
      tasks.get(taskId).description = description;
      boardRevision += 1;
    },
    updateOrchestrationStatus: async ({ workspaceId, id, expectedRevision, status }) => {
      assert.equal(workspaceId, "qa");
      assert.equal(id, record.id);
      assert.equal(expectedRevision, record.revision);
      record.status = status;
      record.revision += 1;
      statuses.push(status);
      return { ...record };
    },
    missionAdapter: {
      ownedReply: async ({ missionId }) => replies.get(missionId) ?? null,
      ensureStarted: async (input) => {
        starts.push(input);
        return { missionId: input.missionId, phase: nextPhase };
      },
    },
  });

  await assert.rejects(
    () => control.callTool("paseo_run", { planId: "run-qa" }, { workspaceId: "qa" }),
    /Planner output is not ready/,
  );
  assert.equal(starts.length, 0);

  replies.set("run-qa-planner", { text: JSON.stringify({ tasks: [
    { role: "worker-2", brief: "Read file B" },
    { role: "worker-1", brief: "Read file A" },
  ] }), agentId: "web-agent", turnId: "plan-turn" });
  await assert.rejects(
    () => control.callTool("paseo_run", { planId: "run-qa" }, { workspaceId: "qa" }),
    /Gemini worker failed/,
  );
  starts.length = 0;
  nextPhase = "unknown";
  const uncertain = await control.callTool("paseo_run", { planId: "run-qa" }, { workspaceId: "qa" });
  assert.equal(uncertain.status, "uncertain");
  starts.length = 0;
  nextPhase = "creating";
  const first = await control.callTool("paseo_run", { planId: "run-qa" }, { workspaceId: "qa" });
  assert.equal(first.status, "executing");
  assert.deepEqual([...tasks.values()].map((task) => task.description), ["Read file A", "Read file B"]);
  assert.deepEqual(starts.map((item) => item.missionId), ["run-qa-worker-1"]);
  assert.equal(starts[0].bindingGeneration, "gemini-gen");
  assert.equal(starts[0].route.model, "gemini-3.8-flash-high");

  replies.set("run-qa-worker-1", { text: "A", agentId: "gemini-agent-1", turnId: "worker-turn-1" });
  await control.callTool("paseo_run", { planId: "run-qa" }, { workspaceId: "qa" });
  assert.deepEqual(starts.map((item) => item.missionId), ["run-qa-worker-1", "run-qa-worker-2"]);
  replies.set("run-qa-worker-2", { text: "B", agentId: "gemini-agent-2", turnId: "worker-turn-2" });
  const ready = await control.callTool("paseo_run", { planId: "run-qa" }, { workspaceId: "qa" });
  assert.equal(ready.status, "ready_for_review");
  assert.deepEqual(statuses, ["executing", "uncertain", "executing", "ready_for_review"]);
  assert.equal(starts.length, 2);
});
