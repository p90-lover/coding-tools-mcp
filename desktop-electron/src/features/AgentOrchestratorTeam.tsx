import { useEffect, useState } from "react";
import type { AoNode } from "./AgentOrchestratorSurface";
import {
  DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, HarnessPicker, NATIVE_HARNESS, SPECIALTIES, emptyRoleSettings, workerRoute,
  type AoHarness, type AoModelLoader, type AoTeam, type RoleSettings,
} from "./AgentOrchestratorRoleEditor";

export const ROLE_TITLE: Record<AoNode["role"], string> = {
  planner: "Orchestrator", approver: "Command approver", worker: "Worker",
  review_split: "Main reviewer · split", sub_reviewer: "Sub-reviewer", reviewer: "Main reviewer", retry: "Retry",
};

const PLACEHOLDER: Record<AoNode["role"], string> = {
  planner: "How should the orchestrator split and assign the task?",
  approver: "Which commands or changes must never be approved?",
  worker: "How should this worker approach its part?",
  review_split: "",
  retry: "Diagnose failed workers. Retry at most twice, preserve partial work, and send unresolved failures to the reviewer. Do not change accounts, credentials or healthy workers.",
  sub_reviewer: "What should this sub-reviewer check?",
  reviewer: "What must the main reviewer confirm before approving?",
};

/** Insert helper-role wiring when roles change, leaving manually connected cards alone. */
export function prepareTeamGraph(team: AoTeam, previous: AoTeam = team): AoTeam {
  const next = structuredClone(team);
  next.editable_graph = true;
  const planner = next.nodes.find(node => node.role === "planner");
  const reviewer = next.nodes.find(node => node.role === "reviewer");
  const workers = next.nodes.filter(node => node.role === "worker");
  const subs = next.nodes.filter(node => node.role === "sub_reviewer");
  let split = next.nodes.find(node => node.role === "review_split");
  if (subs.length && reviewer && !split) {
    split = { ...structuredClone(reviewer), id: crypto.randomUUID(), role: "review_split",
      parents: workers.map(node => node.id), positioned: false, x: 0, y: 2 };
    next.nodes.push(split);
  }
  if (!subs.length) {
    next.nodes = next.nodes.filter(node => node.role !== "review_split");
    split = undefined;
  }
  if (split && reviewer) {
    split.route = { ...reviewer.route };
    split.settings = { ...emptyRoleSettings(), ...reviewer.settings, name: `${reviewer.settings?.name || "Main reviewer"} · split` };
  }
  const newWorkers = workers.filter(node => previous.nodes.find(old => old.id === node.id)?.role !== "worker");
  const newSubs = subs.filter(node => previous.nodes.find(old => old.id === node.id)?.role !== "sub_reviewer");
  const approver = next.nodes.find(node => node.role === "approver");
  const newApprover = approver && previous.nodes.find(node => node.id === approver.id)?.role !== "approver";
  const removed = previous.nodes.filter(old => !next.nodes.some(node => node.id === old.id));
  for (const node of next.nodes) {
    if (node.role === "planner") { node.parents = []; continue; }
    if (node.role === "retry") { node.parents = planner ? [planner.id] : []; continue; }
    node.parents = [...new Set(node.parents.flatMap(id => removed.find(old => old.id === id)?.parents ?? [id]))]
      .filter(id => id !== node.id && next.nodes.some(parent => parent.id === id && parent.role !== "retry"));
    if (node.role === "sub_reviewer" && split && !node.parents.includes(split.id)) node.parents.push(split.id);
    if (node.role === "worker" && newApprover && approver && !node.parents.includes(approver.id)) node.parents.push(approver.id);
    if (node.role === "reviewer") {
      for (const added of subs.length ? newSubs : newWorkers) if (!node.parents.includes(added.id)) node.parents.push(added.id);
    }
    if (node.role === "review_split") {
      for (const added of newWorkers) if (!node.parents.includes(added.id)) node.parents.push(added.id);
    }
    if (!node.parents.length && planner) node.parents = [planner.id];
  }
  return next;
}

const MAX_NODES = 24;
const MAX_SUB_REVIEWERS = 8;

/**
 * The workspace team every new chat starts from. Any role may use any harness and model.
 * The team lists roles only; the service wires them: the command approver sits between the
 * orchestrator and the workers, and sub-reviewers get the main reviewer's split pass in front.
 */
