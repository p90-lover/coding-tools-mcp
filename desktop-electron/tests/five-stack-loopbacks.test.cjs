"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FIVE_STACK_LOOPBACKS,
  MCP_TOOLS,
  fingerprintStatus,
  probeAll,
  publicLoopbackMap,
  sanitizePublic,
} = require("../electron/five-stack-loopbacks.cjs");

test("locked five-stack loopbacks hard-target the SoT ports", () => {
  assert.equal(FIVE_STACK_LOOPBACKS.cpa.origin, "http://127.0.0.1:8317");
  assert.equal(FIVE_STACK_LOOPBACKS.cpa.port, 8317);
  assert.equal(FIVE_STACK_LOOPBACKS["codex-router"].origin, "http://127.0.0.1:4202");
  assert.equal(FIVE_STACK_LOOPBACKS["commandcode-proxy"].origin, "http://127.0.0.1:9090");
  assert.deepEqual(FIVE_STACK_LOOPBACKS["commandcode-proxy"].probes, [
    "http://127.0.0.1:9090/health",
    "http://127.0.0.1:9090/v1/models",
  ]);
  assert.deepEqual(FIVE_STACK_LOOPBACKS["commandcode-proxy"].fallbackProbes, [
    "http://127.0.0.1:3050/health",
    "http://127.0.0.1:3050/v1/models",
  ]);
  assert.equal(FIVE_STACK_LOOPBACKS.paseo.origin, "http://127.0.0.1:6768");
  assert.equal(FIVE_STACK_LOOPBACKS.paseo.execution, "ws://127.0.0.1:6768/ws");
  assert.equal(FIVE_STACK_LOOPBACKS.paseo.protocol, "v1");
  assert.equal(FIVE_STACK_LOOPBACKS.anneal.origin, "http://127.0.0.1:3000");
  assert.equal(FIVE_STACK_LOOPBACKS.anneal.preview, "http://127.0.0.1:3000/#/tasks");
  const map = publicLoopbackMap();
  assert.equal(map.stacks.paseo.execution.includes("6767"), false);
  assert.equal(MCP_TOOLS.some((tool) => tool.name === "five_stack_status"), true);
});

test("CommandCode falls back to :3050 when :9090 is offline", async () => {
  const snapshot = await probeAll({
    timeoutMs: 200,
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.port === "3050") {
        return { status: 200, ok: true, headers: { get: () => "application/json" } };
      }
      const error = new Error("offline");
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    },
  });
  const commandcode = snapshot.stacks.find((stack) => stack.id === "commandcode-proxy");
  assert.equal(commandcode.listening, true);
  assert.equal(commandcode.fallbackUsed, true);
  assert.equal(commandcode.origin, "http://127.0.0.1:3050");
});

test("health snapshots never include secrets", () => {
  const sanitized = sanitizePublic({
    listening: true,
    callerKey: "secret-caller",
    proxyApiKey: "secret-proxy",
    managementKey: "secret-mgmt",
    origin: "http://127.0.0.1:8317",
  });
  assert.equal(sanitized.callerKey, undefined);
  assert.equal(sanitized.proxyApiKey, undefined);
  assert.equal(sanitized.managementKey, undefined);
  assert.equal(sanitized.origin, "http://127.0.0.1:8317");
  const left = fingerprintStatus({ stacks: [{ id: "cpa", listening: true, fallbackUsed: false, statusCode: 401, error: null }] });
  const right = fingerprintStatus({ stacks: [{ id: "cpa", listening: true, fallbackUsed: false, statusCode: 401, error: null }] });
  assert.equal(left, right);
});
