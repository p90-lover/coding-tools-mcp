"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createRunMetrics } = require("../electron/agent-orchestrator-metrics.cjs");
const scope = { workspaceId: "workspace", runId: "run" };
const node = (id, state, history = [], receipt = null) => ({ id, state, history, receipt });

test("lifecycle observations distinguish parallel node time, startup and approval wall time", () => {
  let clock = 1000;
  const metrics = createRunMetrics({ now: () => clock });
  metrics.observe({ ...scope, status: "starting", mission: { nodes: [node("a", "reserved"), node("b", "pending")] } });
  clock = 1100;
  metrics.observe({ ...scope, status: "running", mission: { nodes: [node("a", "running"), node("b", "running")] } });
  clock = 1300;
  metrics.observe({ ...scope, status: "running", approvalNodeIds: ["a", "b"],
    mission: { nodes: [node("a", "running"), node("b", "running")] } });
  clock = 1400;
  metrics.observe({ ...scope, status: "running", mission: { nodes: [node("a", "finished"), node("b", "running")] } });
  clock = 1500;
  const result = metrics.observe({ ...scope, status: "finished", mission: { nodes: [node("a", "finished"), node("b", "finished")] } });
  assert.equal(result.observed_wall_ms, 500);
  assert.equal(result.startup_wait_ms, 100);
  assert.equal(result.node_active_ms, 700);
  assert.equal(result.approval_wait_ms, 100);
  assert.equal(result.counts.finished_nodes, 2);
  clock = 5000;
  assert.equal(metrics.snapshot(scope).observed_wall_ms, 500, "snapshot does not invent unobserved duration");
  assert.equal(metrics.observe({ ...scope, status: "finished" }).observed_wall_ms, 500, "terminal status does not keep aging");
  assert.equal(result.model_active_ms, null);
  assert.equal(result.tool_execution_ms, null);
  assert.equal(result.tokens, null);
  assert.equal(result.provider_latency_ms, null);
  assert.deepEqual(result.observation, { requests: null, bytes: null, cache_hits: null });
});

test("receipt counts are bounded lower bounds and never copy private mission data", () => {
  const metrics = createRunMetrics({ now: () => 100 });
  const result = metrics.observe({ ...scope, status: "held", mission: {
    prompt: "PRIVATE_PROMPT", nodes: [
      { ...node("PRIVATE_NODE", "held", [{ answer: "PRIVATE_ANSWER" }], { route: { apiKey: "PRIVATE_KEY" } }), route: { account_id: "PRIVATE_ACCOUNT" } },
      node("b", "finished", [], { status: "completed" }),
      node("c", "cancelled", [{ status: "interrupted" }]),
    ],
  } });
  assert.deepEqual(result.counts, { nodes: 3, finished_nodes: 1, failed_nodes: 0, cancelled_nodes: 1, retained_attempts: 4, retained_retries: 1 });
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  result.counts.nodes = 999;
  assert.equal(metrics.snapshot(scope).counts.nodes, 3, "callers cannot mutate stored counters");
  const bounded = metrics.observe({ ...scope, mission: { nodes: Array.from({ length: 100 }, (_, index) => node(String(index), "failed", Array(50).fill({}), {})) } });
  assert.equal(bounded.counts.nodes, 24);
  assert.equal(bounded.counts.retained_attempts, 24 * 13);
});

test("same-run driver replacement retains metrics, separate runs and clocks stay independent", () => {
  let clock = 100;
  const metrics = createRunMetrics({ now: () => clock, maxRuns: 2 });
  metrics.observe({ ...scope, status: "running", mission: { nodes: [node("a", "running")] } });
  clock = 200;
  metrics.observe({ ...scope, status: "held" });
  clock = 300;
  metrics.observe({ ...scope, status: "running", mission: { nodes: [node("a", "running")] } });
  clock = 400;
  const resumed = metrics.observe({ ...scope, status: "finished", mission: { nodes: [node("a", "finished")] } });
  assert.equal(resumed.node_active_ms, 200, "held interval does not count as active node time");
  assert.equal(resumed.observed_wall_ms, 300, "same-run wall time includes the held gap");
  clock = 50;
  const separate = metrics.observe({ ...scope, runId: "new", status: "running", mission: { nodes: [] } });
  assert.equal(separate.observed_wall_ms, 0);
  clock = 25;
  assert.equal(metrics.observe({ ...scope, runId: "new", status: "finished", mission: { nodes: [] } }).observed_wall_ms, 0);
  metrics.observe({ ...scope, runId: "third" });
  assert.equal(metrics.snapshot(scope), null, "retention is bounded");
  assert.equal(metrics.snapshot({ ...scope, runId: "new" }).scope, "current_workflow_instance");
  metrics.dispose();
  assert.equal(metrics.snapshot({ ...scope, runId: "third" }), null);
  assert.throws(() => createRunMetrics({ maxRuns: 0 }), /retention/);
});
