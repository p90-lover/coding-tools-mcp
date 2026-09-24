"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("browser native Codex relay keeps the tool allowlist and request identity", async () => {
  const calls = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("native Codex must not inspect the browser"); },
    getPreferences: () => { throw new Error("native Codex must not use browser preferences"); },
    callNativeCodexTool: async (body) => {
      calls.push(body);
      return { ok: true, operation: { request_id: body.request_id, state: "completed", result: { ok: true } } };
    },
  }).start();
  const { endpoint, token } = server.descriptor();
  const body = {
    workspace_id: "ws-1",
    request_id: "request-001",
    tool: "codex_agent_control",
    arguments: { operation: "start", request_id: "request-001" },
  };
  const send = (value, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/coding-tools/native-codex`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  try {
    assert.equal((await send(body, "Bearer wrong")).status, 401);
    assert.equal((await send({ ...body, tool: "exec_command" })).status, 400);
    assert.equal((await send({ ...body, arguments: { ...body.arguments, request_id: "different" } })).status, 400);
    const response = await send(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).operation.request_id, body.request_id);
    assert.deepEqual(calls, [body]);
  } finally {
    await server.close();
  }
});
