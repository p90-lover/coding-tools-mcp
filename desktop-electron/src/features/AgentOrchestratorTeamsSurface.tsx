import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import { AgentOrchestratorCanvas } from "./AgentOrchestratorCanvas";
import { aoDependencyChange, aoLevels, aoUnlinkChange, listAllWorkspaces, moduleCall, type AoMission, type AoNode } from "./AgentOrchestratorSurface";
import { AgentOrchestratorRoleEditor, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, NATIVE_HARNESS, cardMeta,
  defaultTeam, emptyRoleSettings, workerRoute, type AoHarness, type AoModelCatalog, type AoModelLoader, type AoTeam } from "./AgentOrchestratorRoleEditor";
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
/** One-click workers: a worker card already named for its job, with a matching specialty. */
const QUICK_WORKERS = [
  { roleName: "Frontend", specialty: "frontend" }, { roleName: "Backend", specialty: "backend" },
  { roleName: "Tester", specialty: "testing" }, { roleName: "Researcher", specialty: "research" },
  { roleName: "Security auditor", specialty: "security" }, { roleName: "Docs writer", specialty: "docs" },
  { roleName: "DevOps", specialty: "devops" },
] as const;

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
  const modelCache = useRef(new Map<string, ReturnType<AoModelLoader>>());
  const loadModels = useCallback<AoModelLoader>((harness: string) => {
    const key = JSON.stringify([workspaceId, harness]);
    let models = modelCache.current.get(key);
    if (!models) {
      // Keep the catalog's capabilities, as the chat does: without them the role editor shows
      // "Capabilities unverified" and offers no effort or context window.
      models = moduleCall("models", { workspaceId, harness }).then(result => {
        const names = Array.isArray(result.models) ? result.models as string[] : [];
        return result.capabilities ? { models: names, capabilities: result.capabilities as AoModelCatalog["capabilities"] } : names;
      });
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
      // An automatic save lands here too: keep the open role while its block still exists, or its
      // details vanished moments after the click.
      setSelectedId(current => chosen?.nodes.some(node => node.id === current) ? current : "");
      return;
    }
    // Unsaved edits are kept, but on the stored team's current revision: a draft that kept its old
    // revision was refused by every later save ("AO team revision changed; refresh before
    // applying"), so the Team page stopped saving. The edits on this page are the latest intent.
    setDraft(current => {
      const stored = current && saved.find(team => team.id === current.id);
      return current && stored && stored.revision !== current.revision ? { ...current, revision: stored.revision } : current;
    });
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
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  // The draft that last failed to save; it is not retried until it changes.
  const [failed, setFailed] = useState("");
  // An explicit save (Make default) locks the page; an automatic one leaves the inputs live.
  const save = async (makeDefault = false, automatic = false) => {
    const sent = draftRef.current;
    if (!sent || busy || saving) return;
    (automatic ? setSaving : setBusy)(true); setNotice("");
    if (!automatic) setError(null);
    try {
      const result = await moduleCall("team_update", { workspaceId, change: { operation: "save_team", expected_revision: sent.revision,
        team: { ...sent, name: sent.name.trim(), editable_graph: true, is_default: makeDefault || sent.id === defaultId || !defaultId } as unknown as JsonObject } });
      if (result.cancelled) return;
      const updated = result.team as AoTeam;
      // Edits made while saving stay in the draft, on the new revision, for the next save.
      const edited = JSON.stringify(draftRef.current) !== JSON.stringify(sent);
      accept(await moduleCall("runs", { workspaceId }), updated.id, edited);
      setFailed("");
      setNotice(makeDefault ? "Default team saved" : "All changes saved");
      window.dispatchEvent(new CustomEvent("coding-tools:ao:teams-changed", { detail: { workspaceId } }));
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      // Saved elsewhere since this page loaded it: move the draft onto the stored revision (which
      // changes it, so the automatic save goes again) instead of failing every later save.
      if (/revision changed/i.test(message)) {
        try {
          const latest = await moduleCall("runs", { workspaceId });
          const stored = (Array.isArray(latest.teams) ? latest.teams as AoTeam[] : []).find(team => team.id === sent.id);
          if (stored && stored.revision !== sent.revision) { accept(latest, sent.id, true); return; }
        } catch { /* report the original error */ }
      }
      setFailed(JSON.stringify(sent));
      setError(message);
    }
    finally { (automatic ? setSaving : setBusy)(false); }
  };
  // Deleting removes the saved team only; chats keep their own copy. The last team stays.
  const removeTeam = async () => {
    if (!draft || busy || saving) return;
    if (!saved) { // An unsaved new team is just dropped.
      const fallback = teams.find(team => team.id === defaultId) ?? teams[0];
      setDraft(fallback ? structuredClone(fallback) : freshTeam(workspaceId, true));
      setSelectedId(""); return;
    }
    if (!window.confirm(`Delete the team "${saved.name}"? Existing chats keep their own copy of it.`)) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await moduleCall("team_update", { workspaceId, change: { operation: "delete_team", team_id: saved.id, expected_revision: saved.revision } });
      accept(await moduleCall("runs", { workspaceId }));
      setNotice(`Deleted "${saved.name}"`);
      window.dispatchEvent(new CustomEvent("coding-tools:ao:teams-changed", { detail: { workspaceId } }));
    } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setBusy(false); }
  };
  const add = (role: "worker" | "approver" | "sub_reviewer" | "retry", preset?: { roleName: string; specialty: string }) => {
    if (!draft) return;
    const planner = draft.nodes.find(node => node.role === "planner");
    const reviewer = draft.nodes.find(node => node.role === "reviewer");
    if (!planner) return;
    const count = draft.nodes.filter(node => node.role === role).length;
    const id = crypto.randomUUID();
    const node: AoNode = { id, task_id: "", role, state: "pending", x: 0, y: 1, parents: [planner.id],
      route: role === "worker" ? workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL) : { ...reviewer?.route ?? planner.route },
      settings: preset
        ? { ...emptyRoleSettings(), name: preset.roleName, role_name: preset.roleName, specialty: preset.specialty }
        : { ...emptyRoleSettings(), name: `${ROLE_TITLE[role]}${role === "approver" ? "" : ` ${count + 1}`}`, specialty: role === "worker" ? "implementation" : role === "retry" ? "recovery" : "review" } };
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
  // The role editor opens as a popover beside the clicked block; a press outside it (other than on
  // another block, which opens that one), Escape, or a wheel over the canvas closes it.
  const stage = useRef<HTMLDivElement>(null);
  const [popoverAt, setPopoverAt] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const box = stage.current?.getBoundingClientRect();
    const card = selectedId ? stage.current?.querySelector(`[data-ao-node="${CSS.escape(selectedId)}"]`)?.getBoundingClientRect() : null;
    if (!box || !card) { setPopoverAt(null); return; }
    const width = Math.min(380, box.width - 16), gap = 12;
    const after = card.right - box.left + gap;
    const left = after + width <= box.width - 8 ? after : card.left - box.left - gap - width;
    const top = Math.max(8, Math.min(card.top - box.top, box.height - 8 - Math.min(480, box.height - 16)));
    setPopoverAt({ left: Math.max(8, Math.min(left, box.width - width - 8)), top, width, maxHeight: box.height - top - 8 });
  }, [selectedId, Boolean(inspected)]);
  useEffect(() => {
    if (!selectedId) return;
    const inside = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".ao-team-popover, [data-ao-node]"));
    const press = (event: PointerEvent) => { if (!inside(event.target)) setSelectedId(""); };
    const wheel = (event: WheelEvent) => { if (!(event.target instanceof Element && event.target.closest(".ao-team-popover"))) setSelectedId(""); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(""); };
    document.addEventListener("pointerdown", press);
    document.addEventListener("wheel", wheel, { passive: true });
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", press); document.removeEventListener("wheel", wheel); document.removeEventListener("keydown", key); };
  }, [selectedId]);
  const locked = busy || loading;
  useEffect(() => {
    if (!dirty || locked || saving || !draft?.name.trim() || JSON.stringify(draft) === failed) return;
    const timer = window.setTimeout(() => void save(false, true), 800);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, locked, saving, failed]);
  const subCount = draft?.nodes.filter(node => node.role === "sub_reviewer").length ?? 0;
  const full = (draft?.nodes.length ?? 0) >= 24;
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
        <span className="ao-hint">Teams are shared by every workspace</span>
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
        <button type="button" className="button-secondary" disabled={locked || saving || !draft || (Boolean(saved) && teams.length < 2)}
          title={saved && teams.length < 2 ? "Keep at least one team" : "Delete this team; chats keep their own copy"} onClick={() => void removeTeam()}>Delete team</button>
        <button type="button" className="button-secondary" disabled={locked || !workspaceId} onClick={() => {
          if (canLeave()) { setLoading(true); void moduleCall("runs", { workspaceId }).then(result => accept(result, draft?.id))
            .catch(cause => setError(String(cause instanceof Error ? cause.message : cause))).finally(() => setLoading(false)); }
        }}>Refresh</button>
        {/* Changes also save on their own; this saves now and shows the state at a glance. */}
        <button type="button" className="button-primary" disabled={locked || saving || !dirty || !draft?.name.trim()} onClick={() => void save()}>
          {saving ? "Saving…" : dirty ? "Save team" : "Saved"}</button>
      </div>
      {draft ? <div className="ao-teams-settings">
        <label>Team name<input aria-label="Team name" maxLength={128} value={draft.name} disabled={locked} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Workers at once<input aria-label="Team worker limit" type="number" min={1} max={24} value={draft.worker_limit} disabled={locked}
          onChange={event => setDraft({ ...draft, worker_limit: Number(event.target.value) })} /></label>
        <label>Review rounds<input aria-label="Team review rounds" type="number" min={1} max={10} value={draft.max_review_rounds ?? 3} disabled={locked}
          onChange={event => setDraft({ ...draft, max_review_rounds: Number(event.target.value) })} /></label>
        <span className="ao-hint">{draft.id === defaultId ? "Default for new chats" : "Choose this team when starting a chat"}</span>
      </div> : null}
      <div className="ao-teams-stage" ref={stage}>
        {loading ? <div className="ao-empty-state"><p>Loading teams…</p></div> : draft && mission ? <>
          <aside className="ao-teams-palette" aria-label="Add roles">
            <h3>Roles</h3>
            <button type="button" disabled={locked || full} onClick={() => add("worker")}><strong>＋ Worker</strong><small>Does a part of the task</small></button>
            <button type="button" disabled={locked || full || draft.nodes.some(node => node.role === "approver")} onClick={() => add("approver")}><strong>＋ Command approver</strong><small>Screens risky commands</small></button>
            <button type="button" disabled={locked || subCount >= 8 || draft.nodes.length + (subCount ? 1 : 2) > 24} onClick={() => add("sub_reviewer")}><strong>＋ Sub-reviewer</strong><small>Reviews one part</small></button>
            <button type="button" disabled={locked || full || draft.nodes.some(node => node.role === "retry")} onClick={() => add("retry")}><strong>＋ Retry</strong><small>Recovers failed work</small></button>
            <h3>Quick workers</h3>
            {QUICK_WORKERS.map(preset => <button key={preset.roleName} type="button" disabled={locked || full}
              onClick={() => add("worker", preset)}><strong>＋ {preset.roleName}</strong><small>Worker · {preset.specialty}</small></button>)}
          </aside>
          <div className="ao-teams-canvas">
            <AgentOrchestratorCanvas key={draft.id} nodes={draft.nodes} levels={aoLevels(mission)} selectedId={selectedId} busy={busy} showState={false}
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
          {inspected && popoverAt ? <div className="ao-team-popover" role="dialog" aria-label="Team role editor"
            style={{ left: popoverAt.left, top: popoverAt.top, width: popoverAt.width, maxHeight: popoverAt.maxHeight }}>
            <div className="ao-teams-inspector-head"><strong>{inspected.settings?.name || ROLE_TITLE[inspected.role]}</strong>
              <button type="button" className="ao-link" aria-label="Close role editor" onClick={() => setSelectedId("")}>Close</button></div>
            <AgentOrchestratorRoleEditor key={inspected.id} template node={inspected} mission={mission} draft={draft}
              harnesses={harnesses} loadModels={loadModels} busy={busy} change={change}
              discard={() => { setDraft(saved ? structuredClone(saved) : freshTeam(workspaceId, !defaultId)); setSelectedId(""); }}
              taskName={() => "Team template"} />
          </div> : null}
          {!inspected ? <p className="ao-teams-hint">Click a block to edit its role, model and instructions · drag to arrange · Shift-click to connect or unlink</p> : null}
        </> : <div className="ao-empty-state"><p>Add a workspace in Chat to configure a team.</p></div>}
      </div>
      {draft ? <footer className="ao-teams-footer">
        <span role="status" className="ao-hint">{saving || dirty && !failed ? "Saving…" : failed && dirty ? "Not saved — fix the error above" : notice || "Changes save automatically · existing chats keep their original team"}</span>
      </footer> : null}
    </div>
  </section>;
}
