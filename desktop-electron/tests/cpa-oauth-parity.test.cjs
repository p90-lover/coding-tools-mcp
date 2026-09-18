"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const network = require(path.join(desktopRoot, "electron", "provider-network.cjs"));
const externalServices = require(path.join(desktopRoot, "electron", "external-services.cjs"));

const CPA_KEY = "cpa-management-key-abcdefghijklmnopqrstuvwxyz-0123456789";
const CPA_BASE_URL = "http://127.0.0.1:8317";

function retainedRoot(name) {
  const root = path.join(
    repositoryRoot,
    "aiTemp",
    "rc9-cpa-oauth-tests",
    `${name}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function jsonResponse(value, status = 200) {
  const body = structuredClone(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/json" : null },
    async json() { return structuredClone(body); },
    clone() { return jsonResponse(body, status); },
  };
}

function controllerFixture(fetchImpl) {
  const opened = [];
  const controller = network.createProviderNetworkController({
    app: {},
    browserPartition: "persist:rc9-cpa-oauth-test",
    getBrowserHost: () => null,
    getCpaConnection: () => ({ baseUrl: CPA_BASE_URL, managementKey: CPA_KEY }),
    logger: { info() {}, warn() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { setProxy: async () => undefined },
      fromPartition: () => ({ setProxy: async () => undefined }),
    },
    shell: {
      async openExternal(url) { opened.push(url); },
    },
    userData: retainedRoot("provider-network"),
    fetchImpl,
    sleepImpl: async () => undefined,
    oauthPollIntervalMs: 0,
    oauthTimeoutMs: 2_000,
  });
  return { controller, opened };
}

function saveOAuthAccount(controller, providerId, label) {
  const snapshot = controller.store.saveAccount({
    providerId,
    label,
    identity: "",
    auth: "oauth",
    status: "pending",
    enabled: true,
    isDefault: false,
    models: [],
  });
  return snapshot.accounts.find((account) => account.providerId === providerId);
}

const CPA_PROVIDERS = [
  { providerId: "codex-oauth", cpaProvider: "codex", authPath: "codex-auth-url", label: "Codex" },
  { providerId: "claude-oauth", cpaProvider: "anthropic", authPath: "anthropic-auth-url", label: "Claude" },
  { providerId: "gemini-oauth", cpaProvider: "gemini-cli", authPath: "gemini-cli-auth-url", label: "Gemini" },
  { providerId: "cliproxyapi-antigravity", cpaProvider: "antigravity", authPath: "antigravity-auth-url", label: "Antigravity" },
];

test("Codex, Claude, Gemini, and Antigravity use one CPA OAuth start/poll/bind/model lifecycle", async (t) => {
  for (const definition of CPA_PROVIDERS) {
    await t.test(definition.providerId, async () => {
      let authFileReads = 0;
      const requests = [];
      const existing = {
        name: `${definition.cpaProvider}-existing.json`,
        auth_index: `${definition.cpaProvider}-existing-index`,
        provider: definition.cpaProvider,
        email: `existing-${definition.cpaProvider}@example.test`,
        status: "ready",
        disabled: false,
        unavailable: false,
      };
      const created = {
        name: `${definition.cpaProvider}-created.json`,
        auth_index: `${definition.cpaProvider}-created-index`,
        provider: definition.cpaProvider,
        email: `created-${definition.cpaProvider}@example.test`,
        status: "ready",
        disabled: false,
        unavailable: false,
      };
      const fetchImpl = async (url, options = {}) => {
        const parsed = new URL(url);
        requests.push({ parsed, options });
        assert.equal(options.headers?.Authorization, `Bearer ${CPA_KEY}`);
        assert.equal(options.headers?.["X-Management-Key"], CPA_KEY);
        if (parsed.pathname === "/v0/management/auth-files") {
          authFileReads += 1;
          return jsonResponse({ files: authFileReads === 1 ? [existing] : [existing, created] });
        }
        if (parsed.pathname === `/v0/management/${definition.authPath}`) {
          assert.equal(parsed.searchParams.get("is_webui"), "true");
          return jsonResponse({
            status: "ok",
            url: `https://login.example.test/${definition.cpaProvider}`,
            state: `state-${definition.cpaProvider}`,
          });
        }
        if (parsed.pathname === "/v0/management/get-auth-status") {
          assert.equal(parsed.searchParams.get("state"), `state-${definition.cpaProvider}`);
          return jsonResponse({ status: "ok" });
        }
        if (parsed.pathname === "/v0/management/auth-files/models") {
          assert.equal(parsed.searchParams.get("name"), created.name);
          return jsonResponse({ models: [{ id: `${definition.cpaProvider}-model-b` }, { id: `${definition.cpaProvider}-model-a` }] });
        }
        throw new Error(`Unexpected CPA request: ${parsed.pathname}`);
      };

      const { controller, opened } = controllerFixture(fetchImpl);
      const account = saveOAuthAccount(controller, definition.providerId, `${definition.label} primary`);
      const result = await controller.openProviderLogin(account.id);
      const connected = result.snapshot.accounts.find((candidate) => candidate.id === account.id);

      assert.deepEqual(opened, [`https://login.example.test/${definition.cpaProvider}`]);
      assert.equal(result.mode, "external");
      assert.equal(connected.status, "connected");
      assert.equal(connected.identity, created.email);
      assert.equal(connected.endpoint, CPA_BASE_URL);
      assert.deepEqual(connected.models, [`${definition.cpaProvider}-model-a`, `${definition.cpaProvider}-model-b`]);
      assert.equal(JSON.stringify(result.snapshot).includes(CPA_KEY), false);
      assert.equal(JSON.stringify(result.snapshot).includes(created.auth_index), false);
      assert.equal(JSON.stringify(result.snapshot).includes(created.name), false);
      assert.ok(requests.some(({ parsed }) => parsed.pathname.endsWith(definition.authPath)));
    });
  }
});

