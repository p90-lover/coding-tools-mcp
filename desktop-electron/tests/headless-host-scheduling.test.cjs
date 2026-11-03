"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { HeadlessHost } = require("../electron/headless-host.cjs");

const tick = () => new Promise(resolve => setImmediate(resolve));

function scheduler(t, maxInFlight = 12) {
  const host = Object.create(HeadlessHost.prototype);
  host.maxInFlight = maxInFlight;
  host.queueWaitMs = 500;
  const tickets = [];
  const pending = [];
  const take = (owner, category = "read", signal) => {
    const promise = host.takeTurn({ owner, category, signal }).then(ticket => {
      tickets.push(ticket);
      return ticket;
    });
    promise.catch(() => {});
    pending.push(promise);
    return promise;
  };
  const release = () => host.releaseTurn(tickets.shift());
  t.after(async () => {
    for (let i = 0; i < pending.length + 1; i += 1) {
      while (tickets.length) release();
      await tick();
    }
    await Promise.allSettled(pending);
  });
  return { host, take, release };
}

async function serverHost(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const host = Object.create(HeadlessHost.prototype);
  host.ensureStarted = async () => ({ endpoint: `http://127.0.0.1:${server.address().port}`, token: "synthetic-token", uiToken: "synthetic-ui-token" });
  return host;
}

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "fixture did not reach its expected state");
    await tick();
  }
}

test("slow background reads cannot consume the two control slots", async t => {
  const { host, take } = scheduler(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => take(`chat-${i}`)));
  take("chat-10");
  take("chat-11");
  let stopped = false;
  take("chat-0", "control").then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, true, "Stop must be admitted while all ordinary slots are held");
  assert.equal(host.turns.active, 11);
  assert.equal(host.turns.waiting.length, 2);
});

test("queued work rotates between chats instead of draining one chat's entire backlog", async t => {
  const { take, release } = scheduler(t, 1);
  await take("busy");
  const order = [];
  take("busy").then(() => order.push("busy-1"));
  take("busy").then(() => order.push("busy-2"));
  take("other").then(() => order.push("other"));
  release();
  await tick();
  assert.deepEqual(order, ["other"]);
  release();
  await tick();
  assert.deepEqual(order, ["other", "busy-1"]);
});

test("a full background queue keeps room for controls and rejects before sending", async t => {
  const { host, take } = scheduler(t, 1);
  host.maxQueued = 2;
  await take("busy");
  take("queued-1");
  take("queued-2");
  await assert.rejects(take("excess"), { code: "HEADLESS_QUEUE_FULL" });
  take("busy", "control");
  assert.equal(host.turns.waiting.length, 3);
});

test("cancelling an obsolete queued read removes it without consuming the next turn", async t => {
  const { host, take, release } = scheduler(t, 1);
  await take("busy");
  const controller = new AbortController();
  const cancelled = take("old-pane", "read", controller.signal);
  const checked = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  await checked;
  assert.equal(host.turns.waiting.length, 0);
  let next = false;
  take("new-pane").then(() => { next = true; });
  release();
  await tick();
  assert.equal(next, true);
});

test("identical concurrent read polls share one HTTP request, but later polls read afresh", async t => {
  let calls = 0;
  const host = await serverHost(t, (request, response) => {
    calls += 1;
    response.end(JSON.stringify({ ok: true, calls }));
  });
  const results = await Promise.all(Array.from({ length: 35 }, () => host.request("/api/v1/ao/read", { workspace_id: "ws", run_id: "run" })));
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.calls === 1));
  assert.equal((await host.request("/api/v1/ao/read", { workspace_id: "ws", run_id: "run" })).calls, 2);
  assert.equal(host.admissionStatus().coalesced, 34);
});

test("control requests reach HTTP while twenty-four distinct long-chat reads are pending", async t => {
  const held = [];
  const paths = [];
  const host = await serverHost(t, (request, response) => {
    paths.push(request.url);
    if (request.url === "/api/v1/ao/read") held.push(response);
    else response.end('{"ok":true}');
  });
  const pending = Array.from({ length: 24 }, (_, i) => host.request("/api/v1/ao/read", { workspace_id: "ws", run_id: `run-${i}` }));
  const settled = Promise.allSettled(pending);
  t.after(async () => {
    for (let i = 0; i < 4; i += 1) {
      for (const response of held.splice(0)) response.end('{"ok":true}');
      await tick();
    }
    await settled;
  });
  await until(() => held.length >= 22);
  const control = host.request("/api/v1/ao/control", { workspace_id: "ws", run_id: "run-0", action: "stop", confirm: true }, { localConfirmation: true });
  control.catch(() => {});
  await until(() => paths.includes("/api/v1/ao/control"));
  assert.deepEqual(await control, { ok: true });
  assert.equal(host.admissionStatus().active, 22);
  for (const response of held.splice(0)) response.end('{"ok":true}');
  await until(() => held.length === 2);
  for (const response of held.splice(0)) response.end('{"ok":true}');
  assert.ok((await Promise.all(pending)).every(result => result.ok));
});

