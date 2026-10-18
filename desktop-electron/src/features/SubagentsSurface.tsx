import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JsonObject } from "../api/contracts";
import { listAllWorkspaces, moduleCall, watchHarnesses } from "./AgentOrchestratorSurface";
import { DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, HarnessPicker, NATIVE_HARNESS, workerRoute,
  type AoHarness, type AoModelCatalog, type AoModelLoader, type AoRoute } from "./AgentOrchestratorRoleEditor";
import "./agent-orchestrator.css";
import "./subagents.css";

/** A subagent's model as saved: an AO agent harness and its model, with optional tuning. */
export type SubagentRoute = { harness_id: string; model: string; provider_id?: string; effort?: string; context_window?: number };
export type Subagent = { id: string; name: string; enabled: boolean; description: string; instructions: string; route: SubagentRoute | null };
export type SubagentSettings = {
  enabled: boolean; maxConcurrent: number; maxPerChat: number; timeoutMinutes: number;
  permission: "auto" | "full"; releaseWhenDone: boolean; defaultRoute: SubagentRoute | null;
};
export type SubagentConfig = { settings: SubagentSettings; agents: Subagent[] };
export type SubagentRun = { subagent_id: string; agent: string; name: string; state: string; task: string; elapsed_seconds: number; report?: string; error?: string };

