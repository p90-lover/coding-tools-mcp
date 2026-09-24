"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const {
  ALLOWED_ANNEAL_POST,
  ALLOWED_PASEO,
  actUpstream,
  annealPathForOp,
  buildPaseoMessage,
  registerFixedPaseoProviders,
} = require("../electron/upstream-actions.cjs");

function createPaseoSocket(initialProviders = {}, {
  rpcErrorDetail = "",
  wrongTypeBeforeExpected = false,
} = {}) {
  const connections = [];
  const config = {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: structuredClone(initialProviders),
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };

  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.listeners = new Map();
      this.sent = [];
      connections.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type, event) {
      this.listeners.get(type)?.(event);
    }

    send(raw) {
      this.sent.push(raw);
      const frame = JSON.parse(raw);
      if (frame.type === "hello") {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({
          type: "session",
          message: { type: "status", payload: { status: "server_info", serverId: "daemon-1" } },
        }) }));
        return;
      }

      const request = frame.message;
      if (rpcErrorDetail) {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({
          type: "session",
          message: {
            type: "rpc_error",
            payload: { requestId: request.requestId, message: rpcErrorDetail },
          },
        }) }));
        return;
      }
      if (request.type === "set_daemon_config_request") {
        assert.deepEqual(Object.keys(request.config), ["providers"]);
        Object.assign(config.providers, structuredClone(request.config.providers));
      }
      const responseType = request.type === "set_daemon_config_request"
        ? "set_daemon_config_response"
        : "get_daemon_config_response";
      if (wrongTypeBeforeExpected) {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({
          type: "session",
          message: {
            type: "send_agent_message_response",
            payload: { requestId: request.requestId, accepted: true },
          },
        }) }));
      }
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({
        type: "session",
        message: {
          type: responseType,
          payload: { requestId: request.requestId, config: structuredClone(config) },
        },
      }) }));
    }

    close() {}
  }

  return { FakeWebSocket, config, connections };
}

test("Paseo send builds the original-function protocol v1 RPC", () => {
  const message = buildPaseoMessage({
    op: "send",
    agentId: "agent-1",
    text: "hello from coding tools",
    requestId: "req-1",
  });
  assert.equal(message.type, "send_agent_message_request");
  assert.equal(message.agentId, "agent-1");
  assert.equal(message.text, "hello from coding tools");
  assert.ok(ALLOWED_PASEO.includes(message.type));
  assert.throws(() => buildPaseoMessage({ op: "delete_everything", agentId: "agent-1" }), /allowlist/i);
});

test("Anneal start posts the allowlisted original-function path", async () => {
  const spec = annealPathForOp("start", "task-9");
  assert.equal(spec.pattern, "/tasks/{id}/start");
  assert.equal(spec.path, "/tasks/task-9/start");
  assert.ok(ALLOWED_ANNEAL_POST.includes(spec.pattern));

  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/tasks/task-9/start");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await actUpstream({
      toolId: "anneal",
      op: "start",
      taskId: "task-9",
      endpoint: `http://127.0.0.1:${port}/`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.op, "start");
    assert.match(result.detail, /HTTP 200/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Anneal create posts BACKLOG to /projects/{id}/tasks and preview uses GET", async () => {
  const {
    ALLOWED_ANNEAL_GET,
    ALLOWED_ANNEAL_POST,
    actUpstream,
    annealPathForOp,
  } = require("../electron/upstream-actions.cjs");
  const spec = annealPathForOp("create", "proj-9", { title: "Handoff", description: "From Paseo review" });
  assert.equal(spec.method, "POST");
  assert.equal(spec.pattern, "/projects/{id}/tasks");
  assert.equal(spec.path, "/projects/proj-9/tasks");
  assert.equal(spec.body.status, "BACKLOG");
  assert.equal(spec.body.approvalGate, true);
  assert.equal(spec.body.assigneeType, "HUMAN");
  assert.equal(Object.hasOwn(spec.body, "chainIndex"), false);
  assert.equal(spec.body.opensPullRequest, false);
  assert.throws(() => annealPathForOp("create", "proj-9", { name: "x".repeat(201) }), /task name/);
  assert.ok(ALLOWED_ANNEAL_POST.includes(spec.pattern));
  assert.ok(ALLOWED_ANNEAL_GET.includes("/tasks/{id}"));

  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.method === "POST") {
        const body = JSON.parse(raw || "{}");
        assert.equal(body.status, "BACKLOG");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "task-created" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-created", status: "BACKLOG" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const created = await actUpstream({
      toolId: "anneal",
      op: "create",
      projectId: "proj-9",
      title: "Handoff",
      endpoint: `http://127.0.0.1:${port}/`,
    });
    assert.equal(created.ok, true);
    assert.equal(created.body.id, "task-created");
    const preview = await actUpstream({
      toolId: "anneal",
      op: "preview",
      taskId: "task-created",
      endpoint: `http://127.0.0.1:${port}/`,
    });
    assert.equal(preview.body.status, "BACKLOG");
    assert.deepEqual(seen.map((entry) => `${entry.method} ${entry.url}`), [
      "POST /projects/proj-9/tasks",
      "GET /tasks/task-created",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Unknown or remote upstream actions are rejected", async () => {
  assert.throws(() => annealPathForOp("explode", "task-1"), /allowlist/i);
  await assert.rejects(
    () => actUpstream({
      toolId: "anneal",
      op: "start",
      taskId: "task-9",
      endpoint: "http://example.com:3000/",
    }),
    /loopback/i,
  );
});

