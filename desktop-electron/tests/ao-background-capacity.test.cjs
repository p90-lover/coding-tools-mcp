"use strict";

// Reported 2026-11-03: eight split-view chats refreshing together filled the local service's queue,
// and 25 background reads failed as "HEADLESS_CAPACITY: request admission is full", each shown as a
// "Something went wrong" toast or under its chat.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const surface = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8").replace(/\r\n/g, "\n");
const FULL = "IPC_TRANSPORT_FAILED: apps.call failed: HEADLESS_CAPACITY: request admission is full (the launcher's queue did not clear in time)";

/** moduleCall and its helpers, with `call` as the app's apps.call and pauses that end at once. */
function load(call) {
  const start = surface.indexOf("const SHARED_READS = ");
  const end = surface.indexOf("\n}\n", surface.indexOf("async function callModule(")) + 3;
  assert.ok(start > 0 && end > start, "moduleCall and its helpers are in AgentOrchestratorSurface.tsx");
  const pauses = [];
  const context = {
    Map, Set, Error, Promise, JSON, Math, String, Array,
    setTimeout: (resolve, ms) => { pauses.push(ms); return setImmediate(resolve); },
    getCodingToolsClient: () => ({ apps: { call } }),
  };
  vm.runInNewContext(ts.transpileModule(`${surface.slice(start, end).replace(/^export /gm, "")}
globalThis.api = { moduleCall, isCapacityError, spreadInterval };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { ...context.api, pauses };
}

const ok = (result) => ({ ok: true, result: { ok: true, ...result } });

test("a background read the service had no room for is sent again after a spread-out pause", async () => {
  let calls = 0;
  const { moduleCall, pauses } = load(async () => {
    calls += 1;
    if (calls < 3) throw new Error(FULL);
    return ok({ status: "running" });
  });
  assert.equal((await moduleCall("run_status", { workspaceId: "ws", runId: "run" })).status, "running");
  assert.equal(calls, 3);
  assert.equal(pauses.length, 2);
  assert.ok(pauses[0] >= 1500 && pauses[0] <= 2250, `first pause ${pauses[0]} ms`);
  assert.ok(pauses[1] >= 3500 && pauses[1] <= 5250, `second pause ${pauses[1]} ms`);
});

test("it gives up after two retries, and never retries other errors or calls that may write", async () => {
  let calls = 0;
  const full = load(async () => { calls += 1; throw new Error(FULL); });
  await assert.rejects(full.moduleCall("harness_status", { workspaceId: "ws" }), /HEADLESS_CAPACITY/);
  assert.equal(calls, 3, "the first try and two retries");

  calls = 0;
  await assert.rejects(full.moduleCall("chat_send", { workspaceId: "ws" }), /HEADLESS_CAPACITY/);
  assert.equal(calls, 1, "a send is never sent twice");
  await assert.rejects(full.moduleCall("observe", { workspaceId: "ws" }), /HEADLESS_CAPACITY/);
  assert.equal(calls, 2, "observe may act, so it is not retried either");

  let other = 0;
  const failing = load(async () => { other += 1; throw new Error("AO run not found in this workspace"); });
  await assert.rejects(failing.moduleCall("runs", { workspaceId: "ws" }), /AO run not found/);
  assert.equal(other, 1);
});

test("the contentless chat recovery is retried: it only reads and never sends", async () => {
  let calls = 0;
  const { moduleCall } = load(async () => { calls += 1; if (calls === 1) throw new Error(FULL); return ok({ message: "kept" }); });
  assert.equal((await moduleCall("chat_recover", { workspaceId: "ws" })).message, "kept");
  assert.equal(calls, 2);
});

test("panes reading the same run status or harness status at once share one call", async () => {
  let calls = 0;
  let answer;
  const { moduleCall } = load(() => { calls += 1; return new Promise(resolve => { answer = resolve; }); });
  const reads = Array.from({ length: 8 }, () => moduleCall("harness_status", { workspaceId: "ws", runId: "run", nodeId: "n" }));
  await new Promise(resolve => setImmediate(resolve));
  answer(ok({ status: { connected: true } }));
  const results = await Promise.all(reads);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status.connected === true));
  moduleCall("run_status", { workspaceId: "ws", runId: "run" });
  moduleCall("run_status", { workspaceId: "ws", runId: "run" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("capacity errors are told apart, and poll periods drift up to a fifth longer", () => {
  const { isCapacityError, spreadInterval } = load(async () => ok({}));
  assert.equal(isCapacityError(new Error(FULL)), true);
  assert.equal(isCapacityError(new Error("Headless launcher queue is full; wait for pending work to finish")), true);
  assert.equal(isCapacityError(new Error("AO run not found in this workspace")), false);
  const periods = Array.from({ length: 200 }, () => spreadInterval(3000));
  assert.ok(periods.every(ms => ms >= 3000 && ms <= 3600));
  assert.ok(new Set(periods).size > 20, "panes get different periods");
});

test("the two 3 s background polls drop capacity errors instead of showing them, and spread their periods", () => {
  const silent = surface.match(/if \(live && !isCapacityError\(cause\)\) setError\(/g) ?? [];
  assert.equal(silent.length, 2, "the run status poll and the harness status poll");
  assert.equal((surface.match(/setInterval\(\(\) => void refresh\(\), spreadInterval\(3000\)\)/g) ?? []).length, 2);
  assert.doesNotMatch(surface, /setInterval\(\(\) => void refresh\(\), 3000\)/);
});
