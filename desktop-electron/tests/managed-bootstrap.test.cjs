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

test("bootstrap installs missing, repairs damaged, starts installed, and inspects external components", async () => {
  const { bootstrap, calls } = bootstrapFixture([
    managedService("cpa", "not-installed"),
    managedService("commandcode-proxy", "repair-required"),
    managedService("paseo", "installed"),
    managedService("anneal", "external"),
  ]);

  const result = await bootstrap.reconcile({ reason: "startup" });

  assert.deepEqual(calls, [
    "install:cpa",
    "repair:commandcode-proxy",
    "start:paseo",
    "inspect:paseo",
    "inspect:anneal",
  ]);
  assert.equal(result.status, "ready");
  assert.deepEqual(
    result.components.map(({ id, status, action }) => ({ id, status, action })),
    [
      { id: "cpa", status: "ready", action: "install" },
      { id: "commandcode-proxy", status: "ready", action: "repair" },
      { id: "paseo", status: "ready", action: "inspect" },
      { id: "anneal", status: "ready", action: "inspect" },
    ],
  );
});

test("bootstrap blocks only the component with missing required credentials", async () => {
  const { bootstrap, calls } = bootstrapFixture([
    managedService("commandcode-proxy", "not-installed", { missingCredentials: ["proxyApiKey"] }),
    managedService("paseo", "installed"),
  ]);

  const result = await bootstrap.reconcile({ reason: "startup" });

  assert.deepEqual(calls, ["start:paseo", "inspect:paseo"]);
  assert.equal(result.status, "blocked");
  assert.deepEqual(
    result.components.find((component) => component.id === "commandcode-proxy"),
    {
      id: "commandcode-proxy",
      status: "blocked",
      action: null,
      missingCredentials: ["proxyApiKey"],
      message: "Missing required credentials: proxyApiKey",
    },
  );
  assert.equal(result.components.find((component) => component.id === "paseo").status, "ready");
});

test("bootstrap does not block optional Anneal GitHub credentials", async () => {
  const { bootstrap, calls } = bootstrapFixture([
    managedService("anneal", "not-installed", { missingCredentials: [] }),
    managedService("paseo", "installed"),
  ]);

  const result = await bootstrap.reconcile({ reason: "startup" });

  assert.deepEqual(calls, ["install:anneal", "start:paseo", "inspect:paseo"]);
  assert.equal(result.status, "ready");
  assert.equal(result.components.find((component) => component.id === "anneal").status, "ready");
  assert.equal(result.components.find((component) => component.id === "paseo").status, "ready");
});

test("bootstrap keeps reconciling after one component fails", async () => {
  const { bootstrap, calls } = bootstrapFixture([
    managedService("commandcode-proxy", "not-installed"),
    managedService("paseo", "installed"),
  ], {
    install: async ({ id }) => {
      throw new Error(`${id} failed to install`);
    },
  });

  const result = await bootstrap.reconcile({ reason: "startup" });

  assert.deepEqual(calls, [
    "install:commandcode-proxy",
    "start:paseo",
    "inspect:paseo",
  ]);
  assert.equal(result.status, "error");
  assert.match(
    result.components.find((component) => component.id === "commandcode-proxy").message,
    /failed to install/,
  );
  assert.equal(result.components.find((component) => component.id === "paseo").status, "ready");
});

test("concurrent reconcile calls share one run and queue one targeted follow-up", async () => {
  const enteredInstall = deferred();
  const releaseInstall = deferred();
  const { bootstrap, calls, update } = bootstrapFixture([
    managedService("cpa", "not-installed"),
    managedService("anneal", "external"),
  ], {
    install: async ({ id }) => {
      enteredInstall.resolve();
      await releaseInstall.promise;
      return update(id, {
        status: "ready",
        managedInstall: {
          state: "installed",
          installedAt: "2026-09-18T00:03:00.000Z",
        },
      });
    },
  });

  const first = bootstrap.reconcile({ reason: "startup" });
  await enteredInstall.promise;
  const second = bootstrap.reconcile({
    reason: "credential-saved",
    componentIds: ["anneal"],
  });

  assert.equal(second, first);
  releaseInstall.resolve();
  const result = await first;

  assert.equal(result.status, "ready");
  assert.equal(calls.filter((call) => call === "install:cpa").length, 1);
  assert.equal(calls.filter((call) => call === "inspect:anneal").length, 2);
});

test("dispose prevents future reconciliation", () => {
  const { bootstrap } = bootstrapFixture([
    managedService("paseo", "installed"),
  ]);

  bootstrap.dispose();

  assert.throws(
    () => bootstrap.reconcile({ reason: "manual" }),
    /disposed/i,
  );
});

test("dispose stops an in-flight bootstrap pass from starting the next component", async () => {
  const entered = deferred();
  const release = deferred();
  const { bootstrap, calls } = bootstrapFixture([
    managedService("cpa", "installed"),
    managedService("paseo", "installed"),
  ], { start: async ({ id, update }) => {
    if (id === "cpa") { entered.resolve(); await release.promise; }
    return update(id, { status: "starting" });
  } });
  const running = bootstrap.reconcile({ reason: "startup" });
  await entered.promise;
  bootstrap.dispose();
  release.resolve();
  await running;
  assert.equal(calls.includes("start:paseo"), false);
});