test("mutations are never coalesced, retain confirmation, and invalidate in-flight read sharing", async t => {
  const held = [];
  const mutations = [];
  const host = await serverHost(t, (request, response) => {
    if (request.url === "/api/v1/ao/read") held.push(response);
    else {
      mutations.push(request.headers["x-coding-tools-local-ui"]);
      response.end('{"ok":true}');
    }
  });
  const before = host.request("/api/v1/ao/read", { workspace_id: "ws" });
  await until(() => held.length === 1);
  await Promise.all([1, 2].map(() => host.request("/api/v1/ao/control", { action: "pause" }, { localConfirmation: true })));
  const after = host.request("/api/v1/ao/read", { workspace_id: "ws" });
  await until(() => held.length === 2);
  held[0].end('{"revision":1}');
  held[1].end('{"revision":2}');
  assert.equal((await before).revision, 1);
  assert.equal((await after).revision, 2);
  assert.deepEqual(mutations, ["synthetic-ui-token", "synthetic-ui-token"]);
});

test("diagnostics are bounded, detached, and never retain payloads, tokens, or arbitrary paths", async t => {
  const host = await serverHost(t, (request, response) => response.end('{"ok":true}'));
  for (let i = 0; i < 75; i += 1) {
    await host.request("/private-path?secret=synthetic-secret", { prompt: "private prompt", api_key: "synthetic-secret", workspace_id: "ws", run_id: "run" });
  }
  const status = host.admissionStatus();
  assert.equal(status.active, 0);
  assert.equal(status.queued, 0);
  assert.equal(status.recent.length, 64);
  assert.doesNotMatch(JSON.stringify(status), /private|synthetic|prompt|api_key/);
  assert.ok(status.recent.every(row => row.queueWaitMs >= 0 && row.executionMs >= 0 && row.outcome === "completed"));
  status.recent.length = 0;
  assert.equal(host.admissionStatus().recent.length, 64);
});

test("round-robin admission reaches a third chat while two busy backlogs remain", async t => {
  const { take, release } = scheduler(t, 1);
  await take("a");
  const order = [];
  for (const owner of ["a", "a", "a", "b", "b", "b", "c"]) take(owner).then(() => order.push(owner));
  for (let i = 0; i < 3; i += 1) { release(); await tick(); }
  assert.deepEqual(order, ["b", "a", "c"]);
});

test("queue timeout is distinct from service refusal and never loses a slot", async t => {
  const { host, take, release } = scheduler(t, 1);
  await take("active");
  host.queueWaitMs = 5;
  await assert.rejects(take("timed-out"), { code: "HEADLESS_QUEUE_TIMEOUT" });
  assert.equal(host.admissionStatus().recent.at(-1).outcome, "queue-timeout");
  assert.equal(host.turns.waiting.length, 0);
  release();
  await take("later");
  assert.equal(host.turns.active, 1);
});

// Reported 2026-11-03: eight split-view chats refreshing at once waited out a fixed 15 s queue
// although turns kept finishing, and 25 background calls failed as "admission is full".
test("a queue that keeps moving never times out, however long one request waits in it", async t => {
  const { host, take, release } = scheduler(t, 1);
  host.queueWaitMs = 60;
  host.maxQueueWaitMs = 5_000;
  await take("a");
  const queued = ["b", "c", "d", "e"].map(owner => take(owner));
  for (let i = 0; i < queued.length; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 35));
    release();
  }
  const results = await Promise.allSettled(queued);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
    "the last waited about 140 ms, past the 60 ms limit, but a turn finished every 35 ms");
});

test("a request passed over while others finish still fails once it has waited the longest allowed", async t => {
  const { host, take } = scheduler(t, 2);
  host.queueWaitMs = 40;
  host.maxQueueWaitMs = 120;
  await take("holder");
  const started = performance.now();
  const starved = take("starved");
  const failed = assert.rejects(starved, { code: "HEADLESS_QUEUE_TIMEOUT" });
  // Controls go first and keep finishing, so the queue never looks stuck.
  let done = false;
  failed.finally(() => { done = true; });
  while (!done) {
    const control = await take("control", "control");
    await new Promise(resolve => setTimeout(resolve, 15));
    host.releaseTurn(control);
  }
  await failed;
  assert.ok(performance.now() - started >= 110, "not before the total limit");
});

