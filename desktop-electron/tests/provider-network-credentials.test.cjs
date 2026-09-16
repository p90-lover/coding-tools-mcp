"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

function createStore(name) {
  const root = path.resolve(__dirname, "../../aiTemp/provider-planner-review-tests", `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    store: createProviderNetworkStore({
      filePath: path.join(root, "provider-network.json"),
      keyPath: path.join(root, "provider-network.key"),
      safeStorage: { isEncryptionAvailable: () => false },
    }),
  };
}

function apiAccount(secret) {
  return {
    id: "openai-main",
    providerId: "openai-api",
    label: "OpenAI main",
    auth: "api_key",
    status: "connected",
    enabled: true,
    isDefault: true,
    models: ["gpt-test"],
    secret,
  };
}

test("API-key accounts cannot report connected until a usable encrypted credential exists", () => {
  const { root, store } = createStore("credential-presence");

  let snapshot = store.saveAccount(apiAccount(undefined));
  assert.equal(snapshot.accounts[0].status, "pending");
  assert.equal(snapshot.accounts[0].hasCredential, false);

  snapshot = store.saveAccount(apiAccount({ baseUrl: "https://api.example.test/v1" }));
  assert.equal(snapshot.accounts[0].status, "pending");
  assert.equal(snapshot.accounts[0].hasCredential, false);

  snapshot = store.saveAccount(apiAccount({
    apiKey: "provider-secret",
    baseUrl: "https://api.example.test/v1",
  }));
  assert.equal(snapshot.accounts[0].status, "connected");
  assert.equal(snapshot.accounts[0].hasCredential, true);
  assert.equal(JSON.stringify(snapshot).includes("provider-secret"), false);

  const persisted = fs.readFileSync(path.join(root, "provider-network.json"), "utf8");
  assert.equal(persisted.includes("provider-secret"), false);
});

test("an explicit account inherit policy clears the legacy saved account proxy", () => {
  const { store } = createStore("account-policy");
  store.saveProxyProfile({
    id: "old-account-proxy",
    name: "Old account proxy",
    endpoint: { protocol: "socks5", host: "proxy.example.test", port: 1080 },
    scopes: ["paseo"],
  });
  store.saveAccount({
    id: "codex-main",
    providerId: "codex-oauth",
    label: "Codex main",
    auth: "oauth",
    status: "connected",
    enabled: true,
    isDefault: true,
    models: ["codex"],
    proxyProfileId: "old-account-proxy",
  });

  const snapshot = store.setAccountPolicy({ accountId: "codex-main", mode: "inherit" });
  const account = snapshot.accounts.find((candidate) => candidate.id === "codex-main");
  assert.equal(account.proxyProfileId, undefined);
  assert.deepEqual(snapshot.routing.accounts.find((policy) => policy.accountId === "codex-main"), {
    accountId: "codex-main",
    providerId: "codex-oauth",
    inheritProvider: true,
    inheritGlobal: true,
  });
});
