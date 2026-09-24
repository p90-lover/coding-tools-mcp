"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const providerNetwork = require("../electron/provider-network.cjs");

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, "..", relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const module = { exports: {} };
  const localRequire = (specifier) => {
    throw new Error(`unexpected runtime dependency ${specifier} in ${relativePath}`);
  };
  Function("require", "module", "exports", compiled.outputText)(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}

function account(overrides = {}) {
  return {
    id: "codex-main",
    providerId: "codex-oauth",
    label: "Codex main",
    identity: "main@example.test",
    auth: "oauth",
    status: "connected",
    enabled: true,
    isDefault: false,
    models: ["codex"],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function profile(id, host, protocol = "http") {
  return {
    id,
    name: id,
    enabled: true,
    endpoint: { protocol, host, port: protocol.startsWith("socks") ? 1080 : 8080 },
    scopes: ["all"],
    bypass: ["localhost", "127.0.0.1", "::1"],
  };
}

function globalRoutingFixture(reachability, {
  profileId = "global-proxy",
  setProxyImpl = async () => undefined,
} = {}) {
  const proxyCalls = [];
  const createSession = (name) => ({
    async setProxy(configuration) {
      proxyCalls.push({ name, configuration });
      await setProxyImpl(name, configuration);
    },
  });
  const defaultSession = createSession("default");
  const browserSession = createSession("browser");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-global-proxy-"));
  const controller = providerNetwork.createProviderNetworkController({
    app: {},
    browserPartition: "persist:global-proxy-test",
    getBrowserHost: () => null,
    logger: { info() {}, warn() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession,
      fromPartition: () => browserSession,
    },
    shell: { async openExternal() {} },
    userData,
    testTcpEndpointImpl: typeof reachability === "function"
      ? reachability
      : async () => reachability,
  });
  controller.store.saveProxyProfile({
    id: profileId,
    name: "Global proxy",
    enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17891 },
    scopes: ["all", "browser"],
    bypass: ["localhost", "127.0.0.1", "::1"],
  });
  controller.store.setGlobalRouting({ enabled: true, profileId });
  return { browserSession, controller, defaultSession, proxyCalls, userData };
}

test("provider accounts support multiple logins, one default, fallback, and archive without deletion", () => {
  const manager = loadTypeScriptModule("src/providers/provider-account-manager.ts");
  let state = manager.createProviderAccountState([
    account({ id: "codex-main", isDefault: true }),
    account({ id: "codex-backup", label: "Codex backup", identity: "backup@example.test" }),
  ]);

  state = manager.setDefaultProviderAccount(state, "codex-oauth", "codex-backup");
  assert.equal(state.accounts.find((item) => item.id === "codex-main").isDefault, false);
  assert.equal(state.accounts.find((item) => item.id === "codex-backup").isDefault, true);
  assert.equal(manager.selectProviderAccount(state, "codex-oauth").id, "codex-backup");

  state = manager.archiveProviderAccount(
    state,
    "codex-backup",
    "2026-09-16T01:00:00.000Z",
  );
  assert.equal(state.accounts.length, 2, "archive must preserve the account record");
  assert.equal(
    state.accounts.find((item) => item.id === "codex-backup").archivedAt,
    "2026-09-16T01:00:00.000Z",
  );
  assert.equal(manager.selectProviderAccount(state, "codex-oauth").id, "codex-main");
});

test("proxy routing resolves account then provider then global saved profiles", () => {
  const proxy = loadTypeScriptModule("src/network/proxy-manager.ts");
  const state = {
    global: null,
    globalEnabled: true,
    globalProfileId: "global",
    profiles: [
      profile("global", "global.proxy.test"),
      profile("provider", "provider.proxy.test", "socks4"),
      profile("account", "account.proxy.test", "socks5"),
    ],
    providers: [{
      providerId: "codex-oauth",
      inheritGlobal: true,
      profileId: "provider",
    }],
    accounts: [{
      accountId: "codex-main",
      providerId: "codex-oauth",
      inheritProvider: true,
      inheritGlobal: true,
      profileId: "account",
    }],
  };

  assert.equal(proxy.resolveProxy("codex-oauth", state, "codex-main").endpoint.host, "account.proxy.test");
  assert.equal(proxy.resolveProxy("codex-oauth", state, "codex-backup").endpoint.host, "provider.proxy.test");
  assert.equal(proxy.resolveProxy("claude-oauth", state, "claude-main").endpoint.host, "global.proxy.test");
  assert.equal(proxy.validateProxy(profile("socks4", "proxy.test", "socks4")), true);
  assert.equal(
    proxy.shouldProxyUrl("wss://api.example.test/socket", "websocket", profile("ws", "proxy.test")),
    true,
  );
  assert.equal(
    proxy.shouldProxyUrl("http://127.0.0.1:43110/mcp", "local-control", profile("local", "proxy.test")),
    false,
  );
});

test("reachable global proxy is applied only to the ChatGPT session", async (context) => {
  const previousEnvironment = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].map((name) => [name, process.env[name]]),
  );
  for (const name of Object.keys(previousEnvironment)) delete process.env[name];
  const fixture = globalRoutingFixture({ reachable: true, latencyMs: 12 });
  context.after(async () => {
    fixture.controller.store.setGlobalRouting({ enabled: false, profileId: null });
    await fixture.controller.applyGlobalRouting();
    fs.rmSync(fixture.userData, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const snapshot = await fixture.controller.applyGlobalRouting();

  assert.deepEqual(fixture.proxyCalls.slice(0, 2), [
    {
      name: "default",
      configuration: { mode: "direct" },
    },
    {
      name: "browser",
      configuration: {
        mode: "fixed_servers",
        proxyRules: "http://127.0.0.1:17891",
        proxyBypassRules: "localhost,127.0.0.1,::1",
      },
    },
  ]);
  for (const name of Object.keys(previousEnvironment)) {
    assert.equal(process.env[name], undefined, `${name} must not leak to local runtime children`);
  }
  const savedProfile = snapshot.proxyProfiles.find((candidate) => candidate.id === "global-proxy");
  assert.equal(savedProfile.latencyMs, 12);
  assert.equal(savedProfile.lastError, undefined);
});

test("obsolete unreachable ProxyBridge seed is disabled instead of breaking ChatGPT", async (context) => {
  const fixture = globalRoutingFixture(
    { reachable: false, error: "connect ECONNREFUSED 127.0.0.1:17891" },
    { profileId: "proxybridge-local-17891" },
  );
  context.after(() => fs.rmSync(fixture.userData, { recursive: true, force: true }));

  const snapshot = await fixture.controller.applyGlobalRouting();

  assert.deepEqual(fixture.proxyCalls.slice(-2), [
    { name: "default", configuration: { mode: "direct" } },
    { name: "browser", configuration: { mode: "direct" } },
  ]);
  assert.deepEqual(fixture.proxyCalls.slice(0, 2), [
    { name: "default", configuration: { mode: "direct" } },
    {
      name: "browser",
      configuration: {
        mode: "fixed_servers",
        proxyRules: "http://127.0.0.1:17891",
        proxyBypassRules: "localhost,127.0.0.1,::1",
      },
    },
  ]);
  assert.equal(snapshot.routing.globalEnabled, false);
  assert.equal(snapshot.routing.globalProfileId, null);
  const savedProfile = snapshot.proxyProfiles.find((candidate) => candidate.id === "proxybridge-local-17891");
  assert.match(savedProfile.lastError, /ECONNREFUSED/);
  assert.equal(savedProfile.latencyMs, undefined);
});

test("unreachable user proxy fails closed instead of silently bypassing it", async (context) => {
  const previousEnvironment = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].map((name) => [name, process.env[name]]),
  );
  const fixture = globalRoutingFixture({ reachable: false, error: "connect ECONNREFUSED proxy.test" });
  context.after(async () => {
    fixture.controller.store.setGlobalRouting({ enabled: false, profileId: null });
    await fixture.controller.applyGlobalRouting();
    fs.rmSync(fixture.userData, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  await assert.rejects(
    fixture.controller.applyGlobalRouting(),
    (error) => error?.code === "proxy_unreachable" && /direct fallback is disabled/.test(error.message),
  );

  assert.equal(fixture.proxyCalls.length, 2);
  assert.deepEqual(fixture.proxyCalls, [
    { name: "default", configuration: { mode: "direct" } },
    {
      name: "browser",
      configuration: {
        mode: "fixed_servers",
        proxyRules: "http://127.0.0.1:17891",
        proxyBypassRules: "localhost,127.0.0.1,::1",
      },
    },
  ]);
  assert.equal(fixture.controller.store.snapshot().routing.globalEnabled, true);
});

test("proxy setup waits for every target before verified direct rollback", async (context) => {
  const events = [];
  const fixture = globalRoutingFixture(
    { reachable: true, latencyMs: 5 },
    {
      setProxyImpl: async (name, configuration) => {
        if (configuration.mode === "direct") {
          events.push(`${name}:direct`);
          return;
        }
        events.push(`${name}:fixed-start`);
        if (name !== "browser") throw new Error("only the ChatGPT session may receive fixed proxy routing");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push(`${name}:fixed-finished`);
        throw new Error("ChatGPT session rejected proxy");
      },
    },
  );
  context.after(() => fs.rmSync(fixture.userData, { recursive: true, force: true }));

  await assert.rejects(
    fixture.controller.applyGlobalRouting(),
    (error) => error?.code === "proxy_configuration_rejected",
  );

  const fixedFinished = events.indexOf("browser:fixed-finished");
  const rollbackDefault = events.lastIndexOf("default:direct");
  const rollbackBrowser = events.lastIndexOf("browser:direct");
  assert.ok(fixedFinished >= 0, "the slower fixed-proxy operation must finish");
  assert.ok(rollbackDefault > fixedFinished, "direct rollback must wait for every fixed-proxy attempt");
  assert.ok(rollbackBrowser > fixedFinished, "browser rollback must wait for every fixed-proxy attempt");
});

test("serialized proxy applications leave the latest routing decision effective", async (context) => {
  let finishFirstProbe;
  let markFirstProbeStarted;
  const firstProbeStarted = new Promise((resolve) => { markFirstProbeStarted = resolve; });
  const firstProbeFinished = new Promise((resolve) => { finishFirstProbe = resolve; });
  let probeCount = 0;
  const fixture = globalRoutingFixture(async () => {
    probeCount += 1;
    if (probeCount === 1) {
      markFirstProbeStarted();
      await firstProbeFinished;
    }
    return { reachable: true, latencyMs: 1 };
  });
  context.after(() => fs.rmSync(fixture.userData, { recursive: true, force: true }));

  const enableOperation = fixture.controller.applyGlobalRouting();
  await firstProbeStarted;
  fixture.controller.store.setGlobalRouting({ enabled: false, profileId: null });
  const disableOperation = fixture.controller.applyGlobalRouting();
  finishFirstProbe();
  await Promise.all([enableOperation, disableOperation]);

  assert.deepEqual(fixture.proxyCalls.slice(-2), [
    { name: "default", configuration: { mode: "direct" } },
    { name: "browser", configuration: { mode: "direct" } },
  ]);
  assert.equal(fixture.controller.store.snapshot().routing.globalEnabled, false);
});

test("proxy enforcement is installed before reachability probing begins", async (context) => {
  let fixture;
  let proxyWasAppliedBeforeProbe = false;
  fixture = globalRoutingFixture(async () => {
    proxyWasAppliedBeforeProbe = fixture.proxyCalls.length === 2
      && fixture.proxyCalls[0].configuration.mode === "direct"
      && fixture.proxyCalls[1].configuration.mode === "fixed_servers";
    return { reachable: true, latencyMs: 1 };
  });
  context.after(async () => {
    fixture.controller.store.setGlobalRouting({ enabled: false, profileId: null });
    await fixture.controller.applyGlobalRouting();
    fs.rmSync(fixture.userData, { recursive: true, force: true });
  });

  await fixture.controller.applyGlobalRouting();

  assert.equal(proxyWasAppliedBeforeProbe, true);
});

test("proxy credentials are disclosed only to the selected endpoint and owned sessions", (context) => {
  const fixture = globalRoutingFixture({ reachable: true, latencyMs: 1 });
  context.after(() => fs.rmSync(fixture.userData, { recursive: true, force: true }));
  fixture.controller.store.saveProxyProfile({
    id: "global-proxy",
    name: "Authenticated proxy",
    enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17891 },
    scopes: ["all"],
    bypass: ["localhost"],
    username: "proxy-user",
    password: "proxy-password",
  });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  const receivedCredentials = [];
  const callback = (username, password) => receivedCredentials.push({ username, password });

  assert.equal(fixture.controller.handleProxyLogin(
    event,
    null,
    { isProxy: true, host: "127.0.0.1", port: 17891 },
    callback,
  ), false);
  assert.equal(fixture.controller.handleProxyLogin(
    event,
    { session: fixture.browserSession },
    { isProxy: true, host: "other.proxy.test", port: 17891 },
    callback,
  ), false);
  assert.equal(fixture.controller.handleProxyLogin(
    event,
    { session: {} },
    { isProxy: true, host: "127.0.0.1", port: 17891 },
    callback,
  ), false);
  assert.equal(fixture.controller.handleProxyLogin(
    event,
    { session: fixture.browserSession },
    { isProxy: true, host: "127.0.0.1", port: 17891 },
    callback,
  ), true);
  assert.equal(event.prevented, true);
  assert.deepEqual(receivedCredentials, [{ username: "proxy-user", password: "proxy-password" }]);
});

test("renderer and Electron IPC expose the Provider Hub and global proxy controls", () => {
  const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  const main = read("src/main.tsx");
  const integration = read("src/providers/ProviderHubIntegration.tsx");
  const types = read("src/types.ts");
  const preload = read("electron/preload.cjs");
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const wrapper = read("electron/main-with-provider.cjs");
  const styles = read("src/providers/provider-manager.css");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(types, /Surface[^;]+"providers"/s);
  assert.match(main, /ProviderHubIntegration/);
  assert.match(integration, /ProviderManagerSurface/);
  assert.match(integration, /archiveProviderAccount/);
  assert.match(integration, /archiveProxyProfile/);
  assert.match(preload, /providerSnapshot/);
  assert.match(preload, /saveProviderAccount/);
  assert.match(preload, /saveProxyProfile/);
  assert.match(preload, /setGlobalProxyRouting/);
  assert.match(bootstrap, /createProviderNetworkStore/);
  assert.match(bootstrap, /launcher:provider-snapshot/);
  assert.match(bootstrap, /launcher:proxy-global-routing/);
  assert.match(wrapper, /installProviderNetwork/);
  assert.equal(packageJson.main, "electron/main-with-provider.cjs");
  assert.match(styles, /\.provider-manager/);
});
