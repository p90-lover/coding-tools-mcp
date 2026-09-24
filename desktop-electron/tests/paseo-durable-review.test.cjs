"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFiveStackControlPlane } = require("../electron/five-stack-control-plane.cjs");

test("Paseo review waits for owned Gemini output and a distinct Web GPT reviewer turn", async () => {
  const record = {
    id: "run-qa", workspace_id: "qa", task_id: "parent-task", planner_task_id: "planner-task",
    planner_binding_id: "web-binding", planner_binding_generation: "web-gen",
    planner_mission_id: "run-qa-planner", planner_request_key: "run-qa-planner-start",
    worker_binding_ids: ["gemini-binding"], worker_binding_generations: ["gemini-gen"],
    worker_mission_ids: ["run-qa-worker-1"], worker_task_ids: ["worker-task-1"],
    worker_request_keys: ["run-qa-worker-1-start"],
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
    ["parent-task", { id: "parent-task", title: "Harmless check", description: "Read one project file." }],
    ["reviewer-task", { id: "reviewer-task", title: "Web GPT reviewer", description: "" }],
  ]);
  const replies = new Map();
  const starts = [];
  let reviewerPhase = "failed";
  let annealReady = false;
  let remoteTaskId = "";
  let boardRevision = 9;
  const control = createFiveStackControlPlane({
    getServicesSnapshot: async () => ({ services: [{ id: "anneal", status: annealReady ? "ready" : "offline" }] }),
    handoffAnnealTask: async () => ({ id: remoteTaskId }),
    readExecution: async () => ({ ok: true, execution: { orchestrations: [record], bindings, missions: [] } }),
    readWorkflow: async ({ taskId }) => ({ revision: boardRevision, tasks: [tasks.get(taskId)] }),
    updateTask: async ({ taskId, description, expectedRevision }) => {
      assert.equal(expectedRevision, boardRevision);
      tasks.get(taskId).description = description;
      boardRevision += 1;
    },
    missionAdapter: {
      ownedReply: async ({ missionId }) => replies.get(missionId) ?? null,
      ensureStarted: async (input) => {
        starts.push(input);
        return { missionId: input.missionId, phase: reviewerPhase };
      },
    },
  });
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-qa", issues: [{ title: "manual" }] }, { workspaceId: "qa" }),
    /Current child output is required/,
  );
  assert.equal(starts.length, 0);

  replies.set("run-qa-worker-1", { text: "FILE_READ_OK", agentId: "gemini-agent", turnId: "worker-turn" });
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" }),
    /Current planner output is required/,
  );
  replies.set("run-qa-planner", { text: '{"tasks":[{"role":"worker-1","brief":"Read one project file"}]}', agentId: "web-planner", turnId: "plan-turn" });
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" }),
    /Web GPT reviewer failed/,
  );
  starts.length = 0;
  reviewerPhase = "unknown";
  const uncertain = await control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" });
  assert.equal(uncertain.status, "uncertain");
  starts.length = 0;
  reviewerPhase = "creating";
  const reviewing = await control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" });
  assert.equal(reviewing.status, "reviewing");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].missionId, "run-qa-reviewer");
  assert.equal(starts[0].route.model, "chatgpt-web/high");
  assert.match(tasks.get("reviewer-task").description, /FILE_READ_OK/);
  assert.match(tasks.get("reviewer-task").description, /gemini-agent/);
  assert.match(tasks.get("reviewer-task").description, /\{"verdict":"pass","findings":\[\]\}/);

  replies.set("run-qa-reviewer", { text: '{"verdict":"pass","findings":[]}', agentId: "gemini-agent", turnId: "worker-turn" });
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" }),
    /distinct Web GPT reviewer turn/,
  );
  replies.set("run-qa-reviewer", { text: '{"verdict":"pass","findings":[]}', agentId: "web-planner", turnId: "plan-turn" });
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" }),
    /distinct Web GPT reviewer turn/,
  );
  replies.set("run-qa-reviewer", { text: '{"verdict":"pass","findings":[]}', agentId: "web-reviewer", turnId: "review-turn" });
  tasks.get("parent-task").description = "Changed after reviewer start";
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" }),
    /Review evidence changed after the reviewer started/,
  );
  tasks.get("parent-task").description = "Read one project file.";
  const done = await control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" });
  assert.equal(done.status, "passed");
  assert.equal(done.liveModelCompletion, true);
  assert.equal(done.reviewer.agentId, "web-reviewer");
  assert.equal(starts.length, 1);
  await assert.rejects(
    () => control.callTool("anneal_open_from_review", { reviewId: done.id }, { workspaceId: "other" }),
    /Review does not belong to this workspace/,
  );
  replies.set("run-qa-reviewer", { text: '{"verdict":"needs_changes","findings":[{"title":"Missing check","detail":"Add one check"}]}', agentId: "web-reviewer", turnId: "review-turn" });
  const needsChanges = await control.callTool("paseo_review", { runId: "run-qa" }, { workspaceId: "qa" });
  await assert.rejects(
    () => control.callTool("anneal_open_from_review", { reviewId: needsChanges.id }, { workspaceId: "qa" }),
    /Anneal is not ready/,
  );
  annealReady = true;
  await assert.rejects(
    () => control.callTool("anneal_open_from_review", { reviewId: needsChanges.id }, { workspaceId: "qa" }),
    /Anneal did not return a task ID/,
  );
  remoteTaskId = "remote-task-1";
  const handedOff = await control.callTool("anneal_open_from_review", { reviewId: needsChanges.id }, { workspaceId: "qa" });
  assert.equal(handedOff.id, "remote-task-1");
  assert.equal(handedOff.handoff.posted, true);
});

