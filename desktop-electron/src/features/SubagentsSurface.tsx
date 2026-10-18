import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
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
  const reducedMotion = useReducedMotion();
  const [saved, setSaved] = useState<SubagentConfig | null>(null);
  const [draft, setDraft] = useState<SubagentConfig | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const configRequest = useRef(0);
  const saveInFlight = useRef(false);
  const [view, setView] = useState<"agents" | "activity" | "settings">("agents");
  const [expandedAgent, setExpandedAgent] = useState<string | null>("explorer");
  const focusNewAgent = useRef<string | null>(null);
  const [welcomingAgent, setWelcomingAgent] = useState<string | null>(null);
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<AoHarness[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => { try { return localStorage.getItem("coding-tools:ao:workspace") || ""; } catch { return ""; } });

  // The saved config the draft was last compared with; the page stays mounted between visits.
  const savedRef = useRef<SubagentConfig | null>(null);
  const load = useCallback(async () => {
    // A refresh must not overwrite a save, including when returning to this page mid-save.
    if (saveInFlight.current) return;
    const request = ++configRequest.current;
    setLoadError(null);
    try {
      const result = await moduleCall("subagents_config");
      if (request !== configRequest.current) return;
      setAvailable(result.available !== false);
      if (result.settings && Array.isArray(result.agents)) {
        const config = { settings: result.settings as SubagentSettings, agents: result.agents as Subagent[] };
        const previous = savedRef.current;
        savedRef.current = config;
        setSaved(config); setDraft(current => keptDraft(current, previous, config));
      } else if (result.available !== false) {
        throw new Error("Subagent configuration is incomplete. Try loading it again.");
      }
    } catch (cause) {
      if (request === configRequest.current) setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
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
  const addAgent = () => {
    if (!draft || draft.agents.length >= 24) return;
    const id = subagentId("New subagent", draft.agents.map(agent => agent.id));
    setDraft(current => current && { ...current, agents: [...current.agents, {
      id, name: "New subagent", enabled: true, description: "", instructions: "", route: null }] });
    focusNewAgent.current = id;
    setExpandedAgent(id);
    setWelcomingAgent(id);
  };
  const removeAgent = (index: number) => setDraft(current => current && { ...current, agents: current.agents.filter((_, at) => at !== index) });

  const save = async () => {
    if (!draft || saveInFlight.current) return;
    const submitted = draft;
    saveInFlight.current = true;
    ++configRequest.current; // Ignore configuration reads begun before this write.
    setBusy(true); setNotice(""); setLoadError(null);
    try {
      const result = await moduleCall("subagents_save", { settings: draft.settings as unknown as JsonObject, agents: draft.agents as unknown as JsonObject[] } as unknown as JsonObject);
      const config = { settings: result.settings as SubagentSettings, agents: result.agents as Subagent[] };
      savedRef.current = config;
      setSaved(config); setDraft(current => keptDraft(current, submitted, config)); setNotice("Saved. New chats get these subagents; open chats pick them up on their next agent start.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { saveInFlight.current = false; setBusy(false); }
  };
  const stop = (id: string) => void moduleCall("subagents_stop", { subagentId: id })
    .then(() => moduleCall("subagents_runs")).then(result => setRuns(Array.isArray(result.runs) ? result.runs as SubagentRun[] : []))
    .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));

  if (!available) return <div className="subagents-page"><p className="subagents-empty">Subagents need the Agent Orchestrator, which is not available in this build.</p></div>;
  if (!draft) return <div className="subagents-page ao-workflow"><div className="subagents-scroll">
    {loadError ? <div className="subagents-load-error" role="alert"><strong>Could not load subagents</strong><p>{loadError}</p>
      <button type="button" className="subagents-secondary" onClick={() => void load()}>Try again</button></div>
      : <p className="subagents-empty" role="status">Loading…</p>}
  </div></div>;
  const { settings, agents } = draft;
  const missingModel = agents.some(agent => agent.enabled && !agent.route) && !settings.defaultRoute;

  return <div className="subagents-page ao-workflow">
    <div className="subagents-scroll">
      <header className="subagents-head">
        <div>
          <h1>Subagents</h1>
          <p>Give your chat a team of specialists.</p>
        </div>
        <div className="subagents-actions">
          {dirty ? <button type="button" className="subagents-secondary" disabled={busy} onClick={() => saved && setDraft(structuredClone(saved))}>Discard</button> : null}
          <button type="button" className="subagents-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </header>
      {notice ? <p className="subagents-notice" role="status">{notice}</p> : null}
      {loadError ? <div className="subagents-load-error" role="alert"><p>{loadError}</p>
        <button type="button" className="subagents-secondary" onClick={() => void load()}>Try again</button></div> : null}

      <div className="subagents-overview" aria-label="Team overview">
        <div className="subagents-counts"><span>{agents.length} {agents.length === 1 ? "agent" : "agents"}</span><span>{agents.filter(agent => agent.enabled).length} enabled</span><span>{runs.filter(run => ["starting", "running"].includes(run.state)).length} running</span></div>
        <div className="subagents-enabled"><span>{settings.enabled ? "Enabled" : "Disabled"}</span><Switch label="Enable subagents" checked={settings.enabled} onChange={enabled => setSettings({ enabled })} /></div>
      </div>
      <nav className="subagents-tabs" aria-label="Subagent views">
        <button type="button" aria-current={view === "agents" ? "page" : undefined} onClick={() => setView("agents")}>Agents</button>
        <button type="button" aria-current={view === "activity" ? "page" : undefined} onClick={() => setView("activity")}>Activity <span>{runs.length}</span></button>
        <button type="button" aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>Settings</button>
      </nav>
      {missingModel ? <p className="subagents-warning" role="alert">Some enabled agents need a model. <button type="button" className="subagents-link" onClick={() => setView("settings")}>Choose a default in Settings</button>, or choose one in each agent’s editor.</p> : null}
      <section className="subagents-section" aria-label="Subagents" hidden={view !== "agents"}>
        <div className="subagents-section-head"><div><h2>Your agents</h2><p className="subagents-section-description">Define a purpose, choose a model, and let your chat delegate.</p></div><button type="button" className="subagents-secondary subagents-add" disabled={agents.length >= 24} onClick={addAgent}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Add subagent</button></div>
        {!agents.length ? <p className="subagents-empty">No subagents yet. Add one, give it a purpose and instructions, and chat agents can start it.</p> : null}
        {agents.map((agent, index) => <article key={agent.id} className={`subagents-card${agent.enabled ? "" : " is-off"}${welcomingAgent === agent.id ? " is-new" : ""}`} aria-label={agent.name || "Subagent"}>
          <div className="subagents-card-head">
            <button type="button" className="subagents-agent-summary" aria-expanded={expandedAgent === agent.id} aria-controls={`subagent-editor-${agent.id}`}
              onClick={() => setExpandedAgent(current => current === agent.id ? null : agent.id)}>
              <span className={`subagents-avatar tone-${index % 3}`} aria-hidden="true">
                <svg className="subagents-face" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <g className="subagents-eyes">
                    <path d={agent.enabled ? index % 3 === 1 ? "M12 20h7m10 0h7" : "M16 19v3m16-3v3" : "m12 21 4 2 4-2m8 0 4 2 4-2"} />
                    {index % 3 === 2 ? <><circle cx="16" cy="21" r="7" /><circle cx="32" cy="21" r="7" /><path d="M23 21h2" /></> : null}
                  </g>
                  <path className="subagents-smile" d={agent.enabled ? "M17 31q7 7 14 0" : "M20 33h8"} />
                  {index % 3 === 0 ? <path d="m32 11 3-2m-22 2-3-2" /> : null}
                </svg>
                <svg className="subagents-wave" viewBox="0 0 24 24" fill="#fff5d7" stroke="#8b681b" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m8 12-3-4c-1-2 1-3 2-1l2 3-2-6c-.5-2 2-2.5 2.5-.5L11 9l-.5-6c0-2 2.5-2 2.5 0l.5 6 1-4c.5-2 3-1.5 2.5.5l-1 7 2-2c2-1 3 1 1 3l-3 5c-3 5-8 3-9-1l-2-3c-1-2 1-3 3-2Z" />
                </svg>
                <span className="subagents-quip">{agent.enabled ? index % 3 === 0 ? "Detective mode: on." : index % 3 === 1 ? "Less talk. More build." : "I spot the plot holes." : "On a tiny coffee break."}</span>
                {welcomingAgent === agent.id ? <><span className="subagents-welcome">Reporting for duty!</span><span className="subagents-confetti">{Array.from({ length: 6 }, (_, piece) => <i key={piece} />)}</span></> : null}
              </span>
              <span className="subagents-agent-copy"><strong>{agent.name || "Untitled agent"}</strong><code>{agent.id}</code><span>{agent.description || "Add a purpose to help your chat choose this agent."}</span></span>
            </button>
            <span className="subagents-route" title={agent.route?.model || settings.defaultRoute?.model || "Choose a default in Settings"}>{agent.route ? agent.route.model.replace(/^cpa\//, "") : "Default model"}</span>
            <Switch label={`${agent.name} enabled`} checked={agent.enabled} onChange={enabled => setAgent(index, { enabled })} />
            <button type="button" className="subagents-expand" aria-label={`${expandedAgent === agent.id ? "Collapse" : "Edit"} ${agent.name}`} aria-expanded={expandedAgent === agent.id} aria-controls={`subagent-editor-${agent.id}`}
              onClick={() => setExpandedAgent(current => current === agent.id ? null : agent.id)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" style={{ transform: expandedAgent === agent.id ? "rotate(180deg)" : undefined }}><path d="m6 9 6 6 6-6" /></svg></button>
          </div>
          <motion.div className="subagents-editor" id={`subagent-editor-${agent.id}`} inert={expandedAgent !== agent.id} aria-hidden={expandedAgent !== agent.id}
            initial={false} animate={{ height: expandedAgent === agent.id ? "auto" : 0, opacity: expandedAgent === agent.id ? 1 : 0, paddingTop: expandedAgent === agent.id ? 24 : 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: .24, ease: [.22, 1, .36, 1] }}>
            <label className="subagents-field">Name
              <input className="subagents-name" aria-label="Name" ref={input => {
                if (input && focusNewAgent.current === agent.id) { focusNewAgent.current = null; input.focus(); }
              }} value={agent.name} maxLength={60} placeholder="Name"
                onChange={event => setAgent(index, { name: event.target.value })} />
            </label>
            <label className="subagents-field">Purpose <small>The chat uses this to choose an agent.</small>
              <textarea rows={2} maxLength={400} value={agent.description} placeholder="e.g. Reviews changes for bugs and missing tests; changes nothing."
                onChange={event => setAgent(index, { description: event.target.value })} />
            </label>
            <label className="subagents-field">Instructions <small>How this agent should approach its task.</small>
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
            <div className="subagents-editor-actions"><button type="button" className="subagents-link is-danger" onClick={() => removeAgent(index)}>Remove agent</button></div>
          </motion.div>
        </article>)}
      </section>

      <section className="subagents-section" aria-label="Running and recent subagents" hidden={view !== "activity"}>
        <h2>Running and recent</h2><p className="subagents-section-description">Follow delegated work and read the reports your agents send back.</p>
        {!runs.length ? <p className="subagents-empty">No activity yet. When a chat delegates a task, you can follow its progress here.</p> : <ul className="subagents-runs">
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
      <section className="subagents-section" aria-label="Settings" hidden={view !== "settings"}>
        <h2>Settings</h2><p className="subagents-section-description">Set the defaults and boundaries for your team.</p>
        <Row label="Let chat agents start subagents" body="Allows chat agents to delegate work to your enabled subagents. Turn on tools for chat agents in Settings to make them available.">
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
      </section>

      <footer className="subagents-footer"><span>Changes apply after you save.</span><span role="status">{dirty ? "Unsaved changes" : "All changes saved"}</span></footer>
    </div>
  </div>;
}
