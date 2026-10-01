"use strict";

const { randomUUID } = require("node:crypto");
const { createPaseoMissionAdapter } = require("./paseo-mission-adapter.cjs");

function createOrchestrationHeadlessBridge({ request, registerPaseoProviders } = {}) {
  if (typeof request !== "function" || typeof registerPaseoProviders !== "function") {
    throw new Error("Local orchestration runtime is unavailable");
  }

  async function workflow(workspaceId, tool, args) {
    const response = await request("/api/v1/tools/call", {
      request_id: `orchestration-${randomUUID()}`,
      workspace_id: workspaceId,
      tool,
      arguments: args,
    });
    const operation = response?.operation;
    if (operation?.state !== "completed" || operation.result?.ok !== true) {
      throw new Error(`Local ${tool} operation did not complete`);
    }
    return operation.result;
  }

  const readWorkflow = async ({ workspaceId, taskId }) => {
    if (!taskId) throw new Error("Select an exact workflow task ID");
    const result = await workflow(workspaceId, "workflow_list", { task_id: taskId, limit: 1, include_archived: false });
    return { ...result, tasks: result.tasks ?? (result.task ? [result.task] : []) };
  };
  const readExecution = ({ workspaceId, missionId = null, refreshSource = false }) => request(
    "/api/v1/execution/read",
    { workspace_id: workspaceId, mission_id: missionId, refresh_source: refreshSource === true },
  );
  const updateExecution = ({ workspaceId, expectedRevision, change, confirm }) => request(
    "/api/v1/execution/update",
    { workspace_id: workspaceId, expected_revision: expectedRevision, change, confirm: confirm === true },
  );
  const updateTask = ({ workspaceId, taskId, title, description, expectedRevision }) => workflow(
    workspaceId,
    "workflow_update",
    { expected_revision: expectedRevision, change: { operation: "edit", id: taskId, title, description } },
  );
  const stage = ({ bindingId, bindingGeneration, missionId, requestKey }) => ({
    binding_id: bindingId, binding_generation: bindingGeneration,
    mission_id: missionId, request_key: requestKey,
  });
  const reserveOrchestration = async (input) => {
    const response = await request("/api/v1/execution/orchestration/reserve", {
      workspace_id: input.workspaceId,
      id: input.id,
      task_id: input.taskId,
      expected_board_revision: input.expectedBoardRevision,
      planner_prompt: input.plannerPrompt,
      planner: stage(input.planner),
      workers: input.workers.map(stage),
      reviewer: stage(input.reviewer),
    });
    if (response?.ok !== true || !response.orchestration) {
      throw new Error("Local orchestration reservation did not complete");
    }
    return response.orchestration;
  };
  const updateOrchestrationStatus = async ({ workspaceId, id, expectedRevision, status }) => {
    const response = await request("/api/v1/execution/orchestration/status", {
      workspace_id: workspaceId, id, expected_revision: expectedRevision, status,
    });
    if (response?.ok !== true || response.orchestration?.id !== id) {
      throw new Error("Local orchestration status update did not complete");
    }
    return response.orchestration;
  };

  return {
    readWorkflow,
    readExecution,
    updateExecution,
    updateTask,
    reserveOrchestration,
    updateOrchestrationStatus,
    registerPaseoProviders,
    missionAdapter: createPaseoMissionAdapter({ readWorkflow, readExecution, updateExecution }),
  };
}

module.exports = { createOrchestrationHeadlessBridge };
