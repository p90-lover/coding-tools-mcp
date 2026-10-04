import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import { AgentOrchestratorCanvas } from "./AgentOrchestratorCanvas";
import { aoDependencyChange, aoLevels, aoUnlinkChange, listAllWorkspaces, moduleCall, type AoMission, type AoNode } from "./AgentOrchestratorSurface";
import { AgentOrchestratorRoleEditor, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, NATIVE_HARNESS, cardMeta,
  defaultTeam, emptyRoleSettings, workerRoute, type AoHarness, type AoTeam } from "./AgentOrchestratorRoleEditor";
import { ROLE_TITLE, prepareTeamGraph } from "./AgentOrchestratorTeam";
import "./agent-orchestrator.css";

/** A copy is a new preset, never another default or another revision of the original. */
export function duplicateTeam(team: AoTeam): AoTeam {
  const copy = structuredClone(team);
  copy.id = crypto.randomUUID();
  copy.name = `${team.name} copy`;
  copy.revision = 0;
  copy.is_default = false;
  copy.nodes.forEach(node => { if (node.settings) node.settings.revision = 0; });
  return copy;
}

export { prepareTeamGraph } from "./AgentOrchestratorTeam";

const asMission = (team: AoTeam): AoMission => ({
  id: team.id, project_id: "", workspace_id: team.workspace_id, revision: team.revision, cancelled: false, nodes: team.nodes,
});
const freshTeam = (workspaceId: string, first = false): AoTeam => ({
  ...defaultTeam(workspaceId, workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL)),
  name: "New team", is_default: first, editable_graph: true,
});
const native: AoHarness = { id: NATIVE_HARNESS, label: "Native Codex", runnable: true, installed: true };