test("a bound CPA account fails closed when its exact auth file disappears", async () => {
  const created = {
    name: "anthropic-bound.json",
    auth_index: "anthropic-bound-index",
    provider: "anthropic",
    email: "claude@example.test",
    status: "ready",
    disabled: false,
    unavailable: false,
  };
  let phase = "login";
  let fullReads = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/auth-files") {
      if (phase === "login") {
        fullReads += 1;
        return jsonResponse({ files: fullReads === 1 ? [] : [created] });
      }
      assert.equal(parsed.searchParams.get("name"), created.name);
      assert.equal(parsed.searchParams.get("auth_index"), created.auth_index);
      return jsonResponse({ files: [{
        name: "anthropic-other.json",
        auth_index: "anthropic-other-index",
        provider: "anthropic",
        email: "other@example.test",
        status: "ready",
      }] });
    }
    if (parsed.pathname === "/v0/management/anthropic-auth-url") {
      return jsonResponse({ status: "ok", url: "https://login.example.test/claude", state: "claude-state" });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") return jsonResponse({ status: "ok" });
    if (parsed.pathname === "/v0/management/auth-files/models") return jsonResponse({ models: [{ id: "claude-model" }] });
    throw new Error(`Unexpected CPA request: ${parsed.pathname}`);
  };

  const { controller } = controllerFixture(fetchImpl);
  const account = saveOAuthAccount(controller, "claude-oauth", "Claude bound");
  await controller.openProviderLogin(account.id);
  phase = "missing";
  const snapshot = await controller.probeProviderAccount(account.id);
  const pending = snapshot.accounts.find((candidate) => candidate.id === account.id);
  assert.equal(pending.status, "pending");
  assert.match(pending.error, /bound Claude.*unavailable|log in again/i);
  assert.deepEqual(pending.models, []);
});

test("Gemini OAuth fails closed with actionable guidance when the CPA auth plugin is unavailable", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/auth-files") return jsonResponse({ files: [] });
    if (parsed.pathname === "/v0/management/gemini-cli-auth-url") {
      return jsonResponse({ error: "provider not installed" }, 404);
    }
    throw new Error(`Unexpected CPA request: ${parsed.pathname}`);
  };
  const { controller, opened } = controllerFixture(fetchImpl);
  const account = saveOAuthAccount(controller, "gemini-oauth", "Gemini primary");
  await assert.rejects(
    () => controller.openProviderLogin(account.id),
    /Gemini CLI.*plugin|gemini-cli-auth-url|installed CPA/i,
  );
  const failed = controller.store.snapshot().accounts.find((candidate) => candidate.id === account.id);
  assert.equal(failed.status, "error");
  assert.deepEqual(opened, []);
});

