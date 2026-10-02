import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GptBrowserAccount, GptBrowserStatus, LauncherApi } from "../types";
import "./gpt-browser.css";

const CONFIRM_WINDOW_MS = 4_000;

const accountName = (account: GptBrowserAccount) => account.email ?? account.label;

export function GptBrowserSurface({ api, active, setError }: {
  api: LauncherApi;
  active: boolean;
  setError: (error: string | null) => void;
}) {
  const [status, setStatus] = useState<GptBrowserStatus | null>(null);
  const [link, setLink] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
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

  // The page is a native view pinned over .gpb-slot; it only exists in the window while shown.
  useLayoutEffect(() => {
    const visible = active && hasAccount;
    void api.setGptBrowserSurfaceActive(visible).catch(() => undefined);
    if (!visible || !slot) return;
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
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, api, hasAccount, slot]);

  useEffect(() => () => { void api.setGptBrowserSurfaceActive(false).catch(() => undefined); }, [api]);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const run = useCallback(async (action: () => Promise<GptBrowserStatus>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [setError]);

  const openLink = () => {
    const url = link.trim();
    if (!url) return;
    void run(() => api.openGptBrowserUrl(url)).then(() => setLink(""));
  };

  const remove = () => {
    if (!status?.activeId) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      confirmTimer.current = window.setTimeout(() => setConfirmRemove(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmRemove(false);
    const id = status.activeId;
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
          {page?.loading ? <span className="gpb-muted">Loading…</span> : null}
          <form className="gpb-link" onSubmit={(event) => { event.preventDefault(); openLink(); }}>
            <input
              aria-label="Open a chatgpt.com link"
              placeholder="Paste a chatgpt.com link (referral, chat, GPT…)"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              spellCheck={false}
            />
            <button type="submit" className="button-primary" disabled={!link.trim()}>Open</button>
          </form>
        </> : null}
        <span className="gpb-spacer" />
        {hasAccount ? (
          <button
            type="button"
            className={confirmRemove ? "button-danger" : "button-secondary"}
            onClick={remove}
            title="Signs this account out and erases its browser data"
          >
            {confirmRemove ? "Click again to remove" : "Remove account"}
          </button>
        ) : null}
      </header>
      {hasAccount ? (
        <div className="gpb-stage">
          <div className="gpb-slot" ref={setSlot} />
        </div>
      ) : (
        <div className="gpb-empty">
          <strong>Use several ChatGPT accounts side by side</strong>
          <p>Each account gets its own private browser session. Sign in once and it stays signed in; switch accounts from the picker above.</p>
          <button type="button" className="button-primary" onClick={() => void run(() => api.addGptBrowserAccount())}>
            Add your first account
          </button>
          <span className="gpb-muted">Pages load through Coding Tools' proxy route, the same as the Browser.</span>
        </div>
      )}
    </section>
  );
}
