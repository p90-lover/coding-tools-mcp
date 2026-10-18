import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Caret, Icon } from "../icons";
import {
  capabilityText, contextText, harnessLabel, parseTokens, pickerModels, rememberCpaProviders, routeTuning, ModelStatusDot, useComposerPopover,
  NATIVE_HARNESS, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, WEB_ROUTE, WEB_TIERS, isWebModel, modelLabel, modelShortLabel, nativePermission, webTier, workerRoute, withTuning,
  type AoHarness, type AoModelCapabilities, type AoModelLoader, type AoRoute, type AoTeam,
} from "./AgentOrchestratorRoleEditor";
import { HarnessLogo } from "./HarnessLogo";

/** The effort word Codex dims after the model name ("High", "Extra high"). */
const effortWord = (effort?: string) => !effort ? "" : effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);
/** The effort a model id carries itself ("gemini-3.8-flash-high", "gpt-oss-120b-medium", "…(high)"). */
const ownEffort = (model: string) => /[-(](minimal|low|medium|high|xhigh|max)\)?$/i.exec(model)?.[1]?.toLowerCase();
/** A chat's window when none is picked: 400K, kept inside what the model accepts. */
export const DEFAULT_CONTEXT_WINDOW = 400_000;
/**
 * Only a model whose limit is known starts with one (WebGPT's is ChatGPT's own, so it does too).
 * Without a limit the range ends at the client's 2M ceiling, so 400K reached 128K–262K models and
 * their upstreams refused it; those keep the agent's own default.
 */
const defaultWindow = (route: AoRoute, capability: AoModelCapabilities | undefined) => {
  const { context } = routeTuning(route, capability);
  if (!context || !capability?.contextLimit && !isWebModel(route.model)) return null;
  return Math.max(context.min, Math.min(DEFAULT_CONTEXT_WINDOW, context.max ?? DEFAULT_CONTEXT_WINDOW));
};

export type ComposerControlsProps = {
  mode: "single" | "team"; onModeChange: (mode: "single" | "team") => void;
  route: AoRoute; onRouteChange: (route: AoRoute) => void;
  harnesses: AoHarness[]; loadModels: AoModelLoader;
  teams: AoTeam[]; teamId: string; onTeamChange: (teamId: string) => void;
  permissions: ReactNode; busy: boolean;
};

export { useComposerPopover } from "./AgentOrchestratorRoleEditor";

