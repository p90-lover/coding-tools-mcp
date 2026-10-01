"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createManagedBootstrap } = require("../electron/managed-bootstrap.cjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function managedService(id, state, {
  status = state === "external" ? "offline" : "unknown",
  installedAt = state === "installed" || state === "repair-required" ? "2026-09-18T00:00:00.000Z" : null,
  missingCredentials = [],
  error = null,
} = {}) {
  return {
    id,
    status,
    error,
    managedInstall: {
      state,
      installedAt,
      home: `/managed/${id}`,
      missingCredentials: [...missingCredentials],
    },
  };
}

function bootstrapFixture(initialServices, overrides = {}) {
  const services = new Map(initialServices.map((service) => [service.id, clone(service)]));
  const calls = [];

  const current = (id) => services.get(id);
  const update = (id, patch) => {
    const before = current(id);
    const next = {
      ...before,
      ...patch,
      managedInstall: {
        ...before.managedInstall,
        ...(patch.managedInstall || {}),
      },
    };
    services.set(id, next);
    return clone(next);
  };

  const lifecycle = {
    snapshot: () => ({ services: [...services.values()].map(clone) }),
    install: async (id) => {
      calls.push(`install:${id}`);
      if (overrides.install) return overrides.install({ id, update, current, calls });
      return update(id, {
        status: "ready",
        error: null,
        managedInstall: {
          state: "installed",
          installedAt: "2026-09-18T00:01:00.000Z",
          missingCredentials: [],
        },
      });
    },
    repair: async (id) => {
      calls.push(`repair:${id}`);
      if (overrides.repair) return overrides.repair({ id, update, current, calls });
      return update(id, {
        status: "ready",
        error: null,
        managedInstall: {
          state: "installed",
          installedAt: "2026-09-18T00:02:00.000Z",
        },
      });
    },
    start: async (id) => {
      calls.push(`start:${id}`);
      if (overrides.start) return overrides.start({ id, update, current, calls });
      return update(id, { status: "starting", error: null });
    },
    inspect: async (id) => {
      calls.push(`inspect:${id}`);
      if (overrides.inspect) return overrides.inspect({ id, update, current, calls });
      return update(id, { status: "ready", error: null });
    },
  };

  const published = [];
  const bootstrap = createManagedBootstrap({
    componentIds: initialServices.map((service) => service.id),
    ...lifecycle,
    publish: (snapshot) => published.push(clone(snapshot)),
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 8, 18, 0, 0, tick++)).toISOString();
    })(),
  });

  return { bootstrap, calls, current, lifecycle, published, services, update };
}

test("bootstrap rejects injected retired component IDs at construction", () => {
  for (const id of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
    assert.throws(() => createManagedBootstrap({
      componentIds: ["cpa", id],
      snapshot: () => ({ services: [] }),
      install: async () => assert.fail("retired install callback ran"),
      repair: async () => assert.fail("retired repair callback ran"),
      start: async () => assert.fail("retired start callback ran"),
      inspect: async () => assert.fail("retired inspect callback ran"),
    }), /retired/i);
  }
});

test("default bootstrap starts only CPA and rejects retired service requests", async () => {
  const calls = [];
  const bootstrap = createManagedBootstrap({
    snapshot: () => ({ services: [
      managedService("cpa", "installed"),
      managedService("codex-router", "installed"),
      managedService("commandcode-proxy", "installed"),
      managedService("paseo", "installed"),
      managedService("anneal", "installed"),
    ] }),
    install: async (id) => { calls.push(`install:${id}`); },
    repair: async (id) => { calls.push(`repair:${id}`); },
    start: async (id) => { calls.push(`start:${id}`); },
    inspect: async (id) => { calls.push(`inspect:${id}`); },
  });
  const result = await bootstrap.reconcile({ reason: "startup" });
  assert.deepEqual(result.components.map((component) => component.id), [
    "cpa",
  ]);
  assert.deepEqual(calls, [
    "start:cpa", "inspect:cpa",
  ]);
  for (const id of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
    assert.throws(() => bootstrap.reconcile({ componentIds: [id] }), /unknown/i);
  }
});

