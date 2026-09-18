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
      account("webgpt-main", "chatgpt-web", { isDefault: true, models: ["gpt-5"] }),
      account("gemini-main", "gemini-api", { isDefault: true, models: ["gemini-pro"] }),
      account("cpa-main", "cliproxyapi-antigravity", { models: ["claude-sonnet"] }),
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
  });
}

test("API map covers all five stacks and the Paseo→Anneal loop", () => {
  const map = plane().apiMap();
  assert.equal(map.control_plane, "coding-tools-five-stack");
  assert.match(map.loop, /paseo_plan/);
  assert.match(map.loop, /anneal_open_from_review/);
  assert.equal(map.compose.cpaRouterBundle, "pr-194");
  assert.equal(map.compose.commandcodeLongrun, "pr-193");
  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.ok(map.stacks[id], `missing stack ${id}`);
    assert.ok(map.stacks[id].manage.includes("five_stack_manage"));
    assert.ok(map.stacks[id].monitor.includes("five_stack_status"));
    assert.ok(map.stacks[id].monitor.includes("five_stack_inspect"));
  }
  assert.equal(map.stacks.cpa.openai, "http://127.0.0.1:8317/v1");
  assert.equal(map.stacks.cpa.bundleOwner, "pr-194");
  assert.equal(map.stacks["codex-router"].bundleOwner, "pr-194");
  assert.equal(map.stacks.paseo.execution, "ws://127.0.0.1:6768/ws");
  assert.equal(map.stacks.anneal.api, "http://127.0.0.1:3000");
  assert.deepEqual(map.mcp.tools, [...FIVE_STACK_CONTROL_PLANE_TOOLS]);
});

test("Paseo plans an orchestrator and assigned subagents on in-app backends", async () => {
  const control = plane();
  const planned = await control.callTool("paseo_plan", {
    brief: "Ship the five-stack glue",
    orchestrator: { providerId: "chatgpt-web" },
    subagents: [
      { role: "implementer", providerId: "gemini-api" },
      { role: "reviewer", providerId: "cliproxyapi-antigravity" },
    ],
  }, { workspaceId: "ws-1" });

  assert.equal(planned.orchestrator.route.providerId, "chatgpt-web");
  assert.equal(planned.orchestrator.backend, "http://127.0.0.1:4202/v1");
  assert.equal(planned.orchestrator.backendKind, "router");
  assert.equal(planned.orchestrator.route.workload, "paseo");
  assert.equal(planned.subagents.length, 2);
  assert.equal(planned.subagents[0].role, "implementer");
  assert.equal(planned.subagents[0].route.workload, "subagent");
  assert.equal(planned.subagents[0].route.providerId, "gemini-api");
  assert.equal(planned.subagents[1].backend, "http://127.0.0.1:8317/v1");
  assert.equal(planned.subagents[1].backendKind, "cpa");
  assert.equal(planned.backends.cpa, "http://127.0.0.1:8317/v1");
  assert.equal(planned.backends.router, "http://127.0.0.1:4202/v1");
  assert.equal(planned.backends.commandcode, "http://127.0.0.1:9090/v1");
  assert.equal(JSON.stringify(planned).includes("must-never-leak"), false);
});

test("run → submit issues → review → Anneal task preview keeps assignment structure", async () => {
  const control = plane();
  const planned = await control.callTool("paseo_plan", {
    brief: "Find the login bug",
    orchestrator: { providerId: "chatgpt-web" },
    subagents: [{ role: "debugger", providerId: "gemini-api" }],
  }, { workspaceId: "ws-1" });
  const ran = await control.callTool("paseo_run", { planId: planned.id, message: "Reproduce login" }, {
    workspaceId: "ws-1",
  });
  assert.equal(ran.status, "awaiting_results");
  assert.equal(ran.liveModelCompletion, false);
  assert.equal(ran.assignments[0].status, "dispatched");

  await control.callTool("paseo_submit_result", {
    runId: ran.id,
    assignmentId: ran.assignments[0].id,
    ok: false,
    summary: "Null deref in session restore",
    issues: [{ title: "Session restore crash", detail: "Null token on cold start" }],
  });
  const reviewed = await control.callTool("paseo_review", { runId: ran.id });
  assert.equal(reviewed.status, "issues_found");
  assert.equal(reviewed.findings.length, 1);

  const task = await control.callTool("anneal_open_from_review", { reviewId: reviewed.id }, {
    workspaceId: "ws-1",
  });
  assert.equal(task.state, "BACKLOG");
  assert.equal(task.approvalGate, true);
  assert.equal(task.opensPullRequest, false);
  assert.equal(task.handoff.posted, false);
  assert.equal(task.source.kind, "paseo_review");
  assert.equal(task.assignment.orchestrator.route.providerId, "chatgpt-web");
  assert.equal(task.assignment.subagents[0].role, "debugger");
  const preview = await control.callTool("anneal_preview", { taskId: task.id }, { workspaceId: "ws-1" });
  assert.equal(preview.id, task.id);
  const status = await control.callTool("five_stack_status", {}, { workspaceId: "ws-1" });
  assert.equal(status.annealTasks.length, 1);
});