test("fixed Paseo providers use authenticated config RPC, read back, and become idempotent", async () => {
  const paseo = createPaseoSocket({
    user_provider: { label: "Keep me", env: { OPENAI_API_KEY: "existing-secret" } },
  });
  const options = { webSocketImpl: paseo.FakeWebSocket, timeoutMs: 1_000 };

  const first = await registerFixedPaseoProviders(
    "ws://127.0.0.1:6768/",
    "daemon-secret",
    options,
  );
  assert.deepEqual(first, {
    ok: true,
    changed: true,
    providers: ["coding-tools-web-gpt", "coding-tools-cpa-gemini"],
  });
  assert.deepEqual(
    paseo.connections.map((connection) => JSON.parse(connection.sent[1]).message.type),
    ["get_daemon_config_request", "set_daemon_config_request", "get_daemon_config_request"],
  );
  assert.ok(paseo.connections.every((connection) => connection.protocols[0] === "paseo.bearer.daemon-secret"));
  const persistedPatch = JSON.parse(paseo.connections[1].sent[1]).message.config;
  assert.deepEqual(Object.keys(persistedPatch), ["providers"]);
  assert.equal(JSON.stringify(persistedPatch).includes("existing-secret"), false);
  assert.equal(JSON.stringify(first).includes("existing-secret"), false);
  assert.equal(JSON.stringify(first).includes("daemon-secret"), false);

  const second = await registerFixedPaseoProviders(
    "ws://127.0.0.1:6768/",
    "daemon-secret",
    options,
  );
  assert.deepEqual(second, { ok: true, changed: false, providers: [] });
  assert.deepEqual(
    paseo.connections.map((connection) => JSON.parse(connection.sent[1]).message.type),
    [
      "get_daemon_config_request",
      "set_daemon_config_request",
      "get_daemon_config_request",
      "get_daemon_config_request",
    ],
  );
});

test("fixed Paseo provider registration rejects collisions before writing", async () => {
  const paseo = createPaseoSocket({
    "coding-tools-web-gpt": { extends: "codex", label: "Somebody else's provider" },
  });
  await assert.rejects(
    () => registerFixedPaseoProviders("ws://127.0.0.1:6768/", "daemon-secret", {
      webSocketImpl: paseo.FakeWebSocket,
      timeoutMs: 1_000,
    }),
    /provider ID already belongs to another configuration: coding-tools-web-gpt/,
  );
  assert.deepEqual(
    paseo.connections.map((connection) => JSON.parse(connection.sent[1]).message.type),
    ["get_daemon_config_request"],
  );
});

test("private Paseo config RPC ignores same-request-id frames of the wrong type", async () => {
  const paseo = createPaseoSocket({}, { wrongTypeBeforeExpected: true });
  const result = await registerFixedPaseoProviders("ws://127.0.0.1:6768/", "daemon-secret", {
    webSocketImpl: paseo.FakeWebSocket,
    timeoutMs: 1_000,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(
    paseo.connections.map((connection) => JSON.parse(connection.sent[1]).message.type),
    ["get_daemon_config_request", "set_daemon_config_request", "get_daemon_config_request"],
  );
});

test("private Paseo config RPC does not echo daemon error secrets", async () => {
  const paseo = createPaseoSocket({}, { rpcErrorDetail: "OPENAI_API_KEY=upstream-secret" });
  await assert.rejects(
    () => registerFixedPaseoProviders("ws://127.0.0.1:6768/", "daemon-secret", {
      webSocketImpl: paseo.FakeWebSocket,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.message, "Paseo refused the private configuration request");
      assert.equal(error.message.includes("upstream-secret"), false);
      return true;
    },
  );
});

test("public Paseo actions cannot read or write daemon configuration", async () => {
  assert.equal(ALLOWED_PASEO.includes("get_daemon_config_request"), false);
  assert.equal(ALLOWED_PASEO.includes("set_daemon_config_request"), false);
  await assert.rejects(
    () => actUpstream({ toolId: "paseo", op: "get_daemon_config_request" }),
    /allowlist/i,
  );
});

test("Anneal module uses its private web proxy for projects, board, details and state changes", async t => {
  const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
  const seen = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null,
        authorization: request.headers.authorization, origin: request.headers.origin });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: "task-9", name: "Real task", status: "BACKLOG",
        moveTargets: [{ status: "TODO", via: "patch" }] }]));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = createCodingToolsAppsHost({
    actUpstream,
    services: { loopbackRequest: id => {
      assert.equal(id, "anneal");
      return { origin: `http://127.0.0.1:${server.address().port}/api/` };
    } },
  });
  const input = { projectId: "proj-9", taskId: "task-9", endpoint: "http://127.0.0.1:1/",
    credential: "renderer-token-must-not-be-used" };
  for (const operation of ["projects", "board", "preview", "updateTask"]) {
    const result = await host.call("anneal", operation, { ...input, status: "TODO" });
    assert.equal(result.ok, true);
    assert.equal(result.result.body[0].name, "Real task");
    assert.deepEqual(result.result.body[0].moveTargets, [{ status: "TODO", via: "patch" }]);
    assert.equal(host.isReadOnly("anneal", operation), operation !== "updateTask");
  }
  assert.deepEqual(seen.map(({ method, url }) => `${method} ${url}`), [
    "GET /api/projects", "GET /api/tasks?view=board&archived=false&projectId=proj-9",
    "GET /api/tasks/task-9", "PATCH /api/tasks/task-9",
  ]);
  assert.deepEqual(seen[3].body, { status: "TODO" });
  assert.ok(seen.every(item => item.authorization === undefined && item.origin === undefined));
  const refused = await host.call("anneal", "updateTask", { ...input, status: "INVENTED" });
  assert.equal(refused.ok, false);
  assert.match(refused.result.detail, /status/);
  assert.equal(seen.length, 4);
});
