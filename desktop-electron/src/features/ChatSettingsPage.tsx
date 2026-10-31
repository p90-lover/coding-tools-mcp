import { useEffect, useState, type ReactNode } from "react";
import type { ComputerAllowedApp } from "../api/contracts";
import { getCodingToolsClient } from "../api/client";
import type { LauncherState, UpdateSettings, UpdateSettingValues, UpdateState } from "../types";
import { ChatGlyph } from "./ChatMenu";
import "./chat-settings.css";

/**
 * Settings, laid out as Codex 26.1016's own Settings page (settings-page / app-shared settings
 * primitives): the sidebar becomes the settings navigation with "Back to app" on top, and the panel
 * shows the section as a heading over rounded cards of label + description rows with the control on
 * the right. It covers the chat area (the chat stays mounted underneath) and is opened from the
 * sidebar's Settings row or Ctrl+, (pressed again, it closes, as in Codex).
 */

type Section = "general" | "computer-use" | "updates";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "computer-use", label: "Computer use" },
  { id: "updates", label: "Updates" },
];
const SECTION_GLYPHS = { general: "gear", "computer-use": "monitor", updates: "update" } as const;

/**
 * Codex's "Always-allowed apps" (settings.computerUse.allowedApps): the apps a chat agent may use
 * without asking, each with Remove; the agent asks again the next time it wants a removed one.
 */
function AllowedApps({ onError }: { onError: (message: string) => void }) {
  const [apps, setApps] = useState<ComputerAllowedApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    try {
      void getCodingToolsClient().computer.allowedApps().then((result) => { if (live) setApps(result.apps ?? []); }, () => { if (live) setFailed(true); });
    } catch { setFailed(true); }
    return () => { live = false; };
  }, []);
  const remove = (app: ComputerAllowedApp) => {
    if (!window.confirm(`Remove “${app.name}” from always allowed apps?\n\nThe agent will ask to use “${app.name}” the next time it needs it.`)) return;
    void getCodingToolsClient().computer.forgetApp({ app: app.app })
      .then((result) => { if (result.ok && result.apps) setApps(result.apps); else onError(result.error || "Unable to save allowed apps"); },
        () => onError("Unable to save allowed apps"));
  };
  if (failed) return <Row label="Unable to load allowed apps."><span /></Row>;
  if (!apps) return <Row label="Loading allowed apps…"><span /></Row>;
  if (!apps.length) return <Row label="None yet"><span /></Row>;
  return <>{apps.map((app) => <Row key={app.app} label={app.name} description={app.app}>
    <button type="button" className="cxs-button" aria-label={`Remove ${app.name}`} onClick={() => remove(app)}>Remove</button>
  </Row>)}</>;
}

// The choices the minute settings offer; main (state.cjs) accepts any whole minute within the limits.
const IDLE_CHOICES = [0, 5, 10, 15, 30, 60, 120];
const HEALTH_CHOICES = [2, 5, 10, 15, 30, 60];

const minutesLabel = (minutes: number) => (minutes === 0 ? "Right away" : minutes === 1 ? "1 minute" : `${minutes} minutes`);

function updateStatusText(update: UpdateState | null) {
  if (!update) return "Coding Tools checks for new versions every 15 minutes";
  switch (update.status) {
    case "checking": return "Checking for updates…";
    case "up-to-date": return "Coding Tools is up to date";
    case "available": return `Version ${update.version} is ready to install`;
    case "downloading": return `Downloading version ${update.version}…`;
    case "installing": return `Installing version ${update.version}…`;
    case "error": return update.message;
    case "disabled": return "Updates are not available in this build";
    default: return "Coding Tools checks for new versions every 15 minutes";
  }
}

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={checked ? "cxs-toggle is-on" : "cxs-toggle"} onClick={() => onChange(!checked)}>
    <span className="cxs-toggle-thumb" />
  </button>;
}

function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="cxs-row">
    <div className="cxs-row-text">
      <div className="cxs-row-label">{label}</div>
      {description ? <div className="cxs-row-description">{description}</div> : null}
    </div>
    <div className="cxs-row-control">{children}</div>
  </div>;
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="cxs-group">
    {title ? <h2 className="cxs-group-title">{title}</h2> : null}
    <div className="cxs-card">{children}</div>
  </section>;
}

function MinutesSelect({ value, choices, label, onChange }: { value: number; choices: number[]; label: string; onChange: (next: number) => void }) {
  const options = choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b);
  return <select className="cxs-select" aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value))}>
    {options.map((minutes) => <option key={minutes} value={minutes}>{minutesLabel(minutes)}</option>)}
  </select>;
}