test("Paseo uses CPA 8317 and Router 4202 only when those services are available", async () => {
  const {
    createFiveStackControlPlane,
    selectInAppBackend,
    stackAvailability,
  } = require("../electron/five-stack-control-plane.cjs");
  const { FIVE_STACK_ENDPOINTS } = require("../electron/five-stack-cross-use.cjs");
  const backends = {
    cpa: FIVE_STACK_ENDPOINTS.cpa.v1,
    router: FIVE_STACK_ENDPOINTS["codex-router"].v1,
    commandcode: FIVE_STACK_ENDPOINTS["commandcode-proxy"].v1,
  };
  assert.equal(backends.cpa, "http://127.0.0.1:8317/v1");
  assert.equal(backends.router, "http://127.0.0.1:4202/v1");
  assert.equal(backends.commandcode, "http://127.0.0.1:9090/v1");

  const down = stackAvailability({
    services: [
      { id: "cpa", status: "error", running: false },
      { id: "codex-router", status: "ready", running: true },
      { id: "commandcode-proxy", status: "ready", running: true },
    ],
  });
  assert.equal(down.cpa, false);
  assert.equal(down.router, true);
  const cpaFallback = selectInAppBackend("cliproxyapi-antigravity", backends, down);
  assert.equal(cpaFallback.url, "http://127.0.0.1:4202/v1");
  assert.equal(cpaFallback.kind, "router");
  assert.equal(cpaFallback.fallback, true);

  const commandcode = selectInAppBackend("commandcode-proxy", backends, {
    cpa: true,
    router: true,
    commandcode: true,
  });
  assert.equal(commandcode.url, "http://127.0.0.1:9090/v1");
  assert.equal(commandcode.kind, "commandcode");
  assert.equal(commandcode.fallback, false);

  let seq = 0;
  const posted = [];
  const control = createFiveStackControlPlane({
    clock: () => "2026-09-18T00:00:00.000Z",
    idFactory: () => `id${String(++seq).padStart(4, "0")}`,
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => snapshot(),
    getServicesSnapshot: async () => ({
      services: [
        { id: "cpa", status: "ready" },
        { id: "codex-router", status: "ready" },
        { id: "anneal", status: "ready" },
        { id: "commandcode-proxy", status: "ready" },
      ],
    }),
    handoffAnnealTask: async ({ projectId, path, body }) => {
      posted.push({ projectId, path, body });
      return { id: "remote-task-1" };
    },
  });
  const planned = await control.callTool("paseo_plan", {
    brief: "Handoff after review",
    orchestrator: { providerId: "chatgpt-web" },
    subagents: [{ role: "cpa-worker", providerId: "cliproxyapi-antigravity" }],
  }, { workspaceId: "ws-1" });
  assert.equal(planned.orchestrator.backendKind, "router");
  assert.equal(planned.subagents[0].backendKind, "cpa");
  const ran = await control.callTool("paseo_run", { planId: planned.id, message: "Go" }, { workspaceId: "ws-1" });
  await control.callTool("paseo_submit_result", {
    runId: ran.id,
    assignmentId: ran.assignments[0].id,
    ok: false,
    issues: [{ title: "Need a task", detail: "Open Anneal" }],
  });
  const reviewed = await control.callTool("paseo_review", { runId: ran.id });
  const task = await control.callTool("anneal_open_from_review", {
    reviewId: reviewed.id,
    projectId: "proj-1",
  }, { workspaceId: "ws-1" });
  assert.equal(task.state, "BACKLOG");
  assert.equal(task.handoff.posted, true);
  assert.equal(task.id, "remote-task-1");
  assert.equal(posted[0].path, "/projects/proj-1/tasks");
  assert.equal(posted[0].body.status, "BACKLOG");
  assert.equal(posted[0].body.approvalGate, true);
  assert.equal(posted[0].body.opensPullRequest, false);
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

test("Desktop and MCP share the control-plane tools.call path", () => {
  const main = read("electron/main.cjs");
  const paseo = read("src/features/PaseoOrchestratorSurface.tsx");
  const anneal = read("src/features/AnnealTasksSurface.tsx");
  assert.match(main, /createFiveStackControlPlane/);
  assert.match(main, /fiveStackControlPlane\.hasTool/);
  assert.match(main, /mergeCatalog/);
  assert.match(main, /manageService/);
  assert.match(main, /inspectService/);
  assert.match(main, /repairManagedComponent/);
  assert.doesNotMatch(main, /five_stack_manage[\s\S]{0,200}installManagedComponent/);
  assert.match(paseo, /tools\.call/);
  assert.match(paseo, /paseo_plan/);
  assert.match(paseo, /paseo_run/);
  assert.match(paseo, /paseo_review/);
  assert.match(anneal, /anneal_preview|anneal_open_from_review|five_stack_status/);
  assert.doesNotMatch(read("electron/five-stack-control-plane.cjs"), /bundled-runtimes/);
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
        id: "commandcode-proxy",
        running: true,
        endpoint: "http://127.0.0.1:9090/",
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
  assert.equal(status.services.services[0].id, "commandcode-proxy");
  assert.equal(status.services.services[0].secretConfigured, true);
  assert.equal(JSON.stringify(status).includes("must-never-leak"), false);

  const inspected = await control.callTool("five_stack_inspect", { stack: "commandcode-proxy" });
  assert.equal(inspected.id, "commandcode-proxy");
  assert.equal(inspected.managementKey, undefined);

  const started = await control.callTool("five_stack_manage", {
    stack: "commandcode-proxy",
    action: "start",
  });
  assert.equal(started.id, "commandcode-proxy");
  assert.deepEqual(actions, [{ stack: "commandcode-proxy", action: "start" }]);

  await assert.rejects(
    () => control.callTool("five_stack_manage", { stack: "commandcode-proxy", action: "install" }),
    /start, stop, restart or repair/,
  );
});
