"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), "fixture did not reach its expected review stage");
}

function world(stage = "response", { alwaysBroken = false, verdict = "allow" } = {}) {
  let clock = Date.parse("2026-11-06T12:00:00Z"), broken = true, entered = 0, interrupted = false;
  const timers = new Set(), releases = [], models = [], signals = [], resolved = [], deliveries = [], events = [];
  const pending = () => new Promise(resolve => { entered++; releases.push(resolve); });
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  let approval = { approval_id: "review-one", source: "ao", kind: "command", tool: "PowerShell", command: "python task.py",
    since: new Date(clock).toISOString(), decisions: [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }] };
  const node = { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session", request_key: "request", turn_id: "turn" } };
  const mission = { id: "run", workspace_id: "ws", project_id: "task", revision: 3, execution_mode: "single",
    grant: { executable_sha256: "a".repeat(64) }, nodes: [node] };
  const healthyReply = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ outcome: verdict, rationale: "fixture verdict" }) } }] }) });
  const workflow = createAgentOrchestratorWorkflow({
    now: () => clock,
    setTimer: (callback, delay) => {
      if (delay >= 45_000 && delay <= 207_000) {
        const timer = { callback, delay, at: clock, unref() {} }; timers.add(timer); return timer;
      }
      return setTimeout(callback, delay);
    },
    clearTimer: timer => { if (!timers.delete(timer)) clearTimeout(timer); },
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture-key" }),
    logger: { info: (name, data) => events.push([name, data]), warn: (name, data) => events.push([name, data]) },
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("/models")) {
        if (stage === "catalog" && broken) return pending();
        return { ok: true, json: async () => ({ data: [{ id: "test-model" }, { id: "codex-auto-review" }] }) };
      }
      if (!String(url).endsWith("/chat/completions")) return { ok: false, status: 404, json: async () => ({}) };
      const body = JSON.parse(init.body); models.push(body.model); signals.push(init.signal);
      if (stage === "response" && broken) return pending();
      if (stage === "body" && broken) return { ok: true, json: () => pending() };
      return healthyReply();
    },
    requestHeadless: async (endpoint) => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint === "/api/v1/tools/call") {
        if (stage === "context" && broken) return pending();
        return { ok: true, operation: { state: "completed", result: { ok: true, task: { description: "Run this project's tests." } } } };
      }
      if (endpoint.endsWith("/harness/status")) return { ok: true, status: { connected: false } };
      if (endpoint.endsWith("/control")) { mission.cancelled = true; node.state = "held"; return { ok: true, run: mission }; }
      return { ok: true, run: mission };
    },
    aoHarness: {
      sessionWorkspace: async () => stage === "folder" && broken ? pending() : { projectFolder: "G:/fixture/workspace" },
      observe: async () => ({ status: interrupted ? "idle" : "working", turnId: node.receipt.turn_id, turnState: interrupted ? "interrupted" : "running", lastActivityAt: clock,
        needsInput: !interrupted, timeline: [], approvals: interrupted || resolved.some(([id]) => id === approval.approval_id) ? [] : [approval] }),
      resolveApproval: async (_session, id, decision) => {
        deliveries.push([id, decision]);
        if (stage === "delivery" && broken) await pending();
        resolved.push([id, decision]); return { ok: true };
      },
      interrupt: async () => { interrupted = true; return { ok: true }; },
      exitAgent: async () => { interrupted = true; return { ok: true }; },
    },
    confirm: async () => true,
  });
  const observe = () => workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "one" });
  const status = async () => (await workflow.call("harness_status", { workspaceId: "ws", runId: "run", nodeId: "one" })).status?.pending_approvals?.[0];
  return { workflow, node, mission, models, signals, resolved, deliveries, events, observe, status, timers,
    get entered() { return entered; },
    healthy: () => { if (!alwaysBroken) broken = false; clock += 4_001; },
    expire: async () => {
      const timer = [...timers].sort((a, b) => a.at + a.delay - b.at - b.delay)[0];
      assert.ok(timer, "a real watchdog must be armed before any potentially hung review dependency");
      timers.delete(timer); clock = Math.max(clock, timer.at + timer.delay + 1); timer.callback(); await tick(); await tick();
    },
    advance: milliseconds => { clock += milliseconds; },
    release: value => { for (const release of releases.splice(0)) release(value ?? healthyReply()); },
    next: () => { approval = { ...approval, approval_id: "review-two", since: new Date(clock).toISOString() }; },
    close: async () => { workflow.dispose(); for (const release of releases.splice(0)) release(healthyReply()); await tick(); },
  };
}

