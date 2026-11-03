"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { HeadlessHost } = require("../electron/headless-host.cjs");
const { fetchOffThread } = require("../electron/off-thread-run.cjs");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

function fixture(harness = "ao:codex", options = {}) {
  const calls = [];
  const run = { id: "run-1", workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", cancelled: false,
    nodes: [{ id: "lead", state: "finished", route: { harness_id: harness }, receipt: { thread_id: "session-1" } }] };
  const world = { runs: [run], settled: false, calls, run };
  world.workflow = createAgentOrchestratorWorkflow({
    ...options,
    requestHeadless: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: world.runs };
      if (endpoint === "/api/v1/ao/harness/compact") return world.nativeRequest ? world.nativeRequest(endpoint, body) : { ok: true, status: body.status ? world.settled ? "completed" : "compacting" : "in_progress" };
      if (endpoint === "/api/v1/ao/harness/disconnect" || endpoint === "/api/v1/ao/control") {
        if (world.stopRequest) return world.stopRequest(endpoint, body);
        return endpoint.endsWith("disconnect") ? { ok: true, connected: false, owned: false }
          : { ok: true, run: { ...world.run, cancelled: true } };
      }
      throw new Error(`Compaction must not edit a task or invoke a summarizer: ${endpoint}`);
    },
    aoHarness: {
      compact: async (id, options) => { calls.push({ compact: id }); options?.beforeSubmit?.("earlier"); await world.compactGate; return { compactedAt: "earlier" }; },
      compactionStatus: async (id, before) => {
        assert.equal(id, "session-1"); assert.equal(before, "earlier");
        return { status: world.settled ? "completed" : "in_progress" };
      },
      observe: async () => ({ exited: true }),
      exitAgent: async () => { if (world.agentStopError) throw world.agentStopError; return { ok: true }; },
    },
    fetchImpl: async () => { throw new Error("No separate model request is allowed"); },
  });
  return world;
}

