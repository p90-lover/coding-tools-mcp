import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Icon } from "../icons";
import {
  capabilityText, contextText, harnessLabel, parseTokens, rememberCpaProviders, routeTuning, EFFORTS,
  NATIVE_HARNESS, DEFAULT_WORKER_HARNESS, DEFAULT_WORKER_MODEL, WEB_ROUTE, WEB_TIERS, isWebModel, modelLabel, modelShortLabel, nativePermission, webTier, workerRoute, withTuning,
  type AoHarness, type AoModelCapabilities, type AoModelCatalog, type AoModelLoader, type AoRoute, type AoTeam,
} from "./AgentOrchestratorRoleEditor";
import { HarnessLogo, ModelLogo } from "./HarnessLogo";

/** A loader may return a plain id list or a catalog with capabilities; the list needs only ids. */
const modelIds = (items: string[] | AoModelCatalog) => Array.isArray(items) ? items : items.models;
const modelCaps = (items: string[] | AoModelCatalog) => Array.isArray(items) ? {} : items.capabilities ?? {};
const modelGaps = (items: string[] | AoModelCatalog) => Array.isArray(items) ? {} : items.unavailable ?? {};
const modelHeld = (items: string[] | AoModelCatalog) => Array.isArray(items) ? {} : items.held ?? {};
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
type ModelTuning = { effort?: string | null; context_window?: number | null };
const tuningKey = (route: AoRoute) => `coding-tools:ao:model-tuning:${JSON.stringify([route.harness_id, route.provider_id, route.account_id, route.model])}`;
/** Only explicit picks are saved: fitting a smaller model must not replace the person's preference. */
function savedTuning(route: AoRoute): ModelTuning {
  try {
    const saved = JSON.parse(localStorage.getItem(tuningKey(route)) || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const tuning: ModelTuning = {};
    if (saved.effort === null || ["auto", "none", ...EFFORTS].includes(saved.effort)) tuning.effort = saved.effort;
    if (saved.context_window === null || Number.isSafeInteger(saved.context_window) && saved.context_window > 0) tuning.context_window = saved.context_window;
    return tuning;
  } catch { return {}; }
}
function rememberTuning(route: AoRoute, field: keyof ModelTuning) {
  if (!route.model) return;
  try { localStorage.setItem(tuningKey(route), JSON.stringify({ ...savedTuning(route), [field]: route[field] ?? null })); } catch { /* The current chat still keeps its pick. */ }
}

/**
 * The effort a chat starts on when its CPA model lists efforts but no "auto": sent without one, CPA
 * had nothing to serve DeepSeek V4.1 Flash (None/Low/High/Max) and the chip read "Auto" anyway.
 * Medium, else High, else the lowest real one by EFFORTS' order (catalogs keep the provider's order);
 * None only when it is all there is. A picked effort, a model that takes Auto or names its own effort
 * ("…-flash-high"), WebGPT (its tier is its effort) and a harness's own models (they run at their
 * own default) keep theirs. The launch applies the same start (agent-orchestrator-workflow's
 * startEffort), so a message sent before the model list loads gets it too.
 */
const startEffort = (route: AoRoute, efforts: readonly string[] | undefined) => {
  // agy gets the bare model name (it sends no tools for a suffixed one) and picks its own thinking level.
  const viaCpa = route.harness_id !== "ao:agy" && (route.model.startsWith("cpa/") || route.harness_id === NATIVE_HARNESS && !isWebModel(route.model));
  if (!viaCpa || route.effort || !efforts?.length || efforts.includes("auto") || isWebModel(route.model) || ownEffort(route.model)) return null;
  const rank = (effort: string) => { const index = (EFFORTS as readonly string[]).indexOf(effort); return index < 0 ? EFFORTS.length : index; };
  const real = efforts.filter(effort => effort !== "none").sort((a, b) => rank(a) - rank(b));
  return ["medium", "high"].find(effort => efforts.includes(effort)) ?? real[0] ?? efforts[0];
};

/** Restore unset fields, then fit this chat without writing over the saved model preference. */
function tunedRoute(route: AoRoute, capability: AoModelCapabilities | undefined): AoRoute {
  const next = { ...route };
  const saved = savedTuning(route);
  const { context, efforts } = routeTuning(route, capability);
  if (!next.effort && saved.effort) next.effort = saved.effort;
  if (capability && next.effort && next.effort !== "auto" && efforts && !efforts.includes(next.effort)) delete next.effort;
  const tier = webTier(route.model);
  if (tier) next.effort = tier.effort;
  if (!next.context_window && saved.context_window) next.context_window = saved.context_window;
  const fits = next.context_window && context && next.context_window >= context.min
    && (context.max === undefined || next.context_window <= context.max);
  if (!next.context_window || !fits && (capability || route.harness_id === NATIVE_HARNESS)) {
    const window = next.context_window && next.context_window === saved.context_window && context
      ? Math.max(context.min, Math.min(context.max ?? next.context_window, next.context_window)) : defaultWindow(next, capability);
    if (window) next.context_window = window; else delete next.context_window;
  }
  const effort = startEffort(next, efforts);
  if (effort) next.effort = effort;
  return next;
}

export type ComposerControlsProps = {
  mode: "single" | "team"; onModeChange: (mode: "single" | "team") => void;
  /** `adjusted`: the composer fitted the route to its model (a window or effort start), not the person's pick. */
  route: AoRoute; onRouteChange: (route: AoRoute, adjusted?: boolean) => void;
  harnesses: AoHarness[]; loadModels: AoModelLoader;
  teams: AoTeam[]; teamId: string; onTeamChange: (teamId: string) => void;
  permissions: ReactNode; busy: boolean;
};

/** Margin a menu keeps from its pane's edge. */
const POPOVER_EDGE = 8;

/** Shifts an absolutely placed menu left until it ends inside its pane (or the window), never past the pane's left edge. */
function fitInPane(menu: HTMLElement | null) {
  if (!menu?.getBoundingClientRect || typeof getComputedStyle !== "function") return;
  const style = getComputedStyle(menu);
  const rect = menu.getBoundingClientRect();
  // Only the two scrollable pickers use this limit; permissions and branch menus keep theirs.
  if (menu.matches(".ao-harness-popup, .ao-model-popup")) {
    menu.style.setProperty("--ao-picker-room", `${Math.max(0, Math.floor(Math.min(rect.bottom, window.innerHeight) - POPOVER_EDGE))}px`);
  }
  if (style.position !== "absolute") return;
  const bounds = (menu.closest(".cx-pane") ?? document.documentElement).getBoundingClientRect();
  const over = rect.right - (bounds.right - POPOVER_EDGE);
  const room = rect.left - (bounds.left + POPOVER_EDGE);
  if (over > 0 && room > 0) menu.style.left = `${(Number.parseFloat(style.left) || 0) - Math.min(over, room)}px`;
}

/** Marks which ends of a scrolling list have more rows past them, so CSS fades just those ends. */
export function fadeEdges(list: HTMLElement | null) {
  if (!list) return;
  const above = list.scrollTop > 1, below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
  const fade = above && below ? "both" : above ? "top" : below ? "bottom" : "";
  if (list.dataset.fade !== fade) list.dataset.fade = fade;
}

/**
 * Shared keyboard/outside-click behavior for the three independent composer popovers. Focus never
 * scrolls: in a split pane, focusing a menu that reached past the pane's edge scrolled the whole
 * pane sideways and left it cut off. A menu that would reach past its pane's right edge opens
 * shifted left to fit.
 */
export function useComposerPopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const focus = (control: HTMLElement) => {
    control.focus({ preventScroll: true });
    if (!panel.current?.matches(".ao-harness-popup, .ao-model-popup")) return;
    const scroller = control.closest<HTMLElement>(".ao-model-options, .ao-harness-list") ?? panel.current;
    const bounds = scroller.getBoundingClientRect(), rect = control.getBoundingClientRect();
    if (rect.top < bounds.top) scroller.scrollTop -= bounds.top - rect.top;
    else if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
  };
  useEffect(() => {
    if (!open) return;
    fitInPane(panel.current);
    const first = panel.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled), select:not(:disabled)");
    if (first) focus(first);
    const fit = () => fitInPane(panel.current);
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", fit);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", fit); };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") event.preventDefault();
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled), select:not(:disabled), summary, [tabindex='0']") ?? []);
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); focus(last); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); focus(first); }
    }
  };
  return { open, setOpen, root, trigger, panel, close, onKeyDown };
}

