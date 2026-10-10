import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "../icons";
import {
  HarnessPicker, capabilityText, rememberCpaProviders, NATIVE_HARNESS, DEFAULT_WORKER_HARNESS, isWebModel, modelLabel, nativePermission, workerRoute, withTuning,
  type AoHarness, type AoModelCapabilities, type AoModelCatalog, type AoModelLoader, type AoRoute, type AoTeam,
} from "./AgentOrchestratorRoleEditor";

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

export function AgentOrchestratorComposerControls({
  mode, onModeChange, route, onRouteChange, harnesses, loadModels, teams, teamId, onTeamChange, permissions, busy,
}: ComposerControlsProps) {
  const popup = useComposerPopover();
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [caps, setCaps] = useState<Record<string, AoModelCapabilities>>({});
  const [error, setError] = useState("");
  useEffect(() => { popup.setOpen(false); setSearch(""); }, [mode]);
  useEffect(() => {
    if (!popup.open || mode !== "single") return;
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
  }, [popup.open, mode, route.harness_id, loadModels]);
  const selectedTeam = teams.find(team => team.id === teamId);
  const matching = (models ?? []).filter(model => model !== "default" && (model.toLowerCase().includes(search.toLowerCase()) || modelLabel(model).toLowerCase().includes(search.toLowerCase())));
  return <div className="ao-composer-controls">
    {permissions}
    <div className="ao-mode-switch" role="group" aria-label="Who answers">
      {(["single", "team"] as const).map(option => <button key={option} type="button" aria-pressed={mode === option}
        className={mode === option ? "is-active" : undefined} disabled={busy}
        title={option === "single" ? "One model answers by itself" : "A saved team (orchestrator, workers, reviewer) works on it"}
        onClick={() => { popup.close(); if (mode !== option) onModeChange(option); }}>{option === "single" ? "Single" : "Team"}</button>)}
    </div>
    <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
      <button type="button" className="ao-composer-chip" ref={popup.trigger} disabled={busy} aria-expanded={popup.open}
        aria-haspopup="dialog" aria-label={mode === "single" ? "Choose model" : "Choose saved team"}
        onClick={() => popup.setOpen(value => !value)}>
        <Icon name={mode === "single" ? "activity" : "orchestrator"} width="16" height="16" />
        <span>{mode === "single" ? modelLabel(route.model, route.provider_id === "cliproxyapi-antigravity") || "Choose model" : selectedTeam?.name || "Choose saved team"}
          {mode === "single" && route.model && route.effort ? <span className="ao-chip-effort"> {effortWord(route.effort)}</span> : null}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {popup.open ? <section ref={popup.panel} role="dialog" aria-label={mode === "single" ? "Model" : "Orchestrator / Team"}
        className={"ao-composer-popover " + (mode === "single" ? "ao-model-popup" : "ao-team-popup")}>
        <header><h3>{mode === "single" ? "Model" : "Orchestrator / Team"}</h3>
          <button type="button" className="ao-popover-close" aria-label="Close selector" onClick={popup.close}><Icon name="close" width="18" height="18" /></button>
        </header>
        {mode === "single" ? <>
          <input className="ao-model-search" type="search" aria-label="Search models" placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} />
          <div className="ao-field-row"><HarnessPicker route={route} harnesses={harnesses} loadModels={loadModels} onChange={onRouteChange} disabled={busy} hideModel hidePermissionNote /></div>
          <h4>Model</h4>
          <div className="ao-model-options" role="radiogroup" aria-label="Available models">
            {models === null ? <p role="status">Loading models…</p> : matching.map(model => <button key={model} type="button" role="radio" aria-checked={route.model === model}
              className="ao-picker-option" disabled={busy} onClick={() => onRouteChange(withTuning(workerRoute(route.harness_id, model, nativePermission(route)), route))}>
              <span className="ao-option-radio" aria-hidden="true" /><span>{modelLabel(model, route.harness_id === NATIVE_HARNESS && !isWebModel(model))}
                {capabilityText(caps[model], route.harness_id === NATIVE_HARNESS && isWebModel(model)) ? <small>{capabilityText(caps[model], route.harness_id === NATIVE_HARNESS && isWebModel(model))}</small> : null}</span>{route.model === model ? <Icon name="check" width="16" height="16" /> : null}
            </button>)}
            {models !== null && !matching.length ? <p role="status">{error || "No matching models available from this runtime."}</p> : null}
          </div>
        </> : <>
          <p className="ao-popup-muted">Saved in Runtime › Team</p>
          <div role="radiogroup" aria-label="Saved teams">
            {teams.map(team => <button key={team.id} type="button" role="radio" aria-checked={team.id === teamId} className="ao-picker-option" disabled={busy}
              onClick={() => { onTeamChange(team.id); popup.close(); }}>
              <span className="ao-option-radio" aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.nodes.length} {team.nodes.length === 1 ? "agent" : "agents"}</small></span>
              {team.id === teamId ? <Icon name="check" width="16" height="16" /> : null}
            </button>)}
            {!teams.length ? <p role="status">No saved teams yet. Build one on the Orchestrator Team page.</p> : null}
          </div>
        </>}
      </section> : null}
    </div>
  </div>;
}