export function AgentOrchestratorTeamsSurface({ active = true, setError }: {
  active?: boolean; setError: (error: string | null) => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => {
    try { return localStorage.getItem("coding-tools:ao:workspace") || ""; } catch { return ""; }
  });
  const [teams, setTeams] = useState<AoTeam[]>([]);
  const [defaultId, setDefaultId] = useState("");
  const [draft, setDraft] = useState<AoTeam | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [harnesses, setHarnesses] = useState<AoHarness[]>([native]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const modelCache = useRef(new Map<string, Promise<string[]>>());
  const loadModels = useCallback((harness: string) => {
    const key = JSON.stringify([workspaceId, harness]);
    let models = modelCache.current.get(key);
    if (!models) {
      models = moduleCall("models", { workspaceId, harness }).then(result => Array.isArray(result.models) ? result.models as string[] : []);
      models.catch(() => modelCache.current.delete(key));
      modelCache.current.set(key, models);
    }
    return models;
  }, [workspaceId]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([listAllWorkspaces(), moduleCall("harnesses")]).then(([items, result]) => {
      if (!live) return;
      setWorkspaces(items);
      setWorkspaceId(current => items.some(item => item.id === current) ? current : items[0]?.id ?? "");
      const available = result.harnesses as AoHarness[] | undefined;
      setHarnesses(available?.length ? available : [native]);
      if (!items.length) { setLoading(false); setDraft(null); }
    }).catch(cause => { if (live) { setError(String(cause instanceof Error ? cause.message : cause)); setLoading(false); } });
    return () => { live = false; };
  }, [active, setError]);

  const accept = (result: Record<string, unknown>, chosenId?: string, preserveDraft = false) => {
    const savedDefault = result.team as AoTeam | null;
    const saved = Array.isArray(result.teams) ? result.teams as AoTeam[] : savedDefault ? [savedDefault] : [];
    setTeams(saved); setDefaultId(savedDefault?.id ?? "");
    const chosen = saved.find(team => team.id === chosenId) || savedDefault || saved[0];
    if (!preserveDraft) {
      setDraft(chosen ? structuredClone(chosen) : freshTeam(workspaceId, true));
      setSelectedId("");
    }
  };
  useEffect(() => {
    if (!active || !workspaceId) return;
    let live = true;
    const keep = draft?.workspace_id === workspaceId;
    const previous = teams.find(team => team.id === draft?.id);
    const preserve = keep && (!previous || JSON.stringify(previous) !== JSON.stringify(draft));
    setLoading(true);
    if (!keep) { setDraft(null); setTeams([]); setDefaultId(""); setNotice(""); }
    try { localStorage.setItem("coding-tools:ao:workspace", workspaceId); } catch { /* Session selection still works. */ }
    void moduleCall("runs", { workspaceId }).then(result => { if (live) accept(result, keep ? draft?.id : undefined, preserve); })
      .catch(cause => { if (live) setError(String(cause instanceof Error ? cause.message : cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [active, workspaceId]);

  const saved = teams.find(team => team.id === draft?.id);
  const dirty = Boolean(draft && (!saved || JSON.stringify(draft) !== JSON.stringify(saved)));
  const canLeave = () => !dirty || window.confirm("Discard unsaved team changes?");
  const change = (next: AoTeam) => { if (draft) setDraft(prepareTeamGraph(next, draft)); setNotice(""); };
  const save = async (makeDefault = false) => {
    if (!draft || busy) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const result = await moduleCall("team_update", { workspaceId, change: { operation: "save_team", expected_revision: draft.revision,
        team: { ...draft, name: draft.name.trim(), editable_graph: true, is_default: makeDefault || draft.id === defaultId || !defaultId } as unknown as JsonObject } });
      if (result.cancelled) return;
      const updated = result.team as AoTeam;
      accept(await moduleCall("runs", { workspaceId }), updated.id);
      setNotice(makeDefault ? "Default team saved" : "Team saved");
      window.dispatchEvent(new CustomEvent("coding-tools:ao:teams-changed", { detail: { workspaceId } }));
    } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setBusy(false); }
  };
  const add = (role: "worker" | "approver" | "sub_reviewer" | "retry") => {
    if (!draft) return;
    const planner = draft.nodes.find(node => node.role === "planner");
    const reviewer = draft.nodes.find(node => node.role === "reviewer");
    if (!planner) return;
    const count = draft.nodes.filter(node => node.role === role).length;
    const id = crypto.randomUUID();
    const node: AoNode = { id, task_id: "", role, state: "pending", x: 0, y: 1, parents: [planner.id],
      route: role === "worker" ? workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL) : { ...reviewer?.route ?? planner.route },
      settings: { ...emptyRoleSettings(), name: `${ROLE_TITLE[role]}${role === "approver" ? "" : ` ${count + 1}`}`, specialty: role === "worker" ? "implementation" : role === "retry" ? "recovery" : "review" } };
    change({ ...draft, nodes: [...draft.nodes, node] });
    setSelectedId(id);
  };
  const canRemove = (id: string) => {
    const node = draft?.nodes.find(node => node.id === id);
    return Boolean(node && !["planner", "reviewer", "review_split"].includes(node.role)
      && (node.role !== "worker" || draft!.nodes.filter(item => item.role === "worker").length > 1));
  };
  const remove = (id: string) => {
    if (!draft || !canRemove(id)) return;
    change({ ...draft, nodes: draft.nodes.filter(node => node.id !== id) });
    setSelectedId("");
  };
  const mission = draft ? asMission(draft) : null;
  const inspected = draft?.nodes.find(node => node.id === selectedId);
  const locked = busy || loading;
  const subCount = draft?.nodes.filter(node => node.role === "sub_reviewer").length ?? 0;
  const canUnlink = (id: string, parent: string) => Boolean(mission && draft?.nodes.find(node => node.id === id)?.role !== "retry" && aoUnlinkChange(mission, id, parent)
    && !(draft?.nodes.find(node => node.id === id)?.role === "sub_reviewer" && draft.nodes.find(node => node.id === parent)?.role === "review_split"));
  const parents = (id: string, next: string[]) => {
    if (!draft) return;
    const planner = draft.nodes.find(node => node.role === "planner");
    change({ ...draft, nodes: draft.nodes.map(node => node.id === id
      ? { ...node, parents: next.length ? next : planner ? [planner.id] : [] } : node) });
  };
  return <section className="ao-workflow ao-teams" aria-label="Orchestrator Team">
    <div className="ao-main">
      <div className="ao-dragstrip" aria-hidden="true" />
      <header className="ao-workspace-head">
        <div className="ao-workspace-title"><strong>Orchestrator Team</strong><span>Saved role blocks for new chats</span></div>
        <label className="ao-teams-workspace">Workspace<select className="ao-select" aria-label="Team workspace" value={workspaceId} disabled={locked}
          onChange={event => { if (canLeave()) setWorkspaceId(event.target.value); }}>
          {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name || workspace.path}</option>)}
        </select></label>
      </header>
      <div className="ao-teams-bar">
        <label>Team<select aria-label="Saved team" value={draft?.id ?? ""} disabled={locked || !draft}
          onChange={event => { if (canLeave()) { const next = teams.find(team => team.id === event.target.value); if (next) { setDraft(structuredClone(next)); setSelectedId(""); setNotice(""); } } }}>
          {draft && !saved ? <option value={draft.id}>{draft.name || "New team"} (unsaved)</option> : null}
          {teams.map(team => <option key={team.id} value={team.id}>{team.name}{team.id === defaultId ? " · Default" : ""}</option>)}
        </select></label>
        <button type="button" className="button-secondary" disabled={locked || !workspaceId} onClick={() => {
          if (canLeave()) { const next = freshTeam(workspaceId, !defaultId); next.name = `Team ${teams.length + 1}`; setDraft(next); setSelectedId(""); setNotice(""); }
        }}>New team</button>
        <button type="button" className="button-secondary" disabled={locked || !draft} onClick={() => {
          if (draft && canLeave()) { setDraft(duplicateTeam(draft)); setSelectedId(""); setNotice(""); }
        }}>Duplicate</button>
        <button type="button" className="button-secondary" disabled={locked || !draft || draft.id === defaultId} onClick={() => void save(true)}>Make default</button>
        <button type="button" className="button-secondary" disabled={locked || !workspaceId} onClick={() => {
          if (canLeave()) { setLoading(true); void moduleCall("runs", { workspaceId }).then(result => accept(result, draft?.id))
            .catch(cause => setError(String(cause instanceof Error ? cause.message : cause))).finally(() => setLoading(false)); }
        }}>Refresh</button>
      </div>
      {draft ? <div className="ao-teams-settings">
        <label>Team name<input aria-label="Team name" maxLength={128} value={draft.name} disabled={locked} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Workers at once<input aria-label="Team worker limit" type="number" min={1} max={24} value={draft.worker_limit} disabled={locked}
          onChange={event => setDraft({ ...draft, worker_limit: Number(event.target.value) })} /></label>
        <label>Review rounds<input aria-label="Team review rounds" type="number" min={1} max={10} value={draft.max_review_rounds ?? 3} disabled={locked}
          onChange={event => setDraft({ ...draft, max_review_rounds: Number(event.target.value) })} /></label>
        <button type="button" className="button-primary" disabled={locked || !dirty || !draft.name.trim()} onClick={() => void save()}>Save team</button>
        {dirty ? <button type="button" className="button-secondary" disabled={locked} onClick={() => { setDraft(saved ? structuredClone(saved) : freshTeam(workspaceId, !defaultId)); setSelectedId(""); }}>Reset</button> : null}
        <span className="ao-hint">{draft.id === defaultId ? "Default for new chats" : "Choose this team when starting a chat"}</span>
      </div> : null}
      <div className="ao-teams-stage">
        {loading ? <div className="ao-empty-state"><p>Loading teams…</p></div> : draft && mission ? <>
          <div className="ao-teams-canvas">
            <AgentOrchestratorCanvas key={draft.id} nodes={draft.nodes} levels={aoLevels(mission)} selectedId={selectedId} busy={busy}
              onSelect={setSelectedId} describe={node => cardMeta(node as AoNode, harnesses)}
              onMove={async positions => change({ ...draft, nodes: draft.nodes.map(node => {
                const moved = positions.find(position => position.id === node.id);
                return moved ? { ...node, x: moved.x, y: moved.y, positioned: true } : node;
              }) })}
              canConnect={(id, parent) => draft.nodes.find(node => node.id === id)?.role !== "retry"
                && draft.nodes.find(node => node.id === parent)?.role !== "retry" && Boolean(aoDependencyChange(mission, id, parent))}
              onConnect={(id, parent) => { const linked = aoDependencyChange(mission, id, parent); if (linked) parents(id, linked.parents as string[]); }}
              canUnlink={canUnlink} onUnlink={(id, parent) => { const unlinked = aoUnlinkChange(mission, id, parent); if (unlinked && canUnlink(id, parent)) parents(id, unlinked.parents as string[]); }}
              canRemove={canRemove} onRemove={remove} />
          </div>
          <aside className="ao-teams-inspector" aria-label="Team role editor">
            {inspected ? <>
              <div className="ao-teams-inspector-head"><strong>{inspected.settings?.name || ROLE_TITLE[inspected.role]}</strong>
                <button type="button" className="ao-link" aria-label="Close role editor" onClick={() => setSelectedId("")}>Close</button></div>
              <AgentOrchestratorRoleEditor key={inspected.id} template node={inspected} mission={mission} draft={draft}
                harnesses={harnesses} loadModels={loadModels} busy={busy} change={change} apply={() => void save()}
                discard={() => { setDraft(saved ? structuredClone(saved) : freshTeam(workspaceId, !defaultId)); setSelectedId(""); }}
                taskName={() => "Team template"} />
            </> : <div className="ao-empty-state"><p>Select a role block to edit its role, model and instructions.</p><p>Drag blocks to arrange the team. Shift-click to connect or unlink.</p></div>}
          </aside>
        </> : <div className="ao-empty-state"><p>Add a workspace in Chat to configure a team.</p></div>}
      </div>
      {draft ? <footer className="ao-teams-footer">
        <button type="button" className="button-secondary" disabled={locked || draft.nodes.length >= 24} onClick={() => add("worker")}>＋ Worker</button>
        <button type="button" className="button-secondary" disabled={locked || draft.nodes.some(node => node.role === "approver") || draft.nodes.length >= 24} onClick={() => add("approver")}>＋ Command approver</button>
        <button type="button" className="button-secondary" disabled={locked || subCount >= 8 || draft.nodes.length + (subCount ? 1 : 2) > 24} onClick={() => add("sub_reviewer")}>＋ Sub-reviewer</button>
        <button type="button" className="button-secondary" disabled={locked || draft.nodes.some(node => node.role === "retry") || draft.nodes.length >= 24} onClick={() => add("retry")}>＋ Retry</button>
        <span role="status" className="ao-hint">{notice || (dirty ? "Unsaved changes" : "Existing chats keep their original team")}</span>
      </footer> : null}
    </div>
  </section>;
}
