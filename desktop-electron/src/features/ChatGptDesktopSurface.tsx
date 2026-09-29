import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatGptDesktopAccount, ChatGptDesktopStatus, LauncherApi } from "../types";
import "./chatgpt-desktop.css";

const CONFIRM_WINDOW_MS = 4_000;

function accountLabel(account: ChatGptDesktopAccount) {
  const name = account.email ?? (account.signedIn ? "Signed-in account" : "New sign-in");
  const tags = [account.source === "cpa" ? "CPA" : "local", account.plan, account.disabled ? "disabled" : null]
    .filter(Boolean)
    .join(" · ");
  return `${name} (${tags})`;
}

const BUSY_TEXT: Record<NonNullable<ChatGptDesktopStatus["busy"]>, string> = {
  launching: "Starting ChatGPT…",
  switching: "Switching account…",
  clearing: "Clearing session…",
  stopping: "Closing ChatGPT…",
};

export function ChatGptDesktopSurface({ api, active, setError }: {
  api: LauncherApi;
  active: boolean;
  setError: (error: string | null) => void;
}) {
  const [status, setStatus] = useState<ChatGptDesktopStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void api.chatGptDesktopStatus()
      .then((next) => { if (alive) setStatus(next); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const unsubscribe = api.onChatGptDesktopChanged((next) => setStatus(next));
    return () => { alive = false; unsubscribe(); };
  }, [api, setError]);

  // Keep the picker on the active account unless the user is choosing another one.
  useEffect(() => {
    if (!status) return;
    const exists = status.accounts.some((account) => account.slotId === selected);
    if (!exists) setSelected(status.activeSlotId ?? status.accounts[0]?.slotId ?? "");
  }, [status, selected]);

  useLayoutEffect(() => {
    const visible = active && Boolean(status?.running);
    void api.setChatGptDesktopSurfaceActive(visible).catch(() => undefined);
    if (!visible || !slot) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = slot.getBoundingClientRect();
        void api.setChatGptDesktopBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          .catch(() => undefined);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    window.addEventListener("resize", measure);
    const unsubscribe = api.onChatGptDesktopRemeasure(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      unsubscribe();
    };
  }, [active, api, slot, status?.running]);

  // Leaving the pane (or unmounting it) must never leave the native window floating.
  useEffect(() => () => { void api.setChatGptDesktopSurfaceActive(false).catch(() => undefined); }, [api]);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const run = useCallback(async (action: () => Promise<ChatGptDesktopStatus>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [setError]);

  const clear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      confirmTimer.current = window.setTimeout(() => setConfirmClear(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmClear(false);
    void run(() => api.clearChatGptDesktopAccount());
  };

  const busy = Boolean(status?.busy);
  const activeAccount = status?.accounts.find((account) => account.slotId === status.activeSlotId) ?? null;
  const selectedIsRunning = status?.running && status.runningSlotId === selected;
  const selectedAccount = status?.accounts.find((account) => account.slotId === selected);

  return (
    <section className="cgd-surface" aria-label="ChatGPT Desktop">
      <header className="cgd-bar">
        <strong>ChatGPT Desktop</strong>
        {status?.installed ? <span className={`cgd-state ${status.running ? "is-ok" : ""}`}>
          {status.busy ? BUSY_TEXT[status.busy] : status.running ? `Running · v${status.version}` : `v${status.version}`}
        </span> : null}
        {status?.installed ? <>
          <select
            aria-label="Account"
            disabled={busy || status.accounts.length === 0}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {status.accounts.length === 0 ? <option value="">No accounts yet</option> : null}
            {status.accounts.map((account) => (
              <option key={account.slotId} value={account.slotId} disabled={account.disabled}>{accountLabel(account)}</option>
            ))}
          </select>
          <button
            type="button"
            className="button-primary"
            disabled={busy || !selected || selectedIsRunning || selectedAccount?.disabled}
            onClick={() => void run(() => api.openChatGptDesktop(selected))}
            title="CPA accounts sign in automatically with the tokens CPA already holds"
          >
            {status.running ? "Switch" : "Open"}
          </button>
          <button type="button" className="button-secondary" disabled={busy} onClick={() => void run(() => api.newChatGptDesktopSignIn())}>
            New sign-in
          </button>
        </> : null}
        <span className="cgd-spacer" />
        {status?.activeSlotId ? (
          <button
            type="button"
            className={confirmClear ? "button-danger" : "button-secondary"}
            disabled={busy}
            onClick={clear}
            title="Closes ChatGPT, moves this account's local session to Trash, and opens a fresh sign-in. CPA keeps its account."
          >
            {confirmClear ? "Confirm clear" : "Clear account & session"}
          </button>
        ) : null}
        {status?.running ? (
          <button type="button" className="button-secondary" disabled={busy} onClick={() => void run(() => api.stopChatGptDesktop())}>Close</button>
        ) : null}
      </header>

      {status?.error ? <p className="cgd-error" role="status">{status.error}</p> : null}

      <div className="cgd-stage">
        {status?.running ? <div className="cgd-slot" ref={setSlot} /> : (
          <div className="cgd-empty">
            {!status ? <p>Checking the ChatGPT desktop app…</p>
              : !status.supported ? <p>The embedded ChatGPT desktop app is available on Windows only.</p>
                : !status.installed ? <p>Install the ChatGPT desktop app from the Microsoft Store, then reopen this page.</p>
                  : <>
                    <p>
                      Runs a separate ChatGPT desktop instance inside Coding Tools, with its own profile per account.
                      Your installed ChatGPT app is not touched.
                    </p>
                    {activeAccount ? <p className="cgd-muted">Last account: {accountLabel(activeAccount)}</p> : null}
                    {status.accounts.every((account) => account.source !== "cpa")
                      ? <p className="cgd-muted">Add a ChatGPT (Codex) account in CPA to sign in here automatically.</p>
                      : null}
                    <button
                      type="button"
                      className="button-primary"
                      disabled={busy || !selected}
                      onClick={() => void run(() => api.openChatGptDesktop(selected))}
                    >
                      {status.busy ? BUSY_TEXT[status.busy] : "Open ChatGPT"}
                    </button>
                  </>}
          </div>
        )}
      </div>
    </section>
  );
}