for (const stage of ["folder", "catalog", "context", "response", "body"]) {
  test(`a hung ${stage} stage releases its slot and the undriven chat reviews again without user input`, async () => {
    const state = world(stage);
    try {
      await state.observe(); await waitFor(() => state.entered > 0);
      await state.expire();
      state.healthy();
      if (["folder", "catalog"].includes(stage)) state.advance(60_001);
      await state.observe();
      await waitFor(() => state.resolved.length > 0).catch(error => {
        throw new Error(`${error.message}: ${JSON.stringify({ models: state.models, events: state.events, deliveries: state.deliveries })}`);
      });
      assert.deepEqual(state.resolved, [["review-one", "yes"]]);
      assert.ok(state.models.every(model => model === "codex-auto-review"), "only the selected review provider chain is used");
      assert.ok(state.events.some(([name]) => name === "ao.approval_review_failed"));
    } finally { await state.close(); }
  });
}

test("a model that ignores abort cannot deliver its late decision after the review was retired", async () => {
  const state = world("response");
  try {
    await state.observe(); await waitFor(() => state.entered > 0);
    await state.expire();
    assert.equal(state.signals[0].aborted, true);
    state.release({ ok: true, json: async () => ({ choices: [{ message: { content: '{"outcome":"allow","rationale":"late obsolete reply"}' } }] }) });
    await tick(); await tick();
    assert.deepEqual(state.deliveries, []);
    assert.ok(!state.events.some(([name, detail]) => name === "ao.approval_reviewed" && detail.reason?.includes("obsolete")));
  } finally { await state.close(); }
});

test("three hung review attempts fall back visibly instead of remaining hidden forever", async () => {
  const state = world("response", { alwaysBroken: true });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await state.observe(); await waitFor(() => state.entered > attempt);
      await state.expire(); state.healthy();
    }
    const shown = await state.status();
    assert.equal(shown.awaiting_review, undefined);
    assert.equal(shown.recommendation.action, "ask");
    assert.match(shown.recommendation.reason, /3|tries|attempts/);
    assert.deepEqual(state.deliveries, [], "timeout never becomes an implicit allow");
  } finally { await state.close(); }
});

test("model-judge mode denies after bounded review failure instead of silently allowing", async () => {
  const state = world("response", { alwaysBroken: true });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      await state.observe(); await waitFor(() => state.entered > attempt);
      await state.expire(); state.healthy();
    }
    await state.observe(); await waitFor(() => state.resolved.length > 0);
    assert.deepEqual(state.resolved, [["review-one", "no"]]);
    assert.equal(state.models.length, 3, "exhaustion does not spend another reviewer call");
    assert.ok(state.models.every(model => model === "codex-auto-review"));
  } finally { await state.close(); }
});

test("a replaced stale screening cannot send its late allow after its successor denies", async () => {
  const state = world("response", { verdict: "deny" });
  try {
    await state.workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    await waitFor(() => state.entered > 0);
    state.healthy(); state.advance(208_000);
    await waitFor(() => state.resolved.length > 0);
    assert.deepEqual(state.resolved, [["review-one", "no"]]);
    state.release({ ok: true, json: async () => ({ choices: [{ message: { content: '{"outcome":"allow","rationale":"stale allow"}' } }] }) });
    await tick(); await tick();
    assert.deepEqual(state.deliveries, [["review-one", "no"]]);
  } finally { await state.close(); }
});

test("a direct tool review also has a deadline before catalog and response setup", async () => {
  const state = world("body");
  try {
    const pending = state.workflow.reviewToolCall({ workspaceId: "ws", session: "session", tool: "computer_action", args: { action: "click" } });
    await waitFor(() => state.entered > 0);
    await state.expire();
    assert.equal((await pending).action, "ask");
    assert.equal(state.signals[0].aborted, true);
    assert.deepEqual(state.deliveries, []);
  } finally { await state.close(); }
});

test("unknown answer delivery times out visibly and is not automatically replayed", async () => {
  const state = world("delivery");
  try {
    await state.observe(); await waitFor(() => state.entered > 0);
    await state.expire(); state.healthy();
    for (let i = 0; i < 4; i++) { await state.observe(); await tick(); }
    const shown = await state.status();
    assert.equal(shown.awaiting_review, undefined);
    assert.equal(shown.recommendation.action, "ask");
    assert.match(shown.recommendation.reason, /sent|deliver|outcome|unknown/i);
    assert.equal(state.deliveries.length, 1);
  } finally { await state.close(); }
});

for (const change of ["stop", "owner", "dispose"]) {
  test(`a late reviewer cannot answer after ${change}`, async () => {
    const state = world("response");
    try {
      await state.observe(); await waitFor(() => state.entered > 0);
      if (change === "stop") await state.workflow.call("control_run", { workspaceId: "ws", runId: "run", action: "stop" });
      else if (change === "owner") state.node.receipt = { ...state.node.receipt, request_key: "new-request", turn_id: "new-turn" };
      else state.workflow.dispose();
      state.release(); await tick(); await tick();
      assert.deepEqual(state.deliveries, []);
    } finally { await state.close(); }
  });
}
