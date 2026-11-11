import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JsonObject } from "../api/contracts";
import { listAllWorkspaces, moduleCall, watchHarnesses } from "./AgentOrchestratorSurface";
import { AGENT_DEFAULT_MODEL, DEFAULT_WORKER_HARNESS, NATIVE_HARNESS, modelShortLabel, pickerModels, prettyModelName, providerName, rememberCpaProviders, workerRoute,
  type AoHarness, type AoModelCapabilities, type AoModelCatalog, type AoModelLoader, type AoRoute } from "./AgentOrchestratorRoleEditor";
import "./agent-orchestrator.css";
import "./subagents.css";

/** A subagent's model as saved: an AO agent harness and its model, with optional tuning. */
export type SubagentRoute = { harness_id: string; model: string; provider_id?: string; effort?: string; context_window?: number };
export type Subagent = { id: string; name: string; enabled: boolean; description: string; instructions: string; route: SubagentRoute | null };
export type SubagentSettings = {
  enabled: boolean; maxConcurrent: number; maxPerChat: number; timeoutMinutes: number;
  permission: "auto" | "full"; releaseWhenDone: boolean; defaultRoute: SubagentRoute | null;
  /** The providers subagents may use (modelProvider's keys); null allows all of them, ones that appear later too. */
  allowedProviders?: string[] | null;
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

/**
 * One model list for the whole page. A subagent's agent follows from its model: the list holds every
 * model any AO agent runs, each once, with the agents that run it (Claude Code first, then Codex,
 * then opencode). Claude Code alone left out Antigravity's Gemini and Claude models (Antigravity
 * refuses Claude Code's requests), so with Claude Code as the page's agent Gemini 3.8 Flash was
 * missing and the saved default showed "no longer listed".
 */
export type ModelChoice = { model: string; provider: string; harnesses: string[]; capabilities: Record<string, AoModelCapabilities | undefined> };
/** The agents a subagent runs on (subagents.cjs), in the order a model shared by several picks them. */
const AGENT_ORDER = [DEFAULT_WORKER_HARNESS, "ao:codex", "ao:opencode"];
const AGENT_NAMES: Record<string, string> = { [DEFAULT_WORKER_HARNESS]: "Claude Code", "ao:codex": "Codex", "ao:opencode": "opencode" };
const agentRank = (harness: string) => { const at = AGENT_ORDER.indexOf(harness); return at < 0 ? AGENT_ORDER.length : at; };
export function modelChoices(catalogs: ReadonlyArray<{ harness: string; catalog: AoModelCatalog }>): ModelChoice[] {
  const byModel = new Map<string, ModelChoice>();
  for (const { harness, catalog } of [...catalogs].sort((a, b) => agentRank(a.harness) - agentRank(b.harness))) {
    for (const model of catalog.models) {
      if (!model || model === AGENT_DEFAULT_MODEL) continue;
      const choice = byModel.get(model) ?? { model, provider: "", harnesses: [], capabilities: {} };
      choice.harnesses.push(harness);
      choice.capabilities[harness] = catalog.capabilities?.[model];
      byModel.set(model, choice);
    }
  }
  return [...byModel.values()].map(choice => ({ ...choice, provider: modelProvider(choice.model, choice.harnesses, choice.capabilities) }));
}

/**
 * Who serves a model, the key the provider switches save (subagents.cjs providerOf names it the
 * same way, and refuses a launch on a provider that is off): for a CPA model the upstream CPA
 * reports (antigravity, codex, cline-pass…), else its id's own prefix, else "cpa"; an agent's own
 * model (Codex's, on its ChatGPT sign-in) is that agent's ("ao:codex"), never CPA's "codex".
 */
export function modelProvider(model: string, harnesses: readonly string[], capabilities: Record<string, AoModelCapabilities | undefined> = {}): string {
  if (!model.startsWith("cpa/")) return harnesses[0] ?? "";
  const reported = Object.values(capabilities).map(item => item?.provider?.trim().toLowerCase()).find(Boolean);
  const id = model.slice(4);
  return reported || (id.includes("/") ? id.slice(0, id.indexOf("/")).toLowerCase() : "cpa");
}
export function providerLabel(provider: string): string {
  if (provider === "cpa") return "Other";
  if (provider.startsWith("ao:")) return `${AGENT_NAMES[provider] ?? provider.slice(3)} (own account)`;
  return providerName(provider);
}
export type ProviderChoice = { key: string; label: string; models: number };
/** The providers the page's models come from, by name, each with how many models it serves. */
export function providerChoices(choices: readonly ModelChoice[]): ProviderChoice[] {
  const counts = new Map<string, number>();
  for (const choice of choices) counts.set(choice.provider, (counts.get(choice.provider) ?? 0) + 1);
  return [...counts.entries()].map(([key, models]) => ({ key, label: providerLabel(key), models }))
    .sort((a, b) => Number(a.key === "cpa") - Number(b.key === "cpa") || a.label.localeCompare(b.label));
}
export const providerOn = (allowed: readonly string[] | null | undefined, key: string) => !allowed || allowed.includes(key);
/**
 * The allowed list once a provider's switch is flipped. Turning one off keeps every other provider
 * the page lists, so one that shows up later starts off; turning the last one back on clears the
 * list (null), which allows every provider again, new ones too.
 */
export function toggleProvider(allowed: readonly string[] | null | undefined, key: string, on: boolean, known: readonly string[]): string[] | null {
  const current = allowed ?? known;
  const next = on ? [...new Set([...current, key])] : current.filter(item => item !== key);
  return known.every(item => next.includes(item)) ? null : next;
}
/** A saved route's provider: its model's, as listed, else read off the route itself. */
const routeProvider = (route: SubagentRoute, choices: readonly ModelChoice[] | null) =>
  choices?.find(choice => choice.model === route.model)?.provider ?? modelProvider(route.model, [route.harness_id]);
// "cpa/gemini-cli/gemini-3.8-flash" and "cpa/gemini-3.8-flash" are one model from two providers.
const baseModel = (model: string) => model.slice(model.lastIndexOf("/") + 1).toLowerCase();
/** The route a picked model runs on: the agent it is on when that one runs it, else the first that does. */
export function routeForModel(model: string, choices: readonly ModelChoice[], current?: string): SubagentRoute | null {
  const choice = choices.find(item => item.model === model);
  if (!choice) return null;
  const harness = current && choice.harnesses.includes(current) ? current : choice.harnesses[0];
  return subagentRoute(workerRoute(harness, model));
}
/**
 * A saved route its agent no longer runs, moved to an agent that does (Gemini saved on Claude Code
 * goes to Codex, where it starts instead of failing at launch). Its effort stays only where the new
 * agent offers it. A model no agent lists is left as saved.
 */
export function runnableRoute(route: SubagentRoute | null, choices: readonly ModelChoice[]): SubagentRoute | null {
  if (!route) return route;
  const choice = choices.find(item => item.model === route.model);
  if (!choice || choice.harnesses.includes(route.harness_id)) return route;
  const moved = routeForModel(route.model, choices)!;
  const efforts = choice.capabilities[moved.harness_id]?.efforts;
  return route.effort && efforts?.includes(route.effort) ? { ...moved, effort: route.effort } : moved;
}

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
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="sa-row"><span className="sa-row-label">{label}</span><div className="sa-row-control">{children}</div></div>;
}
function NumberField({ value, min, max, label, unit, onChange }: { value: number; min: number; max: number; label: string; unit?: string; onChange: (value: number) => void }) {
  return <span className="sa-number"><input type="number" min={min} max={max} value={value} aria-label={label}
    onChange={event => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))} />{unit ? <small>{unit}</small> : null}</span>;
}
const modelName = (model: string) => model.startsWith("cpa/") ? modelShortLabel(model).name : prettyModelName(model);

