"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  listCpaAuthAccounts,
  mergeProviderAccounts,
  overlayCpaAccounts,
  remainingFromQuota,
} = require("../electron/cpa-auth-inventory.cjs");
const { createAppsProviderServices, publicAccount } = require("../electron/apps-provider-services.cjs");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

function tempAuth(name, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name + "-"));
  for (const [fileName, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, fileName), JSON.stringify(body));
  }
  return directory;
}

const NOW = new Date("2026-11-18T00:00:00.000Z");

test("listCpaAuthAccounts returns every CPA auth file as a public account and never copies secrets", () => {
  const directory = tempAuth("cpa-inv", {
    "antigravity-good@example.com.json": {
      type: "antigravity",
      email: "good@example.com",
      access_token: "secret-token",
    },
    "codex-one@example.com.json": { type: "codex", email: "one@example.com", disabled: true },
    "cpa-provider-manager-openai-api.json": { type: "provider-manager", kind: "openai", label: "OpenAI API", api_key: "sk-secret" },
    "cpa-provider-manager-opencode-go.json": { type: "provider-manager", kind: "opencode-go", label: "OpenCode Go" },
    "cline-pass-switcher.json": { type: "provider-manager", kind: "cline", label: "Cline Pass", disabled: true },
    "notes.txt": "ignore me",
    "broken.json": "{ not json",
  });
  const accounts = listCpaAuthAccounts({
    directory,
    now: NOW,
    quotas: {
      "openai-api": { balances: [{ kind: "credit", currency: "USD", remaining: 12.5 }] },
    },
  });
  assert.equal(accounts.length, 5);
  assert.deepEqual(accounts.map((account) => account.providerId).sort(), [
    "cliproxyapi-antigravity",
    "codex-oauth",
    "custom-openai-compatible",
    "custom-openai-compatible",
    "openai-api",
  ].sort());
  const antigravity = accounts.find((account) => account.providerId === "cliproxyapi-antigravity");
  assert.equal(antigravity.identity, "good@example.com");
  assert.equal(antigravity.status, "connected");
  assert.equal(antigravity.displayOnly, true);
  assert.equal(antigravity.credentialSource, "cpa");
  const openai = accounts.find((account) => account.providerId === "openai-api");
  assert.deepEqual(openai.remainingBalance, { remaining: 12.5, currency: "USD", kind: "credit" });
  const disabled = accounts.find((account) => account.providerId === "codex-oauth");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "disabled");
  const dumped = JSON.stringify(accounts);
  assert.equal(dumped.includes("secret-token"), false);
  assert.equal(dumped.includes("sk-secret"), false);
});

test("mergeProviderAccounts keeps the stored Antigravity account and adds the missing CPA accounts", () => {
  const stored = {
    id: "store-antigravity",
    providerId: "cliproxyapi-antigravity",
    label: "Antigravity",
    identity: "good@example.com",
    auth: "oauth",
    status: "connected",
    enabled: true,
    isDefault: true,
    hasCredential: true,
    models: ["gemini-3-pro"],
    credentialSource: "cpa",
  };
  const archived = {
    id: "old-codex",
    providerId: "codex-oauth",
    label: "Old Codex",
    identity: "archived@example.com",
    auth: "oauth",
    status: "disabled",
    enabled: false,
    isDefault: false,
    hasCredential: false,
    models: [],
    archivedAt: "2026-09-01T00:00:00.000Z",
  };
  const live = [
    {
      id: "cpa-auth:antigravity-good@example.com.json",
      providerId: "cliproxyapi-antigravity",
      label: "good@example.com",
      identity: "good@example.com",
      remainingBalance: { remaining: 1, currency: "USD", kind: "credit" },
      displayOnly: true,
    },
    {
      id: "cpa-auth:codex-two.json",
      providerId: "codex-oauth",
      label: "two@example.com",
      identity: "two@example.com",
      status: "connected",
      enabled: true,
      displayOnly: true,
    },
  ];
  const merged = mergeProviderAccounts([stored, archived], live);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, "store-antigravity");
  assert.equal(merged[0].isDefault, true);
  assert.deepEqual(merged[0].models, ["gemini-3-pro"]);
  assert.deepEqual(merged[0].remainingBalance, { remaining: 1, currency: "USD", kind: "credit" });
  assert.equal(merged[1].id, "old-codex");
  assert.equal(merged[2].id, "cpa-auth:codex-two.json");
  const overlay = overlayCpaAccounts({ accounts: [stored], proxyProfiles: [] }, live);
  assert.equal(overlay.accounts.length, 2);
  assert.deepEqual(overlay.proxyProfiles, []);
});

test("listProviders includes live CPA auth-dir accounts and remaining balance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-listproviders-"));
  const store = createProviderNetworkStore({
    filePath: path.join(directory, "provider-network.json"),
    keyPath: path.join(directory, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  store.saveAccount({
    providerId: "cliproxyapi-antigravity",
    label: "Antigravity",
    identity: "good@example.com",
    auth: "oauth",
    status: "connected",
    enabled: true,
    models: ["gemini-3-pro"],
    credentialSource: "cpa",
  });
  const authDir = tempAuth("cpa-list-auth", {
    "antigravity-good@example.com.json": { type: "antigravity", email: "good@example.com" },
    "codex-two@example.com.json": { type: "codex", email: "two@example.com" },
    "cpa-provider-manager-openai-api.json": { type: "provider-manager", kind: "openai", label: "OpenAI API" },
  });
  const services = createAppsProviderServices({
    providerNetworkReady: async () => ({ store }),
    listCpaAuthAccounts: async () => listCpaAuthAccounts({
      directory: authDir,
      now: NOW,
      quotas: { "openai-api": { balances: [{ kind: "credit", currency: "USD", remaining: 8 }] } },
    }),
  });
  const listed = await services.listProviders();
  assert.equal(listed.ok, true);
  const antigravity = listed.accounts.find((account) => account.providerId === "cliproxyapi-antigravity");
  assert.equal(antigravity.id.startsWith("cpa-auth:"), false);
  assert.equal(antigravity.identity, "good@example.com");
  const openai = listed.accounts.find((account) => account.providerId === "openai-api");
  assert.deepEqual(openai.remainingBalance, { remaining: 8, currency: "USD", kind: "credit" });
  assert.equal(openai.displayOnly, true);
  const codex = listed.accounts.find((account) => account.identity === "two@example.com");
  assert.ok(codex);
  assert.equal(listed.summary.total, listed.accounts.length);
  assert.ok(listed.summary.total >= 3);
  assert.deepEqual(publicAccount({ ...openai, secret: "nope" }).remainingBalance, openai.remainingBalance);
  assert.equal(JSON.stringify(listed).includes("secret"), false);
});

test("remainingFromQuota ignores empty or invalid quota objects", () => {
  assert.equal(remainingFromQuota(null), null);
  assert.equal(remainingFromQuota({ windows: { rolling: { percent: 10 } } }), null);
  assert.deepEqual(remainingFromQuota({ balances: [{ remaining: 3, currency: "CNY", kind: "key-budget" }] }), {
    remaining: 3, currency: "CNY", kind: "key-budget",
  });
});