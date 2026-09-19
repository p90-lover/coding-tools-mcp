"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagedAppApiHandler } = require("../electron/managed-app-api.cjs");

function managedService(id, overrides = {}) {
  const endpoints = {
    cpa: "http://127.0.0.1:8317/",
    "codex-router": "http://127.0.0.1:4202/",
    "commandcode-proxy": "http://127.0.0.1:9090/",
    paseo: "http://127.0.0.1:6768/",
    anneal: "http://127.0.0.1:5173/",
  };
  return {
    id,
    name: id,
    status: "ready",
    endpoint: endpoints[id],
    ...(id === "paseo" ? { executionEndpoint: "ws://127.0.0.1:6768/ws" } : {}),
    ...(id === "anneal" ? { executionEndpoint: "http://127.0.0.1:3000/" } : {}),
    pid: 100,
    owned: true,
    error: null,
    modelCount: id === "commandcode-proxy" ? 3 : null,
    accountCount: id === "cpa" ? 2 : 0,
    connectedAccountCount: id === "cpa" ? 2 : 0,
    providerModelCount: id === "codex-router" ? 7 : 0,
    managedInstall: {
      state: "installed",
      version: "0.7.0-rc.11",
      platformMode: "native",
      missingCredentials: [],
      installedAt: "2026-09-19T00:00:00.000Z",
    },
    ...overrides,
  };
}

