"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore, proxyUrl } = require("../electron/provider-network.cjs");
const { createManagedExternalServicesController, resolveCpaProxyRoute, resolveManagedProxyEnvironment } = require("../electron/managed-external-services.cjs");
const { runtimeConfiguration, installBundledCommandCodePlugin } = require("../electron/cpa-managed.cjs");
const { redactText } = require("../electron/logging.cjs");

test("CPA can use its own proxy profile without changing other components", (t) => {
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
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "legacy");
  store.setProviderPolicy({ providerId: "cpa", mode: "profile", profileId: "cpa-only" });
  const environment = resolveManagedProxyEnvironment("cpa", dataRoot, safeStorage);
  const route = new URL(environment.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL);
  assert.equal(route.port, "17894");
  assert.equal(route.username, "ct");
  assert.equal(route.password, "cpa-test-key");
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "cpa-only");
  assert.equal(new URL(resolveManagedProxyEnvironment("antigravity-cli", dataRoot, safeStorage).HTTPS_PROXY).port, "17891");
  assert.equal(store.snapshot().routing.globalProfileId, "legacy");
  store.setGlobalRouting({ enabled: false, profileId: null });
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "cpa-only");
  store.setProviderPolicy({ providerId: "cpa", mode: "inherit" });
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).url, "");
  store.setGlobalRouting({ enabled: true, profileId: "legacy" });
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).profileId, "legacy");
  store.setProviderPolicy({ providerId: "cpa", mode: "direct" });
  assert.equal(resolveCpaProxyRoute(dataRoot, safeStorage).url, "");
  assert.throws(() => resolveManagedProxyEnvironment("cpa", dataRoot, safeStorage), /Select a .*network proxy/);
});

test("CPA config follows the selected authenticated global profile", () => {
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
    assert.deepEqual(installed.map((file) => fs.statSync(file).size), [7_895_552, 7_707_648, 14_867_968, 813_568, 24_951_296, 3_346_944]);
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
