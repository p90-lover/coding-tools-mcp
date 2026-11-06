"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const network = require("../electron/provider-network.cjs");
const { createAppsProviderServices } = require("../electron/apps-provider-services.cjs");
const fixtureRoots = new Set();
const fixtureStores = new Set();

test.after(async () => {
  const saves = await Promise.allSettled([...fixtureStores].map(store => store.saved()));
  const base = path.resolve(desktopRoot, "../aiTemp/rc9-cpa-oauth-tests") + path.sep;
  for (const root of fixtureRoots) {
    assert.ok(path.resolve(root).startsWith(base));
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(saves.filter(result => result.status === "rejected"), []);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
  };
}

function fixtureRoot() {
  const directory = path.join(desktopRoot, "..", "aiTemp", "rc9-cpa-oauth-tests", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  fixtureRoots.add(directory);
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
  fixtureStores.add(controller.store);
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

for (const change of ["disable", "disable-enable", "adapter", "archive", "other-account"]) {
  test(`account ownership fences a native probe after ${change}`, async () => {
    const gate = deferred();
    const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
      probeAuthentication: () => gate.promise,
    });
    const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
    const pending = controller.probeProviderAccount(account.id);
    if (change === "disable" || change === "disable-enable") controller.store.setAccountEnabled(account.id, false);
    if (change === "disable-enable") controller.store.setAccountEnabled(account.id, true);
    if (change === "adapter") saveCpaAccount(controller, "codex-oauth", "cpa-codex", { id: account.id });
    if (change === "archive") controller.store.archiveAccount(account.id);
    if (change === "other-account") saveCpaAccount(controller, "claude-oauth", "cpa-claude");
    const before = controller.store.snapshot().accounts.find(row => row.id === account.id);
    gate.resolve({ authenticated: true });
    if (change === "other-account") {
      await pending;
      assert.equal(controller.store.snapshot().accounts.find(row => row.id === account.id).status, "connected");
    } else {
      await assert.rejects(pending, change === "archive" ? /not found/ : /account changed/i);
      assert.deepEqual(controller.store.snapshot().accounts.find(row => row.id === account.id), before);
    }
  });
}

for (const login of [false, true]) {
  test(`account ownership fences rejected ${login ? "login" : "probe"} after disable`, async () => {
    const gate = deferred();
    const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
      probeAuthentication: () => gate.promise, openLogin: () => gate.promise,
    });
    const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
    const pending = login ? controller.openProviderLogin(account.id) : controller.probeProviderAccount(account.id);
    controller.store.setAccountEnabled(account.id, false);
    const before = controller.store.snapshot().accounts[0];
    gate.reject(new Error("late browser failure"));
    await assert.rejects(pending, /account changed/i);
    assert.deepEqual(controller.store.snapshot().accounts[0], before);
  });
}

test("account ownership skips disabled probes but allows a new explicit login", async () => {
  let probes = 0, logins = 0;
  const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
    async probeAuthentication() { probes++; return { authenticated: true }; },
    async openLogin() { logins++; return { authenticated: true }; },
  });
  const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
  controller.store.setAccountEnabled(account.id, false);
  assert.equal((await controller.probeProviderAccount(account.id)).accounts[0].enabled, false);
  assert.equal(probes, 0);
  await controller.openProviderLogin(account.id);
  assert.equal(controller.store.snapshot().accounts[0].enabled, true);
  assert.equal(logins, 1);
  await controller.probeProviderAccount(account.id);
  assert.equal(probes, 1, "completed login releases its ownership");
});

test("account ownership gives pending login priority over Apps providerStatus", async () => {
  const gate = deferred();
  let probes = 0;
  const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
    openLogin: () => gate.promise,
    async probeAuthentication() { probes++; return { authenticated: false }; },
  });
  const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
  const login = controller.openProviderLogin(account.id);
  const services = createAppsProviderServices({ providerNetworkReady: async () => controller });
  const status = await services.providerStatus({ accountId: account.id });
  gate.resolve({ authenticated: true });
  await login;
  assert.equal(status.account.status, "pending");
  assert.equal(probes, 0, "a read-only status call must not replace deliberate login");
  assert.equal(controller.store.snapshot().accounts[0].status, "connected");
});