test("Paseo review dispatches a bounded prompt for a long owned Gemini result", async () => {
  const record = {
    id: "run-long", workspace_id: "qa", task_id: "parent-task",
    planner_binding_id: "web-binding", planner_binding_generation: "web-gen",
    planner_mission_id: "run-long-planner", planner_request_key: "run-long-planner-start",
    worker_binding_ids: ["gemini-binding"], worker_binding_generations: ["gemini-gen"],
    worker_mission_ids: ["run-long-worker-1"], worker_request_keys: ["run-long-worker-1-start"],
    reviewer_binding_id: "web-binding", reviewer_binding_generation: "web-gen",
    reviewer_task_id: "reviewer-task", reviewer_mission_id: "run-long-reviewer",
    reviewer_request_key: "run-long-reviewer-start", status: "planning", revision: 1,
  };
  const bindings = [
    { id: "web-binding", generation: "web-gen", workspace_id: "qa", engine: "paseo",
      provider: "chatgpt-web", account_id: "web-account", model: "chatgpt-web/high",
      enabled: true, connected: true, current_scope_valid: true },
    { id: "gemini-binding", generation: "gemini-gen", workspace_id: "qa", engine: "paseo",
      provider: "cliproxyapi-antigravity", account_id: "cpa-account", model: "gemini-3.8-flash-high",
      enabled: true, connected: true, current_scope_valid: true },
  ];
  let prompt = "";
  let reviewerText = "";
  const statuses = [];
  const control = createFiveStackControlPlane({
    readExecution: async () => ({ execution: { orchestrations: [record], bindings } }),
    readWorkflow: async ({ taskId }) => ({ revision: 1, tasks: [{ id: taskId,
      title: taskId, description: taskId === "parent-task" ? "Review this result." : prompt }] }),
    updateTask: async ({ description }) => { prompt = description; },
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
      ownedReply: async ({ missionId }) => missionId === "run-long-worker-1"
        ? { text: "RESULT_OK " + "x".repeat(16_000), agentId: "gemini-agent", turnId: "worker-turn" }
        : missionId === "run-long-planner"
          ? { text: "{}", agentId: "web-planner", turnId: "planner-turn" }
          : reviewerText ? { text: reviewerText, agentId: "web-reviewer", turnId: "review-turn" } : null,
      ensureStarted: async () => ({ phase: "creating" }),
    },
  });
  const result = await control.callTool("paseo_review", { runId: "run-long" }, { workspaceId: "qa" });
  assert.equal(result.status, "reviewing");
  assert.ok(prompt.length <= 8_192);
  assert.match(prompt, /RESULT_OK/);
  assert.match(prompt, /"truncated":true/);
  assert.match(prompt, /Do not pass if any output is truncated/);
  assert.deepEqual(statuses, ["executing", "ready_for_review", "reviewing"]);
  reviewerText = '{"verdict":"pass","findings":[]}';
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-long" }, { workspaceId: "qa" }),
    /cannot pass a review with truncated evidence/,
  );
  assert.equal(record.status, "reviewing");
  reviewerText = '{"verdict":"needs_changes","findings":[{"title":"Shorten output","detail":"Return a concise summary"}]}';
  const completed = await control.callTool("paseo_review", { runId: "run-long" }, { workspaceId: "qa" });
  assert.equal(completed.status, "needs_changes");
  assert.deepEqual(statuses, ["executing", "ready_for_review", "reviewing", "needs_changes"]);
});
