"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

const IDS = ["commandcode-proxy", "paseo", "anneal"];

test("module inspection reports managed runtime state, not bundled source presence", async () => {
  const inspected = [];
  const host = createCodingToolsAppsHost({
    services: { inspect: async id => {
      inspected.push(id);
      return { id, status: "offline", error: "daemon is not running" };
    } },
  });
  for (const id of IDS) {
    const result = await host.call(id, "inspect");
    assert.equal(result.result.status, "offline", id);
    assert.equal(result.result.error, "daemon is not running");
    assert.equal(result.transport, "in-process");
  }
  assert.deepEqual(inspected, IDS);
});

test("CommandCode health and banner probe the managed backend", async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", proxy: "actual-commandcode-runtime" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = createCodingToolsAppsHost({
    services: { loopbackRequest: id => {
      assert.equal(id, "commandcode-proxy");
      return { origin: `http://127.0.0.1:${server.address().port}`, healthPath: "/health" };
    } },
  });
  for (const operation of ["health", "banner"]) {
    const result = await host.call("commandcode-proxy", operation);
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 200);
    assert.equal(result.result.json.proxy, "actual-commandcode-runtime");
  }
  assert.deepEqual(requests, ["/health", "/health"]);
});

test("Paseo plan requires its control plane and returns the real plan", async () => {
  const offline = createCodingToolsAppsHost({ getFiveStack: () => ({ ok: false }) });
  const unavailable = await offline.call("paseo", "plan", { brief: "Read-only probe" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.result.unavailable, true);
  assert.equal(unavailable.result.dependency, "paseo-runtime");
  const calls = [];
  const online = createCodingToolsAppsHost({ getFiveStack: () => ({ ok: true, value: {
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, planId: "real-plan-1" }; },
  } }) });
  const result = await online.call("paseo", "plan", { brief: "Read-only probe", workspaceId: "ws-1" });
  assert.equal(result.result.planId, "real-plan-1");
  assert.equal(calls[0].name, "paseo_plan");
  assert.equal(calls[0].args.workspaceId, "ws-1");
});

test("Anneal task lists and activity use the actual managed API operations", async () => {
  const calls = [];
  const host = createCodingToolsAppsHost({ actUpstream: async input => {
    calls.push(input);
    return { ok: true, status: 200, json: [{ id: "task-1", state: "RUNNING", operation: input.op }] };
  } });
  for (const operation of ["listTasks", "board", "activity"]) {
    const result = await host.call("anneal", operation, { taskId: "task-1" });
    assert.equal(result.result.json[0].id, "task-1");
    assert.equal(result.result.json[0].state, "RUNNING");
    assert.equal(host.isReadOnly("anneal", operation), true);
  }
  assert.deepEqual(calls.map(call => call.op), ["board", "board", "activity"]);
  assert.equal(calls[2].taskId, "task-1");
});

test("missing module services never produce synthetic successful runtime results", async () => {
  const host = createCodingToolsAppsHost();
  for (const id of IDS) assert.equal((await host.call(id, "inspect")).ok, false, id);
  const board = await host.call("anneal", "listTasks");
  assert.equal(board.ok, false);
  assert.equal(board.result.unavailable, true);
});

test("host.call retains positional, moduleId and handle forms", async () => {
  const host = createCodingToolsAppsHost({ services: { inspect: async id => ({ id, status: "ready" }) } });
  assert.equal((await host.call("commandcode-proxy", "inspect")).ok, true);
  assert.equal((await host.call({ moduleId: "commandcode-proxy", operation: "inspect" })).moduleId, "commandcode-proxy");
  assert.equal((await host.call({ handle: "commandcode-proxy", operation: "inspect" })).handle, "commandcode-proxy");
  await assert.rejects(() => host.call({ operation: "inspect" }), /Unknown Coding Tools module: missing/);
});
