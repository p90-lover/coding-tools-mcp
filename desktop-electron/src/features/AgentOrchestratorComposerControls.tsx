import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "../icons";
import {
  capabilityText, contextText, harnessLabel, parseTokens, rememberCpaProviders, routeTuning,
  NATIVE_HARNESS, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, WEB_ROUTE, isWebModel, modelLabel, nativePermission, workerRoute, withTuning,
  type AoHarness, type AoModelCapabilities, type AoModelCatalog, type AoModelLoader, type AoRoute, type AoTeam,
} from "./AgentOrchestratorRoleEditor";
import { HarnessLogo } from "./HarnessLogo";

/** A loader may return a plain id list or a catalog with capabilities; the list needs only ids. */
const modelIds = (items: string[] | AoModelCatalog) => Array.isArray(items) ? items : items.models;
const modelCaps = (items: string[] | AoModelCatalog) => Array.isArray(items) ? {} : items.capabilities ?? {};
/** The effort word Codex dims after the model name ("High", "Extra high"). */
const effortWord = (effort?: string) => !effort ? "" : effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);

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
function ChipMenu({ label, ariaLabel, title, disabled, className = "", popupClass, heading, children }: {
  label: ReactNode; ariaLabel: string; title?: string; disabled: boolean; className?: string; popupClass: string; heading: string;
  children: (close: () => void) => ReactNode;
}) {
  const popup = useComposerPopover();
  return <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
    <button type="button" className={`ao-composer-chip ${className}`.trim()} ref={popup.trigger} disabled={disabled} aria-expanded={popup.open}
      aria-haspopup="dialog" aria-label={ariaLabel} title={title} onClick={() => popup.setOpen(value => !value)}>
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
function Option({ picked, disabled, onPick, children }: { picked: boolean; disabled: boolean; onPick: () => void; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={picked} className="ao-picker-option" disabled={disabled} onClick={onPick}>
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
  useEffect(() => {
    if (mode !== "single") return;
    let live = true;
    setModels(null); setCaps({}); setError("");
    const none: AoModelCatalog = { models: [] };
    // Native Codex lists WebGPT and the CPA pool itself; other harnesses add the WebGPT models.
    const web = route.harness_id === NATIVE_HARNESS ? Promise.resolve(none)
      : loadModels(NATIVE_HARNESS).then(items => modelIds(items).filter(isWebModel), () => none);
    void Promise.all([loadModels(route.harness_id), web]).then(([catalog, webCatalog]) => {
      if (!live) return;
      setModels([...new Set([...modelIds(catalog), ...modelIds(webCatalog)])]);
      setCaps({ ...modelCaps(webCatalog), ...modelCaps(catalog) });
      rememberCpaProviders({ ...modelCaps(webCatalog), ...modelCaps(catalog) });
    }).catch(cause => { if (live) { setModels([]); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [mode, route.harness_id, loadModels]);
  const selectedTeam = teams.find(team => team.id === teamId);
  const matching = (models ?? []).filter(model => model !== "default" && (model.toLowerCase().includes(search.toLowerCase()) || modelLabel(model).toLowerCase().includes(search.toLowerCase())));
  const harness = harnesses.find(item => item.id === route.harness_id);
  const harnessName = harness?.label ?? harnessLabel(route.harness_id, harnesses);
  const capability = caps[route.model];
  const { efforts, context, fullLimit, presets, native } = routeTuning(route, models === null ? undefined : capability);
  const effortUnsupported = Boolean(route.effort && efforts && !efforts.includes(route.effort));
  const setEffort = (effort: string | null) => { const next = { ...route }; if (effort) next.effort = effort; else delete next.effort; onRouteChange(next); };
  const setWindow = (tokens: number | null) => { const next = { ...route }; if (tokens) next.context_window = tokens; else delete next.context_window; onRouteChange(next); };
  const inRange = (tokens: number) => Boolean(context) && Number.isSafeInteger(tokens) && tokens >= context!.min && (context!.max === undefined || tokens <= context!.max);
  const windowLabel = route.context_window ? contextText(route.context_window) : fullLimit ? contextText(fullLimit) : "Default";
  return <div className="ao-composer-controls">
    {permissions}
    <div className="ao-mode-switch" role="group" aria-label="Who answers">
      {(["single", "team"] as const).map(option => <button key={option} type="button" aria-pressed={mode === option}
        className={mode === option ? "is-active" : undefined} disabled={busy}
        title={option === "single" ? "One model answers by itself" : "A saved team (orchestrator, workers, reviewer) works on it"}
        onClick={() => { if (mode !== option) onModeChange(option); }}>{option === "single" ? "Single" : "Team"}</button>)}
    </div>
    {mode === "single" ? <>
      <ChipMenu heading="Harness" popupClass="ao-tuning-popup" ariaLabel={`Harness: ${harnessName}`} disabled={busy || isWebModel(route.model)}
        title={isWebModel(route.model) ? "WebGPT runs only on Native Codex" : "The agent that runs this chat"}
        label={<><HarnessLogo harnessId={route.harness_id} label={harnessName} /><span>{harnessName}</span></>}>
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
      <ChipMenu heading="Model" popupClass="ao-model-popup" ariaLabel="Choose model" disabled={busy}
        label={<span>{modelLabel(route.model, route.provider_id === "cliproxyapi-antigravity") || "Choose model"}</span>}>
        {(close) => <>
          <input className="ao-model-search" type="search" aria-label="Search models" placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} />
          <div className="ao-model-options" role="radiogroup" aria-label="Available models">
            {models === null ? <p role="status">Loading models…</p> : matching.map(model => <Option key={model} picked={route.model === model} disabled={busy}
              onPick={() => { onRouteChange(withTuning(workerRoute(route.harness_id, model, nativePermission(route)), route)); close(); }}>
              {modelLabel(model, route.harness_id === NATIVE_HARNESS && !isWebModel(model))}
              {capabilityText(caps[model], route.harness_id === NATIVE_HARNESS && isWebModel(model)) ? <small>{capabilityText(caps[model], route.harness_id === NATIVE_HARNESS && isWebModel(model))}</small> : null}
            </Option>)}
            {models !== null && !matching.length ? <p role="status">{error || "No matching models available from this runtime."}</p> : null}
          </div>
        </>}
      </ChipMenu>
      <ChipMenu heading="Reasoning effort" popupClass="ao-tuning-popup" className={effortUnsupported ? "is-warning" : ""}
        ariaLabel={`Reasoning effort: ${route.effort ? effortWord(route.effort) : "model default"}`}
        disabled={busy || (!efforts?.length && !route.effort)}
        title={!efforts ? capability?.effortReason || "This model's efforts are not known yet" : !efforts.length ? capability?.effortReason || "This model takes no effort setting" : "How hard the model thinks"}
        label={<span>{route.effort ? effortWord(route.effort) : "Default"}</span>}>
        {(close) => <div role="radiogroup" aria-label="Efforts">
          <Option picked={!route.effort} disabled={busy} onPick={() => { setEffort(null); close(); }}>Model default<small>{native ? "The model's own level" : "Whatever the agent picks"}</small></Option>
          {(efforts ?? []).map(effort => <Option key={effort} picked={route.effort === effort} disabled={busy} onPick={() => { setEffort(effort); close(); }}>{effortWord(effort)}</Option>)}
          {effortUnsupported ? <p className="ao-popup-muted" role="status">{effortWord(route.effort)} is saved but this model does not take it; pick one above.</p> : null}
        </div>}
      </ChipMenu>
      <ChipMenu heading="Context window" popupClass="ao-tuning-popup" ariaLabel={`Context window: ${windowLabel}`} disabled={busy || !context}
        title={!context ? capability?.contextReason || "This agent's window cannot be set" : "How much of the conversation the agent keeps in view"}
        label={<span>{windowLabel}</span>}>
        {(close) => <div role="radiogroup" aria-label="Context windows">
          <Option picked={!route.context_window} disabled={busy} onPick={() => { setWindow(null); close(); }}>
            {fullLimit ? `Full model limit · ${contextText(fullLimit)}` : native ? "Model default" : "Agent default"}
          </Option>
          {presets.filter(tokens => tokens !== fullLimit).map(tokens => <Option key={tokens} picked={route.context_window === tokens} disabled={busy}
            onPick={() => { setWindow(tokens); close(); }}>{contextText(tokens)}</Option>)}
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
