const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

// A chat's frame is computed in the background and the chat shows "checking" until it lands. On
// 2026-11-16 one stayed "checking" for 8 minutes and nothing in the log said which read held it.
function world({ observe, readMs = 0 } = {}) {
  let clock = 1_000_000;
  const logs = [];
  const log = level => (event, data) => logs.push({ level, event, data });
  const workflow = createAgentOrchestratorWorkflow({
    now: () => clock,
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    requestHeadless: async endpoint => {
      assert.equal(endpoint, "/api/v1/ao/read");
      clock += readMs;
      return { ok: true, runs: [{ id: "run", workspace_id: "ws", nodes: [
        { id: "lead", state: "running", route: { harness_id: "ao:claude-code" },
          receipt: { request_key: "key", thread_id: "coding-tools-mcp-561", started_at_ms: 1000 } },
      ] }] };
    },
    aoHarness: { observe },
  });
  return { workflow, logs, tick: ms => { clock += ms; }, events: name => logs.filter(entry => entry.event === name) };
}
const args = { workspaceId: "ws", runId: "run" };
const settle = () => new Promise(resolve => setImmediate(resolve));

test("a frame stuck on its observe is logged once, naming the step, and its slow landing says where the time went", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { workflow, tick, events } = world({ observe: async () => {
    await held;
    return { turnId: "t", turnState: "running", approvals: [{ kind: "command", command: "resume_plan" }], timeline: [] };
  } });
  try {
    assert.equal((await workflow.call("activity", args)).nodes.lead.activity, "checking");
    tick(29_000);
    await workflow.call("activity", args);
    assert.equal(events("ao.activity_frame_stalled").length, 0, "not yet stalled at 29 s");
    tick(2_000);
    await workflow.call("activity", args);
    await workflow.call("activity", args);
    const stalled = events("ao.activity_frame_stalled");
    assert.equal(stalled.length, 1, "logged once per stuck frame, not on every poll");
    assert.equal(stalled[0].level, "warn");
    assert.deepEqual({ ...stalled[0].data, steps: undefined }, { run: "run", node: "lead", session: "coding-tools-mcp-561",
      step: "observe", waitedMs: 31_000, steps: undefined });

    tick(9_000);
    release();
    await settle();
    const slow = events("ao.activity_frame_slow");
    assert.equal(slow.length, 1);
    assert.equal(slow[0].data.tookMs, 40_000);
    assert.equal(slow[0].data.ok, true);
    assert.equal(slow[0].data.steps.observe, 40_000, "the observe held the frame");
    assert.equal(slow[0].data.steps["saved run"], 0);
    assert.match((await workflow.call("activity", args)).nodes.lead.activity, /resume_plan/, "the landed frame names the request");
  } finally { release(); workflow.dispose(); }
});

test("a quick frame and a quick run read log nothing", async () => {
  const { workflow, logs } = world({ observe: async () => ({ turnId: "t", turnState: "running", timeline: [] }) });
  try {
    await workflow.call("activity", args);
    await settle();
    await workflow.call("activity", args);
    assert.deepEqual(logs.filter(entry => entry.event.startsWith("ao.activity_")), []);
  } finally { workflow.dispose(); }
});

test("a slow run read, which the chat's poll waits on itself, is logged", async () => {
  const { workflow, events } = world({ readMs: 16_000, observe: async () => ({ turnId: "t", turnState: "running", timeline: [] }) });
  try {
    await workflow.call("activity", args);
    const slow = events("ao.activity_read_slow");
    assert.equal(slow.length, 1);
    assert.deepEqual(slow[0].data, { run: "run", readMs: 16_000 });
  } finally { workflow.dispose(); }
});
