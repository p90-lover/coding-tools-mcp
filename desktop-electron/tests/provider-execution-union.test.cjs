"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createProviderExecutionPlan,
  resolveExecutionProxy,
} = require("../electron/provider-execution-router.cjs");
const {
  createProviderNetworkStore,
} = require("../electron/provider-network.cjs");

function account(id, providerId, overrides = {}) {
  return {
    id,
    providerId,
    label: id,
    identity: `${id}@example.test`,
    auth: "oauth",
    status: "connected",
    enabled: true,
    isDefault: false,
    hasCredential: true,
    models: ["default-model"],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function profile(id, host, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    endpoint: { protocol: "socks5", host, port: 1080 },
    scopes: ["all"],
    bypass: ["localhost", "127.0.0.1", "::1"],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot() {
  return {
    version: 1,
    accounts: [
      account("codex-main", "codex-oauth", {
        isDefault: true,
        models: ["codex-model"],
      }),
      account("codex-backup", "codex-oauth", {
        models: ["backup-model"],
      }),
      account("claude-main", "claude-oauth", {
        isDefault: true,
        models: ["claude-model"],
      }),
    ],
    proxyProfiles: [
      profile("global", "global.proxy.test"),
      profile("provider", "provider.proxy.test"),
      profile("account", "account.proxy.test"),
    ],
    routing: {
      globalEnabled: true,
      globalProfileId: "global",
      providers: [{ providerId: "codex-oauth", inheritGlobal: true, profileId: "provider" }],
      accounts: [{
        accountId: "codex-main",
        providerId: "codex-oauth",
        inheritProvider: true,
        inheritGlobal: true,
        profileId: "account",
      }],
    },
  };
}

test("strict unknown account selection fails closed", () => {
  assert.throws(
    () => createProviderExecutionPlan(snapshot(), {
      workload: "paseo",
      accountId: "missing-account",
      allowFallback: false,
    }),
    /account.+not found|No connected provider account/i,
  );
});

test("account-only selection infers ownership and rejects provider conflicts", () => {
  const plan = createProviderExecutionPlan(snapshot(), {
    workload: "anneal",
    accountId: "claude-main",
    allowFallback: false,
  });
  assert.equal(plan.provider.id, "claude-oauth");
  assert.equal(plan.account.id, "claude-main");

  assert.throws(
    () => createProviderExecutionPlan(snapshot(), {
      workload: "anneal",
      providerId: "codex-oauth",
      accountId: "claude-main",
      allowFallback: true,
    }),
    /does not belong to provider|conflicts with provider/i,
  );
});

test("model-aware fallback selects another permitted account and strict mode rejects unsupported models", () => {
  const fallback = createProviderExecutionPlan(snapshot(), {
    workload: "paseo",
    providerId: "codex-oauth",
    accountId: "codex-main",
    model: "backup-model",
    allowFallback: true,
  });
  assert.equal(fallback.provider.id, "codex-oauth");
  assert.equal(fallback.account.id, "codex-backup");
  assert.equal(fallback.model, "backup-model");
  assert.equal(fallback.fallbackUsed, true);

  assert.throws(
    () => createProviderExecutionPlan(snapshot(), {
      workload: "paseo",
      providerId: "codex-oauth",
      accountId: "codex-main",
      model: "not-authorized",
      allowFallback: false,
    }),
    /model.+not available|does not allow model/i,
  );
});

test("API-key and local-proxy accounts require encrypted stored credentials", () => {
  for (const [providerId, auth] of [
    ["openai-api", "api_key"],
    ["commandcode-proxy", "local_proxy"],
  ]) {
    const state = snapshot();
    state.accounts = [account(`${providerId}-main`, providerId, {
      auth,
      hasCredential: false,
      isDefault: true,
      models: ["allowed-model"],
    })];
    state.routing = { globalEnabled: false, globalProfileId: null, providers: [], accounts: [] };

    assert.throws(
      () => createProviderExecutionPlan(state, {
        workload: "anneal",
        providerId,
        model: "allowed-model",
        allowFallback: false,
      }),
      /No connected provider account|stored credential|not available/i,
    );

    state.accounts[0].hasCredential = true;
    assert.equal(
      createProviderExecutionPlan(state, {
        workload: "anneal",
        providerId,
        model: "allowed-model",
        allowFallback: false,
      }).account.id,
      `${providerId}-main`,
    );
  }
});

test("proxy precedence honors workload scopes and explicit account inheritance", () => {
  const state = snapshot();
  state.proxyProfiles = [
    profile("global", "global.proxy.test", { scopes: ["anneal"] }),
    profile("provider", "provider.proxy.test", { scopes: ["paseo", "anneal"] }),
    profile("account", "account.proxy.test", { scopes: ["browser"] }),
  ];
  state.accounts = state.accounts.map((item) => (
    item.id === "codex-main" ? { ...item, proxyProfileId: "account" } : item
  ));
  state.routing.accounts = [{
    accountId: "codex-main",
    providerId: "codex-oauth",
    inheritProvider: true,
    inheritGlobal: false,
    profileId: "account",
  }];

  const providerRoute = resolveExecutionProxy(state, "codex-oauth", "codex-main", "paseo");
  assert.equal(providerRoute.source, "provider");
  assert.equal(providerRoute.profile.endpoint.host, "provider.proxy.test");

  state.routing.providers = [];
  const directRoute = resolveExecutionProxy(state, "codex-oauth", "codex-main", "paseo");
  assert.equal(directRoute.mode, "direct");
  assert.equal(directRoute.source, "account");
  assert.equal(directRoute.profile, null);
});

test("explicit account policy suppresses stale legacy account proxy fields", () => {
  const state = snapshot();
  state.accounts = state.accounts.map((item) => (
    item.id === "codex-main" ? { ...item, proxyProfileId: "account" } : item
  ));
  state.routing.accounts = [{
    accountId: "codex-main",
    providerId: "codex-oauth",
    inheritProvider: true,
    inheritGlobal: true,
  }];

  const route = resolveExecutionProxy(state, "codex-oauth", "codex-main", "paseo");
  assert.equal(route.source, "provider");
  assert.equal(route.profile.endpoint.host, "provider.proxy.test");
});

test("local providers with direct defaults do not inherit global routing implicitly", () => {
  for (const providerId of ["ollama", "cliproxyapi-antigravity"]) {
    const state = snapshot();
    state.accounts = [account(`${providerId}-main`, providerId, {
      auth: "oauth",
      isDefault: true,
      models: ["local-model"],
    })];
    state.routing.providers = [];
    state.routing.accounts = [];

    const plan = createProviderExecutionPlan(state, {
      workload: "paseo",
      providerId,
      model: "local-model",
      allowFallback: false,
    });
    assert.equal(plan.proxy.mode, "direct");
    assert.equal(plan.proxy.source, "provider-default");
    assert.equal(plan.proxy.profile, null);
  }
});

test("provider store exposes credential presence without exposing encrypted secret material", () => {
  const fixture = path.resolve(
    __dirname,
    "..",
    "..",
    "aiTemp",
    "provider-execution-union",
    crypto.randomUUID(),
  );
  fs.mkdirSync(fixture, { recursive: true });
  const store = createProviderNetworkStore({
    filePath: path.join(fixture, "provider-network.json"),
    keyPath: path.join(fixture, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });

  let current = store.saveAccount({
    id: "openai-no-secret",
    providerId: "openai-api",
    label: "OpenAI without secret",
    auth: "api_key",
    status: "connected",
    enabled: true,
    isDefault: true,
    models: ["gpt-test"],
  });
  const missing = current.accounts.find((item) => item.id === "openai-no-secret");
  assert.equal(missing.status, "pending");
  assert.equal(missing.hasCredential, false);
  assert.equal(missing.isDefault, false);
  assert.throws(
    () => store.setDefaultAccount("openai-api", "openai-no-secret"),
    /required credential|connected account/i,
  );

  current = store.saveAccount({
    id: "openai-with-secret",
    providerId: "openai-api",
    label: "OpenAI with secret",
    auth: "api_key",
    status: "connected",
    enabled: true,
    isDefault: true,
    models: ["gpt-test"],
    secret: { apiKey: "synthetic-fixture-key" },
  });
  const connected = current.accounts.find((item) => item.id === "openai-with-secret");
  assert.equal(connected.status, "connected");
  assert.equal(connected.hasCredential, true);
  assert.equal(JSON.stringify(current).includes("synthetic-fixture-key"), false);
  assert.equal(store.accountSecret("openai-with-secret").apiKey, "synthetic-fixture-key");

  current = store.saveAccount({
    id: "oauth-without-secret",
    providerId: "codex-oauth",
    label: "OAuth without local secret",
    auth: "oauth",
    status: "connected",
    enabled: true,
    models: ["codex-model"],
  });
  const oauth = current.accounts.find((item) => item.id === "oauth-without-secret");
  assert.equal(oauth.status, "connected");
  assert.equal(oauth.hasCredential, false);
});