/** One composer chip and the menu it opens: the chip shows what is picked, the menu the choices. */
function ChipMenu({ label, ariaLabel, title, disabled, className = "", popupClass, heading, onOpen, children }: {
  label: ReactNode; ariaLabel: string; title?: string; disabled: boolean; className?: string; popupClass: string; heading: string;
  onOpen?: () => void; children: (close: () => void) => ReactNode;
}) {
  const popup = useComposerPopover();
  return <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
    <button type="button" className={`ao-composer-chip ${className}`.trim()} ref={popup.trigger} disabled={disabled} aria-expanded={popup.open}
      aria-haspopup="dialog" aria-label={ariaLabel} title={title} onClick={() => { if (!popup.open) onOpen?.(); popup.setOpen(value => !value); }}>
      {label}<Caret />
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
  // Why a model cannot currently be served (its plugin’s account is disabled in CPA, say).
  const [gaps, setGaps] = useState<Record<string, string>>({});
  // Listed models CPA set aside for now (kept from memory): they stay pickable and still run.
  const [held, setHeld] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [contextDraft, setContextDraft] = useState("");
  useEffect(() => { setSearch(""); }, [mode]);
  // The harness's catalog is read whenever the composer shows a single model, not only when its
  // menu opens: the effort and window chips need the picked model's options to label themselves.
  // Opening the model menu reads the catalog again (the loader keeps it a minute), so a provider
  // added in CPA shows up without switching harness or restarting.
  const [reload, setReload] = useState(0);
  const shown = useRef("");
  // The route as it is now: a catalog that arrives after the user picked another model must not
  // write the route it started with back over that pick.
  const latest = useRef(route);
  latest.current = route;
  useEffect(() => {
    if (mode !== "single") return;
    let live = true;
    const key = `${mode}|${route.harness_id}`;
    if (shown.current !== key) { shown.current = key; setModels(null); setCaps({}); }
    setError(""); setGaps({}); setCatalogReady(false);
    void pickerModels(route.harness_id, loadModels).then(catalog => {
      if (!live) return;
      const loaded = catalog.capabilities ?? {};
      setModels(catalog.models);
      setCatalogReady(true);
      setCaps(loaded);
      setGaps(catalog.unavailable ?? {});
      setHeld(catalog.held ?? {});
      rememberCpaProviders(loaded);
      const current = latest.current;
      if (current.harness_id !== route.harness_id || current.model !== route.model) return;
      // A window carried from another harness or model (the harness chip keeps it) that this model
      // does not take is dropped, then the model's own start applies. A model the catalog does not
      // describe is left alone: it is flagged as unavailable and its send is refused anyway.
      const capability = loaded[current.model];
      const { context } = routeTuning(current, capability);
      const fits = current.context_window && context && current.context_window >= context.min
        && (context.max === undefined || current.context_window <= context.max);
      if (current.context_window && (fits || !capability && current.harness_id !== NATIVE_HARNESS)) return;
      const next = { ...current };
      const start = defaultWindow(current, capability);
      if (start) next.context_window = start; else delete next.context_window;
      if (next.context_window !== current.context_window) onRouteChange(next);
    }).catch(cause => { if (live) { setModels([]); setGaps({}); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [mode, route.harness_id, loadModels, reload]);
  const selectedTeam = teams.find(team => team.id === teamId);
  // Native Codex runs a bare non-WebGPT id through the CPA pool; the labels need to know which.
  const viaPool = (model: string) => route.harness_id === NATIVE_HARNESS && !isWebModel(model);
  const query = search.toLowerCase();
  // Search reads the id, the full label and the short name, so shortening never hides a model.
  const matching = [...new Set([...(route.model && route.model !== "default" ? [route.model] : []), ...(models ?? [])])].filter(model => model !== "default" && [model, modelLabel(model, viaPool(model)), modelShortLabel(model, viaPool(model)).name]
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
  // it once it knows the model's range, and so does picking a model. A model whose limit is not
  // known runs at the agent's own window, which the chip calls "Auto" like an unpicked effort.
  const startWindow = models === null ? null : defaultWindow(route, capability);
  const shownWindow = route.context_window || startWindow || fullLimit;
  const windowLabel = shownWindow ? contextText(shownWindow) : "Auto";
  // No "Default" effort either: unpicked, a model runs at its own effort, which the chip names
  // when the model's id carries it ("Gemini 3.8 Flash High" -> High) and otherwise calls "Auto".
  const modelEffort = ownEffort(route.model);
  const effortLabel = route.effort ? effortWord(route.effort) : modelEffort ? effortWord(modelEffort) : "Auto";
  // A picked model the harness no longer offers (CPA dropped cline-pass/deepseek-v4.1-flash when
  // Cline stopped serving it) must not look as if it would run; the send is refused up front too.
  const baseModel = route.model.replace(/\((?:\d+|none|auto|minimal|low|medium|high|xhigh|max|ultra)\)$/i, "");
  const unlisted = catalogReady && !error && Boolean(route.model) && models !== null && !models.includes(route.model) && !models.includes(baseModel);
  const selectedGap = catalogReady && !error && models !== null ? gaps[route.model] || gaps[baseModel] || (unlisted ? "This model is not in this harness’s current catalog." : undefined) : undefined;
  const modelName = modelLabel(route.model, route.provider_id === "cliproxyapi-antigravity") || "Choose model";
  // The chip shows the model's name only; who serves it is in the menu's groups and the tooltip.
  const chipModel = modelShortLabel(route.model, route.provider_id === "cliproxyapi-antigravity");
  // A WebGPT model is one ChatGPT effort, so the effort chip picks the WebGPT model and the model
  // list sets the effort: the two can never disagree (High model, Low effort).
  const tier = webTier(route.model);
  const pickModel = (model: string) => {
    // The carried window is fitted to the new model, or dropped where it takes none.
    const next = withTuning(workerRoute(route.harness_id, model, nativePermission(route)), route, caps);
    const picked = webTier(model);
    if (picked) next.effort = picked.effort;
    const tuning = routeTuning(next, caps[model]);
    const kept = next.context_window && tuning.context && next.context_window >= tuning.context.min
      && (tuning.context.max === undefined || next.context_window <= tuning.context.max);
    if (!kept) {
      const start = defaultWindow(next, caps[model]);
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
            {!item.runnable ? <small>not installed</small> : item.chat === false ? <small>terminal</small> : null}
          </Option>)}
          {!harnesses.length ? <p role="status">No agents found yet.</p> : null}
        </div>}
      </ChipMenu>
      <ChipMenu heading="Model" popupClass="ao-model-popup" ariaLabel="Choose model" disabled={busy} className={selectedGap ? "is-warning" : ""}
        onOpen={() => setReload(value => value + 1)}
        title={selectedGap ? `${modelName}: ${selectedGap}` : error ? `Model availability could not be checked: ${error}`
          : route.model ? [modelName, held[route.model] ?? held[baseModel]].filter(Boolean).join("\n") : undefined}
        label={<span><ModelStatusDot reason={selectedGap} />{route.model ? chipModel.name : modelName}</span>}>
        {(close) => <>
          <input className="ao-model-search" type="search" aria-label="Search models" placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} />
          <div className="ao-model-options" role="radiogroup" aria-label="Available models">
            {models === null ? <p role="status">Loading models…</p> : [...groups].map(([group, items]) => <div key={group || "own"} className="ao-model-group" role="group" aria-label={group || harnessName}>
              {group ? <h4 aria-hidden="true">{group}</h4> : null}
              {items.map(model => {
                const full = capabilityText(caps[model], route.harness_id === NATIVE_HARNESS && isWebModel(model));
                const reason = catalogReady && !error ? gaps[model] || (model === route.model ? selectedGap : undefined) : undefined;
                // Rows name the model only: its efforts and window are in the tooltip and in the
                // effort and window chips once picked. "Paused" stays visible: it decides whether it runs.
                return <Option key={model} picked={route.model === model} disabled={busy}
                  title={[modelLabel(model, viaPool(model)), model, full, reason, held[model]].filter(Boolean).join("\n")}
                  onPick={() => { pickModel(model); close(); }}>
                  <ModelStatusDot reason={reason} />{modelShortLabel(model, viaPool(model)).name}
                  {reason ? <small>{reason}</small> : null}
                </Option>;
              })}
            </div>)}
            {!catalogReady && !error && models !== null ? <p role="status">Refreshing models…</p> : null}
            {error ? <p role="status">{error}</p> : models !== null && !matching.length ? <p role="status">No matching models available from this runtime.</p> : null}
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
          {/* With no efforts to pick, the menu says why instead of opening empty, and a carried
              effort the model cannot take can be cleared back to the model's own. */}
          {!efforts?.length ? <p className="ao-popup-muted" role="status">{!efforts
            ? capability?.effortReason || "This model's efforts are not known yet."
            : capability?.effortReason || "This model takes no effort setting."}</p> : null}
          {!efforts?.length && route.effort ? <Option picked={false} disabled={busy} onPick={() => { setEffort(null); close(); }}>
            Auto<small>the model's own</small></Option> : null}
          {effortUnsupported && efforts?.length ? <p className="ao-popup-muted" role="status">{effortWord(route.effort)} is saved but this model does not take it; pick one above.</p> : null}
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
