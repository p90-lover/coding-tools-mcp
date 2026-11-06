const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const upstreamModule = require("../electron/agent-orchestrator-upstream.cjs");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
const launched = Date.parse("2026-11-03T10:00:00.100Z");
const accepted = { id: "accepted", state: "running", providerTurnId: "provider-turn", requestedAt: "2026-11-03T10:00:02Z" };
function snapshot() { return { sessionId: "session", controller: "busy", turns: [
  { id: "earlier", state: "completed", providerTurnId: "prior", requestedAt: "2026-11-03T09:59:00Z" }, { ...accepted },
], messages: [], activities: [] }; }
function recoverFixture(conversation = snapshot()) {
  const start = source.indexOf("    async recover(id, expectedTurn");
  const method = source.slice(start, source.indexOf("    async observe(id, expectedTurn", start)).trim().replace(/,$/, "");
  const calls = [], child = { exitCode: null, signalCode: null };
  const api = vm.runInNewContext("({" + method + "})", { state: "ready", child, daemonPort: 1234,
    sessionId: value => value, receiptAcceptedTurn: upstreamModule.receiptAcceptedTurn,
    TERMINAL_TURN_STATES: new Set(["completed", "failed", "interrupted", "cancelled", "recovered"]),
    requestApi: async (method, endpoint) => {
      calls.push({ method, endpoint });
      assert.equal(method, "GET", "recovery never resumes, sends or drains input");
      return { ok: true, data: endpoint.includes("/conversation?") ? conversation
        : { session: { id: "session", mode: "chat", provisionState: "ready" } } };
    },
    internalApi() { throw new Error("Recovery must not start or mutate AO"); },
  });
  return { api, calls };
}

test("Recover inspects a unique accepted turn after receipt launch when no turn ID was persisted", async () => {
  const world = recoverFixture();
  const result = await world.api.recover("session", undefined, { startedAtMs: launched });
  assert.equal(result.recovery, "observed");
  assert.equal(result.status, "working");
  assert.equal(result.turnId, "accepted");
  assert.equal(world.calls.length, 2);
});

for (const [name, change] of [
  ["wrong session", data => { data.sessionId = "foreign"; }],
  ["no acceptance", data => { delete data.turns[1].providerTurnId; }],
  ["old turn", data => { data.turns[1].requestedAt = "2026-11-03T09:59:59Z"; }],
  ["queued turn", data => { data.turns.push({ id: "queued", state: "queued", requestedAt: "2026-11-03T10:00:03Z" }); }],
  ["ambiguous accepted turns", data => { data.turns.push({ ...accepted, id: "another" }); }],
  ["unknown timestamp", data => { delete data.turns[1].requestedAt; }],
  ["rolled back", data => { data.turns[1].rolledBack = true; }],
  ["rollback timestamp", data => { data.turns[1].rolledBackAt = "2026-11-03T10:00:04Z"; }],
  ["unknown state", data => { data.turns[1].state = "unrecognized"; }],
]) test(`missing-ID recovery refuses ${name} without sending or draining work`, async () => {
  const data = snapshot(); change(data);
  const world = recoverFixture(data);
  assert.equal((await world.api.recover("session", undefined, { startedAtMs: launched })).recovery, "unavailable");
  assert.ok(world.calls.every(call => call.method === "GET"));
});

test("an explicit accepted turn still wins instead of selecting the latest one", async () => {
  const world = recoverFixture();
  const result = await world.api.recover("session", "earlier", { startedAtMs: launched });
  assert.equal(result.recovery, "observed");
  assert.equal(result.status, "completed");
  assert.equal(result.turnId, "earlier");
});

test("missing-ID recovery without a valid launch timestamp still fails closed", async () => {
  for (const startedAtMs of [undefined, 0, -1, NaN, Infinity]) {
    const world = recoverFixture();
    assert.equal((await world.api.recover("session", undefined, { startedAtMs })).recovery, "unavailable");
  }
});

function workflowFixture({ autoRetry = true, verified = true, changeRequest = false, approvals = [] } = {}) {
  let interrupted = false, inspections = 0;
  const calls = [], seen = [];
  const receipt = { thread_id: "session", request_key: "request", status: "submitted", started_at_ms: launched };
  const run = { id: "run", workspace_id: "ws", project_id: "task", execution_mode: "single", nodes: [
    { id: "lead", role: "planner", state: "running", parents: [], route: { harness_id: "ao:claude-code", model: "cpa/test-model" }, receipt },
  ] };
  const workflow = createAgentOrchestratorWorkflow({ now: () => launched + 11 * 60000,
    requestHeadless: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)] };
      if (endpoint === "/api/v1/ao/external/terminal") return { ok: true, run };
      throw new Error("Unexpected mutation: " + endpoint);
    },
    aoHarness: {
      observe: async (_session, expected, ownership) => {
        inspections++;
        seen.push({ expected, ownership });
        if (changeRequest && inspections === 1) receipt.request_key = "replacement";
        return { turnId: "accepted", turnState: interrupted ? "interrupted" : "running", status: "working", lastActivityAt: launched,
          sessionActivityAt: launched, approvals, ...(verified ? { acceptedTurnId: "accepted" } : {}) };
      },
      interrupt: async () => { interrupted = true; },
      send() { throw new Error("Never replay a prompt"); }, spawn() { throw new Error("Never spawn during observation"); },
      recover: async (_session, _expected, ownership) => {
        seen.push({ recoveryOwnership: ownership });
        return ownership?.startedAtMs === launched ? { recovery: "observed", status: "working", turnId: "accepted" }
          : { recovery: "unavailable", status: "unknown" };
      },
    },
  });
  return { workflow, run, seen, calls, receipt, interrupted: () => interrupted, autoRetry };
}

test("the automatic retry watchdog can stop a verified stalled fresh turn whose receipt has no turn ID", async () => {
  const world = workflowFixture();
  try {
    await world.workflow.call("chat_auto_retry", { enabled: true });
    await world.workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "lead" });
    assert.equal(world.seen[0].ownership?.startedAtMs, launched);
    assert.equal(world.interrupted(), true);
  } finally { world.workflow.dispose(); }
});

for (const [name, options] of [["retry disabled", { autoRetry: false }], ["unverified turn", { verified: false }],
  ["new request wins", { changeRequest: true }], ["question waits", { approvals: [{ kind: "question", approval_id: "ask" }] }]]) {
  test(`binding discovery does not interrupt when ${name}`, async () => {
    const world = workflowFixture(options);
    try {
      await world.workflow.call("chat_auto_retry", { enabled: world.autoRetry });
      await world.workflow.call("observe", { workspaceId: "ws", runId: "run", nodeId: "lead" });
      assert.equal(world.interrupted(), false);
    } finally { world.workflow.dispose(); }
  });
}

test("the contentless workflow recovery passes the saved launch window to the original agent inspector", async () => {
  const world = workflowFixture();
  try {
    const result = await world.workflow.call("chat_recover", { workspaceId: "ws", taskId: "task", runId: "run", nodeId: "lead",
      requestKey: "request", threadId: "session" });
    assert.equal(result.recovery, "observed");
    assert.equal(world.interrupted(), false);
    assert.ok(world.calls.every(endpoint => endpoint === "/api/v1/ao/read"));
  } finally { world.workflow.dispose(); }
});
