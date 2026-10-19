"use strict";

// Timings are coordinator observations, not provider/tool execution. Parallel node time is
// summed separately from run wall time; receipt history remains the authority for attempts.
function createRunMetrics({ now = Date.now, maxRuns = 128 } = {}) {
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 128) throw new Error("Run metrics retention must be 1..128");
  const runs = new Map();
  const key = ({ workspaceId, runId }) => JSON.stringify([workspaceId, runId]);
  const countsOf = (mission) => {
    const nodes = (Array.isArray(mission.nodes) ? mission.nodes : []).slice(0, 24);
    let attempts = 0, retries = 0;
    for (const node of nodes) {
      const count = (Array.isArray(node.history) ? Math.min(12, node.history.length) : 0) + (node.receipt ? 1 : 0);
      attempts += count;
      retries += Math.max(0, count - 1);
    }
    return {
      nodes: nodes.length,
      finished_nodes: nodes.filter(node => node.state === "finished").length,
      failed_nodes: nodes.filter(node => node.state === "failed").length,
      cancelled_nodes: nodes.filter(node => ["cancelled", "archived"].includes(node.state)).length,
      retained_attempts: attempts,
      retained_retries: retries,
    };
  };
  function snapshot(scope) {
    const entry = runs.get(key(scope));
    if (!entry) return null;
    return {
      version: 1,
      timing_basis: "coordinator_observations",
      scope: "current_workflow_instance",
      first_observed_at_ms: entry.first,
      last_observed_at_ms: entry.last,
      observed_wall_ms: Math.max(0, (entry.closedAt ?? entry.last) - entry.first),
      startup_wait_ms: entry.startup,
      node_active_ms: entry.active,
      approval_wait_ms: entry.approval,
      // Running includes tool/approval waits. Overlapping nodes add node time, not wall time.
      node_active_basis: "sum_of_observed_running_node_intervals",
      counts: entry.counts ? { ...entry.counts } : null,
      retained_attempt_counts_are_lower_bounds: true,
      model_active_ms: null,
      tool_execution_ms: null,
      tokens: null,
      provider_latency_ms: null,
      observation: { requests: null, bytes: null, cache_hits: null },
    };
  }
  function observe(input = {}) {
    const runKey = key(input);
    const clock = now();
    const previous = runs.get(runKey);
    const at = Math.max(previous?.last ?? 0, Number.isSafeInteger(clock) && clock >= 0 ? clock : 0);
    const entry = previous ?? {
      first: at, last: at, startup: 0, active: 0, approval: 0,
      phases: { starting: false, active: 0, approval: false }, counts: null,
    };
    if (entry.closedAt === undefined) {
      const elapsed = at - entry.last;
      entry.startup += entry.phases.starting ? elapsed : 0;
      entry.active += entry.phases.active * elapsed;
      entry.approval += entry.phases.approval ? elapsed : 0;
    }
    entry.last = at;
    const mission = input.mission;
    const nodes = (Array.isArray(mission?.nodes) ? mission.nodes : []).slice(0, 24);
    const active = nodes.filter(node => node.state === "running");
    const approvalIds = new Set((Array.isArray(input.approvalNodeIds) ? input.approvalNodeIds : []).slice(0, 24));
    entry.phases = {
      starting: input.status === "starting" || nodes.some(node => node.state === "reserved"),
      active: active.length,
      approval: input.attention === "pending_approval" || active.some(node => approvalIds.has(node.id)),
    };
    if (mission) entry.counts = countsOf(mission);
    const closed = ["finished", "failed"].includes(input.status)
      || input.status === "held" && !entry.phases.starting && !entry.phases.active;
    if (closed) entry.closedAt ??= at;
    else delete entry.closedAt;
    runs.delete(runKey);
    runs.set(runKey, entry);
    while (runs.size > maxRuns) runs.delete(runs.keys().next().value);
    return snapshot(input);
  }
  return { observe, snapshot, dispose: () => runs.clear() };
}

module.exports = { createRunMetrics };