test("account ownership fences native login success after disable", async () => {
  const gate = deferred();
  const { controller } = controllerFixture(async () => assert.fail("No CPA request"), { openLogin: () => gate.promise });
  const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
  const login = controller.openProviderLogin(account.id);
  controller.store.setAccountEnabled(account.id, false);
  const before = controller.store.snapshot().accounts[0];
  gate.resolve({ authenticated: true });
  await assert.rejects(login, /account changed/i);
  assert.deepEqual(controller.store.snapshot().accounts[0], before);
});

test("account ownership stale cleanup leaves a newer pending login owned", async () => {
  const probeGate = deferred(), loginGate = deferred();
  let probes = 0;
  const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
    probeAuthentication: () => { probes++; return probeGate.promise; },
    openLogin: () => loginGate.promise,
  });
  const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
  const stale = controller.probeProviderAccount(account.id);
  const login = controller.openProviderLogin(account.id);
  probeGate.resolve({ authenticated: false });
  await assert.rejects(stale, /account changed/i);
  const services = createAppsProviderServices({ providerNetworkReady: async () => controller });
  const status = await services.providerStatus({ accountId: account.id });
  loginGate.resolve({ authenticated: true });
  await login;
  assert.equal(status.account.status, "pending");
  assert.equal(probes, 1, "old finally must not remove the newer login token");
  assert.equal(controller.store.snapshot().accounts[0].status, "connected");
});

for (const older of ["probe", "login-success", "login-failure"]) {
  test(`account ownership rejects older ${older} after a newer login`, async () => {
    const first = deferred(), second = deferred();
    let logins = 0;
    const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
      probeAuthentication: () => first.promise,
      openLogin: () => older === "probe" || logins++ ? second.promise : first.promise,
    });
    const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
    const stale = older === "probe" ? controller.probeProviderAccount(account.id) : controller.openProviderLogin(account.id);
    const current = controller.openProviderLogin(account.id);
    second.resolve({ authenticated: true });
    await current;
    const before = controller.store.snapshot().accounts[0];
    first.resolve({ authenticated: older === "login-success" });
    await assert.rejects(stale, /account changed/i);
    assert.deepEqual(controller.store.snapshot().accounts[0], before);
  });
}

test("account ownership lets a newer probe replace an older probe", async () => {
  const first = deferred(), second = deferred();
  let probes = 0;
  const { controller } = controllerFixture(async () => assert.fail("No CPA request"), {
    probeAuthentication: () => probes++ ? second.promise : first.promise,
  });
  const account = saveCpaAccount(controller, "codex-oauth", "native-browser");
  const stale = controller.probeProviderAccount(account.id);
  const current = controller.probeProviderAccount(account.id);
  second.resolve({ authenticated: true });
  await current;
  const before = controller.store.snapshot().accounts[0];
  first.resolve({ authenticated: false });
  await assert.rejects(stale, /account changed/i);
  assert.deepEqual(controller.store.snapshot().accounts[0], before);
});

