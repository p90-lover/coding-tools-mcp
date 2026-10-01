"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");
const { createAppsProviderServices } = require("../electron/apps-provider-services.cjs");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { createManagedExternalServicesController } = require("../electron/managed-external-services.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const readRepo = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const CPA_OPS = [
  "inspect", "start", "stop", "restart", "repair", "install",
  "health", "models", "chatCompletions", "managementHealth",
  "listProviders", "providers", "linkProvider", "unlinkProvider", "providerStatus",
];
function listenMock(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
    server.on("error", reject);
  });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function text(response, status, value, contentType = "text/html") {
  response.writeHead(status, { "content-type": contentType });
  response.end(value);
}

function temporaryDirectory(prefix) {
  const scratch = path.join(repoRoot, "aiTemp");
  fs.mkdirSync(scratch, { recursive: true });
  return fs.mkdtempSync(path.join(scratch, `${prefix}-`));
}

test("CPA exposes the full in-process ops table without an apps listen port", () => {
  const host = createCodingToolsAppsHost();
  const listed = host.list();
  const catalog = host.catalog();
  const cpa = listed.modules.find((entry) => entry.id === "cpa");
  assert.deepEqual(CPA_OPS.filter((name) => !cpa.operations.includes(name)), []);
  assert.equal(host.listenLoopback, undefined);
  assert.equal(host.transport, "in-process");
  const models = catalog.modules.find((entry) => entry.id === "cpa")
    .operations.find((entry) => entry.name === "models");
  assert.equal(models.readOnly, true);
  assert.match(models.description, /models/i);
  assert.doesNotMatch(readRepo("app-handler/host.cjs"), /createServer/);
  assert.doesNotMatch(readRepo("app-handler/host.cjs"), /listenLoopback/);
  assert.doesNotMatch(readRepo("app-handler/cpa/handlers.cjs"), /createServer|listenLoopback/);
  assert.match(readRepo("app-handler/README.md"), /provider accounts/);
});

test("CPA models/health/chatCompletions talk to a mocked loopback with bearer auth", async () => {
  const seen = [];
  const mock = await listenMock((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization || "",
    });
    if (request.url === "/v1/models") {
      json(response, 200, { data: [{ id: "claude-sonnet" }, { id: "gpt-4o-mini" }] });
      return;
    }
    if (request.url === "/v1/chat/completions") {
      json(response, 200, { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "pong" } }] });
      return;
    }
    if (request.url === "/management.html") {
      text(response, 200, "<html>cpa</html>");
      return;
    }
    if (request.url === "/v0/management/auth-files") {
      json(response, 200, {
        files: [{ name: "claude.json", provider: "claude", email: "user@example.com", status: "ok" }],
      });
      return;
    }
    json(response, 404, { error: "missing" });
  });

  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          headers: { Authorization: "Bearer proxy-secret" },
          managementHeaders: {
            Authorization: "Bearer management-secret",
            "X-Management-Key": "management-secret",
          },
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/v1/models",
        }),
        listProviders: async () => ({
          ok: true,
          accounts: [{
            id: "acct-1",
            providerId: "claude-oauth",
            label: "Claude",
            status: "connected",
            enabled: true,
            models: ["claude-sonnet"],
          }],
          summary: { total: 1, enabled: 1, connected: 1, disabled: 0, archived: 0 },
        }),
      },
    });

    const health = await host.call("cpa", "health");
    assert.equal(health.ok, true);
    assert.equal(health.result.reachable, true);
    assert.equal(health.result.modelCount, 2);

    const models = await host.call("cpa", "models");
    assert.equal(models.ok, true);
    assert.deepEqual(models.result.models, ["claude-sonnet", "gpt-4o-mini"]);
    assert.equal(models.result.source, "loopback");

    const chat = await host.call("cpa", "chatCompletions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(chat.ok, true);
    assert.equal(chat.result.json.choices[0].message.content, "pong");

    const management = await host.call("cpa", "managementHealth");
    assert.equal(management.result.reachable, true);
    assert.equal(management.result.authFileCount, 1);

    const serialized = JSON.stringify({ health, models, chat, management });
    assert.equal(serialized.includes("proxy-secret"), false);
    assert.equal(serialized.includes("management-secret"), false);
    assert.ok(seen.some((entry) => entry.authorization === "Bearer proxy-secret"));
    assert.ok(seen.some((entry) => entry.url === "/v0/management/auth-files"));
  } finally {
    await mock.close();
  }
});

