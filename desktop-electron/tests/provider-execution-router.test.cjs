"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createProviderExecutionPlan,
  resolveExecutionProxy,
} = require("../electron/provider-execution-router.cjs");

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
      account("codex-main", "codex-oauth", { isDefault: true, models: ["codex-model"] }),
      account("codex-backup", "codex-oauth"),
      account("claude-main", "claude-oauth", { isDefault: true, models: ["claude-model"] }),
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
    secrets: {
      accounts: { "codex-main": "must-never-leak" },
      proxies: { account: "must-never-leak" },
    },
  };
}

test("Anneal execution plan uses the default account and account proxy before provider/global routes", () => {
  const plan = createProviderExecutionPlan(snapshot(), {
    workload: "anneal",
    providerId: "codex-oauth",
  });

  assert.equal(plan.provider.id, "codex-oauth");
  assert.equal(plan.account.id, "codex-main");
  assert.equal(plan.model, "codex-model");
  assert.equal(plan.proxy.source, "account");
  assert.equal(plan.proxy.profile.endpoint.host, "account.proxy.test");
  assert.equal(plan.fallbackUsed, false);
  assert.equal(JSON.stringify(plan).includes("must-never-leak"), false);
  assert.deepEqual(plan.credentialHandle, {
    providerId: "codex-oauth",
    accountId: "codex-main",
  });
});

test("Paseo falls back to the next healthy provider when a requested provider has no usable account", () => {
  const state = snapshot();
  state.accounts = state.accounts.map((item) => (
    item.providerId === "codex-oauth"
      ? { ...item, status: "expired", isDefault: false }
      : item
  ));

  const plan = createProviderExecutionPlan(state, {
    workload: "paseo",
    providerId: "codex-oauth",
    accountId: "codex-main",
    allowFallback: true,
  });

  assert.equal(plan.provider.id, "claude-oauth");
  assert.equal(plan.account.id, "claude-main");
  assert.equal(plan.proxy.source, "global");
  assert.equal(plan.proxy.profile.endpoint.host, "global.proxy.test");
  assert.equal(plan.fallbackUsed, true);
});

test("provider direct routing blocks global proxy inheritance", () => {
  const state = snapshot();
  state.routing.providers = [{ providerId: "claude-oauth", inheritGlobal: false }];
  state.routing.accounts = [];

  const route = resolveExecutionProxy(state, "claude-oauth", "claude-main", "anneal");
  assert.equal(route.mode, "direct");
  assert.equal(route.source, "provider");
  assert.equal(route.profile, null);
});

test("strict provider selection fails closed instead of silently changing providers", () => {
  const state = snapshot();
  state.accounts = state.accounts.filter((item) => item.providerId !== "codex-oauth");

  assert.throws(
    () => createProviderExecutionPlan(state, {
      workload: "anneal",
      providerId: "codex-oauth",
      allowFallback: false,
    }),
    /No connected provider account/,
  );
});

test("strict account selection fails closed instead of silently changing accounts", () => {
  const state = snapshot();
  state.accounts = state.accounts.map((item) => (
    item.id === "codex-main"
      ? { ...item, status: "expired", isDefault: false }
      : item
  ));

  assert.throws(
    () => createProviderExecutionPlan(state, {
      workload: "paseo",
      providerId: "codex-oauth",
      accountId: "codex-main",
      allowFallback: false,
    }),
    /No connected provider account/,
  );
});

test("account-only requests infer ownership and provider/account conflicts fail closed", () => {
  const inferred = createProviderExecutionPlan(snapshot(), {
    workload: "anneal",
    accountId: "claude-main",
    allowFallback: false,
  });
  assert.equal(inferred.provider.id, "claude-oauth");
  assert.equal(inferred.account.id, "claude-main");

  assert.throws(
    () => createProviderExecutionPlan(snapshot(), {
      workload: "anneal",
      providerId: "codex-oauth",
      accountId: "claude-main",
      allowFallback: true,
    }),
    /does not belong to provider codex-oauth/,
  );
});

test("execution planning rejects unsupported models and API-key accounts without stored credentials", () => {
  assert.throws(
    () => createProviderExecutionPlan(snapshot(), {
      workload: "paseo",
      providerId: "codex-oauth",
      model: "not-in-account-allowlist",
      allowFallback: false,
    }),
    /is not available for Provider Hub account codex-main/,
  );

  const state = snapshot();
  state.accounts = [account("openai-key", "openai-api", {
    auth: "api_key",
    hasCredential: false,
    isDefault: true,
    models: ["gpt-key-model"],
  })];
  assert.throws(
    () => createProviderExecutionPlan(state, {
      workload: "anneal",
      providerId: "openai-api",
      allowFallback: false,
    }),
    /No connected provider account/,
  );
});

test("proxy resolution enforces workload scopes and explicit account inheritance skips stale account profiles", () => {
  const scoped = snapshot();
  scoped.proxyProfiles = scoped.proxyProfiles.map((item) => (
    item.id === "account" ? { ...item, scopes: ["browser"] } : item
  ));
  const scopedRoute = resolveExecutionProxy(scoped, "codex-oauth", "codex-main", "anneal");
  assert.equal(scopedRoute.source, "provider");
  assert.equal(scopedRoute.profile.endpoint.host, "provider.proxy.test");

  const inherited = snapshot();
  inherited.accounts = inherited.accounts.map((item) => (
    item.id === "codex-main" ? { ...item, proxyProfileId: "account" } : item
  ));
  inherited.routing.accounts = [{
    accountId: "codex-main",
    providerId: "codex-oauth",
    inheritProvider: true,
    inheritGlobal: true,
    profileId: null,
  }];
  const inheritedRoute = resolveExecutionProxy(inherited, "codex-oauth", "codex-main", "paseo");
  assert.equal(inheritedRoute.source, "provider");
  assert.equal(inheritedRoute.profile.endpoint.host, "provider.proxy.test");
});

test("execution planning is exposed through bootstrap, preload, and the typed launcher API", () => {
  const root = path.resolve(__dirname, "..");
  const bootstrap = fs.readFileSync(path.join(root, "electron/provider-bootstrap.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const types = fs.readFileSync(path.join(root, "src/types.ts"), "utf8");

  assert.match(bootstrap, /createProviderExecutionPlan/);
  assert.match(bootstrap, /launcher:provider-execution-plan/);
  assert.match(preload, /providerExecutionPlan/);
  assert.match(types, /providerExecutionPlan\(input: ProviderExecutionPlanInput\)/);
});