export function ChatSettingsPage({ onClose }: { onClose: () => void }) {
  const api = window.codexWebLauncher;
  const [section, setSection] = useState<Section>("general");
  const [state, setState] = useState<LauncherState | null>(null);
  const [updates, setUpdates] = useState<UpdateSettings | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void api?.snapshot().then((snapshot) => { if (live) setState(snapshot.state); }, () => undefined);
    void api?.updateSettings?.().then((settings) => { if (live) setUpdates(settings); }, () => undefined);
    const offState = api?.onStateChanged((next) => setState(next));
    const offUpdate = api?.onUpdateState((next) => setUpdate(next));
    return () => { live = false; offState?.(); offUpdate?.(); };
  }, [api]);

  // Every change goes through main, which checks it; the page shows what main kept.
  const run = (task: Promise<unknown> | undefined) => {
    setError("");
    void task?.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const setUpdateSetting = <K extends keyof UpdateSettingValues>(key: K, value: UpdateSettingValues[K]) => {
    run(api?.updateSettings?.({ [key]: value }).then(setUpdates));
  };

  const values = updates?.values;
  const title = SECTIONS.find((item) => item.id === section)?.label ?? "Settings";

  return <div className="cxs-root" role="dialog" aria-label="Settings">
    <aside className="cxs-nav">
      <nav aria-label="Settings" className="cxs-nav-list">
        <button type="button" className="cxs-nav-item cxs-nav-back" onClick={onClose}>
          <span className="cxs-nav-icon"><ChatGlyph name="back" size={16} /></span>
          <span className="cxs-nav-label">Back to app</span>
        </button>
        {SECTIONS.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined}
          className={section === item.id ? "cxs-nav-item is-active" : "cxs-nav-item"} onClick={() => setSection(item.id)}>
          <span className="cxs-nav-icon"><ChatGlyph name={SECTION_GLYPHS[item.id]} size={16} /></span>
          <span className="cxs-nav-label">{item.label}</span>
        </button>)}
      </nav>
    </aside>
    <main className="cxs-panel">
      <div className="cxs-toolbar" />
      <div className="cxs-scroll">
        <div className="cxs-column">
          <h1 className="cxs-title">{title}</h1>
          {error ? <p className="cxs-error" role="alert">{error}</p> : null}
          {section === "general" ? <div className="cxs-sections">
            <Group title="General">
              <Row label="Start at login" description="Open Coding Tools when you sign in to Windows">
                <Toggle label="Start at login" checked={state?.autoStart === true} disabled={!state}
                  onChange={(next) => run(api?.setAutostart(next).then((result) => setState(result.state)))} />
              </Row>
              <Row label="Keep running when the window is closed" description="Chats and background services keep working from the tray">
                <Toggle label="Keep running when the window is closed" checked={state?.keepRunningOnClose === true} disabled={!state}
                  onChange={(next) => run(api?.setPreference("keepRunningOnClose", next).then(setState))} />
              </Row>
            </Group>
          </div> : section === "computer-use" ? <div className="cxs-sections">
            <Group title="Always-allowed apps">
              <AllowedApps onError={setError} />
            </Group>
          </div> : <div className="cxs-sections">
            <Group title="App updates">
              <Row label="Check for updates" description={updateStatusText(update)}>
                <button type="button" className="cxs-button" onClick={() => run(api?.checkForUpdates().then(setUpdate))}>Check now</button>
              </Row>
              <Row label="Automatic updates" description="Download and install new versions while Coding Tools is idle">
                <Toggle label="Automatic updates" checked={state?.automaticUpdates === true} disabled={!state}
                  onChange={(next) => run(api?.setAutomaticUpdates(next).then(setState))} />
              </Row>
              <Row label="Wait for chats to finish" description="Install only when no chat, browser turn or bridge task is running">
                <Toggle label="Wait for chats to finish" checked={values?.updateWaitForChats ?? true} disabled={!values}
                  onChange={(next) => setUpdateSetting("updateWaitForChats", next)} />
              </Row>
              <Row label="Idle time before installing" description="How long without keyboard or mouse input before an update installs">
                <MinutesSelect label="Idle time before installing" value={values?.updateIdleMinutes ?? 10} choices={IDLE_CHOICES}
                  onChange={(next) => setUpdateSetting("updateIdleMinutes", next)} />
              </Row>
            </Group>
            <Group title="Recovery">
              <Row label="Roll back a failed update"
                description="Go back to the previous version if the new one is not healthy in time. Never while a chat is running">
                <Toggle label="Roll back a failed update" checked={values?.updateAutoRollback ?? true} disabled={!values}
                  onChange={(next) => setUpdateSetting("updateAutoRollback", next)} />
              </Row>
              <Row label="Health check window" description="How long a new version has to load its window, backend and AO">
                <MinutesSelect label="Health check window" value={values?.updateHealthMinutes ?? 10} choices={HEALTH_CHOICES}
                  onChange={(next) => setUpdateSetting("updateHealthMinutes", next)} />
              </Row>
              <Row label="Reuse background services only when they match"
                description="Restart the MCP tunnel when a different version left it running">
                <Toggle label="Reuse background services only when they match" checked={values?.updateReuseMatchingOnly ?? true} disabled={!values}
                  onChange={(next) => setUpdateSetting("updateReuseMatchingOnly", next)} />
              </Row>
            </Group>
          </div>}
        </div>
      </div>
    </main>
  </div>;
}
