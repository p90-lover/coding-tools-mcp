import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ComputerAllowedApp, ComputerOverview, ComputerRequest, ComputerStep, ComputerWindow } from "../api/contracts";
import { getCodingToolsClient } from "../api/client";
import "./computer-use.css";

// Runtime > Computer use (the sidebar tab): everything about chat agents using apps on this computer
// in one place (electron/computer-control.cjs). The switch that gives chats the tools, whether each
// step is reviewed, what is under control now with Stop, the requests waiting, the apps always
// allowed (and allowing one before a chat asks), and the steps taken, as the control pill's history.
// Window titles and app names are other programs' text: shown as text only.

export type ComputerPreference = "chatAgentDesktopTools" | "computerReviewSteps";

// How often the tab reads control's state while it is on screen; nothing is read while it is hidden.
const POLL_MS = 1_500;
const EMPTY: ComputerOverview = { ready: false, state: "unknown", controlled: null, history: [], apps: [], requests: [] };
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const computer = () => getCodingToolsClient().computer;

/** The open apps not yet always allowed, one row each with up to two of its window titles, by name. */
export function appsToAllow(windows: readonly ComputerWindow[], allowed: readonly ComputerAllowedApp[]) {
  const known = new Set(allowed.map((app) => app.app));
  const rows = new Map<string, { app: string; appName: string; titles: string[] }>();
  for (const item of windows) {
    if (!item.app || known.has(item.app)) continue;
    const row = rows.get(item.app) ?? { app: item.app, appName: item.appName || item.app, titles: [] };
    if (item.title && row.titles.length < 2 && !row.titles.includes(item.title)) row.titles.push(item.title);
    rows.set(item.app, row);
  }
  return [...rows.values()].sort((a, b) => a.appName.localeCompare(b.appName));
}

/** Headless's control state in words, for the "Now" heading. */
export function controlState(overview: ComputerOverview): string {
  if (!overview.ready) return "starting";
  if (overview.controlled) return "in control";
  return overview.state === "unknown" ? "state unknown" : "idle";
}

const STEP_MARKS: Record<ComputerStep["outcome"], string> = { done: "✓", failed: "✕", running: "…" };

