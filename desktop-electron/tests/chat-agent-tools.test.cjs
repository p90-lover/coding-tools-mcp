"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createChatAgentTools, toolResult } = require("../electron/chat-agent-tools.cjs");

const CATALOG = {
  ok: true, workspace_id: "ws1", tool_profile: "core",
  tools: [
    { name: "read_file", title: "Read file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } },
      annotations: { readOnlyHint: true }, outputSchema: { type: "object" } },
    { name: "exec_command", description: "Run a command", inputSchema: { type: "object" } },
    { name: "capture_screenshot", description: "Screenshot", inputSchema: { type: "object" } },
    { name: "workflow_update", description: "Edit the task board", inputSchema: { type: "object" } },
    { name: "codex_command_exec", description: "Native Codex", inputSchema: { type: "object" } },
    { name: "history_session_read", description: "History", inputSchema: { type: "object" } },
    { name: "mcp_operation_status", description: "Operations", inputSchema: { type: "object" } },
  ],
};

function fixture({ enabled = () => true, results = {} } = {}) {
  const calls = [];
  const tools = createChatAgentTools({
    enabled, version: "9.9.9", logger: { info() {}, warn() {} },
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint.startsWith("/api/v1/tools/catalog?")) return CATALOG;
      if (endpoint === "/api/v1/tools/call") {
        const outcome = results[body.tool];
        if (outcome instanceof Error) throw outcome;
        return { ok: true, operation: outcome ?? { state: "completed", result: { ok: true, tool: body.tool, echo: body.arguments } } };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  return { tools, calls };
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const request = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: headers[":method"] || "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith(":"))) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    if (headers[":method"] !== "GET") request.end(payload); else request.end();
  });
}

test("servers() attaches one http server per workspace for agents whose driver takes it", async () => {
  let on = true;
  const { tools } = fixture({ enabled: () => on });
  try {
    const [server, ...rest] = await tools.servers({ agent: "codex", workspaceId: "ws1" });
    assert.equal(rest.length, 0);
    assert.equal(server.name, "coding-tools");
    assert.equal(server.type, "http");
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/ws1$/);
    assert.match(server.headers.Authorization, /^Bearer [A-Za-z0-9_-]{40,}$/);
    for (const agent of ["claude-code", "opencode"]) assert.equal((await tools.servers({ agent, workspaceId: "ws1" })).length, 1, agent);
    for (const agent of ["agy", "gemini", "aider", undefined]) assert.deepEqual(await tools.servers({ agent, workspaceId: "ws1" }), [], String(agent));
    assert.deepEqual(await tools.servers({ agent: "codex", workspaceId: "../etc" }), []);
    assert.deepEqual(await tools.servers({ agent: "codex" }), []);

    const identity = tools.identity("ws1");
    assert.match(identity, /^on\|http:\/\/127\.0\.0\.1:\d+\/mcp\/ws1\|/);
    assert.ok(!identity.includes(server.headers.Authorization.slice(7)), "the identity never carries the token");
    assert.notEqual(tools.identity("ws2"), identity, "each workspace has its own server URL");
    on = false;
    assert.deepEqual(await tools.servers({ agent: "codex", workspaceId: "ws1" }), [], "the setting turns it off");
    assert.equal(tools.identity("ws1"), "off");
  } finally { await tools.close(); }
});