function fixture() {
  const calls = [];
  const services = new Map([
    ["cpa", managedService("cpa")],
    ["codex-router", managedService("codex-router")],
    ["commandcode-proxy", managedService("commandcode-proxy")],
    ["paseo", managedService("paseo")],
    ["anneal", managedService("anneal")],
  ]);
  const providerSnapshot = {
    version: 1,
    accounts: [
      { id: "a1", providerId: "openai", label: "Primary", identity: "secret@example.com", status: "connected", enabled: true, models: ["gpt-a", "gpt-b"] },
      { id: "a2", providerId: "openai", label: "Backup", identity: "other@example.com", status: "expired", enabled: true, models: ["gpt-b"] },
      { id: "a3", providerId: "anthropic", label: "Claude", identity: "claude@example.com", status: "connected", enabled: true, models: ["claude-a"] },
      { id: "a4", providerId: "anthropic", label: "Old", status: "connected", enabled: true, models: ["hidden"], archivedAt: "2026-09-18T00:00:00Z" },
    ],
    proxyProfiles: [],
    routing: { globalEnabled: false, globalProfileId: null, providers: [], accounts: [] },
  };
  const externalServices = {
    snapshot: () => ({ version: 1, services: [...services.values()] }),
    inspect: async (id) => { calls.push(["inspect", id]); return services.get(id); },
    installManagedComponent: async (id) => { calls.push(["install", id]); return services.get(id); },
    repairManagedComponent: async (id) => { calls.push(["repair", id]); return services.get(id); },
    start: async (id) => { calls.push(["start", id]); return services.get(id); },
    stop: async (id) => { calls.push(["stop", id]); return services.get(id); },
    restart: async (id) => { calls.push(["restart", id]); return services.get(id); },
    syncCodexRouter: async () => {
      calls.push(["sync", "codex-router"]);
      return { ok: true, args: ["codex", "integrate"], stdout: "done", stderr: "" };
    },
    upstreamConfiguration: (id) => ({
      endpoint: services.get(id)?.endpoint,
      executionEndpoint: services.get(id)?.executionEndpoint,
    }),
  };
  const originalUi = {
    snapshot: () => ({
      version: 1,
      tools: [
        { id: "cpa", status: "ready", sections: ["dashboard", "providers"], endpoint: "http://127.0.0.1:8317/", error: null },
        { id: "codex-router", status: "ready", sections: ["dashboard", "models"], endpoint: "http://127.0.0.1:4202/", error: null },
      ],
    }),
    inspect: async (id) => { calls.push(["ui-inspect", id]); return { id, status: "ready", sections: ["dashboard"] }; },
    start: async (id) => { calls.push(["ui-start", id]); return { id, status: "ready", sections: ["dashboard"] }; },
    stop: async (id) => { calls.push(["ui-stop", id]); return { id, status: "stopped", sections: ["dashboard"] }; },
    restart: async (id) => { calls.push(["ui-restart", id]); return { id, status: "ready", sections: ["dashboard"] }; },
    openEmbedded: async (id, section) => {
      calls.push(["ui-open", id, section]);
      return { tool: { id, status: "ready" }, section, url: `http://127.0.0.1/${id}/${section}`, embedded: id === "cpa", originalWindow: id === "codex-router" };
    },
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
  const bootstrap = {
    getSnapshot: () => ({
      status: "idle",
      reason: null,
      startedAt: null,
      completedAt: null,
      components: [...services.keys()].map((id) => ({ id, status: "ready", action: "inspect", missingCredentials: [], message: null })),
    }),
    reconcile: async ({ reason, componentIds }) => {
      calls.push(["reconcile", reason, componentIds]);
      return { status: "ready", reason, components: componentIds.map((id) => ({ id, status: "ready" })) };
    },
  };
  const handler = createManagedAppApiHandler({
    externalServices,
    originalUi,
    upstreamTools,
    managedBootstrap: bootstrap,
    getProviderController: async () => ({ store: { snapshot: () => providerSnapshot } }),
    createExecutionPlan: (_snapshot, input) => ({
      version: 1,
      workload: input.workload,
      provider: { id: input.providerId || "openai", name: "OpenAI", protocol: "openai_responses" },
      account: { id: input.accountId || "a1", label: "Primary", identity: "secret@example.com", auth: "oauth" },
      model: input.model || "gpt-a",
      proxy: { mode: "direct", source: "default", profile: null },
      fallbackUsed: false,
      credentialHandle: { providerId: "openai", accountId: "a1" },
    }),
    commandCodePlan: (input) => {
      calls.push(["registration-plan", input.baseUrl]);
      return {
        provider: { id: "commandcode-proxy", name: "CommandCode Proxy", baseUrl: input.baseUrl, adapter: "openai-chat" },
        commands: [["model-router", "codex", "providers", "generic", "add", "commandcode-proxy"]],
        credentialPromptRequired: true,
        text: "non-secret plan",
      };
    },
    commandCodeApply: (input) => {
      calls.push(["registration-apply", input.baseUrl]);
      return { endpoint: input.baseUrl, credentialPromptRequired: true, steps: [{ name: "add", ok: true, detail: "done" }], planText: "non-secret plan" };
    },
    performUpstreamAction: async (input) => {
      calls.push(["act", input.toolId, input.op, input.endpoint, input.credential]);
      return { ok: true, op: input.op, detail: "done", body: { id: "result-1" } };
    },
  });
  return { calls, handler };
}

test("snapshot exposes five stable handles, capabilities, setup state and no secrets", async () => {
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
  assert.deepEqual(snapshot.apps[0].ui.sections, ["dashboard", "providers"]);
  assert.equal(snapshot.apps[3].setup.status, "ready");
  assert.equal(JSON.stringify(snapshot).includes("secret@example.com"), false);
  assert.equal(JSON.stringify(snapshot).includes("credentialHandle"), false);
  assert.equal(JSON.stringify(snapshot).includes("managementKey"), false);
});

test("lifecycle calls share one dispatcher, require confirmation and reject cross-app operations", async () => {
  const { calls, handler } = fixture();
  await assert.rejects(
    handler.invoke({ handle: "paseo", operation: "start" }),
    /confirmation/i,
  );
  const result = await handler.invoke({ handle: "paseo", operation: "start", confirm: true });
  assert.equal(result.app.handle, "paseo");
  assert.deepEqual(calls, [["start", "paseo"]]);
  await assert.rejects(
    handler.invoke({ handle: "commandcode-proxy", operation: "sync", confirm: true }),
    /does not support/i,
  );
  await assert.rejects(
    handler.invoke({ handle: "anneal", operation: "providers" }),
    /does not support/i,
  );
});

test("CPA provider inventory and route planning are useful but identity-free", async () => {
  const { handler } = fixture();
  const inventory = await handler.invoke({ handle: "cpa", operation: "providers" });
  assert.deepEqual(inventory.providers.map((item) => item.id), ["anthropic", "openai"]);
  assert.equal(inventory.providers.find((item) => item.id === "openai").accountCount, 2);

  const planned = await handler.invoke({
    handle: "cpa",
    operation: "plan",
    arguments: { workload: "paseo", providerId: "openai", accountId: "a1", model: "gpt-a" },
  });
  assert.equal(planned.plan.account.id, "a1");
  assert.equal(planned.plan.account.label, "Primary");
  assert.equal(Object.hasOwn(planned.plan.account, "identity"), false);
  assert.equal(Object.hasOwn(planned.plan, "credentialHandle"), false);
});

test("CPA and Codex original UI controls are exposed only through their own handles", async () => {
  const { calls, handler } = fixture();
  const cpa = await handler.invoke({ handle: "cpa", operation: "ui-inspect" });
  assert.equal(cpa.ui.id, "cpa");
  const router = await handler.invoke({
    handle: "codex-router",
    operation: "ui-open",
    arguments: { section: "models" },
    confirm: true,
  });
  assert.equal(router.ui.section, "models");
  assert.deepEqual(calls, [
    ["ui-inspect", "cpa"],
    ["ui-open", "codex-router", "models"],
  ]);
  await assert.rejects(
    handler.invoke({ handle: "paseo", operation: "ui-open", arguments: { section: "sessions" }, confirm: true }),
    /does not support/i,
  );
});

test("CommandCode registration plan and apply keep credential entry outside Coding Tools", async () => {
  const { calls, handler } = fixture();
  const plan = await handler.invoke({ handle: "commandcode-proxy", operation: "registration-plan" });
  assert.equal(plan.registration.credentialPromptRequired, true);
  assert.equal(plan.registration.text, "non-secret plan");
  await assert.rejects(
    handler.invoke({ handle: "commandcode-proxy", operation: "registration-apply" }),
    /confirmation/i,
  );
  const applied = await handler.invoke({ handle: "commandcode-proxy", operation: "registration-apply", confirm: true });
  assert.equal(applied.registration.steps[0].ok, true);
  assert.deepEqual(calls, [
    ["registration-plan", "http://127.0.0.1:9090/"],
    ["registration-apply", "http://127.0.0.1:9090/"],
  ]);
});

test("Paseo and Anneal expose bounded UI sections and original actions without caller endpoints", async () => {
  const { calls, handler } = fixture();
  const paseo = await handler.invoke({
    handle: "paseo",
    operation: "open",
    arguments: { section: "sessions" },
    confirm: true,
  });
  assert.equal(paseo.embedded.url, "http://127.0.0.1:6768/sessions");
  const anneal = await handler.invoke({
    handle: "anneal",
    operation: "act",
    arguments: { op: "preview", taskId: "task-1" },
    confirm: true,
  });
  assert.equal(anneal.action.ok, true);
  assert.deepEqual(calls, [
    ["open", "paseo", "sessions"],
    ["act", "anneal", "preview", "http://127.0.0.1:3000/", undefined],
  ]);
  await assert.rejects(
    handler.invoke({
      handle: "paseo",
      operation: "act",
      arguments: { op: "send", endpoint: "https://attacker.example/", text: "hello" },
      confirm: true,
    }),
    /endpoint.*not allowed/i,
  );
});

test("reconcile installs or starts all or selected app handles through managed bootstrap", async () => {
  const { calls, handler } = fixture();
  await assert.rejects(handler.reconcile({ handles: ["paseo"] }), /confirmation/i);
  const result = await handler.reconcile({ handles: ["paseo", "anneal"], reason: "user-request", confirm: true });
  assert.equal(result.bootstrap.status, "ready");
  assert.deepEqual(calls, [["reconcile", "user-request", ["paseo", "anneal"]]]);
  await assert.rejects(
    handler.reconcile({ handles: ["not-an-app"], reason: "bad", confirm: true }),
    /unknown managed app handle/i,
  );
});