function nativeFixture(options = {}) {
  const timers = new Set();
  const world = fixture("codex-native", {
    confirm: async () => true,
    setTimer(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    ...options,
  });
  world.timers = timers;
  return world;
}

const scope = { workspaceId: "ws-1", taskId: "task-1" };
const owner = { workspaceId: "ws-1", runId: "run-1", nodeId: "lead" };

test("confirmed native Stop clears only the matching owner's pending compaction and timer", async t => {
  let admissions = 0;
  const world = nativeFixture({ findCodexExecutable: () => { admissions += 1; return "G:/fixture/codex.exe"; }, exists: () => true });
  t.after(() => world.workflow.dispose());
  world.runs.push({ ...world.run, id: "run-2", project_id: "task-2", nodes: [{ ...world.run.nodes[0], receipt: { thread_id: "session-2" } }] },
    { ...world.run, workspace_id: "ws-2" });
  const otherScopes = [{ workspaceId: "ws-1", taskId: "task-2" }, { workspaceId: "ws-2", taskId: "task-1" }];
  const first = await world.workflow.call("compact_chat", scope);
  const others = await Promise.all(otherScopes.map(args => world.workflow.call("compact_chat", args)));
  assert.equal(world.timers.size, 3);
  await world.workflow.call("stop_harness", { ...owner, nodeId: "another-node" });
  assert.equal(world.timers.size, 3, "another node's acknowledgement cannot release this owner");
  await world.workflow.call("stop_harness", owner);
  assert.equal(world.timers.size, 2);
  assert.equal(world.calls.filter(call => call.endpoint?.endsWith("/compact") && !call.body.status).length, 3, "Stop never submits model work");
  world.nativeRequest = async (_endpoint, body) => {
    if (body.status && body.workspace_id === owner.workspaceId && body.run_id === owner.runId) {
      const error = new Error("The chat's native agent is not connected"); error.code = "AO_HARNESS_NOT_CONNECTED"; throw error;
    }
    return { ok: true, status: "in_progress" };
  };
  await assert.rejects(world.workflow.call("chat_send", { ...scope, message: "continue" }), /saved team wasn't found/);
  assert.equal(admissions, 1, "public chat_send reaches normal admission rather than the stopped compaction's missing receipt");
  world.nativeRequest = null;
  for (let i = 0; i < otherScopes.length; i++) assert.equal((await world.workflow.call("compact_chat", { ...otherScopes[i], status: true })).compactionId, others[i].compactionId);
  const next = await world.workflow.call("compact_chat", scope);
  assert.notEqual(next.compactionId, first.compactionId, "a new explicit request can pass the stopped compaction gate");
});

test("uncertain or nonterminal native Stop retains the stable compaction without replay", async t => {
  for (const response of [new Error("lost stop response"), { ok: false }, { ok: true },
    { ok: true, connected: true, owned: false }, { ok: true, connected: false, owned: true }]) await t.test(JSON.stringify(response), async t => {
    const world = nativeFixture(); t.after(() => world.workflow.dispose());
    const first = await world.workflow.call("compact_chat", scope);
    world.stopRequest = async () => { if (response instanceof Error) throw response; return response; };
    await world.workflow.call("stop_harness", owner).catch(() => {});
    assert.equal(world.timers.size, 1);
    await assert.rejects(world.workflow.call("compact_chat", scope), /already compacting/);
    assert.equal((await world.workflow.call("compact_chat", { ...scope, status: true })).compactionId, first.compactionId);
    assert.equal(world.calls.filter(call => call.endpoint?.endsWith("/compact") && !call.body.status).length, 1);
  });
});

test("mission Stop releases compaction only after a terminal owner acknowledgement, not synthesized success", async t => {
  for (const outcome of ["confirmed", "lost", "refused", "foreign", "nonterminal"]) await t.test(outcome, async t => {
    const world = nativeFixture(); t.after(() => world.workflow.dispose());
    const first = await world.workflow.call("compact_chat", scope);
    world.stopRequest = async () => {
      if (outcome === "lost") throw new Error("lost owner Stop");
      if (outcome === "refused") return { ok: false };
      return { ok: true, run: { ...world.run, id: outcome === "foreign" ? "other-run" : world.run.id, cancelled: outcome !== "nonterminal" } };
    };
    const stopped = await world.workflow.call("control_run", { ...owner, action: "stop" });
    assert.equal(stopped.ok, true, "the existing uncertain Stop fallback may synthesize success");
    if (outcome === "confirmed") {
      assert.equal(world.timers.size, 0);
      await assert.rejects(world.workflow.call("compact_chat", { ...scope, status: true, compactionId: first.compactionId }), /replaced/);
    } else {
      assert.equal(world.timers.size, 1);
      assert.equal((await world.workflow.call("compact_chat", { ...scope, status: true })).compactionId, first.compactionId);
    }
    assert.equal(world.calls.filter(call => call.endpoint?.endsWith("/compact") && !call.body.status).length, 1);
  });
});

test("late native compaction start and status replies cannot resurrect or replace a stopped operation", async t => {
  for (const waiting of ["start", "status"]) await t.test(waiting, async t => {
    const world = nativeFixture(); t.after(() => world.workflow.dispose());
    let release, observed;
    const entered = new Promise(resolve => { observed = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let waitingOnce = true;
    world.nativeRequest = async (_endpoint, body) => {
      if (waitingOnce && body.status === (waiting === "status")) { waitingOnce = false; observed(); return gate; }
      return { ok: true, status: "in_progress" };
    };
    let pending;
    if (waiting === "start") pending = world.workflow.call("compact_chat", scope);
    else {
      await world.workflow.call("compact_chat", scope);
      pending = world.workflow.call("compact_chat", { ...scope, status: true });
    }
    const rejected = assert.rejects(pending, /changed|replaced|stopped/);
    await entered;
    await world.workflow.call("stop_harness", owner);
    const replacement = await world.workflow.call("compact_chat", scope);
    release({ ok: true, status: "completed" });
    await rejected;
    assert.equal((await world.workflow.call("compact_chat", { ...scope, status: true })).compactionId, replacement.compactionId);
    assert.equal(world.timers.size, 1, "only the replacement watcher survives");
  });
});

test("a late Stop acknowledgement cannot clear a replacement compaction under the same chat key", async t => {
  const world = nativeFixture(); t.after(() => world.workflow.dispose());
  await world.workflow.call("compact_chat", scope);
  let acknowledge, entered;
  const stopping = new Promise(resolve => { entered = resolve; });
  world.stopRequest = () => { entered(); return new Promise(resolve => { acknowledge = resolve; }); };
  const stop = world.workflow.call("stop_harness", owner);
  await stopping;
  world.settled = true;
  assert.equal((await world.workflow.call("compact_chat", { ...scope, status: true })).status, "completed");
  world.settled = false;
  const replacement = await world.workflow.call("compact_chat", scope);
  acknowledge({ ok: true, connected: false, owned: false });
  await stop;
  const current = await world.workflow.call("compact_chat", { ...scope, status: true });
  assert.equal(current.compactionId, replacement.compactionId);
  assert.equal(current.status, "in_progress");
});

test("a partial mission Stop with unconfirmed external shutdown retains the pending compaction", async t => {
  const world = fixture(); t.after(() => world.workflow.dispose());
  const first = await world.workflow.call("compact_chat", scope);
  world.agentStopError = new Error("external shutdown is uncertain");
  await assert.rejects(world.workflow.call("control_run", { ...owner, action: "stop" }), /stop could not be confirmed/);
  assert.equal((await world.workflow.call("compact_chat", { ...scope, status: true })).compactionId, first.compactionId);
  await assert.rejects(world.workflow.call("compact_chat", scope), /already compacting/);
  assert.equal(world.calls.filter(call => call.compact).length, 1, "no model operation is replayed after partial Stop");
});

test("/compact uses the owned AO session, and acceptance is not completion", async () => {
  const world = fixture();
  const started = await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  assert.equal(started.status, "in_progress");
  assert.deepEqual(world.calls.find(call => call.compact), { compact: "session-1" });
  const pending = await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true });
  assert.equal(pending.status, "in_progress");
  await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /already.*compact/i);
  await assert.rejects(world.workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "next" }), /still running|compact/i);
  world.settled = true;
  assert.equal((await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true })).status, "completed");
  assert.equal(world.calls.filter(call => call.compact).length, 1);
});

