"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CONTRACTS, invokeContract } = require("../electron/ipc-schema.cjs");

const ROOT = path.resolve(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("Coding Tools exposes one typed apps API through preload and focused IPC", () => {
  const main = source("electron/main.cjs");
  const preload = source("electron/preload.cjs");
  const shellBridge = source("electron/coding-tools-shell-bridge.cjs");
  const contracts = source("src/api/contracts.ts");

  assert.match(main, /createManagedAppApiHandler/);
  assert.match(main, /coding-tools:apps:snapshot/);
  assert.match(main, /coding-tools:apps:invoke/);
  assert.match(preload, /apps: Object\.freeze\(\{/);
  assert.match(preload, /invokeContract\(ipcRenderer, "apps\.snapshot"\)/);
  assert.match(preload, /invokeContract\(ipcRenderer, "apps\.invoke", input\)/);
  assert.match(shellBridge, /managedAppsSnapshot/);
  assert.match(shellBridge, /managedAppInvoke/);
  assert.doesNotMatch(shellBridge, /owned by sibling Desktop panels/);
  assert.match(contracts, /export type ManagedAppHandle/);
  assert.match(contracts, /readonly apps:/);
});

test("IPC schema owns the managed app request boundary", async () => {
  assert.equal(CONTRACTS["apps.snapshot"].channel, "coding-tools:apps:snapshot");
  assert.equal(CONTRACTS["apps.invoke"].channel, "coding-tools:apps:invoke");

  const seen = [];
  const ipcRenderer = {
    async invoke(channel, payload) {
      seen.push([channel, payload]);
      return channel === "coding-tools:apps:snapshot"
        ? { version: 1, apps: [] }
        : { version: 1, handle: payload.handle, operation: payload.operation };
    },
  };

  const snapshot = await invokeContract(ipcRenderer, "apps.snapshot");
  assert.deepEqual(snapshot, { version: 1, apps: [] });
  const result = await invokeContract(ipcRenderer, "apps.invoke", {
    handle: "paseo",
    operation: "inspect",
  });
  assert.equal(result.handle, "paseo");
  assert.deepEqual(seen.map(([channel]) => channel), [
    "coding-tools:apps:snapshot",
    "coding-tools:apps:invoke",
  ]);

  await assert.rejects(
    invokeContract(ipcRenderer, "apps.invoke", {
      handle: "unknown-app",
      operation: "inspect",
    }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  assert.equal(seen.length, 2);
});
