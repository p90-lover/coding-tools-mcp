"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { createAppsProviderServices } = require("../electron/apps-provider-services.cjs");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { createOriginalUiController } = require("../electron/original-ui.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const readDesktop = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function listenNothing() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(() => {
      throw new Error("CPA panel must not hit loopback HTTP");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(`http://127.0.0.1:${address.port}/`);
      });
    });
    server.on("error", reject);
  });
}

test("CPA inspect/listProviders/models/managementHealth work with no :8317 listener", async () => {
  const directory = temporaryDirectory("coding-tools-cpa-offline-panel");
  const store = createProviderNetworkStore({
    filePath: path.join(directory, "provider-network.json"),
    keyPath: path.join(directory, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  store.saveAccount({
    providerId: "claude-oauth",
    label: "Claude",
    auth: "oauth",
    enabled: true,
    loginAdapterId: "cpa-claude",
    credentialSource: "cpa",
  });
  const connected = store.updateAccountConnection(store.snapshot().accounts[0].id, {
    status: "connected",
    models: ["claude-sonnet"],
  });
  const providerServices = createAppsProviderServices({
    providerNetworkReady: async () => ({
      store,
      openProviderLogin: async () => ({ opened: false, snapshot: connected }),
      probeProviderAccount: async () => connected,
    }),
  });
  const closedOrigin = await listenNothing();
  const host = createCodingToolsAppsHost({
    services: {
      inspect: async () => {
        throw new Error("CPA inspect must not use the managed child");
      },
      loopbackRequest: () => ({
        origin: closedOrigin,
        headers: { Authorization: "Bearer proxy-secret" },
        managementHeaders: { Authorization: "Bearer management-secret" },
        modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions",
        healthPath: "/v1/models",
      }),
      listProviders: (input) => providerServices.listProviders(input),
      linkProvider: (input) => providerServices.linkProvider(input),
      unlinkProvider: (input) => providerServices.unlinkProvider(input),
      providerStatus: (input) => providerServices.providerStatus(input),
      providerCatalog: (id) => providerServices.providerCatalog(id),
      explainEmptyModels: (id, details) => providerServices.explainEmptyModels(id, details),
    },
  });

  const inspected = await host.invoke({ handle: "cpa", operation: "inspect" });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.status, "ready");
  assert.equal(inspected.result.listening, false);
  assert.equal(inspected.result.transport, "in-process");
  assert.equal(inspected.result.processOptional, true);

  const listed = await host.call("cpa", "listProviders");
  assert.equal(listed.ok, true);
  assert.equal(listed.result.summary.connected, 1);
  assert.equal(listed.result.accounts[0].label, "Claude");

  const models = await host.invoke({ handle: "cpa", operation: "models" });
  assert.equal(models.ok, true);
  assert.deepEqual(models.result.models, ["claude-sonnet"]);
  assert.equal(models.result.source, "provider-network");

  const management = await host.call("cpa", "managementHealth");
  assert.equal(management.ok, true);
  assert.equal(management.result.hosted, true);
  assert.equal(management.result.reachable, true);
  assert.equal(management.result.processReachable, false);
  assert.equal(management.result.authFileCount, 0);

  const status = await host.invoke({ handle: "cpa", operation: "providerStatus" });
  assert.equal(status.ok, true);
  assert.equal(JSON.stringify({ inspected, listed, models, management, status }).includes("proxy-secret"), false);
});

test("CPA original-ui-open does not Start or iframe :8317 when the process is stopped", async () => {
  const calls = [];
  const controller = createOriginalUiController({
    longRun: false,
    sleep: async () => {},
    externalServices: {
      snapshot: () => ({
        services: [{
          id: "cpa",
          endpoint: "http://127.0.0.1:8317/",
          status: "offline",
          pid: null,
          home: "/tmp/cpa-home",
          managedInstall: { state: "installed" },
        }],
      }),
      inspect: async () => {},
      start: async (id) => { calls.push(["start", id]); },
      installManagedComponent: async (id) => { calls.push(["install", id]); },
    },
  });
  const opened = await controller.openEmbedded("cpa", "ai-providers");
  assert.deepEqual(calls, []);
  assert.equal(opened.visual, "in-process-panel");
  assert.equal(opened.url, "");
  assert.equal(opened.embedded, true);
  assert.equal(opened.originalWindow, false);
  assert.equal(opened.api.via, "codingTools.apps");
  controller.dispose();
});

test("desktop CPA panel and Settings call codingTools.apps instead of management.html", () => {
  const surface = readDesktop("src/features/OriginalUiSurface.tsx");
  const panel = readDesktop("src/features/CpaOriginalPanel.tsx");
  const app = readDesktop("src/App.tsx");
  const original = readDesktop("electron/original-ui.cjs");
  const handlers = readRepo("app-handler/cpa/handlers.cjs");
  const longRun = readDesktop("electron/cpa-codex-long-run.cjs");

  assert.match(panel, /handle: "cpa"/);
  assert.match(panel, /listProviders/);
  assert.match(panel, /managementHealth/);
  assert.match(panel, /providerStatus/);
  assert.doesNotMatch(panel, /127\.0\.0\.1:8317/);
  assert.doesNotMatch(panel, /management\.html/);
  assert.match(surface, /CpaOriginalPanel/);
  assert.match(surface, /Start proxy \(optional\)/);
  assert.match(app, /CpaOriginalPanel compact/);
  assert.match(app, /codingTools\.apps/);
  assert.match(original, /visual: "in-process-panel"/);
  assert.match(original, /if \(toolId === "cpa"\)/);
  assert.doesNotMatch(handlers, /pathname: "\/management\.html"/);
  assert.match(handlers, /Does not probe :8317/);
  assert.match(longRun, /if \(id === "cpa"\)/);
});