test("native compaction uses the run/node boundary, never a caller-supplied thread", async () => {
  const world = fixture("codex-native");
  const args = { workspaceId: "ws-1", taskId: "task-1", threadId: "someone-elses-thread" };
  const started = await world.workflow.call("compact_chat", args);
  assert.equal(started.status, "in_progress");
  const request = world.calls.find(call => call.endpoint === "/api/v1/ao/harness/compact");
  assert.deepEqual(request.body, { workspace_id: "ws-1", run_id: "run-1", node_id: "lead", status: false, request_id: `compact-${started.compactionId}` });
  world.settled = true;
  assert.equal((await world.workflow.call("compact_chat", { ...args, status: true })).status, "completed");
});

test("a native start response lost after admission is reconciled by its same receipt without another start", async t => {
  let starts = 0, receipt, completed = false;
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text);
      if (!body.status) { starts += 1; receipt = body.request_id; return; } // admitted; deliberately lose the response
      response.end(JSON.stringify({ ok: true, status: body.request_id === receipt && completed ? "completed" : "in_progress" }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const host = Object.create(HeadlessHost.prototype);
  host.ensureStarted = async () => ({ endpoint: `http://127.0.0.1:${server.address().port}`, token: "fixture" });
  // Requests go out from a worker thread that the first one starts; in the app, the service's own
  // health check does. Started here, the 30 ms start below is sent, and only its answer is lost.
  await (await fetchOffThread(`http://127.0.0.1:${server.address().port}/`, { method: "POST", body: JSON.stringify({ status: "warm" }) })).text();
  const world = fixture("codex-native");
  t.after(() => world.workflow.dispose());
  world.nativeRequest = (endpoint, body) => host.request(endpoint, body, { timeout: body.status ? 1000 : 30 });
  const scope = { workspaceId: "ws-1", taskId: "task-1" };
  const start = await world.workflow.call("compact_chat", scope);
  assert.equal(start.status, "in_progress");
  assert.equal(start.uncertain, true, "the HTTP timeout is neither refusal nor completion");
  assert.equal(receipt, `compact-${start.compactionId}`);
  await assert.rejects(world.workflow.call("compact_chat", scope), /already compacting/);
  assert.equal(starts, 1, "a retry only observes the already admitted request");
  completed = true; // provider work completes after the HTTP caller has timed out
  const settled = await world.workflow.call("compact_chat", scope);
  assert.equal(settled.status, "completed");
  assert.equal(settled.compactionId, start.compactionId);
  assert.equal(starts, 1);
});

test("a confirmed permission refusal does not retain a compaction busy latch", async t => {
  const world = fixture("codex-native");
  let denied = true, starts = 0;
  const server = http.createServer((_request, response) => {
    starts += 1;
    response.writeHead(denied ? 403 : 202, { "content-type": "application/json" });
    response.end(JSON.stringify(denied ? { error: { code: "AO_LOCAL_CONFIRMATION_REQUIRED", message: "Compact the selected chat from the local app" } } : { ok: true, status: "in_progress" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const host = Object.create(HeadlessHost.prototype);
  host.ensureStarted = async () => ({ endpoint: `http://127.0.0.1:${server.address().port}`, token: "fixture" });
  world.nativeRequest = (endpoint, body) => host.request(endpoint, body);
  try {
    const scope = { workspaceId: "ws-1", taskId: "task-1" };
    await assert.rejects(world.workflow.call("compact_chat", scope), /local app/);
    denied = false;
    assert.equal((await world.workflow.call("compact_chat", scope)).status, "in_progress");
    assert.equal(starts, 2, "a known unsubmitted refusal permits a new explicit request");
  } finally { world.workflow.dispose(); }
});

test("an AO response lost after POST uses its captured baseline, never an older compaction timestamp", async () => {
  let completed = false, starts = 0;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => ({ ok: true, runs: [{ id: "r", workspace_id: "ws", project_id: "task", execution_mode: "single", nodes: [
      { id: "one", state: "finished", route: { harness_id: "ao:codex" }, receipt: { thread_id: "session" } },
    ] }] }),
    aoHarness: {
      compact: async (_id, { beforeSubmit }) => { starts += 1; beforeSubmit("old-compaction"); throw new Error("fetch failed"); },
      compactionStatus: async (_id, before) => { assert.equal(before, "old-compaction"); return { status: completed ? "completed" : "in_progress" }; },
    },
  });
  try {
    const scope = { workspaceId: "ws", taskId: "task" };
    const result = await workflow.call("compact_chat", scope);
    assert.equal(result.uncertain, true);
    await assert.rejects(workflow.call("compact_chat", scope), /already compacting/);
    completed = true;
    assert.equal((await workflow.call("compact_chat", scope)).status, "completed");
    assert.equal(starts, 1);
  } finally { workflow.dispose(); }
});

test("native compaction status preserves shared reads while a compaction start invalidates them", async () => {
  const world = fixture("codex-native", { runReadFreshMs: 60_000 });
  try {
    const scope = { workspaceId: "ws-1", taskId: "task-1" };
    const reads = () => world.calls.filter(call => call.endpoint === "/api/v1/ao/read").length;
    await world.workflow.call("runs", { workspaceId: "ws-1" });
    assert.equal(reads(), 1);
    await world.workflow.call("compact_chat", scope);
    await world.workflow.call("runs", { workspaceId: "ws-1" });
    assert.equal(reads(), 2, "starting compaction invalidates the pre-compaction read");
    await world.workflow.call("compact_chat", { ...scope, status: true });
    await world.workflow.call("runs", { workspaceId: "ws-1" });
    assert.equal(reads(), 2, "a status-only observation does not invalidate run/board reads");
  } finally { world.workflow.dispose(); }
});

test("compaction refuses busy, missing and team sessions without any model call", async () => {
  for (const change of [world => { world.run.nodes[0].state = "running"; }, world => { world.run.nodes[0].receipt = null; },
    world => { world.run.execution_mode = "team"; }, world => { world.runs = []; }]) {
    const world = fixture(); change(world);
    await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /progress|session|single|chat/i);
    assert.equal(world.calls.some(call => call.compact), false);
  }
});

test("an unacknowledged start cannot complete from an earlier compaction timestamp", async () => {
  const world = fixture();
  let release;
  world.compactGate = new Promise(resolve => { release = resolve; });
  world.settled = true;
  const starting = world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true })).status, "in_progress");
  release(); await starting;
  world.workflow.dispose();
});

test("foreign-workspace runs never authorize compaction", async () => {
  const world = fixture();
  world.run.workspace_id = "other";
  await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /live agent session/);
  assert.equal(world.calls.some(call => call.compact), false);
});

test("late compaction results cannot follow a replaced chat session", async () => {
  const world = fixture();
  await world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  world.run.nodes[0].receipt.thread_id = "replacement";
  await assert.rejects(world.workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1", status: true }), /changed|replaced/i);
});
