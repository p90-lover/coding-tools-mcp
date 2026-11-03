"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore, proxyUrl } = require("../electron/provider-network.cjs");
const { createManagedExternalServicesController, resolveCpaProxyRoute, resolveManagedProxyEnvironment } = require("../electron/managed-external-services.cjs");
const { runtimeConfiguration, installBundledCommandCodePlugin } = require("../electron/cpa-managed.cjs");
const { redactText } = require("../electron/logging.cjs");

test("CPA can use its own proxy profile without changing other components", async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/cpa-scoped-proxy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = createProviderNetworkStore({
    filePath: path.join(root, "providers", "provider-network.json"),
    keyPath: path.join(root, "providers", "provider-network.key"), safeStorage,
  });
  store.saveProxyProfile({ id: "legacy", name: "Global route", enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17891 }, scopes: ["all"] });
  store.saveProxyProfile({ id: "cpa-only", name: "CPA-only proxy", enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17894 },
    username: "ct", password: "cpa-test-key", scopes: ["all"] });
  store.setGlobalRouting({ enabled: true, profileId: "legacy" });
  const dataRoot = path.join(root, "integrations");
  await store.saved();
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "legacy");
  store.setProviderPolicy({ providerId: "cpa", mode: "profile", profileId: "cpa-only" });
  await store.saved();
  const environment = resolveManagedProxyEnvironment("cpa", dataRoot, safeStorage);
  const route = new URL(environment.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL);
  assert.equal(route.port, "17894");
  assert.equal(route.username, "ct");
  assert.equal(route.password, "cpa-test-key");
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "cpa-only");
  assert.equal(new URL(resolveManagedProxyEnvironment("antigravity-cli", dataRoot, safeStorage).HTTPS_PROXY).port, "17891");
  assert.equal(store.snapshot().routing.globalProfileId, "legacy");
  store.setGlobalRouting({ enabled: false, profileId: null });
  await store.saved();
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "cpa-only");
  store.setProviderPolicy({ providerId: "cpa", mode: "inherit" });
  await store.saved();
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).url, "");
  store.setGlobalRouting({ enabled: true, profileId: "legacy" });
  await store.saved();
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "legacy");
  store.setProviderPolicy({ providerId: "cpa", mode: "direct" });
  await store.saved();
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).url, "");
  assert.throws(() => resolveManagedProxyEnvironment("cpa", dataRoot, safeStorage), /Select a .*network proxy/);
});

