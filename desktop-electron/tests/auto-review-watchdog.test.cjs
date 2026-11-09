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
  let clock = Date.parse("2026-11-06T12:00:00Z"), broken = true, entered = 0, interrupted = false, observations = 0;
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
      if (endpoint.endsWith("/read")) return { ok: true, runs: [structuredClone(mission)], worker_capacity: { run: 1 } };
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
      observe: async () => {
        if (stage === "driver" && observations++ === 0) return pending();
        return { status: interrupted ? "idle" : "working", turnId: node.receipt.turn_id, turnState: interrupted ? "interrupted" : "running", lastActivityAt: clock,
          needsInput: !interrupted, timeline: [], approvals: interrupted || resolved.some(([id]) => id === approval.approval_id) ? [] : [approval] };
      },
      resolveApproval: async (_session, id, decision) => {
        deliveries.push([id, decision]);
        if (stage === "delivery" && broken) await pending();
        if (stage === "refused" && broken) throw new Error("AO did not take the answer");
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

test("the approval observer can review while the run driver's observation is stuck", async () => {
  const state = world("driver");
  try {
    await state.workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    await waitFor(() => state.entered > 0);
    await state.observe();
    await waitFor(() => state.resolved.length > 0);
    assert.deepEqual(state.resolved, [["review-one", "yes"]]);
    assert.equal(state.models.length, 1);
  } finally { await state.close(); }
});

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

test("a direct review rejects a late decision after its cloned owner snapshot changes", async () => {
  const state = world("response");
  try {
    const pending = state.workflow.reviewToolCall({ workspaceId: "ws", session: "session", tool: "computer_action", args: { action: "click" } });
    await waitFor(() => state.entered > 0);
    state.node.receipt = { ...state.node.receipt, request_key: "replacement", turn_id: "new-turn" };
    state.release();
    assert.notEqual((await pending).action, "allow");
    assert.ok(!state.events.some(([name]) => name === "ao.approval_reviewed"));
  } finally { await state.close(); }
});

test("unknown answer delivery times out visibly and is not replayed (normal)", async () => {
  const state = world("delivery");
  try {
    await state.observe(); await waitFor(() => state.entered > 0);
    await state.expire(); state.healthy();
    for (let i = 0; i < 4; i++) { await state.observe(); await tick(); }
    state.advance(60_001);
    for (let i = 0; i < 4; i++) { await state.observe(); await tick(); }
    assert.equal(state.deliveries.length, 1, "without the judge, an outcome-unknown delivery is never resent automatically");
    const shown = await state.status();
    assert.equal(shown.awaiting_review, undefined);
    assert.equal(shown.recommendation.action, "ask");
    assert.match(shown.recommendation.reason, /sent|deliver|outcome|unknown/i);
  } finally { await state.close(); }
});

// The user's report (2026-11-09): with "Let the model judge" on, a request whose answer delivery was
// cut off stayed on its card ("delivery outcome is unknown") with Allow/Deny, and never closed.
for (const mode of ["judge", "enable judge after timeout"]) {
  test(`with the judge on, an unknown delivery AO still lists is sent again as decided and the card closes (${mode})`, async () => {
    const state = world("delivery");
    try {
      if (mode === "judge") await state.workflow.call("chat_model_judges", { enabled: true });
      await state.observe(); await waitFor(() => state.entered > 0);
      await state.expire(); state.healthy();
      if (mode === "enable judge after timeout") await state.workflow.call("chat_model_judges", { enabled: true });
      for (let i = 0; i < 4; i++) { await state.observe(); await tick(); }
      assert.equal(state.deliveries.length, 1, "an answer that may still land is not resent inside the delivery window");
      assert.equal((await state.status()).awaiting_review, true, "the judge's request is not left on the card for the person");
      state.advance(60_001);
      await state.observe(); await waitFor(() => state.resolved.length > 0);
      assert.deepEqual(state.deliveries, [["review-one", "yes"], ["review-one", "yes"]], "the same decision, sent again");
      assert.equal(state.models.length, 1, "a resend never reviews the request again");
      assert.equal(await state.status(), undefined, "the card closes");
    } finally { await state.close(); }
  });
}

test("with the judge on, an answer that never lands is sent three times, then the person decides", async () => {
  const state = world("delivery", { alwaysBroken: true });
  try {
    await state.workflow.call("chat_model_judges", { enabled: true });
    await state.observe(); await waitFor(() => state.entered > 0);
    await state.expire();
    for (let send = 2; send <= 3; send++) {
      state.advance(60_001);
      await state.observe(); await waitFor(() => state.deliveries.length === send);
      await state.expire();
    }
    state.advance(60_001);
    for (let i = 0; i < 4; i++) { await state.observe(); await tick(); }
    assert.equal(state.deliveries.length, 3, "resends are bounded");
    assert.ok(state.deliveries.every(([id, decision]) => id === "review-one" && decision === "yes"));
    assert.equal(state.models.length, 1);
    const shown = await state.status();
    assert.equal(shown.awaiting_review, undefined);
    assert.equal(shown.recommendation.action, "ask");
    assert.match(shown.recommendation.reason, /3 times/);
  } finally { await state.close(); }
});

test("with the judge on, a refused send is retried shortly with the same decision", async () => {
  const state = world("refused");
  try {
    await state.workflow.call("chat_model_judges", { enabled: true });
    await state.observe(); await waitFor(() => state.deliveries.length > 0);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal((await state.status()).awaiting_review, true);
    state.healthy();
    for (let i = 0; i < 20 && !state.resolved.length; i++) { await state.observe(); await tick(); }
    assert.deepEqual(state.deliveries, [["review-one", "yes"], ["review-one", "yes"]]);
    assert.deepEqual(state.resolved, [["review-one", "yes"]]);
    assert.equal(state.models.length, 1);
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
      assert.ok(!state.events.some(([name]) => name === "ao.approval_reviewed"), "obsolete responses do not populate the verdict cache");
    } finally { await state.close(); }
  });
}
