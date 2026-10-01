"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("browser Agent Orchestrator only relays allowlisted operations in the selected workspace", async () => {
  const calls = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("board must not inspect browser"); },
    getPreferences: () => { throw new Error("board must not inspect preferences"); },
    callAgentOrchestrator: async (operation, args) => {
      calls.push({ operation, args });
      return { ok: true, result: { ok: true, revision: 7 } };
    },
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/coding-tools/agent-orchestrator`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const body = { workspace_id: "chosen", operation: "board", arguments: { workspaceId: "other" } };
    assert.equal((await send(body, "Bearer wrong")).status, 401);
    assert.equal((await send({ ...body, operation: "delete" })).status, 400);
    assert.equal((await send({ ...body, operation: "plan" })).status, 400);
    assert.equal((await send({ ...body, unexpected: true })).status, 400);
    const response = await send(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.revision, 7);
    assert.deepEqual(calls, [{ operation: "board", args: { workspaceId: "chosen" } }]);
  } finally {
    await server.close();
  }
});
