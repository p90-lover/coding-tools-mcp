import { useEffect, useState, type ReactNode } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
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

type Section = "general" | "chat" | "updates";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "chat", label: "Chat" },
  { id: "updates", label: "Updates" },
];

// How full a chat gets before its next message compacts it first; the bridge takes 20 to 100
// (chat_auto_compact), and /autocompact any share in between.
const COMPACT_CHOICES = [50, 60, 70, 80, 90, 95, 100];

/** The chat's own preferences, kept by the bridge (agent-orchestrator-workflow.cjs), as Claude Code's settings. */
type ChatPreferences = { autoCompact: boolean; percent: number; autoRetry: boolean; modelJudges: boolean };
const chatCall = (operation: string, args: JsonObject = {}) => getCodingToolsClient().apps
  .call({ moduleId: "agent-orchestrator", operation, arguments: args })
  .then((outer) => ((outer as { result?: Record<string, unknown> }).result ?? outer) as Record<string, unknown>);

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
  const [chat, setChat] = useState<ChatPreferences | null>(null);

  useEffect(() => {
    let live = true;
    void api?.snapshot().then((snapshot) => { if (live) setState(snapshot.state); }, () => undefined);
    void api?.updateSettings?.().then((settings) => { if (live) setUpdates(settings); }, () => undefined);
    const offState = api?.onStateChanged((next) => setState(next));
    const offUpdate = api?.onUpdateState((next) => setUpdate(next));
    return () => { live = false; offState?.(); offUpdate?.(); };
  }, [api]);
  useEffect(() => {
    let live = true;
    void Promise.all([chatCall("chat_auto_compact"), chatCall("chat_auto_retry"), chatCall("chat_model_judges")])
      .then(([compact, retry, judges]) => {
        if (live) setChat({ autoCompact: compact.autoCompact !== false, percent: Number(compact.percent) || 95, autoRetry: retry.autoRetry === true, modelJudges: judges.modelJudges === true });
      }, () => undefined);
    return () => { live = false; };
  }, []);

  // Every change goes through main, which checks it; the page shows what main kept.
  const run = (task: Promise<unknown> | undefined) => {
    setError("");
    void task?.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const setUpdateSetting = <K extends keyof UpdateSettingValues>(key: K, value: UpdateSettingValues[K]) => {
    run(api?.updateSettings?.({ [key]: value }).then(setUpdates));
  };

  // Like the update settings, a chat preference shows what the bridge kept.
  const setChatPreference = (operation: string, args: JsonObject) => {
    run(chatCall(operation, args).then((result) => setChat((current) => current && {
      ...current,
      ...(operation === "chat_auto_compact" ? { autoCompact: result.autoCompact !== false, percent: Number(result.percent) || current.percent } : {}),
      ...(operation === "chat_auto_retry" ? { autoRetry: result.autoRetry === true } : {}),
      ...(operation === "chat_model_judges" ? { modelJudges: result.modelJudges === true } : {}),
    })));
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
          <span className="cxs-nav-icon"><ChatGlyph name={item.id === "general" ? "gear" : item.id === "chat" ? "compose" : "update"} size={16} /></span>
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
          </div> : section === "chat" ? <div className="cxs-sections">
            <Group title="Context">
              <Row label="Auto-compact" description="When a chat gets long, its earlier conversation becomes a summary before the next message, so it never stops full. Also /autocompact">
                <Toggle label="Auto-compact" checked={chat?.autoCompact ?? true} disabled={!chat}
                  onChange={(next) => setChatPreference("chat_auto_compact", { enabled: next })} />
              </Row>
              <Row label="Compact when the chat is" description="How full a chat gets before it compacts itself. Lower compacts sooner, with smaller summaries">
                <select className="cxs-select" aria-label="Compact when the chat is" value={chat?.percent ?? 95} disabled={!chat || !chat.autoCompact}
                  onChange={(event) => setChatPreference("chat_auto_compact", { percent: Number(event.target.value) })}>
                  {(chat && !COMPACT_CHOICES.includes(chat.percent) ? [...COMPACT_CHOICES, chat.percent].sort((a, b) => a - b) : COMPACT_CHOICES)
                    .map((percent) => <option key={percent} value={percent}>{percent}% full</option>)}
                </select>
              </Row>
            </Group>
            <Group title="Turns">
              <Row label="Retry automatically" description="A failed step retries by itself, up to 8 times over about half an hour. Sign-in errors still wait for you">
                <Toggle label="Retry automatically" checked={chat?.autoRetry === true} disabled={!chat}
                  onChange={(next) => setChatPreference("chat_auto_retry", { enabled: next })} />
              </Row>
              <Row label="Let the model judge" description="Requests and goal rounds that would wait for you are judged by the model instead">
                <Toggle label="Let the model judge" checked={chat?.modelJudges === true} disabled={!chat}
                  onChange={(next) => setChatPreference("chat_model_judges", { enabled: next })} />
              </Row>
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