test("the MCP endpoint answers initialize, lists the workspace tools and calls them through the headless service", async () => {
  const { tools, calls } = fixture();
  try {
    const [{ url, headers }] = await tools.servers({ agent: "claude-code", workspaceId: "ws1" });
    const auth = { authorization: headers.Authorization };

    const init = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, auth);
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.body.result.serverInfo, { name: "coding-tools", title: "Coding Tools", version: "9.9.9" });
    assert.ok(init.body.result.capabilities.tools);
    const unknownVersion = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, auth);
    assert.equal(unknownVersion.body.result.protocolVersion, "2025-06-18");

    const notified = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
    assert.equal(notified.status, 202);
    assert.equal(notified.body, null);

    const listed = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
    assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ["read_file", "exec_command", "capture_screenshot"],
      "the task board, native Codex, history and operation-store tools stay with the app");
    assert.equal(Object.hasOwn(listed.body.result.tools[0], "outputSchema"), false);
    assert.deepEqual(listed.body.result.tools[0].annotations, { readOnlyHint: true });
    assert.equal(calls[0].endpoint, "/api/v1/tools/catalog?workspace_id=ws1");
    assert.equal(calls[0].options.method, "GET");

    const called = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "README.md" } } }, auth);
    const call = calls.at(-1);
    assert.equal(call.endpoint, "/api/v1/tools/call");
    assert.equal(call.body.workspace_id, "ws1");
    assert.equal(call.body.tool, "read_file");
    assert.deepEqual(call.body.arguments, { path: "README.md" });
    assert.match(call.body.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(called.body.result.isError, false);
    assert.deepEqual(called.body.result.structuredContent, { ok: true, tool: "read_file", echo: { path: "README.md" } });
    assert.deepEqual(JSON.parse(called.body.result.content[0].text), called.body.result.structuredContent);

    const hidden = await post(url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workflow_update", arguments: {} } }, auth);
    assert.equal(hidden.body.result.isError, true);
    assert.equal(calls.at(-1).body?.tool, "read_file", "a hidden tool never reaches the service");

    const batch = await post(url, [{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "resources/list" }], auth);
    assert.deepEqual(batch.body[0], { jsonrpc: "2.0", id: 5, result: {} });
    assert.equal(batch.body[1].error.code, -32601);
  } finally { await tools.close(); }
});

test("tool failures come back as tool errors, not transport errors", async () => {
  const { tools } = fixture({ results: {
    exec_command: { state: "failed", error: "RESULT_TOO_LARGE: exec_command ran" },
    read_file: new Error("Headless service rejected the request (HTTP 400)"),
    git_status: { state: "completed", result: { ok: false, error: { code: "APPROVAL_REQUIRED" } } },
  } });
  try {
    const [{ url, headers }] = await tools.servers({ agent: "codex", workspaceId: "ws1" });
    const auth = { authorization: headers.Authorization };
    const failed = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exec_command", arguments: { cmd: "dir" } } }, auth);
    assert.equal(failed.body.result.isError, true);
    assert.match(failed.body.result.content[0].text, /RESULT_TOO_LARGE/);
    const rejected = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file" } }, auth);
    assert.equal(rejected.body.result.isError, true);
    assert.match(rejected.body.result.content[0].text, /HTTP 400/);
    const refused = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "git_status" } }, auth);
    assert.equal(refused.body.result.isError, true, "ok:false from the workspace policy is an error result");
    assert.equal(refused.body.result.structuredContent.error.code, "APPROVAL_REQUIRED");
  } finally { await tools.close(); }
});

test("the endpoint refuses callers without the token, from a browser origin, or for another host", async () => {
  const { tools, calls } = fixture();
  try {
    const [{ url, headers }] = await tools.servers({ agent: "codex", workspaceId: "ws1" });
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post(url, message)).status, 401);
    assert.equal((await post(url, message, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(url, message, { authorization: headers.Authorization, origin: "https://evil.example" })).status, 403);
    assert.equal((await post(url, message, { authorization: headers.Authorization, host: "evil.example" })).status, 403);
    assert.equal((await post(url.replace(/ws1$/, "..%2Fetc"), message, { authorization: headers.Authorization })).status, 404);
    assert.equal((await post(url, "", { authorization: headers.Authorization, ":method": "GET" })).status, 405);
    assert.equal((await post(url, "{not json", { authorization: headers.Authorization })).status, 400);
    assert.equal(calls.length, 0, "nothing reached the workspace service");
  } finally { await tools.close(); }
});

test("image results become MCP image content, as the workspace listener shapes them", () => {
  const shot = toolResult("capture_screenshot", {}, { ok: true, mime_type: "image/png", base64: "iVBORw0K", data_url: "data:image/png;base64,iVBORw0K", width: 10 });
  assert.deepEqual(shot.content[0], { type: "image", data: "iVBORw0K", mimeType: "image/png" });
  assert.deepEqual(shot.structuredContent, { ok: true, mime_type: "image/png", width: 10 });
  assert.equal(shot.isError, false);
  const saved = toolResult("capture_screenshot", { output: "file" }, { ok: true, mime_type: "image/png", base64: "abc", path: "C:/shot.png" });
  assert.equal(saved.content.length, 1, "a screenshot written to a file stays text");
  const computer = toolResult("computer_snapshot", {}, { ok: true, mime_type: "image/jpeg", base64: "abc" });
  assert.equal(computer.content[0].type, "image");
  const plain = toolResult("list_dir", {}, ["a", "b"]);
  assert.deepEqual(plain.structuredContent, { value: ["a", "b"] });
});