test("CPA config follows the selected authenticated global profile", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/cpa-outbound-proxy-"));
  const providers = path.join(root, "providers");
  fs.mkdirSync(providers, { recursive: true });
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = createProviderNetworkStore({
    filePath: path.join(providers, "provider-network.json"),
    keyPath: path.join(providers, "provider-network.key"), safeStorage,
  });
  store.saveProxyProfile({ id: "owned", name: "Existing route", enabled: true,
    endpoint: { protocol: "http", host: "proxy.example.test", port: 10000 },
    username: "account", password: "p@ss:word", scopes: ["all"] });
  store.setGlobalRouting({ enabled: true, profileId: "owned" });

  await store.saved();
  const route = resolveCpaProxyRoute(path.join(root, "integrations"), safeStorage);
  assert.equal(route.profileId, "owned");
  const environment = resolveManagedProxyEnvironment("cpa", path.join(root, "integrations"), safeStorage);
  assert.equal(environment.HTTPS_PROXY, route.url);
  assert.equal(environment.https_proxy, route.url);
  assert.equal(environment.NODE_USE_ENV_PROXY, "1");
  assert.match(environment.NO_PROXY, /127\.0\.0\.1/);
  assert.match(environment.NO_PROXY, /192\.168\.0\.0\/16/);
  assert.doesNotMatch(environment.NO_PROXY, /(?:fc00|fe80)::/);
  assert.doesNotMatch(environment.NO_PROXY, /example\.test/);
  assert.equal(environment.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL, route.url);
  for (const componentId of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
    assert.deepEqual(resolveManagedProxyEnvironment(componentId, path.join(root, "integrations"), safeStorage), {});
  }
  assert.equal(new URL(route.url).password, "p%40ss%3Aword");
  assert.equal(proxyUrl(store.activeProxy("owned")), "http://proxy.example.test:10000");
  const config = runtimeConfiguration(path.join(root, "cpa"), "m".repeat(36), "k".repeat(36), route.url);
  assert.match(config, /^proxy-url: "http:\/\/account:p%40ss%3Aword@proxy\.example\.test:10000\/"$/m);
  const pluginDirectory = path.join(root, "cpa", "plugins");
  assert.match(config, /^plugins:\r?$/m);
  assert.match(config, /^  enabled: true$/m);
  assert.ok(config.includes(`  dir: ${JSON.stringify(pluginDirectory)}`));
  assert.equal(fs.statSync(pluginDirectory).isDirectory(), true);
  assert.match(config, /^    commandcode-go:$/m);
  assert.match(config, /^    auth-commandcode:$/m);
  // CPA Helper keeps its data under CPA's state, never in CPA's working directory.
  assert.match(config, /^    cpa-helper:$/m);
  assert.ok(config.includes(`      data_dir: ${JSON.stringify(path.join(root, "cpa", "cpa-helper-data"))}`));
  assert.match(config, /^      keeper_enabled: false$/m);
  // CPA skips a plugin that has no configs entry, so the Grok provider must be listed.
  assert.match(config, /^    grok-login-provider:\r?\n      enabled: true$/m);
  if (process.platform === "win32" && process.arch === "x64") {
    const platformDir = path.join(pluginDirectory, "windows", "amd64");
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(path.join(platformDir, "commandcode-go-v0.9.0.dll"), "old plugin");
    fs.writeFileSync(path.join(platformDir, "auth-commandcode-v0.0.1.dll"), "old plugin");
    const installed = installBundledCommandCodePlugin(path.join(root, "cpa"));
    // The Go plugins as built with Go 1.26.10/1.27.3 (CVE-2026-111943); cpa-helper is Rust and unchanged.
    // The Cline Pass switcher is codingtools.10 (#650: a spent window is a 429).
    assert.deepEqual(installed.map((file) => fs.statSync(file).size), [7_893_504, 7_707_648, 14_867_968, 813_568, 24_951_296, 3_346_944]);
    assert.equal(fs.existsSync(path.join(platformDir, "commandcode-go-v0.9.0.dll")), false);
    assert.equal(fs.existsSync(path.join(platformDir, "auth-commandcode-v0.0.1.dll")), false);
    assert.equal(fs.readdirSync(path.join(root, "cpa", "Trash", "plugins")).length, 2);
    assert.deepEqual(installBundledCommandCodePlugin(path.join(root, "cpa")), installed);
  }
  assert.doesNotMatch(redactText(`Proxy failed: ${route.url}`), /account|p%40ss/);

  const controller = createManagedExternalServicesController({
    dataRoot: path.join(root, "integrations"), safeStorage,
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    env: {}, resolveRuntimeExecutable: () => process.execPath,
  });
  const cpa = controller.snapshot().services.find((service) => service.id === "cpa");
  assert.equal(cpa.outboundProxy.profileId, "owned");
  assert.equal(cpa.outboundProxy.configMatches, false);
  assert.doesNotMatch(JSON.stringify(cpa), /p%40ss|account@/);
  controller.dispose();

  store.setGlobalRouting({ enabled: false, profileId: null });
  await store.saved();
  const direct = resolveCpaProxyRoute(path.join(root, "integrations"), safeStorage);
  assert.equal(direct.url, "");
  assert.throws(() => resolveManagedProxyEnvironment("cpa", path.join(root, "integrations"), safeStorage), /Select a network proxy/);
  for (const componentId of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
    assert.deepEqual(resolveManagedProxyEnvironment(componentId, path.join(root, "integrations"), safeStorage), {});
  }
  assert.doesNotMatch(runtimeConfiguration(path.join(root, "cpa"), "m".repeat(36), "k".repeat(36), direct.url), /^proxy-url:/m);

  const savedFile = path.join(providers, "provider-network.json");
  const broken = JSON.parse(fs.readFileSync(savedFile, "utf8"));
  broken.routing = { ...broken.routing, globalEnabled: true, globalProfileId: "owned" };
  delete broken.secrets.proxies.owned;
  fs.writeFileSync(savedFile, `${JSON.stringify(broken)}\n`);
  assert.throws(() => resolveCpaProxyRoute(path.join(root, "integrations"), safeStorage), /saved sign-in, so CPA didn't start/);
});

// Each snapshot read the proxy settings synchronously on main, up to 12.8 s on the busy disk (0.8.48).
test("a services snapshot reuses the proxy route until the saved settings change", async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/cpa-route-cache-"));
  const providers = path.join(root, "providers");
  fs.mkdirSync(providers, { recursive: true });
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = createProviderNetworkStore({
    filePath: path.join(providers, "provider-network.json"),
    keyPath: path.join(providers, "provider-network.key"), safeStorage,
  });
  store.saveProxyProfile({ id: "owned", name: "Route", enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17895 }, scopes: ["all"] });
  store.setGlobalRouting({ enabled: true, profileId: "owned" });
  const published = [];
  await store.saved();
  const controller = createManagedExternalServicesController({
    dataRoot: path.join(root, "integrations"), safeStorage,
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    env: {}, resolveRuntimeExecutable: () => process.execPath,
    publish: (snapshot) => published.push(snapshot),
  });
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).endsWith("provider-network.json")) reads += 1;
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; controller.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const cpaOf = (snapshot) => snapshot.services.find((service) => service.id === "cpa");

  assert.equal(cpaOf(controller.snapshot()).outboundProxy.profileId, "owned");
  const afterFirst = reads;
  assert.ok(afterFirst > 0);
  for (let index = 0; index < 5; index += 1) assert.equal(cpaOf(controller.snapshot()).outboundProxy.profileId, "owned");
  assert.equal(reads, afterFirst, "later snapshots don't read the saved proxy settings again");
  // A route resolved outside a snapshot (a start) is always read afresh.
  assert.equal(resolveCpaProxyRoute(path.join(root, "integrations"), safeStorage).profileId, "owned");
  assert.ok(reads > afterFirst);

  // Changing the route is seen through the folder's watch, which publishes a fresh snapshot.
  published.length = 0;
  store.setGlobalRouting({ enabled: false, profileId: null });
  const deadline = Date.now() + 5_000;
  while (!published.some((snapshot) => cpaOf(snapshot).outboundProxy.profileId === null) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(published.length > 0, "the change published a snapshot");
  assert.equal(cpaOf(controller.snapshot()).outboundProxy.profileId, null);
});

