"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const { createAgentOrchestratorGateway } = require("../electron/agent-orchestrator-gateway.cjs");
const handler = require("../../app-handler/agent-orchestrator/handler.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

test("upstream AO gateway runs trusted UI requests automatically and blocks untrusted or remote access", async () => {
  const fixtureRoot = path.resolve(__dirname, "../../aiTemp/ao-gateway-tests");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "index.html"), "<h1>Original renderer fixture</h1>");
  const received = [];
  const daemon = http.createServer((request, response) => {
    received.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ projects: [] }));
  });
  await new Promise((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const gateway = createAgentOrchestratorGateway({
    rendererRoot: fixtureRoot, daemonPort: daemon.address().port,
    getStatus: () => ({ state: "ready" }), desktopRequest: async () => "version",
  });
  try {
    const { origin, openUrl } = await gateway.listen();
    assert.equal((await fetch(`${origin}/api/v1/projects`)).status, 403);
    const bootstrap = await fetch(openUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(openUrl, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(origin, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/projects`, { headers: { cookie, origin: "https://hostile.example" } })).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/mobile/enable`, { method: "POST", headers: { cookie, origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/projects`, { headers: { cookie, origin } })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/agents/readiness/ensure`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [], purpose: "display" }),
    })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/sessions`, { method: "POST", headers: { cookie, origin } })).status, 200);
    assert.deepEqual(received, ["/api/v1/projects", "/api/v1/agents/readiness/ensure", "/api/v1/sessions"]);
  } finally {
    await gateway.close();
    await new Promise((resolve) => daemon.close(resolve));
  }
});

test("AO handler exposes named upstream APIs and keeps absent board detail JSON-safe", async () => {
  assert.equal(handler.isReadOnly("upstream_projects"), true);
  assert.equal(handler.isReadOnly("upstream_create_session"), false);
  assert.equal(handler.isReadOnly("upstream_show"), false);
  const operations = [];
  const host = createCodingToolsAppsHost({ services: {
    agentOrchestrator: async () => ({ ok: true, tasks: [] }),
    agentOrchestratorUpstream: async (operation, args) => { operations.push([operation, args]); return { ok: true, data: [] }; },
  } });
  const ipc = { invoke: (_channel, input) => host.call(input.moduleId, input.operation, input.arguments) };
  const result = await invokeContract(ipc, "apps.call", { moduleId: "agent-orchestrator", operation: "board", arguments: {} });
  assert.equal(result.result.task, null);
  await host.call("agent-orchestrator", "upstream_projects", {});
  assert.deepEqual(operations, [["upstream_projects", {}]]);
  await assert.rejects(host.call("agent-orchestrator", "upstream_arbitrary_url", { url: "http://example.com" }), /does not expose/);
});

test("closing the AO gateway cancels a backend request stalled before response headers", async () => {
  let markReceived;
  let markClosed;
  const received = new Promise((resolve) => { markReceived = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const daemon = http.createServer((_request, response) => {
    response.once("close", markClosed);
    markReceived();
  });
  await new Promise((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const gateway = createAgentOrchestratorGateway({ rendererRoot: __dirname, daemonPort: daemon.address().port, getStatus: () => ({}), desktopRequest: async () => null });
  try {
    const { origin, openUrl } = await gateway.listen();
    const bootstrap = await fetch(openUrl, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    const pending = fetch(`${origin}/api/v1/projects`, { headers: { cookie }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    await received;
    await gateway.close();
    await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Backend socket remained open")), 1000).unref())]);
    await pending;
  } finally {
    await gateway.close();
    daemon.closeAllConnections();
    await new Promise((resolve) => daemon.close(resolve));
  }
});