function Toggle({ checked, disabled = false, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <button aria-checked={checked} aria-label={label} className={`switch${checked ? " is-on" : ""}`} disabled={disabled}
    onClick={() => onChange(!checked)} role="switch" type="button"><span /></button>;
}

function Row({ label, body, children }: { label: string; body: string; children?: ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><p>{body}</p></div>{children ?? <span />}</div>;
}

function Heading({ label, meta, first = false }: { label: string; meta?: string; first?: boolean }) {
  return <div className={`section-heading${first ? "" : " is-spaced"}`}><span>{label}</span>{meta ? <small>{meta}</small> : null}</div>;
}

export function ComputerUseSurface({ active, toolsOn, desktopOn, reviewSteps, setPreference, setError }: {
  /** The tab is on screen: control's state is read only then. */
  active: boolean;
  /** Settings > "Give chat agents the app's tools": computer use is one of them. */
  toolsOn: boolean;
  desktopOn: boolean;
  reviewSteps: boolean;
  setPreference: (key: ComputerPreference, value: boolean) => void;
  setError: (error: string | null) => void;
}) {
  const [overview, setOverview] = useState<ComputerOverview>(EMPTY);
  const [windows, setWindows] = useState<ComputerWindow[] | null>(null);
  // What is being done now ("stop", "allow:chrome.exe", "answer:<id>"), so its button waits.
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setOverview(await computer().overview()); } catch { /* keeps what it showed */ }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    let timer = 0;
    const tick = async () => {
      await refresh();
      if (live) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    // A request shows the moment a chat asks, not at the next read.
    let off: () => void = () => undefined;
    try { off = computer().onRequests(() => { if (live) void refresh(); }); } catch { /* read on the next tick */ }
    return () => { live = false; window.clearTimeout(timer); off(); };
  }, [active, refresh]);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      const result = await work() as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) setError(result.error || "That did not go through");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const answer = (request: ComputerRequest, decision: "always" | "conversation" | "deny") =>
    void run(`answer:${request.id}`, () => computer().answer({ id: request.id, decision }));
  const forget = (app: ComputerAllowedApp) => {
    if (!window.confirm(`Remove “${app.name}” from always allowed apps?\n\nA chat asks to use “${app.name}” the next time it needs it.`)) return;
    void run(`forget:${app.app}`, () => computer().forgetApp({ app: app.app }));
  };
  const allow = (app: string) => void run(`allow:${app}`, () => computer().allowApp({ app }));
  const listWindows = () => void run("windows", async () => {
    const result = await computer().windows();
    setWindows(Array.isArray(result?.windows) ? result.windows : []);
  });

  const now = overview.controlled;
  const toAllow = windows ? appsToAllow(windows, overview.apps) : null;
  const usable = toolsOn && desktopOn;

  return <section className="content-surface computer-use">
    <div className="content-scroll is-narrow">
      <header className="surface-header">
        <h1>Computer use</h1>
        <p>Chat agents can use apps on this computer as you do: they look at a window, then click and type in it. You allow each app once. Stop here, or on the bar at the top of the screen, ends control at any time.</p>
      </header>

      <Heading first label="Access" />
      <div className="settings-list">
        <Row label="Let chat agents use the computer"
          body={!toolsOn ? "Turn on “Give chat agents the app's tools” in Settings first."
            : desktopOn ? "On. Chats started from now on can list your windows, ask to use an app, and work in its window. Chats already open keep the tools they started with."
              : "Gives chats you start from now on computer use and screenshots. Off by default."}>
          <Toggle checked={usable} disabled={!toolsOn} label="Let chat agents use the computer"
            onChange={(checked) => setPreference("chatAgentDesktopTools", checked)} />
        </Row>
        <Row label="Review each step"
          body={reviewSteps
            ? "On. The reviewer checks every screenshot, click and keystroke, even in apps you allowed, and asks you when it can't decide. Slower, and a chat may wait on you."
            : "Off. Once you allow an app, the agent works in its window without a review or a prompt for each step, as in Codex. Screenshots of the whole screen or of other windows are still reviewed."}>
          <Toggle checked={reviewSteps} disabled={!usable} label="Review each step"
            onChange={(checked) => setPreference("computerReviewSteps", checked)} />
        </Row>
      </div>

      <Heading label="Now" meta={controlState(overview)} />
      {now ? <div className={`cu-now${now.action ? " is-busy" : ""}`}>
        <div className="cu-now-text">
          <div className="cu-now-line"><span className="cu-app">{now.appName}</span><span className="cu-title" title={now.title}>{now.title}</span></div>
          <div className="cu-now-step"><span className="cu-dot" aria-hidden="true" /><span>{now.action || "Waiting for its next step"}</span></div>
          <div className="cu-now-who">{now.agent}{now.model ? ` · ${now.model}` : ""}</div>
        </div>
        <button className="button-primary cu-stop" disabled={busy === "stop"} onClick={() => void run("stop", () => computer().stop())} type="button">
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
      </div> : <p className="surface-empty-note">{!overview.ready ? "Computer use starts with the app's chat tools."
        : usable ? "Nothing is under control. A chat takes control when it picks a window and you allow its app."
          : "Nothing is under control."}</p>}

      {overview.requests.length ? <div className="cu-requests">{overview.requests.map((request) => {
        const waiting = busy === `answer:${request.id}`;
        return <div className="cu-request" key={request.id} role="alert" aria-label={`Allow ${request.agent} to use ${request.app}?`}>
          <div>
            <strong>Allow {request.agent} to use {request.app}?</strong>
            <p>{[request.window ? `Window: ${request.window}` : "", `Project: ${request.project}`,
              request.captureOff ? `Allowing it turns on screen capture for ${request.project}.` : ""].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="cu-request-actions">
            <button className="button-secondary" disabled={waiting} onClick={() => answer(request, "always")} type="button">Always allow</button>
            <button className="button-secondary" disabled={waiting} onClick={() => answer(request, "deny")} type="button">Deny</button>
            <button className="button-primary" disabled={waiting} onClick={() => answer(request, "conversation")} type="button">Allow this conversation</button>
          </div>
        </div>;
      })}</div> : null}

      <Heading label="Always-allowed apps" meta={overview.apps.length ? String(overview.apps.length) : undefined} />
      <div className="settings-list">
        {overview.apps.map((app) => <Row key={app.app} label={app.name} body={`${app.app} · no chat asks before using it`}>
          <button className="button-secondary" disabled={busy === `forget:${app.app}`} onClick={() => forget(app)} type="button">Remove</button>
        </Row>)}
      </div>
      {overview.apps.length ? null : <p className="surface-empty-note">None yet. A chat asks the first time it needs an app, or allow one from your open windows.</p>}
      <div className="cu-open">
        <button className="button-secondary" disabled={busy === "windows" || !overview.ready} onClick={listWindows} type="button">
          {busy === "windows" ? "Listing windows…" : windows ? "Refresh open windows" : "Allow an app from your open windows"}
        </button>
        {toAllow ? toAllow.length ? <div className="settings-list">{toAllow.map((row) => <Row key={row.app} label={row.appName} body={row.titles.join(" · ") || row.app}>
          <button className="button-secondary" disabled={busy === `allow:${row.app}`} onClick={() => allow(row.app)} type="button">Always allow</button>
        </Row>)}</div> : <p className="surface-empty-note">Every open app is already allowed.</p> : null}
      </div>

      <Heading label="Steps" meta={overview.history.length ? "newest first" : undefined} />
      {overview.history.length ? <ol className="cu-steps">{overview.history.map((step, index) => (
        <li className={`cu-step is-${step.outcome}`} key={`${index}:${step.time}:${step.action}`}>
          <span className="cu-time">{step.time}</span>
          <span className="cu-act" title={step.action}>{step.action}<small>{step.agent}{step.model ? ` · ${step.model}` : ""}</small></span>
          {step.app ? <span className="cu-app is-small">{step.app}</span> : <span className="cu-app-none" />}
          <span className="cu-mark" aria-label={step.outcome}>{STEP_MARKS[step.outcome] ?? "…"}</span>
        </li>))}</ol>
        : <p className="surface-empty-note">No steps yet. What a chat agent does in a window shows here, as on the control bar.</p>}
    </div>
  </section>;
}