/** The model list's group for the WebGPT tiers, apart from the API models. */
const WEB_GROUP = "Web GPT Model";

/**
 * One composer chip and the menu it opens: the chip shows what is picked, the menu the choices. No
 * caret: five of them cost a split pane ~70 px, and the hover tint and tooltip already say it's a menu.
 */
function ChipMenu({ label, ariaLabel, title, disabled, className = "", popupClass, heading, showHeading = true, onOpen, children }: {
  label: ReactNode; ariaLabel: string; title?: string; disabled: boolean; className?: string; popupClass: string; heading: string;
  /** False: no title bar (the heading stays the menu's accessible name); Escape or a click away closes it. */
  showHeading?: boolean; onOpen?: () => void; children: (close: () => void) => ReactNode;
}) {
  const popup = useComposerPopover();
  return <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
    <button type="button" className={`ao-composer-chip ${className}`.trim()} ref={popup.trigger} disabled={disabled} aria-expanded={popup.open}
      aria-haspopup="dialog" aria-label={ariaLabel} title={title} onClick={() => { if (!popup.open) onOpen?.(); popup.setOpen(value => !value); }}>
      {label}
    </button>
    {popup.open ? <section ref={popup.panel} role="dialog" aria-label={heading} className={`ao-composer-popover ${popupClass}`}>
      {showHeading ? <header><h3>{heading}</h3>
        <button type="button" className="ao-popover-close" aria-label="Close selector" onClick={popup.close}><Icon name="close" width="18" height="18" /></button>
      </header> : null}
      {children(popup.close)}
    </section> : null}
  </div>;
}