test("CPA models surfaces an empty catalog when auth-dir is empty and accounts are archived", async () => {
  const mock = await listenMock((request, response) => {
    if (request.url === "/v1/models") {
      json(response, 200, { data: [] });
      return;
    }
    if (request.url === "/v0/management/auth-files") {
      json(response, 200, { files: [] });
      return;
    }
    json(response, 404, {});
  });

  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          headers: { Authorization: "Bearer proxy-secret" },
          managementHeaders: { Authorization: "Bearer management-secret" },
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/v1/models",
        }),
        listProviders: async () => ({
          ok: true,
          accounts: [{
            id: "acct-archived",
            providerId: "claude-oauth",
            label: "Archived Claude",
            status: "disabled",
            enabled: false,
            archivedAt: "2026-09-19T00:00:00.000Z",
            models: [],
          }],
          summary: { total: 1, enabled: 0, connected: 0, disabled: 0, archived: 1 },
          reason: "provider-network accounts are disabled or archived",
        }),
        explainEmptyModels: async () => ({
          reason: "provider-network accounts are disabled or archived",
          summary: { total: 1, enabled: 0, connected: 0, disabled: 0, archived: 1 },
        }),
        providerCatalog: async () => ({ models: [] }),
      },
    });

    const models = await host.call("cpa", "models");
    assert.equal(models.ok, false);
    assert.deepEqual(models.result.models, []);
    assert.match(models.result.reason, /disabled or archived|auth-dir is empty/i);

    const listed = await host.call("cpa", "listProviders");
    assert.equal(listed.result.summary.archived, 1);
    assert.equal(listed.result.summary.connected, 0);
    assert.match(listed.result.reason, /disabled or archived/);
    assert.equal(listed.result.summary.authFileCount, 0);
  } finally {
    await mock.close();
  }
});

test("CPA models returns linked provider catalog when loopback /v1/models is empty", async () => {
  const mock = await listenMock((request, response) => {
    if (request.url === "/v1/models") {
      json(response, 200, { data: [] });
      return;
    }
    json(response, 404, {});
  });

  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          headers: { Authorization: "Bearer proxy-secret" },
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/v1/models",
        }),
        providerCatalog: async () => ({ models: ["claude-sonnet", "gemini-pro"] }),
      },
    });
    const models = await host.call("cpa", "models");
    assert.equal(models.ok, true);
    assert.deepEqual(models.result.models, ["claude-sonnet", "gemini-pro"]);
    assert.equal(models.result.source, "provider-network");
  } finally {
    await mock.close();
  }
});

test("CPA linkProvider and unlinkProvider drive the in-process provider store without opening a window", async () => {
  const directory = temporaryDirectory("coding-tools-cpa-providers");
  const store = createProviderNetworkStore({
    filePath: path.join(directory, "provider-network.json"),
    keyPath: path.join(directory, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  const providerServices = createAppsProviderServices({
    providerNetworkReady: async () => ({
      store,
      openProviderLogin: async () => {
        throw new Error("login should not run in this test");
      },
      probeProviderAccount: async (accountId) => {
        return store.updateAccountConnection(accountId, {
          status: "connected",
          models: ["claude-sonnet"],
        });
      },
    }),
  });
  const host = createCodingToolsAppsHost({
    services: {
      listProviders: (input) => providerServices.listProviders(input),
      linkProvider: (input) => providerServices.linkProvider(input),
      unlinkProvider: (input) => providerServices.unlinkProvider(input),
      providerStatus: (input) => providerServices.providerStatus(input),
    },
  });

  const empty = await host.call("cpa", "listProviders");
  assert.equal(empty.result.summary.total, 0);

  const linked = await host.call("cpa", "linkProvider", {
    providerId: "claude-oauth",
    label: "Claude",
    auth: "oauth",
    enabled: true,
    probe: true,
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.result.linked, true);
  assert.equal(linked.result.accounts[0].status, "connected");
  assert.deepEqual(linked.result.accounts[0].models, ["claude-sonnet"]);
  assert.equal(JSON.stringify(linked).includes("secret"), false);

  const unlinked = await host.call("cpa", "unlinkProvider", { accountId: linked.result.accountId });
  assert.equal(unlinked.ok, true);
  assert.equal(unlinked.result.accounts[0].enabled, false);
  assert.ok(unlinked.result.accounts[0].archivedAt);
});

test("CPA models does not advertise cached catalogs when loopback auth fails", async () => {
  const mock = await listenMock((request, response) => {
    if (request.url === "/v1/models") {
      json(response, 401, { error: "invalid api key" });
      return;
    }
    json(response, 404, {});
  });
  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          headers: { Authorization: "Bearer proxy-secret" },
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/v1/models",
        }),
        providerCatalog: async () => ({ models: ["stale-claude"] }),
      },
    });
    const models = await host.call("cpa", "models");
    assert.equal(models.ok, false);
    assert.deepEqual(models.result.models, []);
    assert.equal(models.result.status, 401);
  } finally {
    await mock.close();
  }
});

