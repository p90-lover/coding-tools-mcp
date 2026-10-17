import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "../icons";
import {
  capabilityText, contextText, harnessLabel, parseTokens, rememberCpaProviders, routeTuning,
  NATIVE_HARNESS, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, WEB_ROUTE, WEB_TIERS, isWebModel, modelLabel, modelShortLabel, nativePermission, webTier, workerRoute, withTuning,
  type AoHarness, type AoModelCapabilities, type AoModelCatalog, type AoModelLoader, type AoRoute, type AoTeam,
} from "./AgentOrchestratorRoleEditor";
import { HarnessLogo } from "./HarnessLogo";

/** A loader may return a plain id list or a catalog with capabilities; the list needs only ids. */
const modelIds = (items: string[] | AoModelCatalog) => Array.isArray(items) ? items : items.models;
const modelCaps = (items: string[] | AoModelCatalog) => Array.isArray(items) ? {} : items.capabilities ?? {};
/** The effort word Codex dims after the model name ("High", "Extra high"). */
const effortWord = (effort?: string) => !effort ? "" : effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);
/** The effort a model id carries itself ("gemini-3.8-flash-high", "gpt-oss-120b-medium", "…(high)"). */
const ownEffort = (model: string) => /[-(](minimal|low|medium|high|xhigh|max)\)?$/i.exec(model)?.[1]?.toLowerCase();
/** A chat's window when none is picked: 400K, kept inside what the model accepts. */
export const DEFAULT_CONTEXT_WINDOW = 400_000;
const defaultWindow = (context: { min: number; max?: number } | undefined) => !context ? null
  : Math.max(context.min, Math.min(DEFAULT_CONTEXT_WINDOW, context.max ?? DEFAULT_CONTEXT_WINDOW));

export type ComposerControlsProps = {
  mode: "single" | "team"; onModeChange: (mode: "single" | "team") => void;
  route: AoRoute; onRouteChange: (route: AoRoute) => void;
  harnesses: AoHarness[]; loadModels: AoModelLoader;
  teams: AoTeam[]; teamId: string; onTeamChange: (teamId: string) => void;
  permissions: ReactNode; busy: boolean;
};

/** Shared keyboard/outside-click behavior for the three independent composer popovers. */
export function useComposerPopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled), select:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") event.preventDefault();
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex='0']") ?? []);
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  return { open, setOpen, root, trigger, panel, close, onKeyDown };
}

/** One composer chip and the menu it opens: the chip shows what is picked, the menu the choices. */
function ChipMenu({ label, ariaLabel, title, disabled, className = "", popupClass, heading, onOpen, children }: {
  label: ReactNode; ariaLabel: string; title?: string; disabled: boolean; className?: string; popupClass: string; heading: string;
  onOpen?: () => void; children: (close: () => void) => ReactNode;
}) {
  const popup = useComposerPopover();
  return <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
    <button type="button" className={`ao-composer-chip ${className}`.trim()} ref={popup.trigger} disabled={disabled} aria-expanded={popup.open}
      aria-haspopup="dialog" aria-label={ariaLabel} title={title} onClick={() => { if (!popup.open) onOpen?.(); popup.setOpen(value => !value); }}>
      {label}<span aria-hidden="true">⌄</span>
    </button>
    {popup.open ? <section ref={popup.panel} role="dialog" aria-label={heading} className={`ao-composer-popover ${popupClass}`}>
      <header><h3>{heading}</h3>
        <button type="button" className="ao-popover-close" aria-label="Close selector" onClick={popup.close}><Icon name="close" width="18" height="18" /></button>
      </header>
      {children(popup.close)}
    </section> : null}
  </div>;
}