test("a services snapshot reads CPA's config once, and again only after CPA rewrites it", async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/cpa-config-cache-"));
  const cpaState = path.join(root, "integrations", "state", "cpa");
  fs.mkdirSync(path.join(cpaState, "plugin-data"), { recursive: true });
  fs.writeFileSync(path.join(cpaState, "config.yaml"), "requests:\n  proxy-url: \"\"\n");
  const safeStorage = { isEncryptionAvailable: () => false };
  const published = [];
  const controller = createManagedExternalServicesController({
    dataRoot: path.join(root, "integrations"), safeStorage,
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    env: {}, resolveRuntimeExecutable: () => process.execPath,
    publish: (snapshot) => published.push(snapshot),
  });
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...rest) {
    if (path.basename(String(file)) === "config.yaml") reads += 1;
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; controller.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  controller.snapshot();
  assert.equal(reads, 1);
  // The folder is watched from a worker. Once the watch is in place it reports that something may
  // have changed (a write before then would otherwise be missed), so the config is read once more.
  await settle();
  controller.snapshot();
  const watched = reads;
  assert.ok(watched <= 2, `read ${watched} times before the watch settled`);
  for (let index = 0; index < 5; index += 1) controller.snapshot();
  assert.equal(reads, watched, "later snapshots reuse it");

  // CPA's own data in its subfolders changes often; that isn't its config.
  published.length = 0;
  fs.writeFileSync(path.join(cpaState, "plugin-data", "state.json"), "{}");
  fs.writeFileSync(path.join(cpaState, "notes.txt"), "x");
  await settle();
  controller.snapshot();
  assert.equal(reads, watched, "other files leave the cached config alone");
  assert.equal(published.length, 0);

  fs.writeFileSync(path.join(cpaState, "config.yaml"), "requests:\n  proxy-url: \"http://127.0.0.1:1/\"\n");
  const deadline = Date.now() + 5_000;
  while (!published.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(published.length > 0, "a rewritten config publishes a snapshot");
  assert.equal(reads, watched + 1, "and is read again");
});

test("the programs the app starts get a signed-in proxy's sign-in; Chromium gets the bare route", async (t) => {
  const { createProviderNetworkController } = require("../electron/provider-network.cjs");
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/global-env-proxy-"));
  const saved = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const applied = [];
  const target = { setProxy: async (config) => { applied.push(config); } };
  const controller = createProviderNetworkController({
    app: {}, browserPartition: "persist:env-proxy-test", getBrowserHost: () => null,
    logger: { info() {}, warn() {} }, safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: target, fromPartition: () => target }, shell: {}, userData: root,
    fetchImpl: async () => { throw new Error("no network in this test"); },
  });
  controller.store.saveProxyProfile({ id: "decodo", name: "HTTP decodo", enabled: true,
    endpoint: { protocol: "http", host: "proxy.example.test", port: 10000 },
    username: "account", password: "p@ss:word", scopes: ["all"] });
  controller.store.setGlobalRouting({ enabled: true, profileId: "decodo" });
  // App start sets the variables before anything awaits, so programs main starts next inherit them.
  controller.applyGlobalEnvironment();
  assert.equal(new URL(process.env.HTTPS_PROXY).host, "proxy.example.test:10000");
  assert.equal(applied.length, 0);
  // Node programs follow the variables only with this set; loopback stays direct even when the
  // profile's own bypass list leaves it out.
  assert.equal(process.env.NODE_USE_ENV_PROXY, "1");
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.ok(process.env.NO_PROXY.split(",").includes(host), host);
  await controller.applyGlobalRouting();

  // Without the sign-in every agent, curl and git call through this proxy was refused with 407.
  const environment = new URL(process.env.HTTPS_PROXY);
  assert.equal(environment.host, "proxy.example.test:10000");
  assert.equal(decodeURIComponent(environment.username), "account");
  assert.equal(decodeURIComponent(environment.password), "p@ss:word");
  assert.equal(process.env.HTTP_PROXY, process.env.HTTPS_PROXY);
  assert.equal(process.env.ALL_PROXY, process.env.HTTPS_PROXY);
  assert.deepEqual(applied.map((config) => config.proxyRules), ["http://proxy.example.test:10000"]);

  controller.store.setGlobalRouting({ enabled: false, profileId: null });
  await controller.applyGlobalRouting();
  assert.equal(process.env.HTTPS_PROXY, undefined);
  assert.equal(process.env.NODE_USE_ENV_PROXY, undefined);
});
