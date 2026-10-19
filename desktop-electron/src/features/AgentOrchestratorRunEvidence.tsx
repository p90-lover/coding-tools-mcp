import type { AoMission } from "./AgentOrchestratorSurface";

export type RunMetrics = {
  version: number; timing_basis: string; scope: string; observed_wall_ms: number;
  startup_wait_ms: number; node_active_ms: number; approval_wait_ms: number;
  counts?: { retained_attempts: number; retained_retries: number } | null;
};

export function AgentOrchestratorRunEvidence({ run, metrics }: { run: AoMission; metrics: RunMetrics | null }) {
  const seconds = (value: number) => Number.isFinite(value) && value >= 0 ? (value / 1000).toFixed(1) + " s" : "Unavailable";
  const checked = run.nodes.filter(node => node.receipt?.acceptance_evidence?.length);
  const skipped = run.nodes.filter(node => run.assignments?.[node.id]?.skip_reason);
  return <div className="ao-sheet">
    <strong>Observed timings</strong>
    {metrics?.version === 1 ? <>
      <p>Wall time: {seconds(metrics.observed_wall_ms)} · startup wait: {seconds(metrics.startup_wait_ms)} · approval wait: {seconds(metrics.approval_wait_ms)}</p>
      <p>Agent time: {seconds(metrics.node_active_ms)}. Simultaneous agents add time separately.</p>
      <p>Retained attempts: {metrics.counts?.retained_attempts ?? "Unavailable"} · retries: {metrics.counts?.retained_retries ?? "Unavailable"}</p>
      <p className="ao-hint">Observed in this app session. History may be incomplete. Model execution, tool execution and provider latency are unavailable.</p>
    </> : <p>No timing observations for this run in this app session.</p>}
    <strong>Worker selection</strong>
    {skipped.length ? <ul>{skipped.map(node => <li key={node.id}>
      {node.settings?.name || node.id}: skipped — {run.assignments?.[node.id]?.skip_reason}
    </li>)}</ul> : <p>No workers explicitly skipped.</p>}
    <strong>Artifact checks</strong>
    {run.nodes.some(node => run.assignments?.[node.id]?.checks?.length) ? <ul>
      {run.nodes.filter(node => run.assignments?.[node.id]?.checks?.length).map(node => <li key={node.id}>
        <strong>{node.settings?.name || node.id}</strong>
        <ul>{run.assignments?.[node.id]?.checks?.map(check => {
          const evidence = node.receipt?.acceptance_evidence?.find(item => item.path === check.path && item.expected_sha256 === check.sha256);
          const current = evidence && evidence.worker_request_key === node.receipt?.request_key
            && evidence.planner_request_key === run.assignments?.[node.id]?.planner_request_key;
          return <li key={check.path}><code>{check.path}</code>: {!evidence ? "Not verified" : !current ? "Outdated evidence" : evidence.passed ? "Verified snapshot" : "Verification failed"}
            {current && evidence.error ? <span> · {evidence.error}</span> : null}</li>;
        })}</ul>
      </li>)}
    </ul> : <p>No typed artifact checks. Prose review remains separate.</p>}
    {checked.length ? <p className="ao-hint">Artifact checks verify specified bytes at a checkpoint; they do not prove tests passed or guarantee later file contents.</p> : null}
  </div>;
}
