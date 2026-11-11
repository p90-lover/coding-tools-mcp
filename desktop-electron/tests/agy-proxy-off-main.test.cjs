"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { resolveManagedProxyEnvironment, resolveManagedProxyEnvironmentAsync } = require("../electron/managed-external-services.cjs");

// 2026-11-11 07:58:38Z: provider-network.json, read synchronously while the Antigravity CLI's proxy
// environment was built for Agent Orchestrator, held main 946 ms on the busy hard disk.
test("the Antigravity and CPA proxy environments are read off main and match the synchronous answer", async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/agy-async-proxy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = createProviderNetworkStore({
    filePath: path.join(root, "providers", "provider-network.json"),
    keyPath: path.join(root, "providers", "provider-network.key"), safeStorage,
  });
  store.saveProxyProfile({ id: "global", name: "Global route", enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17891 }, username: "ct", password: "agy-test-key", scopes: ["all"] });
  store.setGlobalRouting({ enabled: true, profileId: "global" });
  await store.saved();
  const dataRoot = path.join(root, "integrations");
  const ids = ["antigravity-cli", "cpa", "other"];
  const expected = Object.fromEntries(ids.map((id) => [id, resolveManagedProxyEnvironment(id, dataRoot, safeStorage)]));
  const readFileSync = fs.readFileSync;
  const syncReads = [];
  fs.readFileSync = (file, ...rest) => {
    if (String(file).includes("provider-network")) syncReads.push(path.basename(String(file)));
    return readFileSync(file, ...rest);
  };
  try {
    for (const id of ids) assert.deepEqual(await resolveManagedProxyEnvironmentAsync(id, dataRoot, safeStorage), expected[id], id);
  } finally { fs.readFileSync = readFileSync; }
  assert.deepEqual(syncReads, [], "no synchronous read of the saved proxy settings");
  assert.equal(new URL(expected["antigravity-cli"].HTTPS_PROXY).password, "agy-test-key");
  store.setGlobalRouting({ enabled: false, profileId: null });
  await store.saved();
  await assert.rejects(resolveManagedProxyEnvironmentAsync("antigravity-cli", dataRoot, safeStorage), /Select a network proxy/);
});

test("main builds the Antigravity proxy environment off main, and every caller awaits it", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /const antigravityProxyEnvironment = async \(\) => \{\r?\n\s+const env = await resolveManagedProxyEnvironmentAsync\("antigravity-cli"/);
  assert.doesNotMatch(main, /[^.\w]resolveManagedProxyEnvironment\(/, "the synchronous form is not used in main");
  const calls = main.match(/antigravityProxyEnvironment\(\)/g) || [];
  const awaited = main.match(/await antigravityProxyEnvironment\(\)/g) || [];
  assert.ok(calls.length >= 3);
  assert.equal(calls.length, awaited.length, "every call awaits it");
});
