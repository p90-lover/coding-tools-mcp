"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore, proxyUrl } = require("../electron/provider-network.cjs");
const { createManagedExternalServicesController, resolveCpaProxyRoute, resolveManagedProxyEnvironment } = require("../electron/managed-external-services.cjs");
const { runtimeConfiguration, installBundledCommandCodePlugin } = require("../electron/cpa-managed.cjs");
const { redactText } = require("../electron/logging.cjs");

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
  for (const componentId of ["cpa", "paseo", "codex-router", "anneal"]) {
    const environment = resolveManagedProxyEnvironment(componentId, path.join(root, "integrations"), safeStorage);
    assert.equal(environment.HTTPS_PROXY, route.url);
    assert.equal(environment.https_proxy, route.url);
    assert.equal(environment.NODE_USE_ENV_PROXY, "1");
    assert.match(environment.NO_PROXY, /127\.0\.0\.1/);
    assert.match(environment.NO_PROXY, /192\.168\.0\.0\/16/);
    assert.doesNotMatch(environment.NO_PROXY, /(?:fc00|fe80)::/);
    assert.doesNotMatch(environment.NO_PROXY, /example\.test/);
  }
  assert.equal(resolveManagedProxyEnvironment("cpa", path.join(root, "integrations"), safeStorage).CODING_TOOLS_CPA_OUTBOUND_PROXY_URL, route.url);
  assert.equal(resolveManagedProxyEnvironment("paseo", path.join(root, "integrations"), safeStorage).PASEO_RELAY_ENABLED, "false");
  assert.equal(resolveManagedProxyEnvironment("codex-router", path.join(root, "integrations"), safeStorage).CODEX_ROUTER_HOST, "127.0.0.1");
  assert.equal(resolveManagedProxyEnvironment("anneal", path.join(root, "integrations"), safeStorage).RUNNER_HTTP_PROXY, route.url);
  assert.deepEqual(resolveManagedProxyEnvironment("commandcode-proxy", path.join(root, "integrations"), safeStorage), {});
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
  if (process.platform === "win32" && process.arch === "x64") {
    const platformDir = path.join(pluginDirectory, "windows", "amd64");
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(path.join(platformDir, "commandcode-go-v0.9.0.dll"), "old plugin");
    const installed = installBundledCommandCodePlugin(path.join(root, "cpa"));
    assert.equal(fs.statSync(installed).size, 12_664_320);
    assert.equal(fs.existsSync(path.join(platformDir, "commandcode-go-v0.9.0.dll")), false);
    assert.ok(fs.readdirSync(path.join(root, "cpa", "Trash", "plugins")).length > 0);
    assert.equal(installBundledCommandCodePlugin(path.join(root, "cpa")), installed);
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
  assert.throws(() => resolveManagedProxyEnvironment("paseo", path.join(root, "integrations"), safeStorage), /Select a global network proxy/);
  assert.doesNotMatch(runtimeConfiguration(path.join(root, "cpa"), "m".repeat(36), "k".repeat(36), direct.url), /^proxy-url:/m);

  const savedFile = path.join(providers, "provider-network.json");
  const broken = JSON.parse(fs.readFileSync(savedFile, "utf8"));
  broken.routing = { ...broken.routing, globalEnabled: true, globalProfileId: "owned" };
  delete broken.secrets.proxies.owned;
  fs.writeFileSync(savedFile, `${JSON.stringify(broken)}\n`);
  assert.throws(() => resolveCpaProxyRoute(path.join(root, "integrations"), safeStorage), /authentication is unavailable/);
});
