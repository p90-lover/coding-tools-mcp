const assert = require("node:assert/strict");
const test = require("node:test");
const { createPaseoMissionAdapter } = require("../electron/paseo-mission-adapter.cjs");

const route = {
  providerId: "chatgpt-web",
  accountId: "web-account",
  model: "chatgpt-web/high",
  routeId: "web-route",
};

function fixture() {
  const calls = [];
  const reads = [];
  const workflowReads = [];
  const binding = {
    id: "web-binding", generation: "approved-generation", workspace_id: "qa", engine: "paseo", enabled: true,
    connected: true, current_scope_valid: true,
    provider: route.providerId, account_id: route.accountId,
    model: route.model, route_id: route.routeId,
  };
  const state = { bindings: [binding], missions: [] };
  const adapter = createPaseoMissionAdapter({
    readWorkflow: async (input) => {
      workflowReads.push(input);
      return { revision: 7, tasks: [{ id: "task-1", workspace_id: "qa" }] };
    },
    readExecution: async (input) => {
      reads.push(input);
      return { ok: true, execution: { ...state, ...(input.refreshSource ? { refresh_requested: true } : {}) } };
    },
    updateExecution: async (input) => {
      calls.push(input);
      if (input.change.operation === "agent_prepare") {
        assert.equal(input.expectedRevision, 7);
        state.missions.push({
          binding_id: binding.id,
          binding_generation: binding.generation,
          mission: {
            spec: { mission_id: input.change.mission_id, task_id: "task-1", workspace_id: "qa",
              provider: route.providerId, model: route.model,
              account_id: route.accountId, route_id: binding.route_id },
            phase: "draft", revision: 0, receipts: {},
          },
        });
      } else {
        assert.equal(input.change.operation, "agent_control");
        if (input.change.action === "create") {
          assert.equal(input.expectedRevision, 0);
          state.missions[0].mission.phase = "creating";
          state.missions[0].mission.revision = 1;
        } else {
          assert.equal(input.change.action, "start");
          assert.equal(input.expectedRevision, 3);
          state.missions[0].mission.phase = "start_requested";
          state.missions[0].mission.revision = 4;
        }
        state.missions[0].mission.receipts[input.change.request_key] = { state: "reserved" };
      }
      return { ok: true, execution: state };
    },
  });
  return { adapter, binding, calls, reads, workflowReads, state };
}

const request = {
  workspaceId: "qa", taskId: "task-1", missionId: "planner-1",
  bindingId: "web-binding", bindingGeneration: "approved-generation", route, createKey: "planner-create-key",
};

test("mission adapter prepares and creates once with the exact route and stable key", async () => {
  const { adapter, calls, state, workflowReads } = fixture();
  const first = await adapter.ensureCreated(request);
  assert.equal(first.missionId, "planner-1");
  assert.equal(first.phase, "creating");
  assert.deepEqual(calls.map((call) => call.change.operation), ["agent_prepare", "agent_control"]);
  assert.equal(calls[1].change.request_key, "planner-create-key");
  assert.equal(calls[1].change.action, "create");
  assert.deepEqual(workflowReads, [{ workspaceId: "qa", taskId: "task-1" }]);

  const repeated = await adapter.ensureCreated(request);
  assert.equal(repeated.phase, "creating");
  assert.equal(calls.length, 2);
  state.missions[0].mission.phase = "unknown";
  const uncertain = await adapter.ensureCreated(request);
  assert.equal(uncertain.phase, "unknown");
  assert.equal(calls.length, 2);
});

test("mission adapter accepts a verified direct route without inventing a proxy ID", async () => {
  const { adapter, binding } = fixture();
  binding.route_id = null;
  const direct = { ...route, routeId: null };
  const created = await adapter.ensureCreated({ ...request, route: direct });
  assert.equal(created.phase, "creating");
});

test("mission adapter refuses wrong workspace or model before any mutation", async () => {
  const { adapter, calls, state, binding } = fixture();
  state.missions.push({
    binding_id: binding.id,
    mission: { spec: { mission_id: "planner-1", workspace_id: "other", task_id: "task-1" }, phase: "draft", revision: 0 },
  });
  await assert.rejects(() => adapter.ensureCreated(request), /another workspace/);
  state.missions.length = 0;
  binding.model = "native-only";
  await assert.rejects(() => adapter.ensureCreated(request), /exact route/);
  assert.equal(calls.length, 0);
});