export function AgentOrchestratorTeam({ team, harnesses, loadModels, busy, save, close }: {
  team: AoTeam;
  harnesses: AoHarness[];
  loadModels: AoModelLoader;
  busy: boolean;
  save: (team: AoTeam) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState<AoTeam>(() => structuredClone(team));
  useEffect(() => { setDraft(structuredClone(team)); }, [team.revision]);
  const of = (role: AoNode["role"]) => draft.nodes.filter((node) => node.role === role);
  const [planner] = of("planner");
  const [approver] = of("approver");
  const [reviewer] = of("reviewer");
  const [retryRole] = of("retry");
  const workers = of("worker");
  const subReviewers = of("sub_reviewer");
  const ordered = [planner, approver, ...workers, retryRole, ...subReviewers, reviewer].filter(Boolean) as AoNode[];
  // The split pass is one more card once there are sub-reviewers.
  const cardCount = draft.nodes.filter((node) => node.role !== "review_split").length + (subReviewers.length ? 1 : 0);
  const room = MAX_NODES - cardCount;
  const rounds = draft.max_review_rounds ?? 3;

  const update = (id: string, patch: Partial<AoNode>) =>
    setDraft((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }));
  const updateSettings = (node: AoNode, patch: Partial<RoleSettings>) =>
    update(node.id, { settings: { ...emptyRoleSettings(), ...node.settings, ...patch } });

  const addRole = (role: AoNode["role"], name: string, specialty: string, route = workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL)) =>
    setDraft((current) => {
      if (!planner) return current;
      const node: AoNode = {
        id: crypto.randomUUID(), task_id: "", role, state: "pending", parents: [planner.id],
        x: current.nodes.length, y: role === "worker" ? 1 : role === "approver" ? 0 : 2, route,
        settings: { ...emptyRoleSettings(), name, specialty },
      };
      return { ...current, nodes: [...current.nodes, node] };
    });
  const removeRole = (id: string) => setDraft((current) => ({ ...current, nodes: current.nodes.filter((node) => node.id !== id) }));

  const changed = JSON.stringify(draft) !== JSON.stringify(team);
  const limitsValid = Number.isInteger(draft.worker_limit) && draft.worker_limit >= 1 && draft.worker_limit <= 24
    && Number.isInteger(rounds) && rounds >= 1 && rounds <= 10;
  return (
    <form className="ao-sheet ao-team-sheet" aria-label="Team settings" onSubmit={(event) => { event.preventDefault(); save(draft); }}>
      <p className="ao-hint ao-wide">New chats use this team. Chats that are already running keep the team they started with.</p>
      {ordered.map((node) => {
        const settings = { ...emptyRoleSettings(), ...node.settings };
        const removable = node.role === "approver" || node.role === "sub_reviewer" || node.role === "retry" || (node.role === "worker" && workers.length > 1);
        return (
          <fieldset key={node.id} className="ao-team-role ao-wide">
            <legend>{ROLE_TITLE[node.role]}{removable
              ? <button type="button" className="ao-link" disabled={busy} onClick={() => removeRole(node.id)}>Remove</button> : null}</legend>
            <div className="ao-field-row">
              <label>Name<input maxLength={96} value={settings.name} placeholder={ROLE_TITLE[node.role]}
                onChange={(event) => updateSettings(node, { name: event.target.value })} /></label>
              <label>Focus<select value={settings.specialty}
                onChange={(event) => updateSettings(node, { specialty: event.target.value })}>
                <option value="">General</option>
                {SPECIALTIES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select></label>
            </div>
            <div className="ao-field-row">
              <HarnessPicker route={node.route} harnesses={harnesses} loadModels={loadModels}
                disabled={busy} onChange={(route) => update(node.id, { route })} />
            </div>
            <label>Instructions<textarea maxLength={4096} rows={3} value={settings.instructions} placeholder={PLACEHOLDER[node.role]}
              onChange={(event) => updateSettings(node, { instructions: event.target.value })} /></label>
            <label>Expected output<textarea maxLength={2048} rows={2} value={settings.expected_output}
              onChange={(event) => updateSettings(node, { expected_output: event.target.value })} /></label>
            {node.role === "approver" ? <label className="ao-check" title="Off: the approver only recommends and you decide each tool request. On: it allows or denies on its own (unclear requests and hard-blocked commands still come to you or are denied).">
              <input type="checkbox" checked={settings.auto_decide === true} disabled={busy}
                onChange={(event) => updateSettings(node, { auto_decide: event.target.checked })} /> Auto-decide tool requests</label> : null}
            {node.role === "reviewer" && subReviewers.length
              ? <p className="ao-hint">Runs twice: first it splits the review across the sub-reviewers, then it confirms their findings.</p> : null}
          </fieldset>
        );
      })}
      <div className="ao-field-row ao-wide">
        <button type="button" className="button-secondary" disabled={busy || room < 1}
          onClick={() => addRole("worker", `Worker ${workers.length + 1}`, "implementation")}>＋ Worker</button>
        <button type="button" className="button-secondary" disabled={busy || room < (subReviewers.length ? 1 : 2) || subReviewers.length >= MAX_SUB_REVIEWERS}
          onClick={() => addRole("sub_reviewer", `Sub-reviewer ${subReviewers.length + 1}`, "review", reviewer?.route)}>＋ Sub-reviewer</button>
        {!approver ? <button type="button" className="button-secondary" disabled={busy || room < 1}
          onClick={() => addRole("approver", "Command approver", "security", reviewer?.route)}>＋ Command approver</button> : null}
      </div>
      <div className="ao-field-row ao-wide">
        {!retryRole ? <button type="button" className="button-secondary" disabled={busy || room < 1}
          onClick={() => addRole("retry", "Retry", "recovery", reviewer?.route)}>＋ Retry</button> : null}
      </div>
      <div className="ao-field-row ao-wide">
        <label>Workers at once<input type="number" min={1} max={24} value={draft.worker_limit}
          onChange={(event) => setDraft((current) => ({ ...current, worker_limit: Number(event.target.value) }))} /></label>
        <label title="How many times the main reviewer may send work back before the mission waits for you">Review rounds
          <input type="number" min={1} max={10} value={rounds}
            onChange={(event) => setDraft((current) => ({ ...current, max_review_rounds: Number(event.target.value) }))} /></label>
      </div>
      <div className="ao-sheet-actions ao-wide">
        <button className="button-primary" type="submit" disabled={busy || !changed || !limitsValid}>Save team</button>
        <button className="button-secondary" type="button" onClick={close}>Close</button>
      </div>
    </form>
  );
}