test("CPA provider catalog fallback excludes disconnected accounts", async () => {
  const mock = await listenMock((request, response) => {
    json(response, 200, { data: [] });
  });
  try {
    const directory = temporaryDirectory("coding-tools-cpa-stale");
    const store = createProviderNetworkStore({
      filePath: path.join(directory, "provider-network.json"),
      keyPath: path.join(directory, "provider-network.key"),
      safeStorage: { isEncryptionAvailable: () => false },
    });
    store.saveAccount({
      providerId: "claude-oauth",
      label: "Stale Claude",
      auth: "oauth",
      status: "pending",
      enabled: true,
      models: ["claude-sonnet"],
      loginAdapterId: "cpa-claude",
      credentialSource: "cpa",
    });
    const providerServices = createAppsProviderServices({
      providerNetworkReady: async () => ({ store }),
    });
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/v1/models",
        }),
        providerCatalog: (id) => providerServices.providerCatalog(id),
        explainEmptyModels: (id, details) => providerServices.explainEmptyModels(id, details),
      },
    });
    const models = await host.call("cpa", "models");
    assert.equal(models.ok, false);
    assert.deepEqual(models.result.models, []);
  } finally {
    await mock.close();
  }
});

test("CPA managementHealth uses a bounded range GET and requires a working panel", async () => {
  const panelBody = "<html>" + "x".repeat(2 * 1024 * 1024) + "</html>";
  const panelRequests = [];
  let panelStatus = 200;
  const mock = await listenMock((request, response) => {
    if (request.url === "/management.html") {
      panelRequests.push({ method: request.method, range: request.headers.range });
      if (request.method === "HEAD" || panelStatus !== 200) {
        text(response, 404, "not found");
      } else if (request.headers.range === "bytes=0-0") {
        response.writeHead(206, {
          "content-type": "text/html",
          "content-length": "1",
          "content-range": `bytes 0-0/${Buffer.byteLength(panelBody)}`,
        });
        response.end(panelBody[0]);
      } else {
        text(response, 200, panelBody);
      }
      return;
    }
    if (request.url === "/v0/management/auth-files") {
      assert.equal(request.headers.authorization, "Bearer management-secret");
      json(response, 200, { files: [{ name: "fixture.json", status: "ok" }] });
      return;
    }
    json(response, 404, {});
  });
  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          managementHeaders: { Authorization: "Bearer management-secret" },
        }),
      },
    });
    const management = await host.call("cpa", "managementHealth");
    assert.equal(management.ok, true);
    assert.equal(management.result.reachable, true);
    assert.equal(management.result.status, 206);
    assert.equal(management.result.authFileCount, 1);
    assert.deepEqual(panelRequests, [{ method: "GET", range: "bytes=0-0" }]);
    const viaIpc = await invokeContract({
      invoke: (channel, payload) => {
        assert.equal(channel, "coding-tools:apps:call");
        return host.call(payload.moduleId, payload.operation, payload.arguments || {});
      },
    }, "apps.call", { moduleId: "cpa", operation: "managementHealth" });
    assert.equal(viaIpc.result.ok, true);
    assert.equal(Object.hasOwn(viaIpc.result, "reason"), false);

    panelStatus = 404;
    const missing = await host.call("cpa", "managementHealth");
    assert.equal(missing.ok, false);
    assert.equal(missing.result.reachable, true);
    assert.match(missing.result.reason, /management panel.*HTTP 404/);
  } finally {
    await mock.close();
  }
});

test("CPA managementHealth is not ok when the authenticated management API fails", async () => {
  const mock = await listenMock((request, response) => {
    if (request.url === "/management.html") {
      text(response, 200, "<html>cpa</html>");
      return;
    }
    if (request.url === "/v0/management/auth-files") {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    json(response, 404, {});
  });
  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          managementHeaders: { Authorization: "Bearer management-secret" },
        }),
      },
    });
    const management = await host.call("cpa", "managementHealth");
    assert.equal(management.ok, false);
    assert.equal(management.result.reachable, true);
    assert.match(management.result.reason, /HTTP 401|unavailable/i);
  } finally {
    await mock.close();
  }
});

test("desktop wiring keeps CPA handler auth in-process", () => {
  const main = fs.readFileSync(path.join(desktopRoot, "electron/main.cjs"), "utf8");
  const managed = fs.readFileSync(path.join(desktopRoot, "electron/managed-external-services.cjs"), "utf8");
  const original = fs.readFileSync(path.join(desktopRoot, "electron/original-ui.cjs"), "utf8");
  assert.match(main, /createAppsProviderServices/);
  assert.match(main, /loopbackRequest:/);
  assert.match(main, /linkProvider:/);
  assert.match(managed, /function loopbackRequest\(/);
  assert.match(original, /via: "codingTools\.apps"/);
  assert.doesNotMatch(original, /openOriginalControlCenter/);
});
