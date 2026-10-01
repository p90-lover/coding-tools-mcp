"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const Module = require("node:module");

const { MODULE_IDS, createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { defaultRegistry } = require("../../app-handler/handler-registry.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const readDesktop = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

const LIFECYCLE = Object.freeze([
  "inspect",
  "install",
  "repair",
  "start",
  "stop",
  "restart",
]);

const EXPECTED_OPS = Object.freeze({
  "agent-orchestrator": ["inspect", "board", "runs", "update_run"],
  "antigravity-cli": ["inspect", "status", "install", "terminal_open", "terminal_close", "refresh", "sign_in", "sweep", "set_auto"],
  cpa: [
    ...LIFECYCLE,
    "health",
    "models",
    "chatCompletions",
    "managementHealth",
    "listProviders",
    "providers",
    "linkProvider",
    "unlinkProvider",
    "providerStatus",
  ],
  "codex-router": [...LIFECYCLE, "health", "models", "chatCompletions", "sync"],
  "commandcode-proxy": [
    ...LIFECYCLE,
    "health",
    "models",
    "chatCompletions",
    "banner",
    "plan",
    "applyPlan",
    "registration-plan",
    "registration-apply",
  ],
  paseo: [
    ...LIFECYCLE,
    "send",
    "resume",
    "cancel",
    "archive",
    "permission",
    "create",
    "plan",
    "run",
    "submitResult",
    "review",
  ],
  anneal: [
    ...LIFECYCLE,
    "listTasks",
    "board",
    "preview",
    "activity",
    "create",
    "startTask",
    "task-start",
    "retry",
    "hold",
    "resume",
    "archive",
    "unarchive",
    "inboxDecision",
    "inbox_decision",
    "inbox_reply",
    "inbox_close",
    "openFromReview",
  ],
});

const PASEO_PROTOCOL = Object.freeze(["send", "resume", "cancel", "archive", "permission", "create"]);
const PASEO_FIVE_STACK = Object.freeze({
  plan: "paseo_plan",
  run: "paseo_run",
  submitResult: "paseo_submit_result",
  review: "paseo_review",
});
const ANNEAL_ACT = Object.freeze({
  preview: "preview",
  activity: "preview",
  create: "create",
  startTask: "start",
  "task-start": "start",
  retry: "retry",
  hold: "hold",
  resume: "resume",
  archive: "archive",
  unarchive: "unarchive",
  inboxDecision: "inbox_decision",
  inbox_decision: "inbox_decision",
  inbox_reply: "inbox_reply",
  inbox_close: "inbox_close",
});

function createAppsFacade(host) {
  return {
    list: () => host.list(),
    catalog: () => host.catalog(),
    call: (input) => host.call(input.moduleId, input.operation, input.arguments || {}),
    invoke: (input) => host.invoke({
      handle: input.handle || input.moduleId,
      operation: input.operation,
      arguments: input.arguments || {},
    }),
  };
}

function createFixtureHost(overrides = {}) {
  const calls = [];
  const fiveStackCalls = [];
  const host = createCodingToolsAppsHost({
    services: {
      inspect: async (id) => {
        calls.push(["inspect", id]);
        return { id, status: "ready", endpoint: `in-process://${id}` };
      },
      start: async (id) => {
        calls.push(["start", id]);
        return { id, status: "starting" };
      },
      stop: async (id) => {
        calls.push(["stop", id]);
        return { id, status: "stopped" };
      },
      restart: async (id) => {
        calls.push(["restart", id]);
        return { id, status: "restarting" };
      },
      repair: async (id) => {
        calls.push(["repair", id]);
        return { id, status: "repaired" };
      },
      syncCodexRouter: async () => {
        calls.push(["syncCodexRouter"]);
        return { ok: true, synced: true };
      },
      commandCodeProxyPlan: async (args) => {
        calls.push(["commandCodeProxyPlan", args]);
        return { text: "plan", credentialPromptRequired: true };
      },
      applyCommandCodeProxyPlan: async (args) => {
        calls.push(["applyCommandCodeProxyPlan", args]);
        return { applied: true, provider: args.provider || "commandcode" };
      },
      loopbackRequest: (id) => {
        if (id === "cpa") {
          return {
            origin: "http://127.0.0.1:8317/",
            managementHeaders: { Authorization: "Bearer test-mgmt" },
          };
        }
        if (id === "codex-router") {
          return { origin: "http://127.0.0.1:4202/" };
        }
        return { origin: `http://127.0.0.1:${id === "commandcode-proxy" ? "9090" : "6768"}/` };
      },
      listProviders: async () => ({ ok: true, accounts: [], summary: { total: 0, enabled: 0, connected: 0, disabled: 0, archived: 0 } }),
      linkProvider: async (input) => ({ ok: true, linked: true, provider: input?.provider || "test" }),
      unlinkProvider: async (input) => ({ ok: true, unlinked: true, provider: input?.provider || "test" }),
      providerStatus: async () => ({ ok: true, status: "unknown" }),
      agentOrchestrator: async (operation) => ({ ok: true, status: "ready", operation }),
      ...overrides.services,
    },
    actUpstream: overrides.actUpstream || (async (input) => {
      calls.push(["act", input.toolId, input.op]);
      return { ok: true, toolId: input.toolId, op: input.op, echoed: input };
    }),
    getFiveStack: overrides.getFiveStack || (() => ({
      ok: true,
      value: {
        callTool: async (name, args) => {
          fiveStackCalls.push([name, args]);
          return { ok: true, tool: name, args };
        },
      },
    })),
  });
  return { host, apps: createAppsFacade(host), calls, fiveStackCalls };
}

function stubLoopbackHttp(responder) {
  const original = http.request;
  const requests = [];
  http.request = (target, options, callback) => {
    const url = target instanceof URL ? target : new URL(String(target));
    const req = new PassThrough();
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    const destroy = (error) => {
      if (error) req.emit("error", error);
    };
    req.destroy = destroy;
    req.end = function end(chunk, encoding, cb) {
      if (chunk) body += chunk;
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      PassThrough.prototype.end.call(this);
      queueMicrotask(() => {
        let parsedBody = null;
        if (body) {
          try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
        }
        const record = {
          url: url.toString(),
          method: options.method || "GET",
          pathname: url.pathname,
          body: parsedBody,
        };
        requests.push(record);
        try {
          const reply = responder(record);
          if (reply && reply.throw) {
            req.emit("error", reply.throw instanceof Error ? reply.throw : new Error(String(reply.throw)));
            return;
          }
          const res = new PassThrough();
          res.statusCode = reply?.statusCode ?? 200;
          callback(res);
          res.end(reply?.body ?? JSON.stringify({ ok: true, data: [] }));
        } catch (error) {
          req.emit("error", error);
        }
      });
      return req;
    };
    return req;
  };
  return {
    requests,
    restore() {
      http.request = original;
    },
  };
}

function loadPreload(respond = () => ({ ok: true })) {
  const exposed = Object.create(null);
  const invocations = [];
  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      async invoke(channel, payload) {
        const clonedPayload = structuredClone(payload);
        invocations.push({ channel, payload: clonedPayload });
        return respond(channel, clonedPayload);
      },
      on() {},
      removeListener() {},
      send() {},
    },
  };
  const preloadPath = path.resolve(__dirname, "../electron/preload.cjs");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return { api: exposed.codingTools, invocations };
}

