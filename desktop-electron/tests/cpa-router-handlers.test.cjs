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

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const readRepo = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const CPA_OPS = [
  "inspect", "start", "stop", "restart", "repair", "install",
  "health", "models", "chatCompletions", "managementHealth",
  "listProviders", "providers", "linkProvider", "unlinkProvider", "providerStatus",
];
const ROUTER_OPS = [
  "inspect", "start", "stop", "restart", "repair", "install",
  "health", "models", "chatCompletions", "sync",
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test("CPA and Codex Router expose the full in-process ops table without an apps listen port", () => {
  const host = createCodingToolsAppsHost();
  const listed = host.list();
  const catalog = host.catalog();
  const cpa = listed.modules.find((entry) => entry.id === "cpa");
  const router = listed.modules.find((entry) => entry.id === "codex-router");
  assert.deepEqual(CPA_OPS.filter((name) => !cpa.operations.includes(name)), []);
  assert.deepEqual(ROUTER_OPS.filter((name) => !router.operations.includes(name)), []);
  assert.equal(host.listenLoopback, undefined);
  assert.equal(host.transport, "in-process");
  const models = catalog.modules.find((entry) => entry.id === "cpa")
    .operations.find((entry) => entry.name === "models");
  assert.equal(models.readOnly, true);
  assert.match(models.description, /models/i);
  assert.doesNotMatch(readRepo("app-handler/host.cjs"), /createServer/);
  assert.doesNotMatch(readRepo("app-handler/host.cjs"), /listenLoopback/);
  assert.doesNotMatch(readRepo("app-handler/cpa/handlers.cjs"), /createServer|listenLoopback/);
  assert.doesNotMatch(readRepo("app-handler/codex-router/handlers.cjs"), /createServer|listenLoopback/);
  assert.match(readRepo("app-handler/README.md"), /listProviders/);
  assert.match(readRepo("app-handler/README.md"), /linkProvider/);
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

test("Codex Router models/sync/chatCompletions use the caller-secret path and never echo it", async () => {
  const callerKey = "router-caller-secret-value-32chars!!";
  const seen = [];
  const mock = await listenMock((request, response) => {
    seen.push({ method: request.method, url: request.url });
    const prefix = `/_codex-router/${encodeURIComponent(callerKey)}`;
    if (request.url === `${prefix}/v1/models`) {
      json(response, 200, { data: [{ id: "gpt-4o-mini" }, { id: "o3-mini" }] });
      return;
    }
    if (request.url === `${prefix}/v1/chat/completions`) {
      json(response, 200, { id: "chatcmpl-router", choices: [{ message: { content: "routed" } }] });
      return;
    }
    json(response, 401, { error: "missing caller key" });
  });

  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          headers: {},
          modelsPath: `/_codex-router/${encodeURIComponent(callerKey)}/v1/models`,
          chatPath: `/_codex-router/${encodeURIComponent(callerKey)}/v1/chat/completions`,
          healthPath: `/_codex-router/${encodeURIComponent(callerKey)}/v1/models`,
        }),
        syncCodexRouter: async () => ({
          ok: true,
          args: ["router", "integrate", "--apply"],
          stdout: "synced models",
          stderr: "",
        }),
      },
    });

    const synced = await host.invoke({ handle: "codex-router", operation: "sync" });
    assert.equal(synced.ok, true);
    assert.equal(synced.result.ok, true);
    assert.equal(synced.result.stdout, "synced models");

    const models = await host.call("codex-router", "models");
    assert.equal(models.ok, true);
    assert.deepEqual(models.result.models, ["gpt-4o-mini", "o3-mini"]);

    const health = await host.call("codex-router", "health");
    assert.equal(health.result.reachable, true);
    assert.equal(health.result.modelCount, 2);

    const chat = await host.call("codex-router", "chatCompletions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(chat.result.json.choices[0].message.content, "routed");

    const payload = JSON.stringify({ synced, models, health, chat });
    assert.equal(payload.includes(callerKey), false);
    assert.ok(seen.some((entry) => entry.url.includes("/_codex-router/")));
  } finally {
    await mock.close();
  }
});

test("Codex Router models reports a missing caller secret instead of hanging on an unauthenticated probe", async () => {
  const seen = [];
  const mock = await listenMock((request, response) => {
    seen.push(request.url);
    json(response, 200, { data: [{ id: "should-not-be-used" }] });
  });
  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          headers: {},
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/",
          credentialReason: "Codex Router caller secret is not configured",
        }),
      },
    });
    const models = await host.call("codex-router", "models");
    const chat = await host.call("codex-router", "chatCompletions", { model: "x", messages: [] });
    assert.equal(models.ok, false);
    assert.deepEqual(models.result.models, []);
    assert.match(models.result.reason, /caller secret is not configured/);
    assert.equal(chat.ok, false);
    assert.match(chat.result.reason, /caller secret is not configured/);
    assert.deepEqual(seen, []);
  } finally {
    await mock.close();
  }
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

test("Codex Router models stay empty until sync even if provider-network has cached models", async () => {
  const mock = await listenMock((request, response) => {
    json(response, 200, { data: [] });
  });
  try {
    const directory = temporaryDirectory("coding-tools-router-catalog");
    const store = createProviderNetworkStore({
      filePath: path.join(directory, "provider-network.json"),
      keyPath: path.join(directory, "provider-network.key"),
      safeStorage: { isEncryptionAvailable: () => false },
    });
    store.saveAccount({
      providerId: "claude-oauth",
      label: "Claude",
      auth: "oauth",
      status: "connected",
      enabled: true,
      models: ["claude-sonnet"],
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
    const models = await host.call("codex-router", "models");
    assert.equal(models.ok, false);
    assert.deepEqual(models.result.models, []);
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

test("Codex Router chatCompletions redacts caller keys inside JSON error payloads", async () => {
  const callerKey = "router-caller-secret-value-32chars!!";
  const prefix = `/_codex-router/${encodeURIComponent(callerKey)}`;
  const mock = await listenMock((request, response) => {
    json(response, 500, {
      error: { message: `upstream failed at ${prefix}/v1/chat/completions` },
    });
  });
  try {
    const host = createCodingToolsAppsHost({
      services: {
        loopbackRequest: () => ({
          origin: mock.origin,
          modelsPath: `${prefix}/v1/models`,
          chatPath: `${prefix}/v1/chat/completions`,
          healthPath: `${prefix}/v1/models`,
        }),
      },
    });
    const chat = await host.call("codex-router", "chatCompletions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(chat.ok, false);
    const payload = JSON.stringify(chat);
    assert.equal(payload.includes(callerKey), false);
    assert.match(chat.result.json.error.message, /_codex-router\/\[REDACTED\]/);
  } finally {
    await mock.close();
  }
});

test("desktop wiring keeps CPA/Router handler auth in-process", () => {
  const main = fs.readFileSync(path.join(desktopRoot, "electron/main.cjs"), "utf8");
  const managed = fs.readFileSync(path.join(desktopRoot, "electron/managed-external-services.cjs"), "utf8");
  const original = fs.readFileSync(path.join(desktopRoot, "electron/original-ui.cjs"), "utf8");
  assert.match(main, /createAppsProviderServices/);
  assert.match(main, /loopbackRequest:/);
  assert.match(main, /linkProvider:/);
  assert.match(managed, /function loopbackRequest\(/);
  assert.match(managed, /\/_codex-router\/\$\{encodeURIComponent\(callerKey\)\}/);
  assert.match(original, /via: "codingTools\.apps"/);
  assert.doesNotMatch(original, /openOriginalControlCenter/);
});
