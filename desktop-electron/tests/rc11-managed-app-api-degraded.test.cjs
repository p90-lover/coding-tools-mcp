"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagedAppApiHandler } = require("../electron/managed-app-api.cjs");

function baseOptions(overrides = {}) {
  return {
    externalServices: {
      snapshot: () => ({ version: 1, services: [] }),
      inspect: async () => { throw new Error("not used"); },
      installManagedComponent: async () => { throw new Error("not used"); },
      repairManagedComponent: async () => { throw new Error("not used"); },
      start: async () => { throw new Error("not used"); },
      stop: async () => { throw new Error("not used"); },
      restart: async () => { throw new Error("not used"); },
      syncCodexRouter: async () => { throw new Error("not used"); },
      upstreamConfiguration: () => null,
    },
    originalUi: {
      snapshot: () => ({ version: 1, tools: [] }),
      inspect: async () => { throw new Error("not used"); },
      start: async () => { throw new Error("not used"); },
      stop: async () => { throw new Error("not used"); },
      restart: async () => { throw new Error("not used"); },
      openEmbedded: async () => { throw new Error("not used"); },
    },
    upstreamTools: {
      openEmbeddedTool: async () => { throw new Error("not used"); },
    },
    managedBootstrap: {
      getSnapshot: () => ({ status: "idle", components: [] }),
      reconcile: async () => ({ status: "ready", components: [] }),
    },
    getProviderController: async () => ({
      store: { snapshot: () => ({ version: 1, accounts: [], proxyProfiles: [], routing: {} }) },
    }),
    createExecutionPlan: () => { throw new Error("not used"); },
    commandCodePlan: () => { throw new Error("not used"); },
    commandCodeApply: () => { throw new Error("not used"); },
    performUpstreamAction: async () => { throw new Error("not used"); },
    ...overrides,
  };
}

test("all stable handles remain visible when provider and service controllers partly fail", async () => {
  const options = baseOptions();
  options.getProviderController = async () => { throw new Error("provider runtime offline bearer abc123"); };
  options.externalServices.snapshot = () => ({
    version: 1,
    services: [{
      id: "codex-router",
      name: "Codex Router",
      status: "ready",
      endpoint: "http://127.0.0.1:4202/",
      error: null,
      managedInstall: { state: "installed", version: "0.6.0", platformMode: "native", missingCredentials: [] },
    }],
  });
  const handler = createManagedAppApiHandler(options);
  const snapshot = await handler.snapshot();
  assert.deepEqual(snapshot.apps.map((app) => app.handle), [
    "cpa",
    "codex-router",
    "commandcode-proxy",
    "paseo",
    "anneal",
  ]);
  assert.equal(snapshot.apps[0].available, false);
  assert.equal(snapshot.apps[0].providerNetworkStatus, "error");
  assert.doesNotMatch(snapshot.apps[0].error, /abc123/);
  assert.equal(snapshot.apps[1].available, true);
  assert.equal(snapshot.apps[2].status, "unknown");
  assert.equal(snapshot.apps[4].available, false);
});

test("a total service control-plane failure does not hide healthy CPA inventory", async () => {
  const options = baseOptions();
  options.externalServices.snapshot = () => { throw new Error("control plane unavailable authorization=top-secret"); };
  options.getProviderController = async () => ({
    store: {
      snapshot: () => ({
        version: 1,
        accounts: [{ id: "a1", providerId: "openai", label: "Primary", status: "connected", enabled: true, models: ["gpt-a"] }],
        proxyProfiles: [],
        routing: {},
      }),
    },
  });
  const handler = createManagedAppApiHandler(options);
  const snapshot = await handler.snapshot();
  assert.equal(snapshot.apps.length, 5);
  assert.equal(snapshot.apps[0].providerNetworkStatus, "ready");
  assert.equal(snapshot.apps[0].accountCount, 1);
  for (const app of snapshot.apps.slice(1)) {
    assert.equal(app.status, "error");
    assert.equal(app.available, false);
    assert.match(app.error, /control plane unavailable/i);
    assert.doesNotMatch(app.error, /top-secret/);
  }
});

test("original UI and bootstrap failures become bounded app metadata instead of snapshot failure", async () => {
  const options = baseOptions();
  options.externalServices.snapshot = () => ({
    version: 1,
    services: ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"].map((id) => ({
      id,
      name: id,
      status: "stopped",
      endpoint: "http://127.0.0.1/",
      error: null,
      managedInstall: { state: "installed", version: "1", platformMode: "native", missingCredentials: [] },
    })),
  });
  options.originalUi.snapshot = () => { throw new Error("original UI unavailable token=raw-token"); };
  options.managedBootstrap.getSnapshot = () => { throw new Error("bootstrap unavailable password=raw-password"); };
  const handler = createManagedAppApiHandler(options);
  const snapshot = await handler.snapshot();
  assert.equal(snapshot.apps[0].ui.status, "error");
  assert.equal(snapshot.apps[1].ui.status, "error");
  assert.equal(snapshot.apps[3].setup.status, "error");
  assert.doesNotMatch(JSON.stringify(snapshot), /raw-token|raw-password/);
});