/** An option row in a chip menu: a radio mark, its text, and a check when it is the pick. */
function Option({ picked, disabled, onPick, title, children }: { picked: boolean; disabled: boolean; onPick: () => void; title?: string; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={picked} className="ao-picker-option" disabled={disabled} onClick={onPick} title={title}>
    <span className="ao-option-radio" aria-hidden="true" /><span>{children}</span>{picked ? <Icon name="check" width="16" height="16" /> : null}
  </button>;
}

export function AgentOrchestratorComposerControls({
  mode, onModeChange, route, onRouteChange, harnesses, loadModels, teams, teamId, onTeamChange, permissions, busy,
}: ComposerControlsProps) {
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [caps, setCaps] = useState<Record<string, AoModelCapabilities>>({});
  const [error, setError] = useState("");
  const [contextDraft, setContextDraft] = useState("");
  useEffect(() => { setSearch(""); }, [mode]);
  // The harness's catalog is read whenever the composer shows a single model, not only when its
  // menu opens: the effort and window chips need the picked model's options to label themselves.
  // Opening the model menu reads the catalog again (the loader keeps it a minute), so a provider
  // added in CPA shows up without switching harness or restarting.
  const [reload, setReload] = useState(0);
  const shown = useRef("");
  useEffect(() => {
    if (mode !== "single") return;
    let live = true;
    const key = `${mode}|${route.harness_id}`;
    if (shown.current !== key) { shown.current = key; setModels(null); setCaps({}); }
    setError("");
    const none: AoModelCatalog = { models: [] };
    // Native Codex lists WebGPT and the CPA pool itself; other harnesses add the WebGPT models.
    const web = route.harness_id === NATIVE_HARNESS ? Promise.resolve(none)
      : loadModels(NATIVE_HARNESS).then(items => modelIds(items).filter(isWebModel), () => none);
    void Promise.all([loadModels(route.harness_id), web]).then(([catalog, webCatalog]) => {
      if (!live) return;
      const loaded = { ...modelCaps(webCatalog), ...modelCaps(catalog) };
      setModels([...new Set([...modelIds(catalog), ...modelIds(webCatalog)])]);
      setCaps(loaded);
      rememberCpaProviders(loaded);
      const start = route.context_window ? null : defaultWindow(routeTuning(route, loaded[route.model]).context);
      if (start) onRouteChange({ ...route, context_window: start });
    }).catch(cause => { if (live) { setModels([]); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [mode, route.harness_id, loadModels, reload]);
  const selectedTeam = teams.find(team => team.id === teamId);
  // Native Codex runs a bare non-WebGPT id through the CPA pool; the labels need to know which.
  const viaPool = (model: string) => route.harness_id === NATIVE_HARNESS && !isWebModel(model);
  const query = search.toLowerCase();
  // Search reads the id, the full label and the short name, so shortening never hides a model.
  const matching = (models ?? []).filter(model => model !== "default" && [model, modelLabel(model, viaPool(model)), modelShortLabel(model, viaPool(model)).name]
    .some(text => text.toLowerCase().includes(query)));
  // Rows sit under their provider ("Claude · CPA"), in the order the catalog first lists each one.
  const groups = new Map<string, string[]>();
  for (const model of matching) {
    const group = modelShortLabel(model, viaPool(model)).group;
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  const harness = harnesses.find(item => item.id === route.harness_id);
  const harnessName = harness?.label ?? harnessLabel(route.harness_id, harnesses);
  const capability = caps[route.model];
  const { efforts, context, fullLimit, presets } = routeTuning(route, models === null ? undefined : capability);
  const effortUnsupported = Boolean(route.effort && efforts && !efforts.includes(route.effort));
  const setEffort = (effort: string | null) => { const next = { ...route }; if (effort) next.effort = effort; else delete next.effort; onRouteChange(next); };
  const setWindow = (tokens: number | null) => { const next = { ...route }; if (tokens) next.context_window = tokens; else delete next.context_window; onRouteChange(next); };
  const inRange = (tokens: number) => Boolean(context) && Number.isSafeInteger(tokens) && tokens >= context!.min && (context!.max === undefined || tokens <= context!.max);
  // No "Default" window: a chat starts at 400K (or the model's limit, if lower). The model list sets
  // it once it knows the model's range, and so does picking a model.
  const startWindow = defaultWindow(context);
  const windowLabel = contextText(route.context_window || startWindow || fullLimit || DEFAULT_CONTEXT_WINDOW);
  // No "Default" effort either: unpicked, a model runs at its own effort, which the chip names
  // when the model's id carries it ("Gemini 3.8 Flash High" -> High) and otherwise calls "Auto".
  const modelEffort = ownEffort(route.model);
  const effortLabel = route.effort ? effortWord(route.effort) : modelEffort ? effortWord(modelEffort) : "Auto";
  // A picked model the harness no longer offers (CPA dropped cline-pass/deepseek-v4.1-flash when
  // Cline stopped serving it) must not look as if it would run; the send is refused up front too.
  const baseModel = route.model.replace(/\((?:\d+|none|auto|minimal|low|medium|high|xhigh|max|ultra)\)$/i, "");
  const unlisted = Boolean(route.model) && models !== null && models.length > 0 && !models.includes(route.model) && !models.includes(baseModel);
  const modelName = modelLabel(route.model, route.provider_id === "cliproxyapi-antigravity") || "Choose model";
  // The chip shows the model's name only; who serves it is in the menu's groups and the tooltip.
  const chipModel = modelShortLabel(route.model, route.provider_id === "cliproxyapi-antigravity");
  // A WebGPT model is one ChatGPT effort, so the effort chip picks the WebGPT model and the model
  // list sets the effort: the two can never disagree (High model, Low effort).
  const tier = webTier(route.model);
  const pickModel = (model: string) => {
    const next = withTuning(workerRoute(route.harness_id, model, nativePermission(route)), route);
    const picked = webTier(model);
    if (picked) next.effort = picked.effort;
    const tuning = routeTuning(next, caps[model]);
    const kept = next.context_window && tuning.context && next.context_window >= tuning.context.min
      && (tuning.context.max === undefined || next.context_window <= tuning.context.max);
    if (!kept) {
      const start = defaultWindow(tuning.context);
      if (start) next.context_window = start; else delete next.context_window;
    }
    onRouteChange(next);
  };
  return <div className="ao-composer-controls">
    {permissions}
    <div className="ao-mode-switch" role="group" aria-label="Who answers">
      {(["single", "team"] as const).map(option => <button key={option} type="button" aria-pressed={mode === option}
        className={mode === option ? "is-active" : undefined} disabled={busy}
        title={option === "single" ? "One model answers by itself" : "A saved team (orchestrator, workers, reviewer) works on it"}
        onClick={() => { if (mode !== option) onModeChange(option); }}>{option === "single" ? "Single" : "Team"}</button>)}
    </div>
    {mode === "single" ? <>
      {/* The harness shows only its logo; its name is in the tooltip and the accessible label. */}
      <ChipMenu heading="Harness" popupClass="ao-tuning-popup" className="is-logo" ariaLabel={`Harness: ${harnessName}`} disabled={busy || isWebModel(route.model)}
        title={isWebModel(route.model) ? `${harnessName} · WebGPT runs only on Native Codex` : `${harnessName} · the agent that runs this chat`}
        label={<HarnessLogo harnessId={route.harness_id} label={harnessName} />}>
        {(close) => <div role="radiogroup" aria-label="Harnesses">
          {harnesses.map(item => <Option key={item.id} picked={item.id === route.harness_id} disabled={busy || !item.runnable} onPick={() => {
            // Each harness starts on an explicit model; one without a known model shows "Choose a model".
            const model = item.id === NATIVE_HARNESS ? WEB_ROUTE.model : item.id === DEFAULT_WORKER_HARNESS ? DEFAULT_WORKER_MODEL : "";
            if (item.id !== route.harness_id) onRouteChange(withTuning(workerRoute(item.id, model, nativePermission(route)), route));
            close();
          }}>
            <span className="ao-harness-option"><HarnessLogo harnessId={item.id} label={item.label} size={18} /><strong>{item.label}</strong></span>
            {!item.runnable ? <small>not installed</small> : item.authStatus === "unauthorized" ? <small>sign in</small> : item.chat === false ? <small>terminal</small> : null}
          </Option>)}
          {!harnesses.length ? <p role="status">No agents found yet.</p> : null}
        </div>}
      </ChipMenu>
      <ChipMenu heading="Model" popupClass="ao-model-popup" ariaLabel="Choose model" disabled={busy} className={unlisted ? "is-warning" : ""}
        onOpen={() => setReload(value => value + 1)}
        title={unlisted ? `${modelName} is not offered right now; choose another model` : route.model ? modelName : undefined}
        label={<span>{route.model ? chipModel.name : modelName}
          {unlisted ? <span className="ao-chip-unavailable"> · not available</span> : null}</span>}>
        {(close) => <>
          <input className="ao-model-search" type="search" aria-label="Search models" placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} />
          <div className="ao-model-options" role="radiogroup" aria-label="Available models">
            {models === null ? <p role="status">Loading models…</p> : [...groups].map(([group, items]) => <div key={group || "own"} className="ao-model-group" role="group" aria-label={group || harnessName}>
              {group ? <h4 aria-hidden="true">{group}</h4> : null}
              {items.map(model => {
                const full = capabilityText(caps[model], route.harness_id === NATIVE_HARNESS && isWebModel(model));
                // Rows name the model only: its efforts and window are in the tooltip and in the
                // effort and window chips once picked. "Paused" stays visible: it decides whether it runs.
                return <Option key={model} picked={route.model === model} disabled={busy}
                  title={[modelLabel(model, viaPool(model)), model, full].filter(Boolean).join("\n")}
                  onPick={() => { pickModel(model); close(); }}>
                  {modelShortLabel(model, viaPool(model)).name}
                </Option>;
              })}
            </div>)}
            {models !== null && !matching.length ? <p role="status">{error || "No matching models available from this runtime."}</p> : null}
          </div>
        </>}
      </ChipMenu>
      {tier ? <ChipMenu heading="Reasoning effort" popupClass="ao-tuning-popup" ariaLabel={`Reasoning effort: ${tier.label}`} disabled={busy}
        title="A WebGPT model is one ChatGPT effort: picking an effort here picks that WebGPT model"
        label={<span>{tier.label}</span>}>
        {(close) => <div role="radiogroup" aria-label="Efforts">
          {WEB_TIERS.map(item => <Option key={item.model} picked={item.model === route.model} disabled={busy}
            onPick={() => { pickModel(item.model); close(); }}>{item.label}</Option>)}
        </div>}
      </ChipMenu> : <ChipMenu heading="Reasoning effort" popupClass="ao-tuning-popup" className={effortUnsupported ? "is-warning" : ""}
        ariaLabel={`Reasoning effort: ${effortLabel}`}
        disabled={busy || (!efforts?.length && !route.effort)}
        title={!efforts ? capability?.effortReason || "This model's efforts are not known yet" : !efforts.length ? capability?.effortReason || "This model takes no effort setting"
          : route.effort ? "How hard the model thinks" : "The model's own effort until you pick one"}
        label={<span>{effortLabel}</span>}>
        {(close) => <div role="radiogroup" aria-label="Efforts">
          {/* Unpicked, the model's own effort shows as the pick; picking it again keeps it the model's own. */}
          {(efforts ?? []).map(effort => <Option key={effort} picked={route.effort ? route.effort === effort : modelEffort === effort} disabled={busy}
            onPick={() => { setEffort(!route.effort && modelEffort === effort ? null : effort); close(); }}>{effortWord(effort)}</Option>)}
          {effortUnsupported ? <p className="ao-popup-muted" role="status">{effortWord(route.effort)} is saved but this model does not take it; pick one above.</p> : null}
        </div>}
      </ChipMenu>}
      <ChipMenu heading="Context window" popupClass="ao-tuning-popup" ariaLabel={`Context window: ${windowLabel}`} disabled={busy || !context}
        title={!context ? capability?.contextReason || "This agent's window cannot be set" : "How much of the conversation the agent keeps in view"}
        label={<span>{windowLabel}</span>}>
        {(close) => <div role="radiogroup" aria-label="Context windows">
          {[...new Set([...presets, ...(fullLimit ? [fullLimit] : [])])].sort((a, b) => a - b).map(tokens => <Option key={tokens}
            picked={(route.context_window || startWindow) === tokens} disabled={busy}
            onPick={() => { setWindow(tokens); close(); }}>{contextText(tokens)}{tokens === fullLimit ? <small>full model limit</small> : null}</Option>)}
          <form className="ao-context-custom" onSubmit={event => {
            event.preventDefault();
            const tokens = parseTokens(contextDraft);
            if (tokens === null || !inRange(tokens)) return;
            setWindow(tokens); setContextDraft(""); close();
          }}>
            <input type="text" inputMode="numeric" aria-label="Custom context window" placeholder="Other size, e.g. 300k" value={contextDraft}
              aria-invalid={Boolean(contextDraft.trim()) && !inRange(parseTokens(contextDraft) ?? Number.NaN)} onChange={event => setContextDraft(event.target.value)} />
            <button type="submit" className="ao-popover-apply" disabled={busy || !inRange(parseTokens(contextDraft) ?? Number.NaN)}>Set</button>
          </form>
          {context ? <p className="ao-popup-muted">{contextText(context.min)}–{context.max ? contextText(context.max) : "no limit"}. Applies from the next run.</p> : null}
        </div>}
      </ChipMenu>
    </> : <ChipMenu heading="Orchestrator / Team" popupClass="ao-team-popup" ariaLabel="Choose saved team" disabled={busy}
      label={<><Icon name="orchestrator" width="16" height="16" /><span>{selectedTeam?.name || "Choose saved team"}</span></>}>
      {(close) => <>
        <p className="ao-popup-muted">Saved in Runtime › Team</p>
        <div role="radiogroup" aria-label="Saved teams">
          {teams.map(team => <Option key={team.id} picked={team.id === teamId} disabled={busy} onPick={() => { onTeamChange(team.id); close(); }}>
            <strong>{team.name}</strong><small>{team.nodes.length} {team.nodes.length === 1 ? "agent" : "agents"}</small>
          </Option>)}
          {!teams.length ? <p role="status">No saved teams yet. Build one on the Orchestrator Team page.</p> : null}
        </div>
      </>}
    </ChipMenu>}
  </div>;
}
