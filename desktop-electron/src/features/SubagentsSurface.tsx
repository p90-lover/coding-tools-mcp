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
/**
 * The draft the page shows once the saved config is (re)loaded: edits not saved yet are kept, so
 * leaving the page and coming back (it reloads on each visit) never drops them; an untouched draft
 * follows what was loaded.
 */
export function keptDraft(draft: SubagentConfig | null, saved: SubagentConfig | null, loaded: SubagentConfig): SubagentConfig {
  return draft && saved && JSON.stringify(draft) !== JSON.stringify(saved) ? draft : structuredClone(loaded);
}
/**
 * The draft once a save answers: the saved config (as the main process kept it) when nothing was
 * edited while it was on its way, else the newer edits, which the next autosave sends.
 */
export function draftAfterSave(current: SubagentConfig | null, sent: SubagentConfig, kept: SubagentConfig): SubagentConfig {
  return current && JSON.stringify(current) !== JSON.stringify(sent) ? current : structuredClone(kept);
}
/** Edits save themselves this long after the last one, so typing a name is one save, not one per key. */
export const AUTOSAVE_MS = 700;
const STATE_LABEL: Record<string, string> = { starting: "Starting", running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped", timed_out: "Timed out" };
const elapsed = (seconds: number) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;

// The page draws its own controls: the app's .switch and .setting-row take the launcher's dark
// tokens, which on this light page left descriptions, borders and fields invisible.
function Switch({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`sa-switch${checked ? " is-on" : ""}`}
    disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}
function Row({ label, body, children }: { label: string; body?: string; children: ReactNode }) {
  return <div className="sa-row"><div className="sa-row-text"><strong>{label}</strong>{body ? <p>{body}</p> : null}</div><div className="sa-row-control">{children}</div></div>;
}
function NumberField({ value, min, max, label, unit, onChange }: { value: number; min: number; max: number; label: string; unit?: string; onChange: (value: number) => void }) {
  return <span className="sa-number"><input type="number" min={min} max={max} value={value} aria-label={label}
    onChange={event => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))} />{unit ? <small>{unit}</small> : null}</span>;
}
const modelName = (route: SubagentRoute | null) => route ? route.model.replace(/^cpa\//, "").replace(/^cline-pass\//, "") : "";

export function SubagentsSurface({ active = true, setError }: { active?: boolean; setError: (error: string | null) => void }) {
  const [saved, setSaved] = useState<SubagentConfig | null>(null);
  const [draft, setDraft] = useState<SubagentConfig | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  // A save that failed: shown in the save bar, and that draft is not sent again until it changes.
  const [saveError, setSaveError] = useState("");
  const failedDraft = useRef("");
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<AoHarness[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => { try { return localStorage.getItem("coding-tools:ao:workspace") || ""; } catch { return ""; } });

  // The saved config the draft was last compared with; the page stays mounted between visits.
  const savedRef = useRef<SubagentConfig | null>(null);
  const load = useCallback(async () => {
    const result = await moduleCall("subagents_config");
    setAvailable(result.available !== false);
    if (result.settings && Array.isArray(result.agents)) {
      const config = { settings: result.settings as SubagentSettings, agents: result.agents as Subagent[] };
      const previous = savedRef.current;
      savedRef.current = config;
      setSaved(config); setDraft(current => keptDraft(current, previous, config));
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

  const save = async (sent: SubagentConfig) => {
    setBusy(true);
    try {
      const result = await moduleCall("subagents_save", { settings: sent.settings as unknown as JsonObject, agents: sent.agents as unknown as JsonObject[] } as unknown as JsonObject);
      const config = { settings: result.settings as SubagentSettings, agents: result.agents as Subagent[] };
      savedRef.current = config;
      failedDraft.current = ""; setSaveError("");
      setSaved(config); setDraft(current => draftAfterSave(current, sent, config));
    } catch (cause) {
      failedDraft.current = JSON.stringify(sent);
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setBusy(false); }
  };
  // Every change saves itself a moment after the last edit (the user's call, 2026-10-22: a change
  // made without pressing Save was lost). One save at a time; edits made meanwhile go in the next.
  useEffect(() => {
    if (!draft || !dirty || busy || failedDraft.current === JSON.stringify(draft)) return undefined;
    const sent = draft;
    const timer = window.setTimeout(() => void save(sent), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, busy]);
  const stop = (id: string) => void moduleCall("subagents_stop", { subagentId: id })
    .then(() => moduleCall("subagents_runs")).then(result => setRuns(Array.isArray(result.runs) ? result.runs as SubagentRun[] : []))
    .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));

  if (!available) return <div className="subagents-page ao-workflow"><p className="sa-empty is-page">Subagents need the Agent Orchestrator, which this build doesn't include.</p></div>;
  if (!draft) return <div className="subagents-page ao-workflow"><p className="sa-empty is-page">Loading…</p></div>;
  const { settings, agents } = draft;
  const missingModel = agents.some(agent => agent.enabled && !agent.route) && !settings.defaultRoute;
  const enabledCount = agents.filter(agent => agent.enabled).length;
  const running = runs.filter(run => ["starting", "running"].includes(run.state)).length;

  return <div className="subagents-page ao-workflow">
    <div className="subagents-scroll">
      <header className="sa-hero">
        <div className="sa-hero-text">
          <h1>Subagents</h1>
          <div className="sa-hero-stats">
            <span className={`sa-pill${settings.enabled ? " is-on" : ""}`}>{settings.enabled ? "On for new chats" : "Off"}</span>
            <span className="sa-pill">{enabledCount} of {agents.length} enabled</span>
            {running ? <span className="sa-pill is-running">{running} running</span> : null}
          </div>
        </div>
      </header>
      {missingModel ? <p className="sa-warning" role="alert">Some subagents have no model. Choose a default model below, or one for each.</p> : null}

      <section className="sa-section" aria-label="Settings">
        <h2>General</h2>
        <div className="sa-panel">
          <Row label="Let chat agents start subagents">
            <Switch label="Let chat agents start subagents" checked={settings.enabled} onChange={enabled => setSettings({ enabled })} />
          </Row>
          <Row label="Running at once" body="Across all chats">
            <NumberField label="Running at once" min={1} max={100} value={settings.maxConcurrent} onChange={maxConcurrent => setSettings({ maxConcurrent })} />
          </Row>
          <Row label="Per chat">
            <NumberField label="Per chat" min={1} max={100} value={settings.maxPerChat} onChange={maxPerChat => setSettings({ maxPerChat })} />
          </Row>
          <Row label="Time limit">
            <NumberField label="Time limit in minutes" unit="min" min={1} max={240} value={settings.timeoutMinutes} onChange={timeoutMinutes => setSettings({ timeoutMinutes })} />
          </Row>
          <Row label="Permissions">
            <select className="sa-select" aria-label="Permissions" value={settings.permission} onChange={event => setSettings({ permission: event.target.value as SubagentSettings["permission"] })}>
              <option value="auto">Approve for me</option>
              <option value="full">Full access</option>
            </select>
          </Row>
          <Row label="Release agents when done">
            <Switch label="Release agents when done" checked={settings.releaseWhenDone} onChange={releaseWhenDone => setSettings({ releaseWhenDone })} />
          </Row>
        </div>
      </section>

      <section className="sa-section" aria-label="Default model">
        <h2>Default model</h2>
        <div className="sa-panel is-padded">
          {settings.defaultRoute
            ? <>
              <div className="sa-picker">
                <HarnessPicker route={pickerRoute(settings.defaultRoute)} harnesses={harnesses} loadModels={loadModels} hidePermissionNote agentsOnly compact
                  onChange={route => setSettings({ defaultRoute: subagentRoute(route) })} />
              </div>
              <button type="button" className="sa-text-button" onClick={() => setSettings({ defaultRoute: null })}>Clear default model</button>
            </>
            : <button type="button" className="sa-button" onClick={() => setSettings({ defaultRoute: subagentRoute(pickerRoute(null)) })}>Choose a default model</button>}
        </div>
      </section>

      <section className="sa-section" aria-label="Subagents">
        <div className="sa-section-head">
          <h2>Your subagents <span className="sa-count">{agents.length}</span></h2>
          <button type="button" className="sa-button" disabled={agents.length >= 24} onClick={addAgent}>+ Add subagent</button>
        </div>
        {!agents.length ? <div className="sa-panel is-padded"><p className="sa-empty">No subagents yet.</p></div> : null}
        <div className="sa-agents">
          {agents.map((agent, index) => <article key={index} className={`sa-agent${agent.enabled ? "" : " is-off"}`} aria-label={agent.name || "Subagent"}>
            <header className="sa-agent-head">
              <span className="sa-avatar" aria-hidden="true">{(agent.name.trim()[0] || "?").toUpperCase()}</span>
              <div className="sa-agent-title">
                <input className="sa-agent-name" aria-label="Name" value={agent.name} maxLength={60} placeholder="Name"
                  onChange={event => setAgent(index, { name: event.target.value })} />
                <code title="ID chat agents use to start it">{agent.id}</code>
              </div>
              <Switch label={`${agent.name} enabled`} checked={agent.enabled} onChange={enabled => setAgent(index, { enabled })} />
              <button type="button" className="sa-icon-button" aria-label={`Remove ${agent.name || "subagent"}`} title="Remove" onClick={() => removeAgent(index)}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </header>
            <label className="sa-field"><span>What it's for</span>
              <textarea rows={2} maxLength={400} value={agent.description} placeholder="e.g. Reviews changes for bugs and missing tests; changes nothing."
                onChange={event => setAgent(index, { description: event.target.value })} />
            </label>
            <label className="sa-field"><span>Instructions</span>
              <textarea rows={4} maxLength={8000} value={agent.instructions} placeholder="How it should work and what its report should contain."
                onChange={event => setAgent(index, { instructions: event.target.value })} />
            </label>
            <div className="sa-field">
              <span>Model</span>
              <div className="sa-segmented" role="radiogroup" aria-label={`${agent.name} model`}>
                <button type="button" role="radio" aria-checked={!agent.route} onClick={() => setAgent(index, { route: null })}>
                  Default{settings.defaultRoute ? <small>{modelName(settings.defaultRoute)}</small> : <small>none chosen</small>}
                </button>
                <button type="button" role="radio" aria-checked={Boolean(agent.route)}
                  onClick={() => { if (!agent.route) setAgent(index, { route: subagentRoute(pickerRoute(settings.defaultRoute)) }); }}>Its own model</button>
              </div>
              {agent.route ? <div className="sa-picker"><HarnessPicker route={pickerRoute(agent.route)} harnesses={harnesses} loadModels={loadModels} hidePermissionNote agentsOnly compact
                onChange={route => setAgent(index, { route: subagentRoute(route) })} /></div> : null}
            </div>
          </article>)}
        </div>
      </section>

      <section className="sa-section" aria-label="Running and recent subagents">
        <h2>Running and recent</h2>
        {!runs.length ? <div className="sa-panel is-padded"><p className="sa-empty">None yet.</p></div>
          : <ul className="sa-runs">
            {runs.map(run => <li key={run.subagent_id} className={`sa-run is-${run.state}`}>
              <div className="sa-run-head">
                <span className="sa-state"><i aria-hidden="true" />{STATE_LABEL[run.state] ?? run.state}</span>
                <strong>{run.name}</strong>
                <span className="sa-muted">{elapsed(run.elapsed_seconds)}</span>
                <span className="sa-run-actions">
                  {["starting", "running"].includes(run.state) ? <button type="button" className="sa-text-button is-danger" onClick={() => stop(run.subagent_id)}>Stop</button> : null}
                  {run.report || run.error ? <button type="button" className="sa-text-button" aria-expanded={openReport === run.subagent_id}
                    onClick={() => setOpenReport(current => current === run.subagent_id ? null : run.subagent_id)}>{openReport === run.subagent_id ? "Hide report" : "Report"}</button> : null}
                </span>
              </div>
              <p className="sa-task">{run.task}</p>
              {run.error && openReport !== run.subagent_id ? <p className="sa-run-error">{run.error.split("\n")[0]}</p> : null}
              {openReport === run.subagent_id ? <pre className="sa-report">{[run.error, run.report].filter(Boolean).join("\n\n")}</pre> : null}
            </li>)}
          </ul>}
      </section>
    </div>
    {/* Changes save themselves; the bar on the page's bottom edge says where they are. */}
    <div className={`sa-savebar${saveError ? " is-error" : dirty ? " is-dirty" : ""}`} role="status" aria-label="Save status">
      <span>{saveError ? `Not saved: ${saveError}` : busy ? "Saving…" : dirty ? "Saving changes…" : "All changes saved"}</span>
      {saveError ? <button type="button" className="sa-button is-primary" disabled={busy} onClick={() => { failedDraft.current = ""; void save(draft); }}>Try again</button> : null}
    </div>
  </div>;
}
