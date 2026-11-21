import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const AUTOBOT_NAME = "Autobot Roll Out";
export type AutobotState = {
  enabled: boolean;
  selected: string[];
  options: { id: string; title: string; commands: string[] }[];
  summary: string;
  cancelled?: boolean;
};
export type AutobotControl = (change?: { selected?: string[]; disable?: true }) => Promise<AutobotState>;

export function AutobotMark({ animate = false }: { animate?: boolean }) {
  return <svg className={`cx-autobot-mark${animate ? " is-transforming" : ""}`} width="18" height="18" viewBox="0 0 24 24"
    stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" fill="none" aria-hidden="true">
    <g className="cx-autobot-car">
      <path d="M3 12 5.7 7.5h12.6L21 12v5H3zM5.7 7.5 7.4 12h9.2l1.7-4.5M3 12h18M6.4 14.5h2M15.6 14.5h2" />
      <path d="M5 17v2h3v-2m8 0v2h3v-2" />
    </g>
    <g className="cx-autobot-robot">
      <path d="M8.5 3.5h7v6h-7zM8 11h8v6H8zM9.5 17v3.5h-3m8-3.5v3.5h3M8 11l-4 2v3m12-5 4 2v3" />
      <path d="M10.7 6.5h.1m2.4 0h.1M10.8 13.7h2.4M12 3.5V2" />
    </g>
  </svg>;
}

export function AutobotScope({ state, canEnable, dark, onClose, configure }: {
  state: AutobotState; canEnable: boolean; dark: boolean; onClose: () => void; configure: AutobotControl;
}) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [selected, setSelected] = useState(state.selected);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  const commands = state.options.filter(option => selected.includes(option.id)).flatMap(option => option.commands);
  const apply = async (disable: boolean) => {
    if (busy.current || (!disable && (!canEnable || !selected.length))) return;
    busy.current = true; setSaving(true); setError("");
    try {
      const next = await configure(disable ? { disable: true } : { selected });
      if (!next.cancelled) onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Autobot settings could not be changed"); }
    finally { busy.current = false; setSaving(false); }
  };
  const dialog = <div className="cx-fullaccess" data-theme={dark ? "dark" : "light"} onPointerDown={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget && !busy.current) onClose();
  }} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape" && !busy.current) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  }}>
    <section className="cx-fullaccess-panel cx-autobot-scope" role="dialog" aria-modal="true" aria-labelledby={id}>
      <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void apply(false); }}>
        <div className="cx-fullaccess-section">
          <h2 id={id}><AutobotMark animate />{AUTOBOT_NAME}</h2>
          <p>Choose the exact read-only commands to approve once, in this chat’s working folder. These matches use no model quota.</p>
          {!canEnable ? <p>To enable it, first select Ask for approval on a supported single-model chat.</p> : null}
        </div>
        <fieldset className="cx-fullaccess-section cx-autobot-choices" disabled={!canEnable || saving}>
          <legend>Preapproved command groups</legend>
          {state.options.map(option => <label key={option.id}>
            <input type="checkbox" checked={selected.includes(option.id)} onChange={event => {
              const checked = event.target.checked;
              setSelected(previous => checked ? [...previous, option.id] : previous.filter(value => value !== option.id));
            }} />
            <span><strong>{option.title}</strong><code>{option.commands.join(" · ")}</code></span>
          </label>)}
        </fieldset>
        <div className="cx-fullaccess-section cx-autobot-summary">
          <strong>Scope summary</strong>
          <p>{commands.length ? `Only ${commands.join("; ")}. Nothing else is locally preapproved.` : "No commands preapproved."}</p>
          <p>Other requests go to Codex Guardian first. If Guardian is unavailable, fallback to Let the model judge requires quota-based reviews to be on too. Otherwise you decide. This plugin clears on app restart.</p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="cx-fullaccess-actions">
            {state.enabled ? <button type="button" className="cx-fullaccess-cancel" disabled={saving} onClick={() => void apply(true)}>Turn off</button> : null}
            <button ref={close} type="button" className="cx-fullaccess-cancel" disabled={saving} onClick={onClose}>Cancel</button>
            <button type="submit" className="button-primary" disabled={saving || !canEnable || !selected.length}>{state.enabled ? "Update scope" : "Enable for this chat"}</button>
          </div>
        </div>
      </form>
    </section>
  </div>;
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}
