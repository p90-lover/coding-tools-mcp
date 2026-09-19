"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagedAppApiHandler } = require("../electron/managed-app-api.cjs");

test("app discovery remains usable when CPA or one managed service is unavailable", async () => {
  const handler = createManagedAppApiHandler({
    externalServices: {
      snapshot: () => ({
        version: 1,
        services: [{
          id: "codex-router",
          name: "Codex Router",
          status: "ready",
          endpoint: "http://127.0.0.1:4202/",
          modelCount: 2,
          error: null,
          managedInstall: {
            state: "installed",
            version: "0.6.0",
            platformMode: "native",
            missingCredentials: [],
          },
        }],
      }),
      inspect: async () => { throw new Error("not used"); },
      start: async () => { throw new Error("not used"); },
      stop: async () => { throw new Error("not used"); },
      restart: async () => { throw new Error("not used"); },
      installManagedComponent: async () => { throw new Error("not used"); },
      repairManagedComponent: async () => { throw new Error("not used"); },
      syncCodexRouter: async () => { throw new Error("not used"); },
    },
    upstreamTools: {
      openEmbeddedTool: async () => { throw new Error("not used"); },
    },
    getProviderController: async () => { throw new Error("provider runtime offline"); },
    createExecutionPlan: () => { throw new Error("not used"); },
  });

  const snapshot = await handler.snapshot();
  assert.deepEqual(snapshot.apps.map((app) => app.handle), [
    "cpa",
    "codex-router",
    "commandcode-proxy",
    "paseo",
    "anneal",
  ]);
  assert.equal(snapshot.apps[0].available, false);
  assert.equal(snapshot.apps[0].status, "error");
  assert.match(snapshot.apps[0].error, /unavailable/i);
  assert.equal(snapshot.apps[1].available, true);
  assert.equal(snapshot.apps[2].available, false);
  assert.equal(snapshot.apps[2].status, "unknown");
  assert.equal(snapshot.apps[4].available, false);
});

test("a failing service snapshot does not hide stable app handles", async () => {
  const handler = createManagedAppApiHandler({
    externalServices: {
      snapshot: () => { throw new Error("control plane unavailable"); },
      inspect: async () => { throw new Error("not used"); },
      start: async () => { throw new Error("not used"); },
      stop: async () => { throw new Error("not used"); },
      restart: async () => { throw new Error("not used"); },
      installManagedComponent: async () => { throw new Error("not used"); },
      repairManagedComponent: async () => { throw new Error("not used"); },
      syncCodexRouter: async () => { throw new Error("not used"); },
    },
    upstreamTools: {
      openEmbeddedTool: async () => { throw new Error("not used"); },
    },
    getProviderController: async () => ({
      store: {
        snapshot: () => ({ version: 1, accounts: [], proxyProfiles: [], routing: {} }),
      },
    }),
    createExecutionPlan: () => { throw new Error("not used"); },
  });

  const snapshot = await handler.snapshot();
  assert.equal(snapshot.apps.length, 5);
  assert.equal(snapshot.apps[0].status, "ready");
  for (const app of snapshot.apps.slice(1)) {
    assert.equal(app.status, "error");
    assert.equal(app.available, false);
    assert.match(app.error, /control plane unavailable/i);
  }
});