/**
 * Who serves it (a provider the user allows), then one of that provider's models, then its effort
 * when the model offers one. `fallback` is the "Default" option a subagent can keep; `like` is the
 * model a newly picked provider starts on when it serves one of the same name (the default's).
 */
function ModelPicker({ label, route, choices, allowed, fallback, like = null, onChange }: {
  label: string; route: SubagentRoute | null; choices: ModelChoice[] | null; allowed: string[] | null; fallback?: string;
  like?: SubagentRoute | null; onChange: (route: SubagentRoute | null) => void;
}) {
  const known = useMemo(() => providerChoices(choices ?? []), [choices]);
  const providers = known.filter(item => providerOn(allowed, item.key));
  const current = route ? choices?.find(choice => choice.model === route.model) : undefined;
  const provider = route ? routeProvider(route, choices) : "";
  const models = (choices ?? []).filter(choice => choice.provider === provider);
  const efforts = route ? current?.capabilities[route.harness_id]?.efforts ?? [] : [];
  // A provider that also serves the model already chosen (Gemini 3.8 Flash on Antigravity or on
  // Gemini CLI) keeps it, and its effort where offered; otherwise its first model.
  const pickProvider = (key: string) => {
    if (!key) { onChange(null); return; }
    const offered = (choices ?? []).filter(choice => choice.provider === key);
    const seed = route ?? like;
    const next = (seed ? offered.find(choice => baseModel(choice.model) === baseModel(seed.model)) : undefined) ?? offered[0];
    const moved = next ? routeForModel(next.model, choices ?? [], route?.harness_id) : null;
    const effort = route?.effort;
    onChange(moved && effort && next?.capabilities[moved.harness_id]?.efforts?.includes(effort) ? { ...moved, effort } : moved);
  };
  const shown = providers.some(item => item.key === provider);
  return <span className="sa-model">
    <select className="sa-select is-provider" aria-label={`${label} provider`} value={provider} disabled={choices === null}
      onChange={event => pickProvider(event.target.value)}>
      {fallback !== undefined ? <option value="">{fallback}</option> : !route ? <option value="" disabled>Choose a provider</option> : null}
      {route && !shown ? <option value={provider}>{providerLabel(provider)}{choices === null ? "" : known.some(item => item.key === provider) ? " (off)" : " (not available)"}</option> : null}
      {providers.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
    </select>
    {route ? <select className="sa-select" aria-label={label} value={route.model} disabled={choices === null}
      onChange={event => onChange(routeForModel(event.target.value, choices ?? [], route.harness_id))}>
      {!current ? <option value={route.model}>{modelName(route.model)}{choices === null ? "" : " (not available)"}</option> : null}
      {models.map(choice => <option key={choice.model} value={choice.model}>{modelName(choice.model)}</option>)}
    </select> : null}
    {route && efforts.length ? <select className="sa-select is-effort" aria-label={`${label} effort`} value={route.effort ?? ""}
      onChange={event => { const next = { ...route }; if (event.target.value) next.effort = event.target.value; else delete next.effort; onChange(next); }}>
      <option value="">Default effort</option>
      {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
    </select> : null}
  </span>;
}

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
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
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

  // The models of every installed agent a subagent runs on, merged into the page's one list. An
  // agent a saved subagent is on stays in it, so that subagent's model still reads as listed.
  const savedAgents = [draft?.settings.defaultRoute, ...draft?.agents.map(agent => agent.route) ?? []].flatMap(route => route ? [route.harness_id] : []);
  const agentIds = harnesses.filter(item => item.runnable && (AGENT_ORDER.includes(item.id) || savedAgents.includes(item.id))).map(item => item.id).join(",");
  useEffect(() => {
    if (!active || !agentIds) return undefined;
    let live = true;
    void Promise.allSettled(agentIds.split(",").map(harness => pickerModels(harness, loadModels, true).then(catalog => ({ harness, catalog }))))
      .then(results => {
        if (!live) return;
        const catalogs = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        for (const { catalog } of catalogs) rememberCpaProviders(catalog.capabilities);
        setChoices(modelChoices(catalogs));
      });
    return () => { live = false; };
  }, [active, agentIds, loadModels]);

  // Saved routes whose agent cannot run their model move to one that can, and save themselves.
  useEffect(() => {
    if (!choices?.length) return;
    setDraft(current => {
      if (!current) return current;
      const settings = { ...current.settings, defaultRoute: runnableRoute(current.settings.defaultRoute, choices) };
      const agents = current.agents.map(agent => ({ ...agent, route: runnableRoute(agent.route, choices) }));
      const next = { settings, agents };
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [choices, saved]);

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
  const allowed = settings.allowedProviders ?? null;
  const providers = providerChoices(choices ?? []);
  // A saved model whose provider was turned off: subagents.cjs refuses to start it.
  const providerOff = choices !== null && Boolean(allowed) && [settings.defaultRoute, ...agents.filter(agent => agent.enabled).map(agent => agent.route)]
    .some(route => route && !providerOn(allowed, routeProvider(route, choices)));
  const defaultName = settings.defaultRoute
    ? `Default · ${providerLabel(routeProvider(settings.defaultRoute, choices))} · ${modelName(settings.defaultRoute.model)}` : "Default";

  return <div className="subagents-page ao-workflow">
    <div className="subagents-scroll">
      <header className="sa-hero">
        <h1>Subagents</h1>
        <Switch label="Let chat agents start subagents" checked={settings.enabled} onChange={enabled => setSettings({ enabled })} />
      </header>
      {missingModel ? <p className="sa-warning" role="alert">Choose a default model, or one for each subagent.</p> : null}
      {providerOff ? <p className="sa-warning" role="alert">A model below is from a provider that's off. Subagents on it won't start until you pick another.</p> : null}

      <div className={`sa-panel${settings.enabled ? "" : " is-off"}`} aria-label="Settings">
        <Row label="Default model">
          <ModelPicker label="Default model" route={settings.defaultRoute} choices={choices} allowed={allowed} onChange={defaultRoute => setSettings({ defaultRoute })} />
        </Row>
        <Row label="Running at once">
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

      {providers.length ? <section className="sa-section" aria-label="Providers">
        <div className="sa-section-head">
          <h2>Providers</h2>
          <span className="sa-muted">{allowed ? `${providers.filter(item => providerOn(allowed, item.key)).length} of ${providers.length} on` : "All on"}</span>
        </div>
        <p className="sa-hint">Subagents use only the providers that are on, including models a chat agent picks itself.</p>
        <div className={`sa-panel${settings.enabled ? "" : " is-off"}`}>
          {providers.map(item => <Row key={item.key} label={item.label}>
            <span className="sa-muted">{item.models} {item.models === 1 ? "model" : "models"}</span>
            <Switch label={`Use ${item.label}`} checked={providerOn(allowed, item.key)}
              onChange={on => setSettings({ allowedProviders: toggleProvider(allowed, item.key, on, providers.map(provider => provider.key)) })} />
          </Row>)}
        </div>
      </section> : null}

      <section className="sa-section" aria-label="Subagents">
        <div className="sa-section-head">
          <h2>Agents</h2>
          <button type="button" className="sa-button" disabled={agents.length >= 24} onClick={addAgent}>Add</button>
        </div>
        <div className="sa-agents">
          {agents.map((agent, index) => <article key={index} className={`sa-agent${agent.enabled ? "" : " is-off"}`} aria-label={agent.name || "Subagent"}>
            <header className="sa-agent-head">
              <input className="sa-agent-name" aria-label="Name" value={agent.name} maxLength={60} placeholder="Name"
                onChange={event => setAgent(index, { name: event.target.value })} />
              <Switch label={`${agent.name} enabled`} checked={agent.enabled} onChange={enabled => setAgent(index, { enabled })} />
              <button type="button" className="sa-icon-button" aria-label={`Remove ${agent.name || "subagent"}`} title="Remove" onClick={() => removeAgent(index)}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </header>
            <label className="sa-label">Purpose
              <textarea className="sa-text" rows={2} maxLength={400} value={agent.description} placeholder="When a chat agent should use it"
                onChange={event => setAgent(index, { description: event.target.value })} /></label>
            <label className="sa-label">Instructions
              <textarea className="sa-text" rows={4} maxLength={8000} value={agent.instructions} placeholder="How it works and what it reports"
                onChange={event => setAgent(index, { instructions: event.target.value })} /></label>
            <ModelPicker label={`${agent.name} model`} route={agent.route} choices={choices} allowed={allowed}
              fallback={defaultName} like={settings.defaultRoute} onChange={route => setAgent(index, { route })} />
          </article>)}
        </div>
      </section>

      {runs.length ? <section className="sa-section" aria-label="Running and recent subagents">
        <h2>Runs</h2>
        <ul className="sa-runs">
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
        </ul>
      </section> : null}
    </div>
    {/* Changes save themselves; the bar shows only while one is on its way or failed. */}
    {saveError || busy || dirty ? <div className={`sa-savebar${saveError ? " is-error" : ""}`} role="status" aria-label="Save status">
      <span>{saveError ? `Not saved: ${saveError}` : "Saving…"}</span>
      {saveError ? <button type="button" className="sa-button is-primary" disabled={busy} onClick={() => { failedDraft.current = ""; void save(draft); }}>Try again</button> : null}
    </div> : null}
  </div>;
}