const ROUTE_FIELDS = ["harness_id", "model", "provider_id", "effort", "context_window"] as const;
/** The fields of a picker route a subagent keeps (its permissions come from the page's setting). */
export function subagentRoute(route: AoRoute): SubagentRoute {
  const kept: Record<string, unknown> = {};
  for (const field of ROUTE_FIELDS) if (route[field as keyof AoRoute] !== undefined && route[field as keyof AoRoute] !== null) kept[field] = route[field as keyof AoRoute];
  return kept as SubagentRoute;
}
const pickerRoute = (route: SubagentRoute | null): AoRoute => ({ ...workerRoute(DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL), ...(route ?? {}) } as AoRoute);
/** A new subagent's id: from its name, unique among the others. */
export function subagentId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "subagent";
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}
const STATE_LABEL: Record<string, string> = { starting: "Starting", running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped", timed_out: "Timed out" };
const elapsed = (seconds: number) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;

function Switch({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? " is-on" : ""}`}
    disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}
function Row({ label, body, children }: { label: string; body: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><p>{body}</p></div>{children}</div>;
}

export function SubagentsSurface({ active = true, setError }: { active?: boolean; setError: (error: string | null) => void }) {
  const [saved, setSaved] = useState<SubagentConfig | null>(null);
  const [draft, setDraft] = useState<SubagentConfig | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<AoHarness[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => { try { return localStorage.getItem("coding-tools:ao:workspace") || ""; } catch { return ""; } });

  const load = useCallback(async () => {
    const result = await moduleCall("subagents_config");
    setAvailable(result.available !== false);
    if (result.settings && Array.isArray(result.agents)) {
      const config = { settings: result.settings as SubagentSettings, agents: result.agents as Subagent[] };
      setSaved(config); setDraft(structuredClone(config));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    void listAllWorkspaces().then(items => setWorkspaceId(current => items.some(item => item.id === current) ? current : items[0]?.id ?? "")).catch(() => undefined);
    // Subagents run on AO agents only: Native Codex (and its WebGPT models) is left out.
    return watchHarnesses(list => setHarnesses(list.filter(item => item.id !== NATIVE_HARNESS)));
  }, [active, load]);

  // The running subagents, read every few seconds while the page is open.
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => void moduleCall("subagents_runs").then(result => { if (live) setRuns(Array.isArray(result.runs) ? result.runs as SubagentRun[] : []); }).catch(() => undefined);
    read();
    const timer = window.setInterval(read, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active]);

  const modelCache = useRef(new Map<string, { at: number; models: ReturnType<AoModelLoader> }>());
  const loadModels = useCallback<AoModelLoader>((harness: string) => {
    const key = JSON.stringify([workspaceId, harness]);
    const cached = modelCache.current.get(key);
    let models = cached && Date.now() - cached.at < 60_000 ? cached.models : undefined;
    if (!models) {
      models = moduleCall("models", { workspaceId, harness }).then(result => {
        const names = Array.isArray(result.models) ? result.models as string[] : [];
        return result.capabilities ? { models: names, capabilities: result.capabilities as AoModelCatalog["capabilities"] } : names;
      });
      const entry = { at: Date.now(), models };
      models.catch(() => { if (modelCache.current.get(key) === entry) modelCache.current.delete(key); });
      modelCache.current.set(key, entry);
    }
    return models;
  }, [workspaceId]);

  const dirty = useMemo(() => Boolean(saved && draft) && JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  const setSettings = (change: Partial<SubagentSettings>) => setDraft(current => current && { ...current, settings: { ...current.settings, ...change } });
  const setAgent = (index: number, change: Partial<Subagent>) => setDraft(current => current && {
    ...current, agents: current.agents.map((agent, at) => at === index ? { ...agent, ...change } : agent) });
  const addAgent = () => setDraft(current => current && { ...current, agents: [...current.agents, {
    id: subagentId("New subagent", current.agents.map(agent => agent.id)), name: "New subagent", enabled: true, description: "", instructions: "", route: null }] });
  const removeAgent = (index: number) => setDraft(current => current && { ...current, agents: current.agents.filter((_, at) => at !== index) });

  const save = async () => {
    if (!draft) return;
    setBusy(true); setNotice("");
    try {
      const result = await moduleCall("subagents_save", { settings: draft.settings as unknown as JsonObject, agents: draft.agents as unknown as JsonObject[] } as unknown as JsonObject);
      const config = { settings: result.settings as SubagentSettings, agents: result.agents as Subagent[] };
      setSaved(config); setDraft(structuredClone(config)); setNotice("Saved. New chats get these subagents; open chats pick them up on their next agent start.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const stop = (id: string) => void moduleCall("subagents_stop", { subagentId: id })
    .then(() => moduleCall("subagents_runs")).then(result => setRuns(Array.isArray(result.runs) ? result.runs as SubagentRun[] : []))
    .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));

  if (!available) return <div className="subagents-page"><p className="subagents-empty">Subagents need the Agent Orchestrator, which is not available in this build.</p></div>;
  if (!draft) return <div className="subagents-page"><p className="subagents-empty">Loading…</p></div>;
  const { settings, agents } = draft;
  const missingModel = agents.some(agent => agent.enabled && !agent.route) && !settings.defaultRoute;

  return <div className="subagents-page ao-workflow">
    <div className="subagents-scroll">
      <header className="subagents-head">
        <div>
          <h1>Subagents</h1>
          <p>Helpers a chat's agent can start for a piece of its work: exploring the code, an independent change, a review. Each runs as its own agent in the chat's project, on the model you choose, and reports back to the chat.</p>
        </div>
        <div className="subagents-actions">
          {dirty ? <button type="button" className="subagents-secondary" disabled={busy} onClick={() => saved && setDraft(structuredClone(saved))}>Discard</button> : null}
          <button type="button" className="subagents-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </header>
      {notice ? <p className="subagents-notice" role="status">{notice}</p> : null}

      <section className="subagents-section" aria-label="Settings">
        <h2>Settings</h2>
        <Row label="Let chat agents start subagents" body="Gives new Claude Code, Codex and opencode chats the subagent tools (subagent_list, subagent_start, subagent_result, subagent_status, subagent_stop). Needs the app's tools for chat agents on in Settings.">
          <Switch label="Let chat agents start subagents" checked={settings.enabled} onChange={enabled => setSettings({ enabled })} />
        </Row>
        <Row label="Running at once" body="How many subagents may run at the same time across all chats.">
          <input className="subagents-number" type="number" min={1} max={10} value={settings.maxConcurrent} aria-label="Running at once"
            onChange={event => setSettings({ maxConcurrent: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })} />
        </Row>
        <Row label="Per chat" body="How many subagents one chat may run at the same time.">
          <input className="subagents-number" type="number" min={1} max={10} value={settings.maxPerChat} aria-label="Per chat"
            onChange={event => setSettings({ maxPerChat: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })} />
        </Row>
        <Row label="Time limit" body="Minutes a subagent may work before it is stopped.">
          <input className="subagents-number" type="number" min={1} max={240} value={settings.timeoutMinutes} aria-label="Time limit in minutes"
            onChange={event => setSettings({ timeoutMinutes: Math.max(1, Math.min(240, Number(event.target.value) || 1)) })} />
        </Row>
        <Row label="Permissions" body={settings.permission === "full"
          ? "Full access: subagents run with permissions bypassed and can change anything your account can."
          : "Approve for me: nobody watches a subagent, so its requests are allowed once, except what the command approver's safety rules block (pushing, deleting outside the project, secrets), which is denied. Questions get their recommended answer."}>
          <select className="subagents-select" aria-label="Permissions" value={settings.permission} onChange={event => setSettings({ permission: event.target.value as SubagentSettings["permission"] })}>
            <option value="auto">Approve for me</option>
            <option value="full">Full access</option>
          </select>
        </Row>
        <Row label="Release agents when done" body="Stops a finished subagent's agent process. Its session, worktree and conversation stay for you to inspect.">
          <Switch label="Release agents when done" checked={settings.releaseWhenDone} onChange={releaseWhenDone => setSettings({ releaseWhenDone })} />
        </Row>
        <div className="subagents-model">
          <div className="setting-row-text"><strong>Default model</strong><p>Used by every subagent without a model of its own.</p></div>
          {settings.defaultRoute
            ? <div className="subagents-picker">
              <HarnessPicker route={pickerRoute(settings.defaultRoute)} harnesses={harnesses} loadModels={loadModels} hidePermissionNote agentsOnly
                onChange={route => setSettings({ defaultRoute: subagentRoute(route) })} />
              <button type="button" className="subagents-link" onClick={() => setSettings({ defaultRoute: null })}>Clear default model</button>
            </div>
            : <button type="button" className="subagents-secondary" onClick={() => setSettings({ defaultRoute: subagentRoute(pickerRoute(null)) })}>Choose a default model</button>}
        </div>
        {missingModel ? <p className="subagents-warning" role="alert">Some subagents have no model: choose a default model, or one for each of them.</p> : null}
      </section>

      <section className="subagents-section" aria-label="Subagents">
        <div className="subagents-section-head"><h2>Subagents</h2><button type="button" className="subagents-secondary" disabled={agents.length >= 24} onClick={addAgent}>Add subagent</button></div>
        {!agents.length ? <p className="subagents-empty">No subagents yet. Add one, give it a purpose and instructions, and chat agents can start it.</p> : null}
        {agents.map((agent, index) => <article key={index} className={`subagents-card${agent.enabled ? "" : " is-off"}`} aria-label={agent.name || "Subagent"}>
          <div className="subagents-card-head">
            <input className="subagents-name" aria-label="Name" value={agent.name} maxLength={60} placeholder="Name"
              onChange={event => setAgent(index, { name: event.target.value })} />
            <code title="The id a chat agent starts it by">{agent.id}</code>
            <Switch label={`${agent.name} enabled`} checked={agent.enabled} onChange={enabled => setAgent(index, { enabled })} />
            <button type="button" className="subagents-link is-danger" onClick={() => removeAgent(index)}>Remove</button>
          </div>
          <label className="subagents-field">What it is for <small>(the chat agent reads this to choose it)</small>
            <textarea rows={2} maxLength={400} value={agent.description} placeholder="e.g. Reviews changes for bugs and missing tests; changes nothing."
              onChange={event => setAgent(index, { description: event.target.value })} />
          </label>
          <label className="subagents-field">Instructions <small>(given to the subagent ahead of its task)</small>
            <textarea rows={4} maxLength={8000} value={agent.instructions} placeholder="How it should work and what its report should contain."
              onChange={event => setAgent(index, { instructions: event.target.value })} />
          </label>
          <div className="subagents-field">
            <label className="subagents-inline"><input type="checkbox" checked={!agent.route}
              onChange={event => setAgent(index, { route: event.target.checked ? null : subagentRoute(pickerRoute(settings.defaultRoute)) })} />
              Use the default model{!agent.route && settings.defaultRoute ? <small> ({settings.defaultRoute.model.replace(/^cpa\//, "")})</small> : null}</label>
            {agent.route ? <div className="subagents-picker"><HarnessPicker route={pickerRoute(agent.route)} harnesses={harnesses} loadModels={loadModels} hidePermissionNote agentsOnly
              onChange={route => setAgent(index, { route: subagentRoute(route) })} /></div> : null}
          </div>
        </article>)}
      </section>

      <section className="subagents-section" aria-label="Running and recent subagents">
        <h2>Running and recent</h2>
        {!runs.length ? <p className="subagents-empty">No subagent has run since the app started.</p> : <ul className="subagents-runs">
          {runs.map(run => <li key={run.subagent_id} className={`is-${run.state}`}>
            <div className="subagents-run-head">
              <span className="subagents-state">{STATE_LABEL[run.state] ?? run.state}</span>
              <strong>{run.name}</strong>
              <span className="subagents-muted">{elapsed(run.elapsed_seconds)}</span>
              {["starting", "running"].includes(run.state) ? <button type="button" className="subagents-link is-danger" onClick={() => stop(run.subagent_id)}>Stop</button> : null}
              {run.report || run.error ? <button type="button" className="subagents-link" aria-expanded={openReport === run.subagent_id}
                onClick={() => setOpenReport(current => current === run.subagent_id ? null : run.subagent_id)}>{openReport === run.subagent_id ? "Hide report" : "Report"}</button> : null}
            </div>
            <p className="subagents-task">{run.task}</p>
            {openReport === run.subagent_id ? <pre className="subagents-report">{[run.error, run.report].filter(Boolean).join("\n\n")}</pre> : null}
          </li>)}
        </ul>}
      </section>
    </div>
  </div>;
}
