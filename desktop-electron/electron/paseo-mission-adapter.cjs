"use strict";

function createPaseoMissionAdapter({ readWorkflow, readExecution, updateExecution } = {}) {
  if (![readWorkflow, readExecution, updateExecution].every((value) => typeof value === "function")) {
    throw new Error("Paseo execution service is unavailable");
  }
  const execution = (view) => view?.execution ?? view;

  async function ensureCreated({ workspaceId, taskId, missionId, bindingId, bindingGeneration, route, createKey } = {}) {
    if (![workspaceId, taskId, missionId, bindingId, bindingGeneration, createKey].every((value) => typeof value === "string" && value)) {
      throw new Error("Paseo mission identity is required");
    }
    const selected = route && [route.providerId, route.accountId, route.model]
      .every((value) => typeof value === "string" && value)
      && (route.routeId === null || (typeof route.routeId === "string" && route.routeId));
    if (!selected) throw new Error("An exact Paseo route is required");

    const findMission = (view) => (execution(view).missions || []).find((row) => row.mission?.spec?.mission_id === missionId);
    let view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
    let entry = findMission(view);
    if (entry && entry.mission.spec.workspace_id !== workspaceId) {
      throw new Error("Paseo mission ID belongs to another workspace");
    }
    const binding = (execution(view).bindings || []).find((row) => (
      row.id === bindingId && row.workspace_id === workspaceId && row.engine === "paseo"
        && row.enabled === true && row.connected === true && row.current_scope_valid === true
    ));
    if (!binding || binding.provider !== route.providerId || binding.model !== route.model
      || binding.account_id !== route.accountId || (binding.route_id ?? null) !== route.routeId) {
      throw new Error("Selected binding does not match the exact route");
    }
    if (binding.generation !== bindingGeneration) throw new Error("Paseo binding generation changed");

    if (!entry) {
      const board = await readWorkflow({ workspaceId, taskId });
      if (!Array.isArray(board.tasks) || !board.tasks.some((task) => task.id === taskId)) {
        throw new Error("Select an existing task in this workspace");
      }
      try {
        await updateExecution({
          workspaceId,
          expectedRevision: board.revision,
          change: { operation: "agent_prepare", binding_id: bindingId, task_id: taskId, mission_id: missionId },
          confirm: true,
        });
      } catch (error) {
        // Another writer may have prepared this exact mission; reconcile it before sending Create.
        view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
        if (!findMission(view)) throw error;
      }
      view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
      entry = findMission(view);
    }

    const spec = entry?.mission?.spec;
    if (entry.binding_id !== bindingId || entry.binding_generation !== bindingGeneration
      || spec?.task_id !== taskId || spec?.workspace_id !== workspaceId
      || spec?.provider !== route.providerId || spec?.model !== route.model
      || spec?.account_id !== route.accountId || (spec?.route_id ?? null) !== route.routeId) {
      throw new Error("Prepared Paseo mission does not match the exact task and route");
    }
    if (entry.mission.phase === "draft") {
      await updateExecution({
        workspaceId,
        expectedRevision: entry.mission.revision,
        change: { operation: "agent_control", mission_id: missionId, request_key: createKey, action: "create" },
        confirm: true,
      });
      view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
      entry = findMission(view);
    }
    return {
      missionId,
      phase: entry.mission.phase,
      revision: entry.mission.revision,
      recordId: entry.mission.record_id ?? null,
    };
  }

  async function ensureStarted(input = {}) {
    if (typeof input.startKey !== "string" || !input.startKey) {
      throw new Error("Paseo Start request key is required");
    }
    const created = await ensureCreated(input);
    if (created.phase !== "ready") return created;
    if (!created.recordId) throw new Error("Owned Paseo agent ID is not confirmed");
    await updateExecution({
      workspaceId: input.workspaceId,
      expectedRevision: created.revision,
      change: {
        operation: "agent_control",
        mission_id: input.missionId,
        request_key: input.startKey,
        action: "start",
      },
      confirm: true,
    });
    const view = await readExecution({ workspaceId: input.workspaceId, missionId: input.missionId, refreshSource: false });
    const entry = (execution(view).missions || []).find((row) => row.mission?.spec?.mission_id === input.missionId);
    return {
      missionId: input.missionId,
      phase: entry.mission.phase,
      revision: entry.mission.revision,
      recordId: entry.mission.record_id ?? null,
    };
  }

  async function ownedReply({ workspaceId, missionId, bindingGeneration, startKey } = {}) {
    if (![workspaceId, missionId, bindingGeneration, startKey].every((value) => typeof value === "string" && value)) {
      throw new Error("Paseo reply identity is required");
    }
    const view = await readExecution({ workspaceId, missionId, refreshSource: false });
    const entry = (execution(view).missions || []).find((row) => row.mission?.spec?.mission_id === missionId);
    if (!entry || entry.mission.spec.workspace_id !== workspaceId) {
      throw new Error("Paseo mission belongs to another workspace or is missing");
    }
    if (entry.binding_generation !== bindingGeneration) throw new Error("Paseo binding generation changed");
    if (entry.start_message_id !== startKey) throw new Error("Paseo output belongs to another Start");
    if (!["review_required", "accepted"].includes(entry.mission.phase) || !entry.output) return null;
    const output = entry.output;
    if (output.agent_id !== entry.mission.record_id) throw new Error("Paseo output belongs to another agent");
    if (typeof output.text !== "string" || !output.text.trim()
      || typeof output.turn_id !== "string" || !output.turn_id
      || typeof output.epoch !== "string" || !output.epoch
      || !Number.isInteger(output.seq_start) || !Number.isInteger(output.seq_end)
      || output.seq_end < output.seq_start) {
      throw new Error("Paseo output is incomplete");
    }
    return {
      text: output.text,
      agentId: output.agent_id,
      turnId: output.turn_id,
      epoch: output.epoch,
      seqStart: output.seq_start,
      seqEnd: output.seq_end,
    };
  }

  async function requestObservation({ workspaceId, missionId, bindingGeneration, startKey } = {}) {
    if (![workspaceId, missionId, bindingGeneration, startKey].every((value) => typeof value === "string" && value)) {
      throw new Error("Paseo observation identity is required");
    }
    const before = await readExecution({ workspaceId, missionId, refreshSource: false });
    const entry = (execution(before).missions || []).find((row) => row.mission?.spec?.mission_id === missionId);
    if (!entry || entry.mission.spec.workspace_id !== workspaceId || !entry.mission.record_id) {
      throw new Error("Owned Paseo agent is not confirmed");
    }
    if (entry.binding_generation !== bindingGeneration) throw new Error("Paseo binding generation changed");
    if (entry.start_message_id !== startKey) throw new Error("Paseo observation belongs to another Start");
    const queued = await readExecution({ workspaceId, missionId, refreshSource: true });
    if (execution(queued).refresh_requested !== true) throw new Error("Paseo source refresh was not queued");
    return { missionId, refreshRequested: true };
  }

  return { ensureCreated, ensureStarted, ownedReply, requestObservation };
}

module.exports = { createPaseoMissionAdapter };