test("mission adapter refuses a reconfigured binding generation before Create", async () => {
  const { adapter, binding, calls } = fixture();
  binding.generation = "replacement-generation";
  await assert.rejects(() => adapter.ensureCreated(request), /binding generation changed/);
  assert.equal(calls.length, 0);
});

test("mission adapter starts an owned ready agent once and never replays an unknown Start", async () => {
  const { adapter, calls, state, binding } = fixture();
  state.missions.push({
    binding_id: binding.id,
    binding_generation: binding.generation,
    mission: {
      spec: { mission_id: "planner-1", task_id: "task-1", workspace_id: "qa",
        provider: route.providerId, model: route.model,
        account_id: route.accountId, route_id: route.routeId },
      phase: "ready", revision: 3, record_id: "agent-1", receipts: {},
    },
  });
  const started = await adapter.ensureStarted({ ...request, startKey: "planner-start-key" });
  assert.equal(started.phase, "start_requested");
  assert.deepEqual(calls.map((call) => call.change.action), ["start"]);
  assert.equal(calls[0].change.request_key, "planner-start-key");

  state.missions[0].mission.phase = "unknown";
  const uncertain = await adapter.ensureStarted({ ...request, startKey: "planner-start-key" });
  assert.equal(uncertain.phase, "unknown");
  assert.equal(calls.length, 1);
});

test("mission adapter returns only a current, ownership-checked assistant result", async () => {
  const { adapter, state, binding } = fixture();
  const entry = {
    binding_id: binding.id,
    binding_generation: binding.generation,
    start_message_id: "planner-start-key",
    mission: {
      spec: { mission_id: "planner-1", task_id: "task-1", workspace_id: "qa" },
      record_id: "agent-1", phase: "review_required", revision: 5,
    },
    output: { agent_id: "agent-1", turn_id: "turn-2", epoch: "epoch-1",
      seq_start: 2, seq_end: 4, text: "CURRENT_REPLY" },
  };
  state.missions.push(entry);
  const reply = await adapter.ownedReply({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key" });
  assert.equal(reply.text, "CURRENT_REPLY");
  assert.equal(reply.turnId, "turn-2");

  entry.binding_generation = "replacement-generation";
  await assert.rejects(
    () => adapter.ownedReply({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key" }),
    /binding generation changed/,
  );
  entry.binding_generation = binding.generation;

  entry.mission.phase = "running";
  assert.equal(await adapter.ownedReply({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key" }), null);
  entry.mission.phase = "review_required";
  entry.output.agent_id = "other-agent";
  await assert.rejects(() => adapter.ownedReply({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key" }), /another agent/);
  entry.output.agent_id = "agent-1";
  await assert.rejects(() => adapter.ownedReply({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "older-start-key" }), /another Start/);
});

test("mission adapter requests source observation without claiming a result before it lands", async () => {
  const { adapter, state, binding, reads } = fixture();
  state.missions.push({
    binding_id: binding.id,
    binding_generation: binding.generation,
    start_message_id: "planner-start-key",
    mission: {
      spec: { mission_id: "planner-1", task_id: "task-1", workspace_id: "qa" },
      record_id: "agent-1", phase: "running", revision: 4,
    },
    output: null,
  });
  const requested = await adapter.requestObservation({
    workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key",
  });
  assert.deepEqual(requested, { missionId: "planner-1", refreshRequested: true });
  assert.equal(reads.at(-1).refreshSource, true);
  assert.equal(await adapter.ownedReply({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key" }), null);
  state.missions[0].binding_generation = "replacement-generation";
  await assert.rejects(
    () => adapter.requestObservation({ workspaceId: "qa", missionId: "planner-1", bindingGeneration: binding.generation, startKey: "planner-start-key" }),
    /binding generation changed/,
  );
  assert.equal(reads.at(-1).refreshSource, false);
});