test("CPA is a first-class encrypted external service and its management key stays main-process-only", async () => {
  assert.ok(externalServices.SERVICE_IDS.includes("cliproxyapi"));
  const root = retainedRoot("external-service");
  const filePath = path.join(root, "external-services.json");
  const keyPath = path.join(root, "external-services.key");
  const requests = [];
  const controller = externalServices.createExternalServicesController({
    filePath,
    keyPath,
    safeStorage: { isEncryptionAvailable: () => false },
    env: {},
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return jsonResponse({ files: [] });
    },
  });

  controller.configure("cliproxyapi", {
    endpoint: CPA_BASE_URL,
    managementKey: CPA_KEY,
    enabled: true,
  });
  const snapshot = controller.snapshot();
  const cpa = snapshot.services.find((service) => service.id === "cliproxyapi");
  assert.equal(cpa.endpoint, `${CPA_BASE_URL}/`);
  assert.equal(cpa.secretConfigured, true);
  assert.equal(JSON.stringify(snapshot).includes(CPA_KEY), false);
  assert.deepEqual(controller.providerConnection("cliproxyapi"), {
    baseUrl: CPA_BASE_URL,
    managementKey: CPA_KEY,
  });
  const inspected = await controller.inspect("cliproxyapi");
  assert.equal(inspected.status, "ready");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${CPA_KEY}`);
  assert.equal(requests[0].options.headers["X-Management-Key"], CPA_KEY);
  controller.dispose();

  const reopened = externalServices.createExternalServicesController({
    filePath,
    keyPath,
    safeStorage: { isEncryptionAvailable: () => false },
    env: {},
  });
  assert.equal(reopened.providerConnection("cliproxyapi").managementKey, CPA_KEY);
  assert.equal(JSON.stringify(reopened.snapshot()).includes(CPA_KEY), false);
  reopened.dispose();
});

test("catalogue, Provider Center, Integrations, and bootstrap expose CPA-managed OAuth without replacing existing provider modes", () => {
  const catalog = fs.readFileSync(path.join(desktopRoot, "src/providers/provider-types.ts"), "utf8");
  const providerSurface = fs.readFileSync(path.join(desktopRoot, "src/features/ProviderHubSaasSurface.tsx"), "utf8");
  const integrationSurface = fs.readFileSync(path.join(desktopRoot, "src/features/ExternalServicesSurface.tsx"), "utf8");
  const types = fs.readFileSync(path.join(desktopRoot, "src/types.ts"), "utf8");
  const bootstrap = fs.readFileSync(path.join(desktopRoot, "electron/provider-bootstrap.cjs"), "utf8");
  const main = fs.readFileSync(path.join(desktopRoot, "electron/main.cjs"), "utf8");
  const manifest = path.join(desktopRoot, "vendor/upstream/cliproxyapi.json");

  assert.match(catalog, /ProviderLoginMode[^;]*cpa_oauth/s);
  for (const providerId of ["codex-oauth", "claude-oauth", "gemini-oauth", "cliproxyapi-antigravity"]) {
    assert.match(catalog, new RegExp(`id: \\"${providerId}\\"[\\s\\S]*?loginMode: \\"cpa_oauth\\"`));
  }
  assert.match(providerSurface, /Login with CPA/);
  assert.match(providerSurface, /使用 CPA 登入/);
  assert.match(providerSurface, /Refresh CPA session/);
  assert.match(providerSurface, /更新 CPA 工作階段/);
  assert.match(integrationSurface, /CPA \/ CLIProxyAPI management key/);
  assert.match(integrationSurface, /CPA／CLIProxyAPI 管理金鑰/);
  assert.match(types, /ExternalServiceId[^;]*cliproxyapi/);
  assert.match(types, /managementKey\?: string/);
  assert.match(bootstrap, /setProviderCpaConnection/);
  assert.match(main, /setProviderCpaConnection/);
  assert.equal(fs.existsSync(manifest), true);
});