test("control bursts still obey the global limit and have a bounded separate queue", async t => {
  const { host, take, release } = scheduler(t, 3);
  await Promise.all([1, 2, 3].map(i => take(`control-${i}`, "control")));
  for (let i = 0; i < 16; i += 1) take(`waiting-${i}`, "control");
  await assert.rejects(take("excess-control", "control"), { code: "HEADLESS_QUEUE_FULL" });
  assert.equal(host.turns.active, 3);
  assert.equal(host.turns.waiting.length, 16);
  release();
  await tick();
  assert.equal(host.turns.active, 3);
  assert.equal(host.turns.waiting.length, 15);
});

test("an explicitly cancelled HTTP read releases capacity and is not shared or replayed", async t => {
  let calls = 0;
  const host = await serverHost(t, (request, response) => {
    calls += 1;
    if (calls > 1) response.end('{"ok":true}');
  });
  host.maxInFlight = 1;
  const controller = new AbortController();
  const pending = host.request("/api/v1/ao/read", { run_id: "run" }, { signal: controller.signal });
  const checked = assert.rejects(pending, { name: "AbortError" });
  await until(() => calls === 1);
  const next = host.request("/api/v1/ao/read", { run_id: "run" });
  controller.abort("private cancellation reason");
  await checked;
  assert.deepEqual(await next, { ok: true });
  assert.equal(calls, 2);
  assert.equal(host.admissionStatus().recent[0].outcome, "cancelled");
  assert.equal(host.turns.active, 0);
});

test("pure-read failures are evicted; observation side effects never coalesce", async t => {
  let calls = 0;
  const host = await serverHost(t, (request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(400);
      response.end('{"error":{"code":"BAD_READ","message":"fixture error"}}');
    } else response.end('{"ok":true}');
  });
  const results = await Promise.allSettled([1, 2].map(() => host.request("/api/v1/ao/read", { run_id: "same" })));
  assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "BAD_READ"));
  assert.equal(calls, 1);
  assert.deepEqual(await host.request("/api/v1/ao/read", { run_id: "same" }), { ok: true });
  await Promise.all([1, 2].map(() => host.request("/api/v1/ao/harness/observe", { run_id: "same" })));
  assert.equal(calls, 4);
});

test("a Stop prerequisite read uses protected capacity without joining a saturated poll", async t => {
  const held = [];
  const host = await serverHost(t, (request, response) => { held.push(response); });
  const poll = host.request("/api/v1/ao/read", { workspace_id: "ws", run_id: "run" });
  await until(() => held.length === 1);
  const urgent = host.request("/api/v1/ao/read", { workspace_id: "ws", run_id: "run" }, { admissionControl: true });
  await until(() => held.length === 2);
  assert.deepEqual(host.admissionStatus().running.map(entry => entry.category), ["read", "control"]);
  held[1].end('{"ok":true}');
  assert.deepEqual(await urgent, { ok: true });
  held[0].end('{"ok":true}');
  await poll;
});

test("Stop bypasses workflow-level background read sharing and preserves local confirmation", async () => {
  const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
  const calls = [];
  const run = { id: "run", workspace_id: "ws", cancelled: false, nodes: [] };
  let releasePoll;
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => "fixture-codex",
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, options });
      if (endpoint === "/api/v1/ao/read") {
        if (!options?.admissionControl) await new Promise(resolve => { releasePoll = resolve; });
        return { ok: true, runs: [structuredClone(run)] };
      }
      assert.equal(endpoint, "/api/v1/ao/control");
      assert.equal(options.localConfirmation, true);
      run.cancelled = true;
      return { ok: true, run: structuredClone(run) };
    },
  });
  try {
    const poll = workflow.call("runs", { workspaceId: "ws", runId: "run" });
    await until(() => releasePoll);
    const stop = workflow.call("control_run", { workspaceId: "ws", runId: "run", action: "stop" });
    await until(() => calls.some(call => call.endpoint === "/api/v1/ao/control"));
    assert.equal((await stop).ok, true);
    assert.ok(calls.some(call => call.endpoint === "/api/v1/ao/read" && call.options?.admissionControl === true));
    releasePoll();
    await poll;
  } finally { releasePoll?.(); workflow.dispose(); }
});
