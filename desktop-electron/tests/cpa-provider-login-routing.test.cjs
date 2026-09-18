"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const network = require("../electron/provider-network.cjs");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
  };
}

function fixtureRoot() {
  const directory = path.join(desktopRoot, "aiTemp/rc9-cpa-oauth-tests", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function controllerFixture(fetchImpl, browser = null) {
  const opened = [];
  const controller = network.createProviderNetworkController({
    app: {},
    browserPartition: "persist:rc9-cpa-oauth",
    getBrowserHost: () => browser,
    logger: { info() {}, warn() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { setProxy: async () => undefined },
      fromPartition: () => ({ setProxy: async () => undefined }),
    },
    shell: { async openExternal(url) { opened.push(url); } },
    userData: fixtureRoot(),
    fetchImpl,
    sleepImpl: async () => undefined,
    oauthPollIntervalMs: 0,
    oauthTimeoutMs: 2_000,
  });
  return { controller, opened };
}

function saveCpaAccount(controller, providerId, adapterId, overrides = {}) {
  const snapshot = controller.store.saveAccount({
    providerId,
    label: `${providerId} account`,
    identity: "",
    endpoint: "http://127.0.0.1:8317",
    auth: "oauth",
    status: "pending",
    enabled: true,
    isDefault: false,
    models: [],
    loginAdapterId: adapterId,
    secret: {
      managementKey: "management-secret",
      baseUrl: "http://127.0.0.1:8317",
    },
    ...overrides,
  });
  return snapshot.accounts.find((account) => account.providerId === providerId);
}

test("Codex CPA login completes, stores only binding metadata, and discovers models", async () => {
  let listingReads = 0;
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    if (parsed.pathname === "/v0/management/auth-files") {
      listingReads += 1;
      return jsonResponse({
        files: listingReads === 1 ? [] : [{
          name: "codex-user.json",
          auth_index: "codex-index",
          provider: "codex",
          email: "codex@example.test",
          status: "ready",
        }],
      });
    }
    if (parsed.pathname === "/v0/management/codex-auth-url") {
      return jsonResponse({ status: "ok", state: "codex-state", url: "https://login.example.test/codex" });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") return jsonResponse({ status: "ok" });
    if (parsed.pathname === "/v0/management/auth-files/models") {
      return jsonResponse({ models: [{ id: "gpt-5.6-codex" }] });
    }
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };

  const { controller, opened } = controllerFixture(fetchImpl);
  const account = saveCpaAccount(controller, "codex-oauth", "cpa-codex");
  const result = await controller.openProviderLogin(account.id, "cpa-codex");
  const connected = result.snapshot.accounts.find((candidate) => candidate.id === account.id);

  assert.deepEqual(opened, ["https://login.example.test/codex"]);
  assert.equal(connected.status, "connected");
  assert.equal(connected.identity, "codex@example.test");
  assert.equal(connected.loginAdapterId, "cpa-codex");
  assert.equal(connected.credentialSource, "cpa");
  assert.equal(connected.authFileId, "codex-index");
  assert.equal(connected.authFileName, "codex-user.json");
  assert.deepEqual(connected.models, ["gpt-5.6-codex"]);
  assert.equal(JSON.stringify(result.snapshot).includes("management-secret"), false);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer management-secret"));
});

test("Claude CPA login uses anthropic-auth-url", async () => {
  let listingReads = 0;
  const paths = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === "/v0/management/auth-files") {
      listingReads += 1;
      return jsonResponse({ files: listingReads === 1 ? [] : [{
        name: "claude-user.json",
        provider: "anthropic",
        email: "claude@example.test",
        status: "ready",
      }] });
    }
    if (parsed.pathname === "/v0/management/anthropic-auth-url") {
      return jsonResponse({ status: "ok", state: "claude-state", url: "https://login.example.test/claude" });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") return jsonResponse({ status: "ok" });
    if (parsed.pathname === "/v0/management/auth-files/models") {
      return jsonResponse({ models: [{ id: "claude-opus-4-1" }] });
    }
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };

  const { controller } = controllerFixture(fetchImpl);
  const account = saveCpaAccount(controller, "claude-oauth", "cpa-claude");
  const result = await controller.openProviderLogin(account.id, "cpa-claude");
  assert.ok(paths.includes("/v0/management/anthropic-auth-url"));
  assert.equal(result.snapshot.accounts.find((candidate) => candidate.id === account.id).status, "connected");
});

test("Gemini CPA account imports an existing auth file without pretending an OAuth route exists", async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === "/v0/management/auth-files") {
      return jsonResponse({ files: [{
        name: "gemini-user.json",
        provider: "gemini",
        email: "gemini@example.test",
        status: "ready",
      }] });
    }
    if (parsed.pathname === "/v0/management/auth-files/models") {
      return jsonResponse({ models: [{ id: "gemini-2.5-pro" }] });
    }
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };

  const { controller, opened } = controllerFixture(fetchImpl);
  const account = saveCpaAccount(controller, "gemini-oauth", "cpa-gemini", {
    identity: "gemini@example.test",
  });
  const result = await controller.openProviderLogin(account.id, "cpa-gemini");
  const connected = result.snapshot.accounts.find((candidate) => candidate.id === account.id);
  assert.deepEqual(opened, []);
  assert.equal(paths.some((pathname) => pathname.includes("gemini-auth-url")), false);
  assert.equal(connected.status, "connected");
  assert.equal(connected.authFileName, "gemini-user.json");
});

test("Codex native browser login remains explicit and separate from CPA", async () => {
  const browser = {
    async openLogin() {
      return { authenticated: true, status: "ready" };
    },
  };
  const { controller } = controllerFixture(async () => assert.fail("Native login must not call CPA"), browser);
  const snapshot = controller.store.saveAccount({
    providerId: "codex-oauth",
    label: "Native Codex",
    auth: "oauth",
    status: "pending",
    enabled: true,
    isDefault: false,
    models: ["web-gpt"],
    loginAdapterId: "native-browser",
  });
  const account = snapshot.accounts.find((candidate) => candidate.label === "Native Codex");
  const result = await controller.openProviderLogin(account.id, "native-browser");
  const connected = result.snapshot.accounts.find((candidate) => candidate.id === account.id);
  assert.equal(connected.status, "connected");
  assert.equal(connected.loginAdapterId, "native-browser");
  assert.equal(connected.credentialSource, "native_browser");
});

test("unsupported providers no longer report success after merely opening a website", async () => {
  const { controller, opened } = controllerFixture(async () => assert.fail("No network request expected"));
  const snapshot = controller.store.saveAccount({
    providerId: "ai-studio-reverse-proxy",
    label: "Unsupported browser-only placeholder",
    auth: "browser_session",
    status: "pending",
    enabled: true,
    isDefault: false,
    models: [],
  });
  const account = snapshot.accounts.find((candidate) => candidate.providerId === "ai-studio-reverse-proxy");
  await assert.rejects(() => controller.openProviderLogin(account.id), /login adapter|not configured/i);
  assert.deepEqual(opened, []);
});
