import { useEffect, useState } from "react";
import type { AoNode } from "./AgentOrchestratorSurface";
import {
  DEFAULT_WORKER_MODEL, HarnessPicker, NATIVE_HARNESS, SPECIALTIES, emptyRoleSettings, workerRoute,
  type AoHarness, type AoTeam, type RoleSettings,
} from "./AgentOrchestratorRoleEditor";

const ROLE_TITLE: Record<AoNode["role"], string> = { planner: "Orchestrator", worker: "Worker", reviewer: "Reviewer" };

/**
 * The workspace team every new chat starts from: the orchestrator, its workers and the reviewer,
 * each with its own name, instructions, expected output and model. The orchestrator and reviewer
 * always run on Native Codex (the run loop drives external harnesses only as workers).
 */
export function AgentOrchestratorTeam({ team, harnesses, loadModels, busy, save, close }: {
  team: AoTeam;
  harnesses: AoHarness[];
  loadModels: (harness: string) => Promise<string[]>;
  busy: boolean;
  save: (team: AoTeam) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState<AoTeam>(() => structuredClone(team));
  useEffect(() => { setDraft(structuredClone(team)); }, [team.revision]);
  const nativeOnly = harnesses.filter((item) => item.id === NATIVE_HARNESS);
  const workers = draft.nodes.filter((node) => node.role === "worker");
  const planner = draft.nodes.find((node) => node.role === "planner");
  const reviewer = draft.nodes.find((node) => node.role === "reviewer");
  const ordered = [planner, ...workers, reviewer].filter(Boolean) as AoNode[];

  const update = (id: string, patch: Partial<AoNode>) =>
    setDraft((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }));
  const updateSettings = (node: AoNode, patch: Partial<RoleSettings>) =>
    update(node.id, { settings: { ...emptyRoleSettings(), ...node.settings, ...patch } });

  // The reviewer depends on every worker; keep that edge set in step when workers change.
  const withReviewerParents = (nodes: AoNode[]) => {
    const workerIds = nodes.filter((node) => node.role === "worker").map((node) => node.id);
    return nodes.map((node) => node.role === "reviewer" ? { ...node, parents: workerIds } : node);
  };
  const addWorker = () => setDraft((current) => {
    if (!planner) return current;
    const node: AoNode = {
      id: crypto.randomUUID(), task_id: "", role: "worker", state: "pending", parents: [planner.id],
      x: workers.length + 1, y: 1, route: workerRoute(NATIVE_HARNESS, DEFAULT_WORKER_MODEL),
      settings: { ...emptyRoleSettings(), name: `Worker ${workers.length + 1}`, specialty: "implementation" },
    };
    return { ...current, nodes: withReviewerParents([...current.nodes, node]) };
  });
  const removeWorker = (id: string) => setDraft((current) =>
    ({ ...current, nodes: withReviewerParents(current.nodes.filter((node) => node.id !== id)) }));

  const changed = JSON.stringify(draft) !== JSON.stringify(team);
  return (
    <form className="ao-sheet ao-team-sheet" aria-label="Team settings" onSubmit={(event) => { event.preventDefault(); save(draft); }}>
      <p className="ao-hint ao-wide">New chats use this team. Chats that are already running keep the team they started with.</p>
      {ordered.map((node) => {
        const settings = { ...emptyRoleSettings(), ...node.settings };
        return (
          <fieldset key={node.id} className="ao-team-role ao-wide">
            <legend>{ROLE_TITLE[node.role]}{node.role === "worker" && workers.length > 1
              ? <button type="button" className="ao-link" disabled={busy} onClick={() => removeWorker(node.id)}>Remove</button> : null}</legend>
            <div className="ao-field-row">
              <label>Name<input maxLength={96} value={settings.name} placeholder={ROLE_TITLE[node.role]}
                onChange={(event) => updateSettings(node, { name: event.target.value })} /></label>
              {node.role === "worker" ? <label>Focus<select value={settings.specialty || "implementation"}
                onChange={(event) => updateSettings(node, { specialty: event.target.value })}>
                {SPECIALTIES.filter((value) => value !== "review").map((value) => <option key={value} value={value}>{value}</option>)}
              </select></label> : null}
            </div>
            <div className="ao-field-row">
              <HarnessPicker route={node.route} harnesses={node.role === "worker" ? harnesses : nativeOnly} loadModels={loadModels}
                disabled={busy} onChange={(route) => update(node.id, { route })} />
            </div>
            <label>Instructions<textarea maxLength={4096} rows={3} value={settings.instructions}
              placeholder={node.role === "planner" ? "How should the orchestrator split and assign the task?" : node.role === "reviewer" ? "What must the reviewer check before approving?" : "How should this worker approach its part?"}
              onChange={(event) => updateSettings(node, { instructions: event.target.value })} /></label>
            <label>Expected output<textarea maxLength={2048} rows={2} value={settings.expected_output}
              onChange={(event) => updateSettings(node, { expected_output: event.target.value })} /></label>
          </fieldset>
        );
      })}
      <div className="ao-field-row ao-wide">
        <button type="button" className="button-secondary" disabled={busy || workers.length >= 22} onClick={addWorker}>＋ Add worker</button>
        <label>Workers at once<input type="number" min={1} max={24} value={draft.worker_limit}
          onChange={(event) => setDraft((current) => ({ ...current, worker_limit: Number(event.target.value) }))} /></label>
      </div>
      <div className="ao-sheet-actions ao-wide">
        <button className="button-primary" type="submit"
          disabled={busy || !changed || !Number.isInteger(draft.worker_limit) || draft.worker_limit < 1 || draft.worker_limit > 24}>Save team</button>
        <button className="button-secondary" type="button" onClick={close}>Close</button>
      </div>
    </form>
  );
}
