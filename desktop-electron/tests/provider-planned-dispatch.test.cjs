"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createProviderExecutionDispatcher,
  providerBindingId,
} = require("../electron/provider-execution-dispatch.cjs");

function snapshot() {
  return {
    version: 1,
    accounts: [{
      id: "api-account",
      providerId: "openai-api",
      label: "API account",
      identity: "api@example.test",
      auth: "api_key",
      status: "connected",
      enabled: true,
      isDefault: true,
      models: ["gpt-test"],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    }],
    proxyProfiles: [{
      id: "global",
      name: "Global",
      enabled: true,
      endpoint: { protocol: "socks5", host: "proxy.example.test", port: 1080 },
      scopes: ["anneal"],
      bypass: ["localhost", "127.0.0.1", "::1"],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    }],
    routing: {
      globalEnabled: true,
      globalProfileId: "global",
      providers: [],
      accounts: [],
    },
  };
}

function store() {
  return {
    snapshot,
    accountSecret(accountId) {
      assert.equal(accountId, "api-account");
      return { executionCredential: "engine-secret" };
    },
  };
}

test("planned configure selects the Provider Hub account and keeps its secret out of the response", async () => {
  const calls = [];
  const dispatcher = createProviderExecutionDispatcher({
    store: store(),
    applyGlobalRouting: async () => snapshot(),
    requestExecution: async (pathname, body) => {
      calls.push({ pathname, body });
      if (pathname.endsWith("/read")) return { execution: { revision: 7 } };
      return { execution: { revision: 8 } };
    },
  });

  const result = await dispatcher.configure({
    workspaceId: "workspace-1",
    workload: "anneal",
    providerId: "openai-api",
    accountId: "api-account",
    model: "gpt-test",
    endpoint: "http://127.0.0.1:3000/",
    mode: "default",
    projectId: "project-1",
    repoId: "repo-1",
    assigneeId: "agent-1",
    maxDurationMin: 120,
    confirm: true,
  });

  assert.equal(result.plan.account.id, "api-account");
  assert.equal(result.bindingId, providerBindingId(result.plan, "anneal"));
  assert.equal(JSON.stringify(result).includes("engine-secret"), false);
  assert.deepEqual(calls.map((call) => call.pathname), [
    "/api/v1/execution/read",
    "/api/v1/execution/provider",
  ]);
  assert.equal(calls[1].body.settings.provider, "openai-api");
  assert.equal(calls[1].body.settings.model, "gpt-test");
  assert.equal(calls[1].body.settings.id, result.bindingId);
  assert.equal(calls[1].body.credential, "engine-secret");
});

test("planned Anneal dispatch uses the exact account-owned binding selected by the planner", async () => {
  const calls = [];
  let readCount = 0;
  const planBindingId = "provider-hub-anneal-api-account";
  const dispatcher = createProviderExecutionDispatcher({
    store: store(),
    applyGlobalRouting: async () => snapshot(),
    requestExecution: async (pathname, body) => {
      calls.push({ pathname, body });
      if (pathname.endsWith("/read")) {
        readCount += 1;
        if (readCount === 1) {
          return {
            revision: 11,
            execution: {
              bindings: [{
                id: planBindingId,
                engine: "anneal",
                provider: "openai-api",
                model: "gpt-test",
                enabled: true,
                connected: true,
                current_scope_valid: true,
              }],
            },
          };
        }
        return {
          execution: {
            missions: [{
              mission: {
                revision: 3,
                spec: { mission_id: "mission-1" },
              },
            }],
          },
        };
      }
      return { ok: true };
    },
  });

  const result = await dispatcher.dispatchMission({
    workspaceId: "workspace-1",
    workload: "anneal",
    providerId: "openai-api",
    accountId: "api-account",
    model: "gpt-test",
    taskId: "task-1",
    missionId: "mission-1",
    confirm: true,
  });

  assert.equal(result.bindingId, planBindingId);
  assert.equal(result.plan.account.id, "api-account");
  assert.deepEqual(calls.map((call) => call.pathname), [
    "/api/v1/execution/read",
    "/api/v1/execution/update",
    "/api/v1/execution/read",
    "/api/v1/execution/update",
  ]);
  assert.equal(calls[1].body.change.binding_id, planBindingId);
  assert.equal(calls[3].body.change.mission_id, "mission-1");
  assert.equal(JSON.stringify(result).includes("engine-secret"), false);
});

test("renderer dispatch calls the planned main-process bridge instead of bypassing Provider Hub", () => {
  const root = path.resolve(__dirname, "..");
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const surface = fs.readFileSync(
    path.join(root, "src/features/ProviderOrchestratorSurfaces.tsx"),
    "utf8",
  );

  assert.match(preload, /configureProviderExecution/);
  assert.match(preload, /dispatchProviderMission/);
  assert.match(surface, /configureProviderExecution\(/);
  assert.match(surface, /dispatchProviderMission\(/);
  assert.doesNotMatch(surface, /api\.execution\.provider\(/);
});
