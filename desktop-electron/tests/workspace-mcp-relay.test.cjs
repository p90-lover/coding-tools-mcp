"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("workspace MCP relay requires owner auth and returns scoped catalog", async () => {
  const catalog = {
    workspaces: [{
      id: "ws-1",
      name: "Demo",
      path: "C:\\Projects\\Demo",
      permission_mode: "workspace-write",
      approval_mode: "on-request",
      tool_profile: "advanced",
    }],
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("workspace relay must not inspect the browser"); },
    getPreferences: () => { throw new Error("workspace relay must not read preferences"); },
    getCodingToolsWorkspaces: async () => catalog,
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (authorization, body = "{}") => fetch(`${endpoint}/v1/coding-tools/workspaces`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });
  try {
    assert.equal((await send("Bearer wrong")).status, 401);
    assert.equal((await send(`Bearer ${token}`, '{"extra":true}')).status, 400);
    const response = await send(`Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), catalog);
  } finally {
    await server.close();
  }
});

test("module MCP relay permits only read-only catalog operations", async () => {
  const called = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("module relay must not inspect the browser"); },
    getPreferences: () => { throw new Error("module relay must not read preferences"); },
    callReadOnlyAppTool: async (tool) => {
      called.push(tool);
      return { tool, modules: [] };
    },
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/coding-tools/apps`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await send({ tool: "apps_catalog" }, "Bearer wrong")).status, 401);
    assert.equal((await send({ tool: "apps_call" })).status, 400);
    assert.equal((await send({ tool: "apps_catalog", arguments: {} })).status, 400);
    const response = await send({ tool: "apps_catalog" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { tool: "apps_catalog", modules: [] });
    assert.deepEqual(called, ["apps_catalog"]);
  } finally {
    await server.close();
  }
});
