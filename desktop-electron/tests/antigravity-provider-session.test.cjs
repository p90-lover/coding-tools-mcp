"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const network = require(path.join(root, "electron/provider-network.cjs"));

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

function fixtureRoot() {
  const directory = path.join(
    root,
    "aiTemp/antigravity-provider-session",
    crypto.randomUUID(),
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function controllerFixture(fetchImpl) {
  const opened = [];
  const userData = fixtureRoot();
  const controller = network.createProviderNetworkController({
    app: {},
    browserPartition: "persist:antigravity-test",
    getBrowserHost: () => null,
    logger: { info() {}, warn() {} },
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
    session: {
      defaultSession: { setProxy: async () => undefined },
      fromPartition: () => ({ setProxy: async () => undefined }),
    },
    shell: {
      async openExternal(url) {
        opened.push(url);
      },
    },
    userData,
    fetchImpl,
    sleepImpl: async () => undefined,
    oauthPollIntervalMs: 0,
    oauthTimeoutMs: 2_000,
  });
  return { controller, opened };
}

function saveAntigravityAccount(controller, overrides = {}) {
  const snapshot = controller.store.saveAccount({
    providerId: "cliproxyapi-antigravity",
    label: "Antigravity primary",
    identity: "",
    auth: "local_proxy",
    status: "pending",
    enabled: true,
    isDefault: false,
    endpoint: "http://127.0.0.1:8317",
    models: [],
    secret: { credential: "management-secret" },
    ...overrides,
  });
  return snapshot.accounts.find((account) => account.providerId === "cliproxyapi-antigravity");
}

test("Antigravity login uses CLIProxyAPI management OAuth, polls status, and discovers models", async () => {
  const requests = [];
  let statusPolls = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    if (parsed.pathname === "/v0/management/antigravity-auth-url") {
      assert.equal(parsed.searchParams.get("is_webui"), "true");
      return jsonResponse({
        status: "ok",
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
        state: "state-123",
      });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") {
      assert.equal(parsed.searchParams.get("state"), "state-123");
      statusPolls += 1;
      return jsonResponse({ status: statusPolls === 1 ? "wait" : "ok" });
    }
    if (parsed.pathname === "/v0/management/auth-files") {
      return jsonResponse({
        files: [{
          name: "antigravity-user@example.test.json",
          provider: "antigravity",
          type: "antigravity",
          label: "user@example.test",
          email: "user@example.test",
          status: "ready",
          status_message: "",
          disabled: false,
          unavailable: false,
        }],
      });
    }
    if (parsed.pathname === "/v0/management/auth-files/models") {
      assert.equal(parsed.searchParams.get("name"), "antigravity-user@example.test.json");
      return jsonResponse({ models: [{ id: "gemini-2.5-pro" }, { id: "gemini-2.5-flash" }] });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const { controller, opened } = controllerFixture(fetchImpl);
  const account = saveAntigravityAccount(controller);
  const result = await controller.openProviderLogin(account.id);

  assert.deepEqual(opened, ["https://accounts.google.com/o/oauth2/v2/auth?client_id=test"]);
  assert.equal(result.opened, true);
  assert.equal(result.mode, "external");
  assert.equal(result.state, "state-123");
  const connected = result.snapshot.accounts.find((item) => item.id === account.id);
  assert.equal(connected.status, "connected");
  assert.equal(connected.identity, "user@example.test");
  assert.equal(connected.endpoint, "http://127.0.0.1:8317");
  assert.deepEqual(connected.models, ["gemini-2.5-flash", "gemini-2.5-pro"]);
  assert.equal(connected.hasCredential, true);
  assert.equal(JSON.stringify(result.snapshot).includes("management-secret"), false);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer management-secret"));
  assert.ok(requests.every(({ options }) => options.headers["X-Management-Key"] === "management-secret"));
});

test("Antigravity login binds the newly created auth file when other accounts already exist", async () => {
  let authFileReads = 0;
  const existing = {
    name: "antigravity-existing@example.test.json",
    provider: "antigravity",
    label: "existing@example.test",
    email: "existing@example.test",
    status: "ready",
    status_message: "",
    disabled: false,
    unavailable: false,
  };
  const created = {
    name: "antigravity-created@example.test.json",
    provider: "antigravity",
    label: "created@example.test",
    email: "created@example.test",
    status: "ready",
    status_message: "",
    disabled: false,
    unavailable: false,
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/auth-files") {
      authFileReads += 1;
      return jsonResponse({ files: authFileReads === 1 ? [existing] : [existing, created] });
    }
    if (parsed.pathname === "/v0/management/antigravity-auth-url") {
      return jsonResponse({
        status: "ok",
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=multi-account",
        state: "state-multi-account",
      });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") {
      return jsonResponse({ status: "ok" });
    }
    if (parsed.pathname === "/v0/management/auth-files/models") {
      assert.equal(parsed.searchParams.get("name"), created.name);
      return jsonResponse({ models: [{ id: "gemini-created-account" }] });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const { controller } = controllerFixture(fetchImpl);
  const account = saveAntigravityAccount(controller, { label: "New Antigravity login" });
  const result = await controller.openProviderLogin(account.id);
  const connected = result.snapshot.accounts.find((item) => item.id === account.id);

  assert.equal(authFileReads, 2);
  assert.equal(connected.identity, "created@example.test");
  assert.deepEqual(connected.models, ["gemini-created-account"]);
});

test("Antigravity probe maps missing, expired, and healthy sessions without exposing the management key", async () => {
  const responses = [
    { files: [] },
    { files: [{
      name: "expired.json",
      provider: "antigravity",
      status: "error",
      status_message: "refresh token expired",
      disabled: false,
      unavailable: true,
    }] },
    { files: [{
      name: "ready.json",
      provider: "antigravity",
      label: "ready@example.test",
      status: "ready",
      status_message: "",
      disabled: false,
      unavailable: false,
    }] },
  ];
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers.Authorization, "Bearer management-secret");
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/auth-files") {
      return jsonResponse(responses.shift());
    }
    if (parsed.pathname === "/v0/management/auth-files/models") {
      return jsonResponse({ models: [{ id: "gemini-ready" }] });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const { controller } = controllerFixture(fetchImpl);
  const account = saveAntigravityAccount(controller);

  let snapshot = await controller.probeProviderAccount(account.id);
  assert.equal(snapshot.accounts.find((item) => item.id === account.id).status, "pending");

  snapshot = await controller.probeProviderAccount(account.id);
  assert.equal(snapshot.accounts.find((item) => item.id === account.id).status, "expired");

  snapshot = await controller.probeProviderAccount(account.id);
  const ready = snapshot.accounts.find((item) => item.id === account.id);
  assert.equal(ready.status, "connected");
  assert.deepEqual(ready.models, ["gemini-ready"]);
  assert.equal(JSON.stringify(snapshot).includes("management-secret"), false);
});

test("temporary CLIProxyAPI unavailability is an error, not an expired OAuth session", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/auth-files") {
      return jsonResponse({
        files: [{
          name: "temporarily-blocked.json",
          provider: "antigravity",
          label: "blocked@example.test",
          status: "ready",
          status_message: "temporarily blocked until retry window",
          disabled: false,
          unavailable: true,
        }],
      });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const { controller } = controllerFixture(fetchImpl);
  const account = saveAntigravityAccount(controller);
  const snapshot = await controller.probeProviderAccount(account.id);
  const blocked = snapshot.accounts.find((item) => item.id === account.id);

  assert.equal(blocked.status, "error");
  assert.match(blocked.error, /temporarily blocked/i);
});

test("provider management URLs reject unsafe remote HTTP and unsafe OAuth redirects", async () => {
  assert.equal(
    network.normalizeProviderBaseUrl("http://127.0.0.1:8317/v1"),
    "http://127.0.0.1:8317",
  );
  assert.equal(
    network.normalizeProviderBaseUrl("https://proxy.example.test/v1"),
    "https://proxy.example.test",
  );
  assert.throws(
    () => network.normalizeProviderBaseUrl("http://proxy.example.test:8317"),
    /HTTPS|loopback/i,
  );

  const fetchImpl = async () => jsonResponse({
    status: "ok",
    url: "http://attacker.example.test/oauth",
    state: "unsafe-state",
  });
  const { controller, opened } = controllerFixture(fetchImpl);
  const account = saveAntigravityAccount(controller);
  await assert.rejects(() => controller.openProviderLogin(account.id), /unsafe|HTTPS|loopback/i);
  assert.deepEqual(opened, []);
});

test("renderer, preload, types, and IPC expose automatic Antigravity login and health controls", () => {
  const surface = fs.readFileSync(path.join(root, "src/features/ProviderHubSaasSurface.tsx"), "utf8");
  const catalog = fs.readFileSync(path.join(root, "src/providers/provider-types.ts"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const types = fs.readFileSync(path.join(root, "src/types.ts"), "utf8");
  const bootstrap = fs.readFileSync(path.join(root, "electron/provider-bootstrap.cjs"), "utf8");

  assert.match(catalog, /id:\s*"cliproxyapi-antigravity"[\s\S]*loginMode:\s*"antigravity_management"/);
  assert.match(surface, /supportsProviderLogin/);
  assert.match(surface, /probeProviderAccount/);
  assert.match(surface, /Refresh session/);
  assert.match(surface, /更新工作階段/);
  assert.match(surface, /Test connection/);
  assert.match(surface, /測試連線/);
  assert.match(preload, /probeProviderAccount/);
  assert.match(types, /probeProviderAccount\(accountId: string\)/);
  assert.match(bootstrap, /active\.openProviderLogin\(accountId\)/);
  assert.match(bootstrap, /active\.probeProviderAccount\(accountId\)/);
});
