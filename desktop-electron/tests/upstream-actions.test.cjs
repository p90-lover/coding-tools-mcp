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
