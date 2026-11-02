const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

for (const model of ["cpa/gpt-6.1-sol", "cpa/deepseek-v4.1-flash"]) {
  test(`activity reads the card's assigned turn, not a later queued turn (${model})`, async () => {
    const observed = [];
    const timeline = [{ id: "message-1", kind: "message", status: "running", text: "The response is still being written." }];
    const run = { id: "run", workspace_id: "ws", nodes: [
      { id: "lead", role: "planner", state: "running", route: { harness_id: "ao:claude-code", model },
        receipt: { thread_id: "session", turn_id: "assigned", started_at_ms: 1000 } },
    ] };
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: async endpoint => {
        assert.equal(endpoint, "/api/v1/ao/read");
        return { ok: true, runs: [run] };
      },
      aoHarness: { observe: async (session, expectedTurn) => {
        observed.push([session, expectedTurn]);
        // AO's newest turn is queued behind the turn this card still owns.
        return expectedTurn === "assigned"
          ? { turnId: "assigned", turnState: "running", liveOutput: timeline[0].text, timeline, lastActivityAt: 2000 }
          : { turnId: "queued-follow-up", turnState: "queued", liveOutput: "", timeline: [] };
      } },
    });
    try {
      const args = { workspaceId: "ws", runId: "run" };
      await workflow.call("activity", args);
      await new Promise(resolve => setImmediate(resolve));
      const result = await workflow.call("activity", args);
      assert.equal(result.nodes.lead.output, timeline[0].text);
      assert.deepEqual(result.nodes.lead.timeline, timeline);
      assert.equal(result.nodes.lead.activity_at_ms, 2000);
      assert.ok(observed.every(([session, turn]) => session === "session" && turn === "assigned"));
    } finally { workflow.dispose(); }
  });
}

test("activity still refuses output when a harness returns another turn despite the requested scope", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => ({ ok: true, runs: [{ id: "run", workspace_id: "ws", nodes: [
      { id: "lead", state: "running", route: { harness_id: "ao:claude-code" }, receipt: { thread_id: "session", turn_id: "assigned" } },
    ] }] }),
    aoHarness: { observe: async () => ({ turnId: "other", turnState: "running", liveOutput: "Another turn's private reply",
      timeline: [{ id: "other-message", kind: "message", status: "running", text: "Wrong turn" }], lastActivityAt: 2000 }) },
  });
  try {
    const args = { workspaceId: "ws", runId: "run" };
    await workflow.call("activity", args);
    await new Promise(resolve => setImmediate(resolve));
    const result = await workflow.call("activity", args);
    assert.equal(result.nodes.lead.output, "");
    assert.deepEqual(result.nodes.lead.timeline, []);
    assert.equal(result.nodes.lead.activity_at_ms, null);
  } finally { workflow.dispose(); }
});
