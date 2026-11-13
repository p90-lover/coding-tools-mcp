"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createAgentOrchestratorUpstream } = require("../electron/agent-orchestrator-upstream.cjs");
const { RUNTIME_METHODS, HARNESS_METHODS, inspectRuntime, createOrchestratorHandler } = require("../electron/orchestrator-handler.cjs");
const { BACKEND_MODULES } = require("../electron/backend-bundle.cjs");

test("the vendored handler matches its pinned source provenance", () => {
  const fs = require("node:fs");
  const { createHash } = require("node:crypto");
  const provenance = require("../vendor/orchestrator-handler.json");
  const { HANDLER_VERSION, CONTRACT_VERSION } = require("../electron/orchestrator-handler.cjs");
  const source = fs.readFileSync(path.join(__dirname, "../electron/orchestrator-handler.cjs"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(createHash("sha256").update(source).digest("hex"), provenance.sha256);
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.version, HANDLER_VERSION);
  assert.equal(provenance.contractVersion, CONTRACT_VERSION);
});

test("the actual AO adapter uses the complete handler contract without starting an engine", () => {
  const runtime = createAgentOrchestratorUpstream({
    resourceRoot: path.resolve(__dirname, "../../aiTemp/orchestrator-contract/resources"),
    dataRoot: path.resolve(__dirname, "../../aiTemp/orchestrator-contract/data"),
  });
  assert.equal(inspectRuntime(runtime).shapeCompatible, true);
  assert.deepEqual(Object.keys(runtime).sort(), [...RUNTIME_METHODS, "harness"].sort());
  assert.deepEqual(Object.keys(runtime.harness).sort(), [...HARNESS_METHODS].sort());
  assert.ok(Object.isFrozen(runtime), "the production factory returns the immutable handler boundary");
  assert.ok(Object.isFrozen(runtime.harness));
  assert.equal(runtime.snapshot().state, "stopped");
  assert.ok(BACKEND_MODULES.includes("orchestrator-handler.cjs"));
});

test("all handler operations preserve exact values and invoke the same engine once", async () => {
  const runtime = { harness: {} };
  const result = {};
  let calls = [];
  for (const [scope, names] of [[runtime, RUNTIME_METHODS], [runtime.harness, HARNESS_METHODS]]) {
    for (const name of names) scope[name] = function (...args) { calls.push({ receiver: this, name, args }); return result; };
  }
  const handler = createOrchestratorHandler({ runtime });
  const input = { signal: new AbortController().signal };
  for (const [scope, proxy, names] of [[runtime, handler, RUNTIME_METHODS], [runtime.harness, handler.harness, HARNESS_METHODS]]) {
    for (const name of names) {
      calls = [];
      const method = proxy[name];
      assert.strictEqual(method(input, undefined, "turn-1"), result, name);
      assert.equal(calls.length, 1, name);
      assert.strictEqual(calls[0].receiver, scope, name);
      assert.deepEqual(calls[0].args, [input, undefined, "turn-1"], name);
      assert.strictEqual(calls[0].args[0], input, name);
    }
  }
  const error = Object.assign(new Error("unknown send outcome"), { code: "AMBIGUOUS" });
  const rejected = Promise.reject(error);
  runtime.harness.send = () => rejected;
  const asyncHandler = createOrchestratorHandler({ runtime });
  const response = asyncHandler.harness.send("session-1", "message", "request-1");
  assert.strictEqual(response, rejected);
  await assert.rejects(response, actual => actual === error);
});

test("incomplete engines fail closed rather than dropping a Coding Tools operation", () => {
  const runtime = { harness: {} };
  for (const name of RUNTIME_METHODS) runtime[name] = () => assert.fail("must not invoke engine");
  for (const name of HARNESS_METHODS) runtime.harness[name] = () => assert.fail("must not invoke engine");
  delete runtime.harness.setContextWindow;
  assert.throws(() => createOrchestratorHandler({ runtime }), /harness.setContextWindow/);
  assert.throws(() => createOrchestratorHandler({ runtime, contractVersion: 0 }), /Unsupported Orchestrator contract version/);
});