test("bootstrap installs, repairs, starts and inspects CPA by its current state", async () => {
  const { bootstrap, calls, update } = bootstrapFixture([
    managedService("cpa", "not-installed"),
  ]);
  const installed = await bootstrap.reconcile({ reason: "startup" });
  assert.deepEqual(calls, ["install:cpa"]);
  assert.equal(installed.status, "ready");
  assert.equal(installed.components[0].action, "install");

  update("cpa", { managedInstall: { state: "repair-required" } });
  const repaired = await bootstrap.reconcile({ reason: "repair" });
  assert.deepEqual(calls, ["install:cpa", "repair:cpa"]);
  assert.equal(repaired.components[0].action, "repair");

  const started = await bootstrap.reconcile({ reason: "start" });
  assert.deepEqual(calls, ["install:cpa", "repair:cpa", "start:cpa", "inspect:cpa"]);
  assert.deepEqual(started.components.map(({ id, status, action }) => ({ id, status, action })),
    [{ id: "cpa", status: "ready", action: "inspect" }]);
});

test("bootstrap blocks CPA with missing required credentials before lifecycle callbacks", async () => {
  const { bootstrap, calls } = bootstrapFixture([
    managedService("cpa", "not-installed", { missingCredentials: ["proxyApiKey"] }),
  ]);
  const result = await bootstrap.reconcile({ reason: "startup" });
  assert.deepEqual(calls, []);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.components[0], {
    id: "cpa",
    status: "blocked",
    action: null,
    missingCredentials: ["proxyApiKey"],
    message: "Missing required credentials: proxyApiKey",
  });
});

test("bootstrap installs CPA when no required credentials are missing", async () => {
  const { bootstrap, calls } = bootstrapFixture([
    managedService("cpa", "not-installed", { missingCredentials: [] }),
  ]);
  const result = await bootstrap.reconcile({ reason: "startup" });
  assert.deepEqual(calls, ["install:cpa"]);
  assert.equal(result.status, "ready");
  assert.equal(result.components[0].status, "ready");
});

test("bootstrap can retry CPA after one failed reconciliation", async () => {
  let attempts = 0;
  const { bootstrap, calls, update } = bootstrapFixture([
    managedService("cpa", "not-installed"),
  ], {
    install: async ({ id }) => {
      if (++attempts === 1) throw new Error(`${id} failed to install`);
      return update(id, { status: "ready", managedInstall: { state: "installed" } });
    },
  });
  const failed = await bootstrap.reconcile({ reason: "startup" });
  assert.equal(failed.status, "error");
  assert.match(failed.components[0].message, /failed to install/);
  const retried = await bootstrap.reconcile({ reason: "retry" });
  assert.deepEqual(calls, ["install:cpa", "install:cpa"]);
  assert.equal(retried.status, "ready");
});

test("concurrent CPA reconcile calls share one run and queue one targeted follow-up", async () => {
  const enteredInstall = deferred();
  const releaseInstall = deferred();
  const { bootstrap, calls, update } = bootstrapFixture([
    managedService("cpa", "not-installed"),
  ], {
    install: async ({ id }) => {
      enteredInstall.resolve();
      await releaseInstall.promise;
      return update(id, {
        status: "ready",
        managedInstall: { state: "installed", installedAt: "2026-09-18T00:03:00.000Z" },
      });
    },
  });
  const first = bootstrap.reconcile({ reason: "startup" });
  await enteredInstall.promise;
  const second = bootstrap.reconcile({ reason: "credential-saved", componentIds: ["cpa"] });
  assert.equal(second, first);
  releaseInstall.resolve();
  const result = await first;
  assert.equal(result.status, "ready");
  assert.deepEqual(calls, ["install:cpa", "start:cpa", "inspect:cpa"]);
});

test("dispose prevents future CPA reconciliation", () => {
  const { bootstrap } = bootstrapFixture([
    managedService("cpa", "installed"),
  ]);

  bootstrap.dispose();

  assert.throws(
    () => bootstrap.reconcile({ reason: "manual" }),
    /disposed/i,
  );
});

test("dispose stops a queued CPA follow-up during an in-flight bootstrap pass", async () => {
  const entered = deferred();
  const release = deferred();
  const { bootstrap, calls } = bootstrapFixture([
    managedService("cpa", "installed"),
  ], { start: async ({ id, update }) => {
    if (id === "cpa") { entered.resolve(); await release.promise; }
    return update(id, { status: "starting" });
  } });
  const running = bootstrap.reconcile({ reason: "startup" });
  await entered.promise;
  assert.equal(bootstrap.reconcile({ reason: "follow-up", componentIds: ["cpa"] }), running);
  bootstrap.dispose();
  release.resolve();
  await running;
  assert.deepEqual(calls, ["start:cpa", "inspect:cpa"]);
});