test("registry and catalog expose every contracted module operation", () => {
  const { apps } = createFixtureHost();
  const listed = apps.list();
  const catalog = apps.catalog();

  assert.equal(listed.host, "coding-tools-apps");
  assert.equal(listed.transport, "in-process");
  assert.deepEqual(listed.modules.map((entry) => entry.id), MODULE_IDS);
  assert.deepEqual(catalog.modules.map((entry) => entry.id), MODULE_IDS);
  assert.equal(defaultRegistry.ids().sort().join(","), [...MODULE_IDS].sort().join(","));

  for (const moduleId of MODULE_IDS) {
    const registered = defaultRegistry.operations(moduleId);
    const listedOps = listed.modules.find((entry) => entry.id === moduleId).operations;
    const catalogOps = catalog.modules.find((entry) => entry.id === moduleId).operations.map((entry) => entry.name);
    assert.deepEqual(listedOps, registered, `${moduleId} list operations`);
    assert.deepEqual(catalogOps, registered, `${moduleId} catalog operations`);
    for (const operation of EXPECTED_OPS[moduleId]) {
      assert.equal(
        defaultRegistry.ownsOperation(moduleId, operation),
        true,
        `${moduleId} must expose ${operation}`,
      );
    }
  }
});

test("codingTools.apps list/catalog/call/invoke stay in-process and inspect does not hit loopback HTTP", async () => {
  const { apps, calls } = createFixtureHost();
  const stub = stubLoopbackHttp(() => ({ statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) }));
  try {
    const catalog = await apps.catalog();
    assert.equal(Array.isArray(catalog.modules), true);
    assert.equal(catalog.transport, "in-process");

    const loopbackInspect = ["cpa"];
    const bundledInspect = [];
    for (const moduleId of MODULE_IDS) {
      const viaCall = await apps.call({ moduleId, operation: "inspect" });
      assert.equal(viaCall.ok, true, `${moduleId} call inspect`);
      assert.equal(viaCall.moduleId, moduleId);
      assert.equal(viaCall.handle, moduleId);
      assert.equal(viaCall.transport, "in-process");
      assert.equal(viaCall.result.status, "ready");
      assert.doesNotMatch(JSON.stringify(viaCall), /401/);
      assert.doesNotMatch(JSON.stringify(viaCall), /ECONNREFUSED/);

      const viaInvoke = await apps.invoke({ handle: moduleId, operation: "inspect" });
      assert.equal(viaInvoke.ok, true, `${moduleId} invoke inspect`);
      assert.equal(viaInvoke.handle, moduleId);
      assert.equal(viaInvoke.moduleId, moduleId);
    }
    for (const moduleId of bundledInspect) {
      const inspected = await apps.call({ moduleId, operation: "inspect" });
      assert.equal(inspected.result.listening, false, `${moduleId} inspect must not require a listen port`);
    }
    assert.equal(stub.requests.length, 0, "inspect must not probe loopback HTTP");
    assert.equal(
      calls.filter((entry) => entry[0] === "inspect").length,
      loopbackInspect.length * 2,
      "CPA inspect uses the injected service; AO stays in-process",
    );
  } finally {
    stub.restore();
  }
});

