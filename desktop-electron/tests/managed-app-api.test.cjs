"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagedAppApiHandler } = require("../electron/managed-app-api.cjs");

function service(id, status = "ready") {
  return {
    id,
    name: id,
    status,
    endpoint: `http://127.0.0.1:${id === "codex-router" ? 4202 : id === "commandcode-proxy" ? 9090 : id === "paseo" ? 6768 : 5173}/`,
    ...(id === "paseo" ? { executionEndpoint: "ws://127.0.0.1:6767/ws" } : {}),
    ...(id === "anneal" ? { executionEndpoint: "http://127.0.0.1:3000/" } : {}),
    modelCount: id === "commandcode-proxy" ? 3 : null,
    accountCount: id === "codex-router" ? 4 : 0,
    connectedAccountCount: id === "codex-router" ? 3 : 0,
    providerModelCount: id === "codex-router" ? 7 : 0,
    error: null,
    managedInstall: {
      state: "installed",
      version: "0.7.0-rc.9",
      platformMode: "native",
      missingCredentials: [],
    },
  };
}

function fixture() {
  const calls = [];
  const services = new Map([
    ["codex-router", service("codex-router")],
    ["commandcode-proxy", service("commandcode-proxy")],
    ["paseo", service("paseo")],
    ["anneal", service("anneal")],
  ]);
  const externalServices = {
    snapshot: () => ({ version: 1, services: [...services.values()] }),
    inspect: async (id) => { calls.push(["inspect", id]); return services.get(id); },
    start: async (id) => { calls.push(["start", id]); return services.get(id); },
    stop: async (id) => { calls.push(["stop", id]); return services.get(id); },
    restart: async (id) => { calls.push(["restart", id]); return services.get(id); },
    installManagedComponent: async (id) => { calls.push(["install", id]); return services.get(id); },
    repairManagedComponent: async (id) => { calls.push(["repair", id]); return services.get(id); },
    syncCodexRouter: async () => { calls.push(["sync", "codex-router"]); return { ok: true, args: [], stdout: "done", stderr: "" }; },
  };
  const upstreamTools = {
    openEmbeddedTool: async (id, section) => {
      calls.push(["open", id, section]);
      return {
        tool: { id, status: "ready" },
        section,
        url: id === "paseo"
          ? `http://127.0.0.1:6768/${section}`
          : `http://127.0.0.1:5173/#/${section}`,
        embedded: true,
      };
    },
  };
  const providerSnapshot = {
    version: 1,
    accounts: [
      { id: "a1", providerId: "openai", label: "Primary", status: "connected", enabled: true, models: ["gpt-a", "gpt-b"] },
      { id: "a2", providerId: "openai", label: "Backup", status: "expired", enabled: true, models: ["gpt-b"] },
      { id: "a3", providerId: "anthropic", label: "Claude", status: "connected", enabled: true, models: ["claude-a"] },
      { id: "a4", providerId: "anthropic", label: "Archived", status: "connected", enabled: true, models: ["hidden"], archivedAt: "2026-09-18T00:00:00Z" },
    ],
    proxyProfiles: [],
    routing: { globalEnabled: false, globalProfileId: null, providers: [], accounts: [] },
  };
  const handler = createManagedAppApiHandler({
    externalServices,
    upstreamTools,
    getProviderController: async () => ({ store: { snapshot: () => providerSnapshot } }),
    createExecutionPlan: (_snapshot, input) => ({
      version: 1,
      workload: input.workload,
      provider: { id: "openai", name: "OpenAI", protocol: "openai_responses" },
      account: { id: "a1", label: "Primary", identity: "private@example.com", auth: "oauth" },
      model: input.model || "gpt-a",
      proxy: { mode: "direct", source: "default", profile: null },
      fallbackUsed: false,
      credentialHandle: { providerId: "openai", accountId: "a1" },
    }),
  });
  return { calls, handler };
}

test("one Coding Tools API snapshot exposes all five app handles without secrets", async () => {
  const { handler } = fixture();
  const snapshot = await handler.snapshot();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.apps.map((app) => app.handle), [
    "cpa",
    "codex-router",
    "commandcode-proxy",
    "paseo",
    "anneal",
  ]);
  assert.equal(snapshot.apps[0].accountCount, 3);
  assert.equal(snapshot.apps[0].connectedAccountCount, 2);
  assert.equal(snapshot.apps[0].providerCount, 2);
  assert.equal(snapshot.apps[0].modelCount, 3);
  assert.equal(JSON.stringify(snapshot).includes("private@example.com"), false);
  assert.equal(JSON.stringify(snapshot).includes("credentialHandle"), false);
});

test("mutating lifecycle calls require confirmation and dispatch through one handler", async () => {
  const { calls, handler } = fixture();
  await assert.rejects(
    handler.invoke({ handle: "paseo", operation: "start" }),
    /confirmation/i,
  );
  const result = await handler.invoke({ handle: "paseo", operation: "start", confirm: true });
  assert.equal(result.app.handle, "paseo");
  assert.deepEqual(calls, [["start", "paseo"]]);
});

test("per-app allowlists reject operations belonging to another engine", async () => {
  const { handler } = fixture();
  await assert.rejects(
    handler.invoke({ handle: "commandcode-proxy", operation: "sync", confirm: true }),
    /does not support/i,
  );
  await assert.rejects(
    handler.invoke({ handle: "cpa", operation: "start", confirm: true }),
    /does not support/i,
  );
});

test("CPA provider inventory and route planning stay redacted", async () => {
  const { handler } = fixture();
  const inventory = await handler.invoke({ handle: "cpa", operation: "providers" });
  assert.deepEqual(inventory.providers.map((item) => item.id), ["anthropic", "openai"]);
  assert.equal(inventory.providers.find((item) => item.id === "openai").accountCount, 2);

  const plan = await handler.invoke({
    handle: "cpa",
    operation: "plan",
    arguments: { workload: "paseo", providerId: "openai", model: "gpt-a" },
  });
  assert.equal(plan.plan.account.id, "a1");
  assert.equal(plan.plan.account.label, "Primary");
  assert.equal(Object.hasOwn(plan.plan.account, "identity"), false);
  assert.equal(Object.hasOwn(plan.plan, "credentialHandle"), false);
});

test("Paseo and Anneal section APIs return bounded embedded routes", async () => {
  const { calls, handler } = fixture();
  const paseo = await handler.invoke({
    handle: "paseo",
    operation: "open",
    arguments: { section: "sessions" },
  });
  const anneal = await handler.invoke({
    handle: "anneal",
    operation: "open",
    arguments: { section: "tasks" },
  });
  assert.equal(paseo.embedded.url, "http://127.0.0.1:6768/sessions");
  assert.equal(anneal.embedded.url, "http://127.0.0.1:5173/#/tasks");
  assert.deepEqual(calls, [
    ["open", "paseo", "sessions"],
    ["open", "anneal", "tasks"],
  ]);
});
