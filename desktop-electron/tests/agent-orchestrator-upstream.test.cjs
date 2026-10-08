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


test("actual upstream observe exposes bounded current streaming output separately from terminal evidence", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async observe(id) {");
  const end = source.indexOf("    async interrupt(id)", start);
  const method = source.slice(start, end).trim().replace(/,$/, "");
  const prefix = source.slice(source.indexOf("  function utf8Prefix"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  let turn = "owned-turn";
  const messages = [
    { role: "assistant", turnId: "other-turn", streaming: true, text: "OTHER_TURN_SECRET" },
    { role: "user", turnId: turn, text: "user message is not output" },
    { role: "assistant", turnId: turn, streaming: false, text: "verified part" },
    { role: "assistant", turnId: turn, streaming: true, text: "streaming partial " + "界".repeat(5000) },
  ];
  const upstream = vm.runInNewContext(prefix + identity + "({" + method + "})", {
    Buffer,
    internalApi: async (method, endpoint) => {
      assert.equal(method, "GET");
      if (endpoint === "/api/v1/sessions/owned-session") return { session: { id: "owned-session", mode: "chat", status: "working" } };
      if (endpoint === "/api/v1/sessions/owned-session/conversation?limit=100") return { turns: [{ id: turn, state: "running" }], messages };
      throw new Error("Session is not owned");
    },
    observeTui: async () => { throw new Error("not a TUI fixture"); },
  });
  const observed = await upstream.observe("owned-session");
  assert.equal(observed.answer, "verified part", "streaming must not become terminal answer evidence");
  assert.match(observed.liveOutput, /streaming partial/);
  assert.ok(Buffer.byteLength(observed.liveOutput, "utf8") <= 4096);
  assert.doesNotMatch(observed.liveOutput, /OTHER_TURN_SECRET|user message/);
  turn = "new-turn";
  const current = await upstream.observe("owned-session");
  assert.equal(current.liveOutput, "", "old turn output is not current output");
  await assert.rejects(upstream.observe("bad/session"), /valid AO session ID/);
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

test("the AO harness list waits for fresh install checks and re-checks after a minute", async () => {
  const { createAgentInventory } = require("../electron/agent-orchestrator-upstream.cjs");
  let clock = 0;
  const calls = [];
  const fresh = { supported: [{ id: "codex" }, { id: "opencode" }], installed: [{ id: "codex" }, { id: "opencode" }] };
  const partial = { supported: fresh.supported, installed: [{ id: "codex" }] };
  const api = async (method, endpoint) => { calls.push(`${method} ${endpoint}`); return method === "POST" ? fresh : partial; };
  const inventory = createAgentInventory(api, { now: () => clock, recheckMs: 60_000 });
  assert.deepEqual(await inventory(), fresh, "the first list runs the checks instead of reading half-finished ones");
  clock = 30_000;
  assert.deepEqual(await inventory(), partial, "within a minute the cached list is read");
  clock = 61_000;
  await inventory();
  assert.deepEqual(calls, ["POST /api/v1/agents/refresh", "GET /api/v1/agents", "POST /api/v1/agents/refresh"]);

  const older = createAgentInventory(async (method) => { if (method === "POST") throw new Error("404"); return partial; });
  assert.deepEqual(await older(), partial, "a daemon without refresh still answers the plain list");
});