for (const login of [false, true]) {
  for (const result of ["connected", "missing", "rejected"]) {
    test(`account ownership fences CPA ${login ? "login" : "probe"} ${result} after disable`, async () => {
      const listing = deferred();
      const { controller } = controllerFixture(async url => {
        if (new URL(url).pathname === "/v0/management/auth-files") return listing.promise;
        if (new URL(url).pathname === "/v0/management/auth-files/models") return jsonResponse({ models: [{ id: "fresh-model" }] });
        assert.fail(`Unexpected CPA request ${url}`);
      });
      const account = saveCpaAccount(controller, "gemini-oauth", "cpa-gemini", { identity: "synthetic@example.test" });
      const pending = login ? controller.openProviderLogin(account.id) : controller.probeProviderAccount(account.id);
      controller.store.setAccountEnabled(account.id, false);
      const before = controller.store.snapshot().accounts[0];
      const secret = controller.store.accountSecret(account.id);
      if (result === "rejected") listing.reject(new Error("late CPA failure"));
      else listing.resolve(jsonResponse({ files: result === "missing" ? [] : [{
        name: "synthetic.json", auth_index: "synthetic-index", provider: "gemini", email: "synthetic@example.test", status: "ready",
      }] }));
      await assert.rejects(pending, /account changed/i);
      assert.deepEqual(controller.store.snapshot().accounts[0], before);
      assert.deepEqual(controller.store.accountSecret(account.id), secret, "no late auth binding is persisted");
    });
  }
}

test("Codex CPA login completes, stores an encrypted binding, and discovers models", async () => {
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
  const storedBinding = controller.store.accountSecret(account.id);
  assert.equal(storedBinding.cpaAuthIndex, "codex-index");
  assert.equal(storedBinding.cpaAuthName, "codex-user.json");
  assert.deepEqual(connected.models, ["gpt-5.6-codex"]);
  assert.equal(JSON.stringify(result.snapshot).includes("management-secret"), false);
  assert.equal(JSON.stringify(result.snapshot).includes("codex-index"), false);
  assert.equal(JSON.stringify(result.snapshot).includes("codex-user.json"), false);
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
  const storedBinding = controller.store.accountSecret(account.id);
  assert.equal(storedBinding.cpaAuthName, "gemini-user.json");
  assert.equal(JSON.stringify(result.snapshot).includes("gemini-user.json"), false);
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

for (const [providerId, adapterId, route, cpaProvider] of [
  ["commandcode-proxy", "commandcode-oauth", "commandcode-go-auth-url", "commandcode-go"],
  ["commandcode-studio", "cpa-commandcode-studio", "commandcode-auth-url", "commandcode"],
]) {
  test(`${providerId} logs in through its CPA plugin and preserves the account`, async () => {
    let listingReads = 0;
    const requests = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      requests.push(parsed.pathname);
      if (parsed.pathname === "/v0/management/auth-files") {
        listingReads += 1;
        return jsonResponse({ files: listingReads === 1 ? [] : [{
          name: `${cpaProvider}-user.json`, provider: cpaProvider,
          email: "user@example.test", status: "ready",
        }] });
      }
      if (parsed.pathname === `/v0/management/${route}`) {
        return jsonResponse({ status: "ok", state: "plugin-state", url: "https://login.example.test/commandcode" });
      }
      if (parsed.pathname === "/v0/management/get-auth-status") return jsonResponse({ status: "ok" });
      if (parsed.pathname === "/v0/management/auth-files/models") return jsonResponse({ models: [{ id: "test-model" }] });
      throw new Error(`Unexpected request ${parsed.pathname}`);
    };
    const { controller, opened } = controllerFixture(fetchImpl);
    const account = saveCpaAccount(controller, providerId, adapterId, {
      auth: providerId === "commandcode-proxy" ? "local_proxy" : "oauth",
    });
    const result = await controller.openProviderLogin(account.id);
    const connected = result.snapshot.accounts.find((candidate) => candidate.id === account.id);
    assert.deepEqual(opened, ["https://login.example.test/commandcode"]);
    assert.equal(connected.auth, "oauth");
    assert.equal(connected.credentialSource, "cpa");
    assert.equal(connected.loginAdapterId, providerId === "commandcode-proxy" ? "cpa-commandcode-go" : adapterId);
    assert.equal(connected.endpoint, "http://127.0.0.1:8317");
    assert.ok(requests.includes(`/v0/management/${route}`));
  });
}
