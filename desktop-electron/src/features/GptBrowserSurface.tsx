import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GptBrowserAccount, GptBrowserStatus, LauncherApi } from "../types";
import "./gpt-browser.css";

const CONFIRM_WINDOW_MS = 4_000;

const accountName = (account: GptBrowserAccount) => account.email ?? account.label;

export function GptBrowserSurface({ api, active, covered = false, setError, placement = "standalone" }: {
  api: LauncherApi;
  active: boolean;
  /** Something of the app page is laid over the pane (the sidebar sliding out): the page steps aside for a still of it. */
  covered?: boolean;
  setError: (error: string | null) => void;
  placement?: "standalone" | "chat";
}) {
  const [status, setStatus] = useState<GptBrowserStatus | null>(null);
  // null while the address bar simply mirrors the page; a string while the user is typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  // A still of the page, drawn in the slot while the page is off the window for the sidebar.
  const [still, setStill] = useState<string | null>(null);
  // Whether the page is in the window now: only a page being shown has a still to take.
  const pageShown = useRef(false);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void api.gptBrowserStatus()
      .then((next) => { if (alive) setStatus(next); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const unsubscribe = api.onGptBrowserChanged((next) => setStatus(next));
    return () => { alive = false; unsubscribe(); };
  }, [api, setError]);

  const hasAccount = Boolean(status?.activeId);
  const confirmingRemove = hasAccount && confirmRemove === status?.activeId;

  // The page is a native view pinned over .gpb-slot; it only exists in the window while shown.
  useLayoutEffect(() => {
    const visible = active && hasAccount && !covered;
    let live = true;
    if (!visible && covered && pageShown.current) {
      // The native view is drawn above the whole app page, so it must step aside for the sidebar;
      // it left the pane black. A still of the page takes its place first, then the view goes.
      void api.gptBrowserSnapshot().catch(() => null).then((url) => {
        if (!live) return;
        if (url) setStill(url);
        requestAnimationFrame(() => {
          if (!live) return;
          pageShown.current = false;
          void api.setGptBrowserSurfaceActive(false).catch(() => undefined);
        });
      });
      return () => { live = false; };
    }
    pageShown.current = visible;
    void api.setGptBrowserSurfaceActive(visible).catch(() => undefined);
    if (!visible || !slot) return () => { live = false; };
    // The view is back over the still; the still goes once the view has drawn.
    const clearStill = window.setTimeout(() => { if (live) setStill(null); }, 250);
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = slot.getBoundingClientRect();
        void api.setGptBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(() => undefined);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    window.addEventListener("resize", measure);
    return () => {
      live = false;
      window.clearTimeout(clearStill);
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, covered, api, hasAccount, slot, placement]);

  useEffect(() => () => { void api.setGptBrowserSurfaceActive(false).catch(() => undefined); }, [api]);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);
  useEffect(() => {
    setConfirmRemove(null);
    window.clearTimeout(confirmTimer.current);
  }, [status?.activeId]);

  const run = useCallback(async (action: () => Promise<GptBrowserStatus>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [setError]);

  const go = (input: HTMLInputElement | null) => {
    const url = (draft ?? "").trim();
    if (!url) return;
    setDraft(null);
    input?.blur();
    void run(() => api.openGptBrowserUrl(url));
  };

  const remove = () => {
    const id = status?.activeId;
    if (!id) return;
    if (confirmRemove !== id) {
      setConfirmRemove(id);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmRemove(null), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmRemove(null);
    void run(() => api.removeGptBrowserAccount(id));
  };

  const page = status?.page ?? null;

  return (
    <section className="gpb-surface" aria-label="GPT Browser">
      <header className="gpb-bar">
        <strong>GPT Browser</strong>
        {status && status.accounts.length > 0 ? (
          <select
            aria-label="ChatGPT account"
            value={status.activeId ?? ""}
            onChange={(event) => void run(() => api.switchGptBrowserAccount(event.target.value))}
          >
            {status.accounts.map((account) => (
              <option key={account.id} value={account.id}>{accountName(account)}</option>
            ))}
          </select>
        ) : null}
        <button type="button" className="button-secondary" onClick={() => void run(() => api.addGptBrowserAccount())}>
          Add account
        </button>
        {hasAccount ? <>
          <span className="gpb-nav">
            <button type="button" aria-label="Back" title="Back" disabled={!page?.canGoBack} onClick={() => void run(() => api.navigateGptBrowser("back"))}>‹</button>
            <button type="button" aria-label="Forward" title="Forward" disabled={!page?.canGoForward} onClick={() => void run(() => api.navigateGptBrowser("forward"))}>›</button>
            <button type="button" aria-label="Reload" title="Reload" onClick={() => void run(() => api.navigateGptBrowser("reload"))}>⟳</button>
          </span>
          <form
            className="gpb-link"
            onSubmit={(event) => {
              event.preventDefault();
              go(event.currentTarget.querySelector("input"));
            }}
          >
            <input
              type="text"
              inputMode="url"
              aria-label="Address"
              placeholder="Enter a web address, like chatgpt.com"
              value={draft ?? page?.url ?? ""}
              onFocus={(event) => { setDraft(event.target.value); event.target.select(); }}
              onBlur={() => setDraft(null)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }}
              spellCheck={false}
              autoComplete="off"
            />
            {/* mousedown would blur the field (dropping the draft) before the submit fires */}
            <button
              type="submit"
              className="button-primary"
              disabled={draft === null || !draft.trim()}
              onMouseDown={(event) => event.preventDefault()}
            >
              Go
            </button>
          </form>
          {page?.loading ? <span className="gpb-muted">Loading…</span> : null}
        </> : null}
        <span className="gpb-spacer" />
        {hasAccount ? (
          <button
            type="button"
            className={confirmingRemove ? "button-danger" : "button-secondary"}
            onClick={remove}
            title="Sign out and erase browser data"
          >
            {confirmingRemove ? "Click again to remove" : "Remove account"}
          </button>
        ) : null}
      </header>
      {hasAccount ? (
        <div className="gpb-stage">
          <div className="gpb-slot" ref={setSlot}>
            {still ? <img className="gpb-still" src={still} alt="" draggable={false} /> : null}
          </div>
        </div>
      ) : (
        <div className="gpb-empty">
          <strong>Use several ChatGPT accounts</strong>
          <p>Each account gets its own browser session and stays signed in. Switch accounts from the picker above.</p>
          <button type="button" className="button-primary" onClick={() => void run(() => api.addGptBrowserAccount())}>
            Add your first account
          </button>
          <span className="gpb-muted">Pages load through the same proxy as the Browser.</span>
        </div>
      )}
    </section>
  );
}
