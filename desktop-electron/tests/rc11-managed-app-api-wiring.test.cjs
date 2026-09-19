"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CONTRACTS, invokeContract } = require("../electron/ipc-schema.cjs");

const ROOT = path.resolve(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("main, shell bridge, preload and TypeScript expose one managed-app API", () => {
  const main = source("electron/main.cjs");
  const shell = source("electron/coding-tools-shell-bridge.cjs");
  const preload = source("electron/preload.cjs");
  const contracts = source("src/api/contracts.ts");

  assert.match(main, /createManagedAppApiHandler/);
  assert.match(main, /coding-tools:apps:snapshot/);
  assert.match(main, /coding-tools:apps:invoke/);
  assert.match(main, /coding-tools:apps:reconcile/);
  assert.match(shell, /managedAppsSnapshot/);
  assert.match(shell, /managedAppInvoke/);
  assert.match(shell, /managedAppsReconcile/);
  assert.doesNotMatch(shell, /owned by sibling Desktop panels/);
  assert.match(preload, /apps: Object\.freeze\(\{/);
  assert.match(preload, /invokeContract\(ipcRenderer, "apps\.snapshot"\)/);
  assert.match(preload, /invokeContract\(ipcRenderer, "apps\.invoke", input\)/);
  assert.match(preload, /invokeContract\(ipcRenderer, "apps\.reconcile", input\)/);
  assert.match(preload, /onChanged: \(listener\) => subscribeManagedApps\(listener\)/);
  assert.match(contracts, /export type ManagedAppHandle/);
  assert.match(contracts, /readonly apps:/);
  assert.match(contracts, /reconcile\(input: ManagedAppsReconcileInput\)/);
  assert.match(contracts, /onChanged\(listener: \(snapshot: ManagedAppsSnapshot\) => void\): \(\) => void/);
});

test("managed app subscriptions coalesce provider, service and bootstrap changes and clean up", () => {
  const preload = source("electron/preload.cjs");
  assert.match(preload, /launcher:external-services-changed/);
  assert.match(preload, /launcher:provider-network-changed/);
  assert.match(preload, /launcher:managed-bootstrap-changed/);
  assert.match(preload, /if \(refreshPromise\) \{/);
  assert.match(preload, /queued = true/);
  assert.match(preload, /removeListener\(channel, refresh\)/);
});

test("IPC schemas bound handles, operations and explicit reconcile confirmation", async () => {
  assert.equal(CONTRACTS["apps.snapshot"].channel, "coding-tools:apps:snapshot");
  assert.equal(CONTRACTS["apps.invoke"].channel, "coding-tools:apps:invoke");
  assert.equal(CONTRACTS["apps.reconcile"].channel, "coding-tools:apps:reconcile");

  const seen = [];
  const ipcRenderer = {
    async invoke(channel, payload) {
      seen.push([channel, payload]);
      if (channel.endsWith(":snapshot")) return { version: 1, apps: [] };
      if (channel.endsWith(":reconcile")) return { version: 1, bootstrap: { status: "ready" }, apps: [] };
      return { version: 1, handle: payload.handle, operation: payload.operation };
    },
  };

  await invokeContract(ipcRenderer, "apps.snapshot");
  await invokeContract(ipcRenderer, "apps.invoke", {
    handle: "anneal",
    operation: "inspect",
  });
  await invokeContract(ipcRenderer, "apps.reconcile", {
    handles: ["paseo", "anneal"],
    reason: "manual",
    confirm: true,
  });
  assert.deepEqual(seen.map(([channel]) => channel), [
    "coding-tools:apps:snapshot",
    "coding-tools:apps:invoke",
    "coding-tools:apps:reconcile",
  ]);

  await assert.rejects(
    invokeContract(ipcRenderer, "apps.invoke", {
      handle: "unknown-app",
      operation: "inspect",
    }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  await assert.rejects(
    invokeContract(ipcRenderer, "apps.invoke", {
      handle: "paseo",
      operation: "arbitrary-shell-command",
    }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  await assert.rejects(
    invokeContract(ipcRenderer, "apps.reconcile", {
      handles: ["paseo"],
      reason: "manual",
    }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  assert.equal(seen.length, 3);
});

test("managed app API materializer stays idempotent after four-locale shell composition", () => {
  const materializer = source("../aiTemp/rc11-managed-app-api/materialize.mjs");
  const repair = source("../aiTemp/rc11-managed-app-api/repair-locale-materializer.mjs");
  const sentinel = '  "const appByHandle = useMemo(",';

  assert.equal(materializer.split(sentinel).length - 1, 2);
  assert.match(repair, /RC11_MANAGED_APP_LOCALE_MATERIALIZER_REPAIRED/);
  assert.match(repair, /Expected one locale-sensitive materializer sentinel/);
});
