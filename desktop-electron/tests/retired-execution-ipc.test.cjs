"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const handlers = new Map();
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === "handle"
    && ts.isStringLiteral(node.arguments[0])) {
    handlers.set(node.arguments[0].text, node.arguments[1].getText(file));
  }
  ts.forEachChild(node, visit);
}
visit(file);

function handler(channel, context) {
  assert.ok(handlers.has(channel), channel);
  return vm.runInNewContext(`(${handlers.get(channel)})`, context);
}

test("retired legacy execution mutations stop at IPC admission", async () => {
  const calls = [];
  const context = {
    assertFocusedMainWindow: () => calls.push("focus"),
    headlessHost: { request: async () => { calls.push("headless"); return {}; } },
    providerNetworkReady: async () => { calls.push("provider-network"); return {}; },
    createProviderExecutionPlan: () => { calls.push("provider-plan"); return {}; },
    executionSettingsPayload: () => { calls.push("settings"); return {}; },
    logger: { info: () => calls.push("log") },
  };
  const provider = handler("coding-tools:execution:provider", context);
  const update = handler("coding-tools:execution:update", context);
  for (const engine of ["paseo", "anneal"]) {
    const input = new Proxy({
      operation: "configure", settings: { engine }, providerAccountId: "account-1",
      controlCredential: "control-secret", credential: "provider-secret",
    }, { get(target, key) { calls.push("read:" + String(key)); return target[key]; } });
    await assert.rejects(provider({}, input), {
      message: "Retired legacy execution mutation: provider",
    });
  }
  const updateInput = new Proxy({ change: { operation: "start" }, confirm: true }, {
    get(target, key) { calls.push("read:" + String(key)); return target[key]; },
  });
  await assert.rejects(update({}, updateInput), {
    message: "Retired legacy execution mutation: update",
  });
  assert.deepEqual(calls, []);
});

test("legacy execution read forces read-only recovery", async () => {
  const calls = [];
  const read = handler("coding-tools:execution:read", {
    assertFocusedMainWindow: () => {},
    headlessHost: { request: async (url, body) => { calls.push([url, body]); return { ok: true }; } },
  });
  await read({}, { workspaceId: "workspace-1", refreshSource: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/v1/execution/read");
  assert.equal(calls[0][1].refresh_source, false);
});

test("retired upstream-act refuses before controller configuration", async () => {
  const calls = [];
  const act = handler("launcher:upstream-tool-act", {
    assertFocusedMainWindow: () => calls.push("focus"),
    externalServicesController: {
      upstreamConfiguration: () => { calls.push("config"); return { executionEndpoint: "http://127.0.0.1:1" }; },
      loopbackRequest: () => { calls.push("loopback"); return { origin: "http://127.0.0.1:1" }; },
    },
    actUpstream: () => { calls.push("transport"); return {}; },
  });
  for (const toolId of ["paseo", "anneal", "codex-router", "commandcode-proxy"]) {
    assert.throws(() => act({}, { toolId, op: "start" }), /retired/i);
  }
  assert.deepEqual(calls, []);
  for (const channel of ["coding-tools:tools:call", "coding-tools:native-codex:status", "coding-tools:apps:call"]) {
    assert.ok(handlers.has(channel), channel);
  }
});
