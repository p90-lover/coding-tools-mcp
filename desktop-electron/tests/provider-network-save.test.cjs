"use strict";

// Proxy-page saves held every window 0.5-1.2 s on 2026-11-03 (an fsync of provider-network.json on
// main), and a Decodo sync saved once per proxy. Saves now flush on a pool thread.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

function scratch(t) {
  const base = path.resolve(__dirname, "../../aiTemp/tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "provider-save-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function profile(index) {
  return { id: `p${index}`, name: `Proxy ${index}`, enabled: true,
    endpoint: { protocol: "http", host: "proxy.example.test", port: 8000 + index }, scopes: ["all"] };
}

test("a save writes nothing synchronously, and a burst ends with the latest state on disk", async (t) => {
  const root = scratch(t);
  const filePath = path.join(root, "provider-network.json");
  const store = createProviderNetworkStore({ filePath, keyPath: path.join(root, "provider-network.key"), safeStorage: null });
  const calls = [];
  const originals = {};
  for (const name of ["fsyncSync", "writeFileSync", "writeSync", "renameSync"]) {
    originals[name] = fs[name];
    fs[name] = function (...args) { calls.push(name); return originals[name].apply(this, args); };
  }
  try {
    for (let index = 0; index < 20; index += 1) store.saveProxyProfile(profile(index));
    store.setGlobalRouting({ enabled: true, profileId: "p19" });
  } finally {
    Object.assign(fs, originals);
  }
  assert.deepEqual(calls, [], "no file call blocks the calling thread");
  await store.saved();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(saved.proxyProfiles.length, 20);
  assert.equal(saved.routing.globalProfileId, "p19");
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8")), saved);
});

test("saved() reports a save that failed, and a later save that lands clears it", async (t) => {
  const root = scratch(t);
  const blocker = path.join(root, "not-a-folder");
  fs.writeFileSync(blocker, "");
  const filePath = path.join(blocker, "provider-network.json");
  const store = createProviderNetworkStore({ filePath, keyPath: path.join(root, "provider-network.key"), safeStorage: null });
  store.saveProxyProfile(profile(1));
  await assert.rejects(store.saved());
  await store.saved();

  fs.rmSync(blocker);
  fs.mkdirSync(blocker);
  store.saveProxyProfile(profile(2));
  await store.saved();
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).proxyProfiles.map((item) => item.id), ["p1", "p2"]);
});