/** An option row in a chip menu: a radio mark, its text, and a check when it is the pick. `row` staggers its entrance. */
function Option({ picked, disabled, onPick, title, ariaLabel, row, children }: {
  picked: boolean; disabled: boolean; onPick: () => void; title?: string; ariaLabel?: string; row?: number; children: ReactNode;
}) {
  return <button type="button" role="radio" aria-checked={picked} className="ao-picker-option" disabled={disabled} onClick={onPick} title={title} aria-label={ariaLabel}
    style={row === undefined ? undefined : { "--row": row } as CSSProperties}>
    <span className="ao-option-radio" aria-hidden="true" /><span>{children}</span>{picked ? <Icon name="check" width="16" height="16" /> : null}
  </button>;
}

export function AgentOrchestratorComposerControls({
  mode, onModeChange, route, onRouteChange, harnesses, loadModels, teams, teamId, onTeamChange, permissions, busy,
}: ComposerControlsProps) {
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [caps, setCaps] = useState<Record<string, AoModelCapabilities>>({});
  // Why a listed-but-unserved model is not offered (its plugin's account is disabled in CPA, say).
  const [gaps, setGaps] = useState<Record<string, string>>({});
  // Listed models CPA set aside for now (kept from memory): they stay pickable and still run.
  const [held, setHeld] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [contextDraft, setContextDraft] = useState("");
  useEffect(() => { setSearch(""); }, [mode]);
  // The harness's catalog is read whenever the composer shows a single model, not only when its
  // menu opens: the effort and window chips need the picked model's options to label themselves.
  // Opening the model menu reads the catalog again (the loader keeps it a minute), so a provider
  // added in CPA shows up without switching harness or restarting.
  const [reload, setReload] = useState(0);
  // The harness strip's name bubble: the hovered or focused logo's name, at that row's height.
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
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
      setGaps({ ...modelGaps(webCatalog), ...modelGaps(catalog) });
      setHeld({ ...modelHeld(webCatalog), ...modelHeld(catalog) });
      rememberCpaProviders(loaded);
      const current = latest.current;
      if (current.harness_id !== route.harness_id || current.model !== route.model) return;
      // A late catalog fits restored preferences too; existing chat picks keep priority over them.
      const next = tunedRoute(current, loaded[current.model]);
      // Reported as an adjustment: it is this chat's fit, not a pick the next new chat should start on.
      if (next.context_window !== current.context_window || next.effort !== current.effort) onRouteChange(next, true);
    }).catch(cause => { if (live) { setModels([]); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [mode, route.harness_id, route.model, loadModels, reload]);
  const selectedTeam = teams.find(team => team.id === teamId);
  // Native Codex runs a bare non-WebGPT id through the CPA pool; the labels need to know which.
  const viaPool = (model: string) => route.harness_id === NATIVE_HARNESS && !isWebModel(model);
  const query = search.toLowerCase();
  // Search reads the id, the full label and the short name, so shortening never hides a model.
  // A list row: its maker's logo and the model's own name, under who serves it. WebGPT's tiers sit
  // apart under "Web GPT Model", each named by its tier alone ("High"), as the effort chip names it.
  const listLabel = (model: string) => isWebModel(model)
    ? { group: WEB_GROUP, name: webTier(model)?.label ?? modelLabel(model).replace(/^(?:WebGPT|ChatGPT Web) /, "") }
    : modelShortLabel(model, viaPool(model));
  const matching = (models ?? []).filter(model => model !== "default" && [model, modelLabel(model, viaPool(model)), listLabel(model).name, listLabel(model).group]
    .some(text => text.toLowerCase().includes(query)));
  // Rows sit under their provider ("Claude · CPA"), in the order the catalog first lists each one.
  const groups = new Map<string, string[]>();
  for (const model of matching) {
    const group = listLabel(model).group;
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  const harness = harnesses.find(item => item.id === route.harness_id);
  const harnessName = harness?.label ?? harnessLabel(route.harness_id, harnesses);
  const capability = caps[route.model];
  const { efforts, context, fullLimit, presets, fixed } = routeTuning(route, models === null ? undefined : capability);
  // "auto" is always takeable: the model runs at its own effort and nothing is sent (aoLaunchArgs).
  const effortUnsupported = Boolean(route.effort && route.effort !== "auto" && efforts && !efforts.includes(route.effort));
  const levels = (efforts ?? []).filter(effort => effort !== "auto");
  const setEffort = (effort: string | null) => { const next = { ...route }; if (effort) next.effort = effort; else delete next.effort; rememberTuning(next, "effort"); onRouteChange(next); };
  const setWindow = (tokens: number | null) => { const next = { ...route }; if (tokens) next.context_window = tokens; else delete next.context_window; rememberTuning(next, "context_window"); onRouteChange(next); };
  const inRange = (tokens: number) => Boolean(context) && Number.isSafeInteger(tokens) && tokens >= context!.min && (context!.max === undefined || tokens <= context!.max);
  // No "Default" window: a chat starts at 400K (or the model's limit, if lower). The model list sets
  // it once it knows the model's range, and so does picking a model. A model whose limit is not
  // known runs at the agent's own window, which the chip calls "Auto" like an unpicked effort.
  const startWindow = models === null ? null : defaultWindow(route, capability);
  const shownWindow = fixed || route.context_window || startWindow || fullLimit;
  const windowLabel = shownWindow ? contextText(shownWindow) : "Auto";
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
  const pickModel = (model: string, harness = route.harness_id) => {
    if (model === route.model && harness === route.harness_id) return;
    const next = withTuning(workerRoute(harness, model, nativePermission(route)), route);
    // Tuning belongs to the destination model, not the one we just left. Unset fields use defaults.
    delete next.context_window;
    const capability = next.harness_id === route.harness_id || isWebModel(model) ? caps[model] : undefined;
    onRouteChange(tunedRoute(next, capability));
  };
  return <div className="ao-composer-controls">
    {permissions}
    {/* Who answers, one click to switch: the logo of the mode in use, a person (one model by itself) or a
        group (a saved team). Both logos are in the button, so a switch rolls one out as the other rolls in.
        Two buttons on a sliding thumb asked for an aimed click and ~56 px of a split pane's chat box. */}
    <button type="button" className="ao-mode-toggle" role="switch" aria-checked={mode === "team"} aria-label="Team mode"
      data-mode={mode} disabled={busy}
      title={mode === "single" ? "Single: one model answers by itself · click for Team" : "Team: a saved team works on it · click for Single"}
      onClick={() => onModeChange(mode === "single" ? "team" : "single")}>
      <span className="ao-mode-face is-single" aria-hidden="true"><Icon name="user" width="15" height="15" /></span>
      <span className="ao-mode-face is-team" aria-hidden="true"><Icon name="team" width="15" height="15" /></span>
    </button>
    {mode === "single" ? <>
      {/* The harness shows only its logo; its name is in the tooltip and the accessible label. */}
      <ChipMenu heading="Harness" showHeading={false} popupClass="ao-tuning-popup ao-harness-popup" className="is-logo" ariaLabel={`Harness: ${harnessName}`} disabled={busy || isWebModel(route.model)}
        title={isWebModel(route.model) ? `${harnessName} · WebGPT runs only on Native Codex` : `${harnessName} · the agent that runs this chat`}
        label={<HarnessLogo harnessId={route.harness_id} label={harnessName} />}>
        {(close) => {
          // A slim strip of logos, every harness in one scrolling column: the ones that run first,
          // then the missing ones, each with a red dot on its logo (one that needs a sign-in has an
          // amber dot). No names on the rows: hovering or focusing a logo shows its name in a bubble
          // beside the strip, and the ends of the column fade where more logos follow.
          const nameOf = (item: AoHarness) => item.runnable ? item.label : `${item.label} · not installed`;
          const row = (item: AoHarness, index: number) => <Option key={item.id} picked={item.id === route.harness_id} disabled={busy || !item.runnable} row={index}
            ariaLabel={nameOf(item)}
            onPick={() => {
              // Each harness starts on an explicit model; one without a known model shows "Choose a model".
              const model = item.id === NATIVE_HARNESS ? WEB_ROUTE.model : item.id === DEFAULT_WORKER_HARNESS ? DEFAULT_WORKER_MODEL : "";
              if (item.id !== route.harness_id) pickModel(model, item.id);
              close();
            }}>
            <span className={item.runnable ? "ao-harness-option" : "ao-harness-option is-missing"}>
              <span className="ao-harness-face"><HarnessLogo harnessId={item.id} label={item.label} size={18} />
                {!item.runnable ? <i className="ao-harness-missing" aria-hidden="true" />
                  : item.authStatus === "unauthorized" ? <i className="ao-harness-signin" aria-hidden="true" /> : null}</span></span>
          </Option>;
          // The picked harness always stays up top, even if it went missing since.
          const ordered = [...harnesses.filter(item => item.runnable || item.id === route.harness_id),
            ...harnesses.filter(item => !item.runnable && item.id !== route.harness_id)];
          // One listener for the whole column: a missing harness's row is a disabled button. The gap
          // between two rows keeps the bubble; leaving the column clears it.
          const point = (target: EventTarget | null) => {
            const option = (target as HTMLElement | null)?.closest?.<HTMLElement>(".ao-picker-option");
            const panel = option?.closest<HTMLElement>(".ao-harness-popup");
            const label = option?.getAttribute("aria-label");
            if (!option || !panel || !label) return;
            const at = option.getBoundingClientRect(), box = panel.getBoundingClientRect();
            const top = Math.round(at.top - box.top + at.height / 2);
            setTip(current => current?.label === label && current.top === top ? current : { label, top });
          };
          const [name, state] = tip?.label.split(" · ") ?? [];
          return <>
            <div role="radiogroup" aria-label="Harnesses" className="ao-harness-list"
              ref={list => { fadeEdges(list); if (list && typeof requestAnimationFrame === "function") requestAnimationFrame(() => fadeEdges(list)); }}
              onScroll={event => { fadeEdges(event.currentTarget); setTip(null); }}
              onPointerOver={event => point(event.target)} onPointerLeave={() => setTip(null)}
              // Keyboard focus names its logo too; the focus a mouse-opened menu puts on its first row does not.
              onFocus={event => { if ((event.target as HTMLElement).matches?.(":focus-visible")) point(event.target); }} onBlur={() => setTip(null)}>
              {ordered.map(row)}
              {!harnesses.length ? <p role="status">No agents found yet.</p> : null}
            </div>
            {tip ? <span key={tip.label} className="ao-harness-tip" aria-hidden="true" style={{ "--tip-y": `${tip.top}px` } as CSSProperties}>
              {name}{state ? <small>{state}</small> : null}</span> : null}
          </>;
        }}
      </ChipMenu>
      <ChipMenu heading="Model" showHeading={false} popupClass="ao-model-popup" ariaLabel="Choose model" disabled={busy} className={unlisted ? "is-warning" : ""}
        onOpen={() => setReload(value => value + 1)}
        title={unlisted ? `${modelName} is not offered right now: ${gaps[route.model] ?? gaps[baseModel] ?? "choose another model"}`
          : route.model ? [modelName, held[route.model] ?? held[baseModel]].filter(Boolean).join("\n") : undefined}
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
                  title={[modelLabel(model, viaPool(model)), model, full, held[model]].filter(Boolean).join("\n")}
                  onPick={() => { pickModel(model); close(); }}>
                  <span className="ao-model-row"><ModelLogo model={model} label={listLabel(model).name} /><span>{listLabel(model).name}</span></span>
                </Option>;
              })}
            </div>)}
            {models !== null && !matching.length ? <p role="status">{error || "No matching models."}</p> : null}
          </div>
        </>}
      </ChipMenu>
      {tier ? <ChipMenu heading="Reasoning effort" popupClass="ao-tuning-popup" ariaLabel={`Reasoning effort: ${tier.label}`} disabled={busy}
        title="Each effort is its own WebGPT model"
        label={<span>{tier.label}</span>}>
        {(close) => <div role="radiogroup" aria-label="Efforts">
          {WEB_TIERS.map(item => <Option key={item.model} picked={item.model === route.model} disabled={busy}
            onPick={() => { pickModel(item.model); close(); }}>{item.label}</Option>)}
        </div>}
      </ChipMenu> : <ChipMenu heading="Reasoning effort" popupClass="ao-tuning-popup" className={effortUnsupported ? "is-warning" : ""}
        ariaLabel={`Reasoning effort: ${effortLabel}`}
        disabled={busy || (!levels.length && !route.effort)}
        title={!efforts ? capability?.effortReason || "This model's efforts are not known yet" : !efforts.length ? capability?.effortReason || "This model takes no effort setting"
          : route.effort ? "How hard the model thinks" : "The model's own effort until you pick one"}
        label={<span>{effortLabel}</span>}>
        {(close) => <div role="radiogroup" aria-label="Efforts">
          {/* Auto on every model: no effort is sent, so CPA and the provider can never refuse the level
              (a level a plugin lacked 400ed, and the chat's launch looked stuck). It is saved as "auto",
              so the model's start effort (startEffort) never replaces it. */}
          {levels.length ? <Option picked={route.effort === "auto"} disabled={busy}
            onPick={() => { setEffort("auto"); close(); }}>Auto<small>the model's own</small></Option> : null}
          {/* Unpicked, the model's own effort shows as the pick; picking it again keeps it the model's own. */}
          {levels.map(effort => <Option key={effort} picked={route.effort ? route.effort === effort : modelEffort === effort} disabled={busy}
            onPick={() => { setEffort(!route.effort && modelEffort === effort ? null : effort); close(); }}>{effortWord(effort)}</Option>)}
          {/* With no efforts to pick, the menu says why instead of opening empty, and a carried
              effort the model cannot take can be cleared back to the model's own. */}
          {!levels.length ? <p className="ao-popup-muted" role="status">{!efforts
            ? capability?.effortReason || "This model's efforts are not known yet."
            : capability?.effortReason || "This model takes no effort setting."}</p> : null}
          {!levels.length && route.effort ? <Option picked={false} disabled={busy} onPick={() => { setEffort(null); close(); }}>
            Auto<small>the model's own</small></Option> : null}
          {effortUnsupported && levels.length ? <p className="ao-popup-muted" role="status">This model doesn't take {effortWord(route.effort)}. Pick another above.</p> : null}
        </div>}
      </ChipMenu>}
      {/* WebGPT's window is the Codex bridge's (ChatGPT's own limit): shown, locked. */}
      <ChipMenu heading="Context window" popupClass="ao-tuning-popup" ariaLabel={`Context window: ${windowLabel}`} disabled={busy || !context || Boolean(fixed)}
        title={fixed ? capability?.contextReason || "WebGPT's window is the Codex bridge's" : !context ? capability?.contextReason || "This agent's window cannot be set" : "How much of the conversation the agent keeps in view"}
        label={<span>{windowLabel}</span>}>
        {(close) => <div role="radiogroup" aria-label="Context windows">
          {[...new Set([...presets, ...(fullLimit ? [fullLimit] : [])])].sort((a, b) => a - b).map(tokens => <Option key={tokens}
            picked={(route.context_window || startWindow) === tokens} disabled={busy}
            onPick={() => { setWindow(tokens); close(); }}>{contextText(tokens)}{tokens === fullLimit ? <small>full model limit</small> : null}</Option>)}
          {/* Not a <form>: this menu sits inside the chat box's form, and a nested form's submit
              reached the chat box's onSubmit too, so Set could send the typed message. */}
          <div className="ao-context-custom" onKeyDown={event => {
            if (event.key !== "Enter") return;
            event.preventDefault(); event.stopPropagation();
            event.currentTarget.querySelector<HTMLButtonElement>("button")?.click();
          }}>
            <input type="text" inputMode="numeric" aria-label="Custom context window" placeholder="Other size, e.g. 300k" value={contextDraft}
              aria-invalid={Boolean(contextDraft.trim()) && !inRange(parseTokens(contextDraft) ?? Number.NaN)} onChange={event => setContextDraft(event.target.value)} />
            <button type="button" className="ao-popover-apply" disabled={busy || !inRange(parseTokens(contextDraft) ?? Number.NaN)} onClick={() => {
              const tokens = parseTokens(contextDraft);
              if (tokens === null || !inRange(tokens)) return;
              setWindow(tokens); setContextDraft(""); close();
            }}>Set</button>
          </div>
          {context ? <p className="ao-popup-muted">{contextText(context.min)}–{context.max ? contextText(context.max) : "no limit"}. Applies from the next turn.</p> : null}
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