test("CPA key operations dispatch through the in-process host", async () => {
  const { apps, calls } = createFixtureHost();
  const stub = stubLoopbackHttp((request) => {
    if (request.pathname === "/v1/models") {
      return { statusCode: 200, body: JSON.stringify({ data: [{ id: "gpt-test" }] }) };
    }
    if (request.pathname === "/v1/chat/completions") {
      return { statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) };
    }
    if (request.pathname === "/management.html") {
      return { statusCode: 200, body: "<html></html>" };
    }
    if (request.pathname === "/v0/management/auth-files") {
      return { statusCode: 200, body: JSON.stringify({ files: [{ name: "acct.json", provider: "openai", status: "ok" }] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  });

  try {
    for (const operation of LIFECYCLE) {
      const result = await apps.call({ moduleId: "cpa", operation });
      assert.equal(result.ok, true, `cpa ${operation}`);
    }

    const health = await apps.invoke({ handle: "cpa", operation: "health" });
    assert.equal(health.ok, true);
    assert.equal(health.result.reachable, true);

    const models = await apps.call({ moduleId: "cpa", operation: "models" });
    assert.equal(models.ok, true);
    assert.deepEqual(models.result.models, ["gpt-test"]);

    const chat = await apps.invoke({
      handle: "cpa",
      operation: "chatCompletions",
      arguments: { model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(chat.ok, true);
    assert.equal(chat.result.ok, true);

    const management = await apps.call({ moduleId: "cpa", operation: "managementHealth" });
    assert.equal(management.ok, true);
    assert.equal(management.result.reachable, true);
    assert.equal(management.result.authFileCount, 1);

    const listed = await apps.invoke({ handle: "cpa", operation: "listProviders" });
    assert.equal(listed.ok, true);
    const linked = await apps.call({
      moduleId: "cpa",
      operation: "linkProvider",
      arguments: { provider: "openai" },
    });
    assert.equal(linked.ok, true);
    const status = await apps.invoke({ handle: "cpa", operation: "providerStatus" });
    assert.equal(status.ok, true);
    const unlinked = await apps.call({
      moduleId: "cpa",
      operation: "unlinkProvider",
      arguments: { provider: "openai" },
    });
    assert.equal(unlinked.ok, true);

    assert.ok(stub.requests.some((entry) => entry.pathname === "/v1/models"));
    assert.ok(stub.requests.some((entry) => entry.pathname === "/v1/chat/completions"));
  } finally {
    stub.restore();
  }
});

test("preload invoke remaps handle onto coding-tools:apps:call and omits undefined optionals", async () => {
  const { api, invocations } = loadPreload(() => ({
    ok: true,
    moduleId: "cpa",
    handle: "cpa",
    operation: "inspect",
    transport: "in-process",
  }));

  await api.apps.list();
  await api.apps.catalog();
  await api.apps.call({ moduleId: "cpa", operation: "inspect" });
  await api.apps.invoke({ handle: "cpa", operation: "inspect" });
  await api.apps.invoke({
    handle: "agent-orchestrator",
    operation: "board",
    requestId: "req-1",
    arguments: { agentId: "agent-1", text: "ping" },
  });

  assert.deepEqual(invocations.map((entry) => entry.channel), [
    "coding-tools:apps:list",
    "coding-tools:apps:catalog",
    "coding-tools:apps:call",
    "coding-tools:apps:call",
    "coding-tools:apps:call",
  ]);
  assert.deepEqual(invocations[2].payload, { moduleId: "cpa", operation: "inspect" });
  assert.deepEqual(invocations[3].payload, { moduleId: "cpa", operation: "inspect" });
  assert.equal(Object.hasOwn(invocations[3].payload, "handle"), false);
  assert.equal(Object.hasOwn(invocations[3].payload, "requestId"), false);
  assert.equal(Object.hasOwn(invocations[3].payload, "arguments"), false);
  assert.deepEqual(invocations[4].payload, {
    moduleId: "agent-orchestrator",
    operation: "board",
    requestId: "req-1",
    arguments: { agentId: "agent-1", text: "ping" },
  });

  const fakeIpc = { invoke: async () => ({ ok: true }) };
  await invokeContract(fakeIpc, "apps.call", {
    moduleId: "cpa",
    operation: "inspect",
  });
  await assert.rejects(
    () => invokeContract(fakeIpc, "apps.call", { handle: "cpa", operation: "inspect" }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
});

test("app-handler tree does not add listen ports and IPC names stay list/catalog/call", () => {
  const hostSource = fs.readFileSync(path.join(repoRoot, "app-handler/host.cjs"), "utf8");
  const registrySource = fs.readFileSync(path.join(repoRoot, "app-handler/handler-registry.cjs"), "utf8");
  const main = readDesktop("electron/main.cjs");
  const schema = readDesktop("electron/ipc-schema.cjs");
  const preload = readDesktop("electron/preload.cjs");

  assert.doesNotMatch(hostSource, /createServer|listenLoopback|\.listen\(/);
  assert.doesNotMatch(registrySource, /createServer|\.listen\(/);
  assert.match(main, /handle\("coding-tools:apps:list"/);
  assert.match(main, /handle\("coding-tools:apps:catalog"/);
  assert.match(main, /handle\("coding-tools:apps:call"/);
  assert.doesNotMatch(main, /coding-tools:apps:invoke/);
  assert.match(schema, /channel: "coding-tools:apps:call"/);
  assert.match(preload, /invoke: \(input\) => invokeContract\(ipcRenderer, "apps.call"/);
  assert.match(main, /appsHost\.call\(input\.moduleId, input\.operation, input\.arguments/);
});

test("AO apps.call reaches the host while retired IDs fail before dispatch", async () => {
  const ipcCalls = [];
  const ipc = { invoke: async (channel, payload) => {
    ipcCalls.push({ channel, payload });
    return { ok: true };
  } };
  await invokeContract(ipc, "apps.call", { moduleId: "agent-orchestrator", operation: "board" });
  assert.equal(ipcCalls.length, 1);
  assert.equal(ipcCalls[0].payload.moduleId, "agent-orchestrator");

  const retired = ["paseo", "codex-router", "commandcode-proxy", "anneal"];
  const { api, invocations } = loadPreload();
  for (const moduleId of retired) {
    for (const call of [
      () => invokeContract(ipc, "apps.call", { moduleId, operation: "inspect" }),
      () => api.apps.call({ moduleId, operation: "inspect" }),
    ]) {
      await assert.rejects(call, (error) => {
        assert.equal(error.code, "APP_MODULE_RETIRED");
        assert.match(error.message, new RegExp(moduleId));
        return true;
      }, moduleId);
    }
  }
  await assert.rejects(
    invokeContract(ipc, "apps.call", { moduleId: "unknown", operation: "inspect" }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  assert.equal(ipcCalls.length, 1, "retired IPC requests must never reach transport");
  assert.equal(invocations.length, 0, "retired preload calls must never reach transport");

  const dispatched = [];
  const registry = {
    has: () => true,
    invoke: async (id) => { dispatched.push(id); return { ok: true }; },
  };
  const host = createCodingToolsAppsHost({ registry });
  for (const moduleId of retired) {
    await assert.rejects(host.call(moduleId, "inspect"), (error) => {
      assert.equal(error.code, "APP_MODULE_RETIRED");
      assert.match(error.message, /retired/i);
      return true;
    }, moduleId);
  }
  assert.deepEqual(dispatched, [], "no retired handler may run, even if registered");
});

test("app catalog and registry expose only CPA, AO and the Antigravity CLI tool", () => {
  const host = createCodingToolsAppsHost();
  assert.deepEqual(host.moduleIds, ["cpa", "agent-orchestrator", "antigravity-cli"]);
  assert.deepEqual(host.list().modules.map((entry) => entry.id), host.moduleIds);
  assert.deepEqual(host.catalog().modules.map((entry) => entry.id), host.moduleIds);
  assert.deepEqual(defaultRegistry.ids().sort(), [...host.moduleIds].sort());
});
