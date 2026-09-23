"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore, proxyUrl } = require("../electron/provider-network.cjs");
const { createManagedExternalServicesController, resolveCpaProxyRoute } = require("../electron/managed-external-services.cjs");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");
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
  assert.equal(new URL(route.url).password, "p%40ss%3Aword");
  assert.equal(proxyUrl(store.activeProxy("owned")), "http://proxy.example.test:10000");
  const config = runtimeConfiguration(path.join(root, "cpa"), "m".repeat(36), "k".repeat(36), route.url);
  assert.match(config, /^proxy-url: "http:\/\/account:p%40ss%3Aword@proxy\.example\.test:10000\/"$/m);
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
  assert.doesNotMatch(runtimeConfiguration(path.join(root, "cpa"), "m".repeat(36), "k".repeat(36), direct.url), /^proxy-url:/m);

  const savedFile = path.join(providers, "provider-network.json");
  const broken = JSON.parse(fs.readFileSync(savedFile, "utf8"));
  broken.routing = { ...broken.routing, globalEnabled: true, globalProfileId: "owned" };
  delete broken.secrets.proxies.owned;
  fs.writeFileSync(savedFile, `${JSON.stringify(broken)}\n`);
  assert.throws(() => resolveCpaProxyRoute(path.join(root, "integrations"), safeStorage), /authentication is unavailable/);
});
