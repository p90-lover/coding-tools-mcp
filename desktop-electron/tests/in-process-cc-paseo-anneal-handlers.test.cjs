"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

function forbidTcp(label) {
  const originalHttp = http.request;
  const originalHttps = require("node:https").request;
  const originalConnect = net.Socket.prototype.connect;
  const hits = [];
  function record(kind, target) {
    hits.push({ kind, target: String(target || "") });
    throw new Error(`${label} must not open TCP (${kind}: ${target})`);
  }
  http.request = function patchedHttp(target, ...rest) {
    record("http.request", target instanceof URL ? target.href : target);
    return originalHttp.call(this, target, ...rest);
  };
  require("node:https").request = function patchedHttps(target, ...rest) {
    record("https.request", target instanceof URL ? target.href : target);
    return originalHttps.call(this, target, ...rest);
  };
  net.Socket.prototype.connect = function patchedConnect(options, ...rest) {
    const target = options && typeof options === "object"
      ? `${options.host || options.hostname || ""}:${options.port || ""}`
      : options;
    record("net.connect", target);
    return originalConnect.call(this, options, ...rest);
  };
  return {
    hits,
    restore() {
      http.request = originalHttp;
      require("node:https").request = originalHttps;
      net.Socket.prototype.connect = originalConnect;
    },
  };
}

function createBareHost() {
  return createCodingToolsAppsHost({
    getFiveStack: () => ({ ok: false }),
  });
}

function assertNoLegacyPorts(payload) {
  const serialized = JSON.stringify(payload);
  assert.equal(/ECONNREFUSED/i.test(serialized), false, serialized);
  assert.equal(/127\.0\.0\.1:9090/.test(serialized) && /reachable":false/.test(serialized), false, serialized);
  assert.doesNotMatch(serialized, /Five-stack control plane is not ready/);
}

test("CommandCode health/inspect/banner succeed in-process without a :9090 listener", async () => {
  const guard = forbidTcp("commandcode-proxy");
  try {
    const host = createBareHost();
    for (const operation of ["inspect", "health", "banner"]) {
      const positional = await host.call("commandcode-proxy", operation);
      assert.equal(positional.ok, true, `positional ${operation}`);
      assert.equal(positional.transport, "in-process");
      assert.equal(positional.result.listening, false);
      assert.equal(positional.result.ok, true);
      assert.equal(positional.result.reachable, undefined);
      assertNoLegacyPorts(positional);

      const objectForm = await host.call({
        moduleId: "commandcode-proxy",
        operation,
      });
      assert.equal(objectForm.ok, true, `object ${operation}`);
      assert.equal(objectForm.handle, "commandcode-proxy");
      assert.equal(objectForm.result.status === "ready" || objectForm.result.status === "ok", true);
    }
    const invoked = await host.invoke({ handle: "commandcode-proxy", operation: "health" });
    assert.equal(invoked.ok, true);
    assert.equal(invoked.result.proxy, "commandcode-proxy");
    assert.equal(invoked.result.source.present, true);
    assert.equal(guard.hits.length, 0);
  } finally {
    guard.restore();
  }
});

test("Paseo inspect/plan succeed in-process when five-stack is not ready", async () => {
  const guard = forbidTcp("paseo");
  try {
    const host = createBareHost();
    const inspected = await host.call({ moduleId: "paseo", operation: "inspect" });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.result.status, "ready");
    assert.equal(inspected.result.listening, false);
    assert.equal(inspected.result.source.present, true);
    assertNoLegacyPorts(inspected);

    const planned = await host.invoke({
      handle: "paseo",
      operation: "plan",
      arguments: { brief: "Reproduce login", workspaceId: "ws-1" },
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.result.tool, "paseo_plan");
    assert.equal(planned.result.status, "planned");
    assert.equal(planned.result.listening, false);
    assertNoLegacyPorts(planned);

    const run = await host.call("paseo", "run", { workspaceId: "ws-1" });
    assert.equal(run.ok, false);
    assert.equal(run.result.softFail, true);
    assert.equal(run.result.unavailable, true);
    assert.equal(run.result.dependency, "paseo-runtime");
    assert.equal(guard.hits.length, 0);
  } finally {
    guard.restore();
  }
});

test("Anneal inspection is local but task listing requires an actual runtime", async () => {
  const guard = forbidTcp("anneal");
  try {
    const host = createBareHost();
    const inspected = await host.call({ handle: "anneal", operation: "inspect" });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.result.status, "ready");
    assert.equal(inspected.result.listening, false);
    assertNoLegacyPorts(inspected);

    const listed = await host.call("anneal", "listTasks");
    assert.equal(listed.ok, false);
    assert.equal(listed.result.unavailable, true);
    assert.equal(listed.result.dependency, "anneal-runtime");
    assert.equal(listed.result.listening, false);

    const board = await host.invoke({ handle: "anneal", operation: "board" });
    assert.equal(board.ok, false);
    assert.equal(board.result.unavailable, true);
    assertNoLegacyPorts(board);
    assert.equal(guard.hits.length, 0);
  } finally {
    guard.restore();
  }
});

test("Anneal returns real managed tasks and calls the distinct activity endpoint", async () => {
  const calls = [];
  const host = createCodingToolsAppsHost({
    actUpstream: async (input) => {
      calls.push(input);
      return { ok: true, body: input.op === "board" ? [{ id: "remote-1", name: "Real task", status: "IN_PROGRESS" }] : [] };
    },
  });
  const board = await host.call("anneal", "board");
  assert.equal(board.ok, true);
  assert.equal(board.result.tasks[0].id, "remote-1");
  assert.equal(board.result.source, "managed-anneal-api");
  await host.call("anneal", "activity", { taskId: "remote-1" });
  assert.deepEqual(calls.map((call) => call.op), ["board", "activity"]);

  const unavailable = createCodingToolsAppsHost({ actUpstream: async () => {
    throw new Error("database connection refused 127.0.0.1:5432");
  } });
  const failed = await unavailable.call("anneal", "board");
  assert.equal(failed.ok, false);
  assert.equal(failed.result.dependency, "postgres");
});

test("host.call accepts both positional and contract object forms", async () => {
  const host = createBareHost();
  const positional = await host.call("commandcode-proxy", "inspect");
  const objectForm = await host.call({
    moduleId: "commandcode-proxy",
    operation: "inspect",
    arguments: {},
  });
  const handleForm = await host.call({
    handle: "commandcode-proxy",
    operation: "inspect",
  });
  assert.equal(positional.ok, true);
  assert.equal(objectForm.ok, true);
  assert.equal(handleForm.ok, true);
  assert.equal(objectForm.moduleId, "commandcode-proxy");
  assert.equal(handleForm.handle, "commandcode-proxy");
  await assert.rejects(
    () => host.call({ operation: "inspect" }),
    /Unknown Coding Tools module: missing/,
  );
});
