"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  FIVE_STACK_CONTROL_PLANE_TOOLS,
  createFiveStackControlPlane,
  mergeCatalog,
} = require("../electron/five-stack-control-plane.cjs");
const { createProviderExecutionPlan } = require("../electron/provider-execution-router.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function account(id, providerId, overrides = {}) {
  return {
    id,
    providerId,
    label: id,
    identity: `${id}@example.test`,
    auth: "oauth",
    status: "connected",
    enabled: true,
    isDefault: false,
    hasCredential: true,
    models: ["default-model"],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot() {
  return {
    version: 1,
    accounts: [
      account("webgpt-main", "chatgpt-web", { isDefault: true, models: ["chatgpt-web/high", "gpt-5"] }),
      account("gemini-main", "gemini-api", { isDefault: true, models: ["gemini-pro"] }),
      account("cpa-main", "cliproxyapi-antigravity", { models: ["gemini-3.8-flash-high", "claude-sonnet"] }),
    ],
    proxyProfiles: [],
    routing: { globalEnabled: false, providers: [], accounts: [] },
    secrets: { accounts: { "webgpt-main": "must-never-leak" } },
  };
}

function plane() {
  let seq = 0;
  return createFiveStackControlPlane({
    clock: () => "2026-09-18T00:00:00.000Z",
    idFactory: () => `id${String(++seq).padStart(4, "0")}`,
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => snapshot(),
    getWebBridgeStatus: async () => true,
    getServicesSnapshot: async () => ({
      services: ["cpa"].map((id) => ({ id, status: "ready" })),
    }),
  });
}

test("API map covers all five stacks and the Paseo→Anneal loop", () => {
  const map = plane().apiMap();
  assert.equal(map.control_plane, "coding-tools-five-stack");
  assert.match(map.loop, /paseo_plan/);
  assert.match(map.loop, /anneal_open_from_review/);
  for (const id of ["cpa", "paseo", "anneal"]) {
    assert.ok(map.stacks[id], `missing stack ${id}`);
    assert.ok(map.stacks[id].manage.includes("five_stack_manage"));
    assert.ok(map.stacks[id].monitor.includes("five_stack_status"));
    assert.ok(map.stacks[id].monitor.includes("five_stack_inspect"));
  }
  assert.equal(map.stacks.cpa.openai, "http://127.0.0.1:8317/v1");
  assert.equal(map.stacks.cpa.bundleOwner, "pr-194");
  assert.equal(map.stacks.paseo.execution, "ws://127.0.0.1:6768/ws");
  assert.equal(map.stacks.anneal.api, "http://127.0.0.1:3000");
  assert.deepEqual(map.mcp.tools, [...FIVE_STACK_CONTROL_PLANE_TOOLS]);
});

test("Paseo plans an orchestrator and assigned subagents on in-app backends", async () => {
  const control = plane();
  const planned = await control.callTool("paseo_plan", {
    brief: "Ship the five-stack glue",
    orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
    subagents: [
      { role: "implementer", providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" },
      { role: "tester", providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" },
    ],
  }, { workspaceId: "ws-1" });

  assert.equal(planned.orchestrator.route.providerId, "chatgpt-web");
  assert.equal(planned.orchestrator.route.routeId, null);
  assert.equal(planned.orchestrator.backend, "http://127.0.0.1:17841/v1");
  assert.equal(planned.orchestrator.backendKind, "web");
  assert.equal(planned.orchestrator.route.workload, "paseo");
  assert.equal(planned.subagents.length, 2);
  assert.equal(planned.subagents[0].role, "implementer");
  assert.equal(planned.subagents[0].route.workload, "subagent");
  assert.equal(planned.subagents[0].route.providerId, "cliproxyapi-antigravity");
  assert.equal(planned.subagents[1].backend, "http://127.0.0.1:8317/v1");
  assert.equal(planned.subagents[1].backendKind, "cpa");
  assert.equal(planned.backends.cpa, "http://127.0.0.1:8317/v1");
  assert.equal(planned.backends.web, "http://127.0.0.1:17841/v1");
  assert.equal(JSON.stringify(planned).includes("must-never-leak"), false);
});

test("Paseo planning reserves one durable run and starts only the owned Web GPT planner", async () => {
  const bindings = [
    { id: "web-binding", generation: "web-generation", workspace_id: "ws-1", engine: "paseo",
      provider: "chatgpt-web", model: "chatgpt-web/high", account_id: "webgpt-main", route_id: null,
      enabled: true, connected: true, current_scope_valid: true },
    { id: "cpa-binding", generation: "cpa-generation", workspace_id: "ws-1", engine: "paseo",
      provider: "cliproxyapi-antigravity", model: "gemini-3.8-flash-high", account_id: "cpa-main", route_id: null,
      enabled: true, connected: true, current_scope_valid: true },
  ];
  const calls = [];
  let wrongWorkerBinding = false;
  const control = createFiveStackControlPlane({
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => snapshot(),
    getWebBridgeStatus: async () => true,
    getServicesSnapshot: async () => ({ services: [{ id: "cpa", status: "ready" }] }),
    readExecution: async () => ({ ok: true, execution: { bindings, missions: [], orchestrations: [] } }),
    readWorkflow: async () => ({ revision: 4, tasks: [{ id: "task-1", title: "Harmless check", description: "Read one project file." }] }),
    registerPaseoProviders: async () => { calls.push({ op: "providers" }); return { ok: true }; },
    reserveOrchestration: async (input) => {
      calls.push({ op: "reserve", input });
      return {
        id: input.id, workspace_id: "ws-1", task_id: "task-1", planner_task_id: "planner-task-1",
        planner_binding_id: "web-binding", planner_binding_generation: "web-generation",
        planner_mission_id: "run-1-planner", planner_request_key: "run-1-planner-start",
        worker_task_ids: ["worker-task-1"], worker_binding_ids: [wrongWorkerBinding ? "other-binding" : "cpa-binding"],
        worker_binding_generations: ["cpa-generation"], worker_mission_ids: ["run-1-worker-1"],
        worker_request_keys: ["run-1-worker-1-start"],
        reviewer_task_id: "reviewer-task-1", reviewer_binding_id: "web-binding",
        reviewer_binding_generation: "web-generation", reviewer_mission_id: "run-1-reviewer",
        reviewer_request_key: "run-1-reviewer-start", status: "planning", revision: 1,
      };
    },
    missionAdapter: {
      ensureStarted: async (input) => {
        calls.push({ op: "start-planner", input });
        return { missionId: input.missionId, phase: "creating", revision: 1 };
      },
    },
  });
  const input = {
    runId: "run-1", taskId: "task-1", brief: "Read one project file.",
    orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
    subagents: [{ role: "reader", providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
  };
  const planned = await control.callTool("paseo_plan", input, { workspaceId: "ws-1" });
  assert.equal(planned.id, "run-1");
  assert.equal(planned.status, "planning");
  assert.deepEqual(calls.map((call) => call.op), ["providers", "reserve", "start-planner"]);
  assert.equal(calls[1].input.expectedBoardRevision, 4);
  assert.match(calls[1].input.plannerPrompt, /Read one project file\./);
  assert.match(calls[1].input.plannerPrompt, /worker-1/);
  assert.match(calls[1].input.plannerPrompt, /reader/);
  assert.equal(calls[2].input.taskId, "planner-task-1");
  assert.equal(calls[2].input.bindingGeneration, "web-generation");
  assert.equal(calls[2].input.route.model, "chatgpt-web/high");
  assert.equal(calls.some((call) => call.input?.route?.model === "gemini-3.8-flash-high"), false);
  wrongWorkerBinding = true;
  await assert.rejects(
    () => control.callTool("paseo_plan", input, { workspaceId: "ws-1" }),
    /Durable Paseo reservation does not match the selected run and route/,
  );
  assert.equal(calls.filter((call) => call.op === "start-planner").length, 1);
});

test("Paseo refuses provider substitution for selected Web GPT and Gemini roles", async () => {
  const base = snapshot();
  const request = {
    brief: "Exact routes",
    orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
    subagents: [{ providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
  };
  const control = (accounts) => createFiveStackControlPlane({
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => ({ ...base, accounts }),
  });

  await assert.rejects(
    () => control(base.accounts.filter((row) => row.providerId !== "chatgpt-web"))
      .callTool("paseo_plan", request, { workspaceId: "ws-1" }),
    /Requested model chatgpt-web\/high is not available/,
  );
  await assert.rejects(
    () => control(base.accounts.filter((row) => row.providerId !== "cliproxyapi-antigravity"))
      .callTool("paseo_plan", request, { workspaceId: "ws-1" }),
    /Requested model gemini-3\.8-flash-high is not available/,
  );
});

test("Paseo refuses implicit account or model selection", async () => {
  const control = plane();
  await assert.rejects(
    () => control.callTool("paseo_plan", {
      brief: "Keep the requested Web GPT route",
      orchestrator: { providerId: "chatgpt-web" },
      subagents: [{ providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
    }, { workspaceId: "ws-1" }),
    /Select an exact orchestrator provider, account and model/,
  );
  await assert.rejects(
    () => control.callTool("paseo_plan", {
      brief: "Keep the requested Gemini route",
      orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
      subagents: [{ providerId: "gemini-api" }],
    }, { workspaceId: "ws-1" }),
    /Select an exact subagent provider, account and model/,
  );
});

test("Paseo orchestration refuses different Web GPT and Gemini model routes", async () => {
  const control = plane();
  await assert.rejects(
    () => control.callTool("paseo_plan", {
      brief: "Use the selected orchestration route",
      orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "gpt-5" },
      subagents: [{ providerId: "gemini-api", accountId: "gemini-main", model: "gemini-pro" }],
    }, { workspaceId: "ws-1" }),
    /Web GPT orchestrator requires chatgpt-web\/high/,
  );
  await assert.rejects(
    () => control.callTool("paseo_plan", {
      brief: "Use the selected orchestration route",
      orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
      subagents: [{ providerId: "gemini-api", accountId: "gemini-main", model: "gemini-pro" }],
    }, { workspaceId: "ws-1" }),
    /Gemini worker requires gemini-3\.8-flash-high through CPA/,
  );
});

test("Paseo plans refuse backend substitution when the selected service is down", async () => {
  for (const [unavailableId, selectedProvider] of [
    ["chatgpt-web", "chatgpt-web"],
    ["cpa", "cliproxyapi-antigravity"],
  ]) {
    const control = createFiveStackControlPlane({
      planProvider: createProviderExecutionPlan,
      getProviderSnapshot: async () => snapshot(),
      getWebBridgeStatus: async () => unavailableId !== "chatgpt-web",
      getServicesSnapshot: async () => ({
        services: ["cpa"].map((id) => ({
          id,
          status: id === unavailableId ? "stopped" : "ready",
        })),
      }),
    });
    await assert.rejects(
      () => control.callTool("paseo_plan", {
        brief: "Use the exact Web GPT and Gemini routes",
        orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
        subagents: [{ providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
      }, { workspaceId: "ws-1" }),
      new RegExp(`No ready backend for selected provider ${selectedProvider}`),
    );
    const status = await control.callTool("five_stack_status", {}, { workspaceId: "ws-1" });
    assert.equal(status.plans.length, 0);
  }
});

test("Web GPT planning uses the verified bridge and refuses an unavailable bridge", async () => {
  const create = (webReady) => createFiveStackControlPlane({
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => snapshot(),
    getWebBridgeStatus: async () => webReady,
    getServicesSnapshot: async () => ({
      services: [
        { id: "cpa", status: "ready" },
      ],
    }),
  });
  const input = {
    brief: "Use Web GPT, not Router",
    orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
    subagents: [{ providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
  };
  const planned = await create(true).callTool("paseo_plan", input, { workspaceId: "ws-1" });
  assert.equal(planned.orchestrator.backend, "http://127.0.0.1:17841/v1");
  assert.equal(planned.orchestrator.backendKind, "web");
  await assert.rejects(
    () => create(false).callTool("paseo_plan", input, { workspaceId: "ws-1" }),
    /No ready backend for selected provider chatgpt-web/,
  );
});

test("Paseo refuses an unverified worker backend", async () => {
  const control = createFiveStackControlPlane({
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => snapshot(),
    getWebBridgeStatus: async () => true,
  });
  await assert.rejects(
    () => control.callTool("paseo_plan", {
      brief: "No unverified CPA",
      orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
      subagents: [{ providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
    }, { workspaceId: "ws-1" }),
    /No ready backend for selected provider cliproxyapi-antigravity/,
  );
});

test("Paseo run refuses fake dispatch without a real execution service", async () => {
  const control = plane();
  const planned = await control.callTool("paseo_plan", {
    brief: "Run a real worker",
    orchestrator: { providerId: "chatgpt-web", accountId: "webgpt-main", model: "chatgpt-web/high" },
    subagents: [{ providerId: "cliproxyapi-antigravity", accountId: "cpa-main", model: "gemini-3.8-flash-high" }],
  }, { workspaceId: "ws-1" });

  await assert.rejects(
    () => control.callTool("paseo_run", { planId: planned.id }, { workspaceId: "ws-1" }),
    /execution service is unavailable/i,
  );
  const status = await control.callTool("five_stack_status", {}, { workspaceId: "ws-1" });
  assert.equal(status.runs.length, 0);
});

test("manual results cannot fabricate a Paseo review or Anneal task", async () => {
  const control = plane();
  await assert.rejects(
    () => control.callTool("paseo_submit_result", { runId: "run-fake", assignmentId: "sub-fake" }),
    /Paseo run was not found/,
  );
  await assert.rejects(
    () => control.callTool("paseo_review", { runId: "run-fake" }),
    /Paseo run was not found/,
  );
  await assert.rejects(
    () => control.callTool("anneal_open_from_review", { reviewId: "review-fake" }),
    /Paseo review was not found/,
  );
  const status = await control.callTool("five_stack_status", {}, { workspaceId: "ws-1" });
  assert.equal(status.reviews.length, 0);
  assert.equal(status.annealTasks.length, 0);
});

test("Paseo selects CPA for CommandCode plugin accounts and fails closed when CPA is down", () => {
  const { selectInAppBackend, stackAvailability } = require("../electron/five-stack-control-plane.cjs");
  const cpa = "http://127.0.0.1:8317/v1";
  const up = stackAvailability({ services: [{ id: "cpa", status: "ready" }] });
  assert.equal(selectInAppBackend("commandcode-proxy", { cpa }, up).url, cpa);
  assert.equal(selectInAppBackend("commandcode-proxy", { cpa }, up).kind, "cpa");
  const down = stackAvailability({ services: [{ id: "cpa", status: "error" }] });
  assert.equal(selectInAppBackend("commandcode-proxy", { cpa }, down).available, false);
});

test("MCP catalog overlay keeps headless tools and exposes five-stack resources", () => {
  const catalog = mergeCatalog({
    tools: [{ name: "read_file", description: "Read a file" }, "five_stack_status"],
    resources: [{ uri: "coding-tools://workspace/one" }],
  });
  assert.equal(catalog.control_plane, "coding-tools-five-stack");
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name || tool).slice(0, FIVE_STACK_CONTROL_PLANE_TOOLS.length),
    [...FIVE_STACK_CONTROL_PLANE_TOOLS],
  );
  assert.ok(catalog.tools.some((tool) => tool.name === "read_file"));
  assert.equal(catalog.tools.filter((tool) => (tool.name || tool) === "five_stack_status").length, 1);
  assert.ok(catalog.resources.some((resource) => resource.uri === "coding-tools://five-stack/api-map"));
  assert.ok(catalog.resources.some((resource) => resource.uri === "coding-tools://workspace/one"));
});

test("MCP manage/inspect uses the panel controller and strips secrets", async () => {
  const actions = [];
  let seq = 0;
  const control = createFiveStackControlPlane({
    clock: () => "2026-09-18T00:00:00.000Z",
    idFactory: () => `id${String(++seq).padStart(4, "0")}`,
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => snapshot(),
    getServicesSnapshot: async () => ({
      version: 1,
      services: [{
        id: "cpa",
        running: true,
        endpoint: "http://127.0.0.1:8317/",
        callerKey: "must-never-leak",
        proxyApiKey: "must-never-leak",
        secretConfigured: true,
      }],
    }),
    inspectService: async (stack) => ({
      id: stack,
      reachable: true,
      managementKey: "must-never-leak",
    }),
    manageService: async (stack, action) => {
      actions.push({ stack, action });
      return { id: stack, action, running: action !== "stop" };
    },
  });

  const status = await control.callTool("five_stack_status", {});
  assert.equal(status.services.services[0].id, "cpa");
  assert.equal(status.services.services[0].secretConfigured, true);
  assert.equal(JSON.stringify(status).includes("must-never-leak"), false);

  const inspected = await control.callTool("five_stack_inspect", { stack: "cpa" });
  assert.equal(inspected.id, "cpa");
  assert.equal(inspected.managementKey, undefined);

  const started = await control.callTool("five_stack_manage", {
    stack: "cpa",
    action: "start",
  });
  assert.equal(started.id, "cpa");
  assert.deepEqual(actions, [{ stack: "cpa", action: "start" }]);

  await assert.rejects(
    () => control.callTool("five_stack_manage", { stack: "cpa", action: "install" }),
    /start, stop, restart or repair/,
  );
});
