import { useEffect, useState, type ReactNode } from "react";
import type { ComputerAllowedApp, JsonObject } from "../api/contracts";
import { getCodingToolsClient } from "../api/client";
import type { LauncherState, UpdateSettings, UpdateSettingValues, UpdateState } from "../types";
import { ChatGlyph } from "./ChatMenu";
import { CHAT_PAGE_LIMIT, recordPageShortcut, saveChatPagePreferences, useChatPagePreferences, type ChatPagePreferences } from "./chat-pages";
import { archiveDayLabel, dayChoices, onChatListSettings, readChatListSettings, saveChatListSettings, VISIBLE_CHOICES } from "./chat-list-settings";
import { SHORTCUTS } from "./ChatThreadList";
import "./chat-settings.css";

/** The chat list's keys, shown in Settings › Chat (they act on the open chat, or the focused split pane's). */
const LIST_SHORTCUTS: { label: string; keys: string }[] = [
  { label: "New chat", keys: "Ctrl+N" },
  { label: "Rename chat", keys: SHORTCUTS.rename },
  { label: "Pin or unpin chat", keys: SHORTCUTS.pin },
  { label: "Mark as read or unread", keys: SHORTCUTS.unread },
  { label: "Archive chat", keys: SHORTCUTS.archive },
  { label: "Delete chat", keys: SHORTCUTS.delete },
  { label: "Move chat up or down", keys: "Alt+Shift+↑ / ↓" },
  { label: "Settings", keys: "Ctrl+," },
];

/**
 * Settings, laid out as Codex 26.1016's own Settings page (settings-page / app-shared settings
 * primitives): the sidebar becomes the settings navigation with "Back to app" on top, and the panel
 * shows the section as a heading over rounded cards of label + description rows with the control on
 * the right. It covers the chat area (the chat stays mounted underneath) and is opened from the
 * sidebar's Settings row or Ctrl+, (pressed again, it closes, as in Codex).
 */

type Section = "general" | "chat" | "instructions" | "computer-use" | "updates";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "chat", label: "Chat" },
  { id: "instructions", label: "Instructions" },
  { id: "computer-use", label: "Computer use" },
  { id: "updates", label: "Updates" },
];
const SECTION_GLYPHS = { general: "gear", chat: "compose", instructions: "edit", "computer-use": "monitor", updates: "update" } as const;

/** What agent_instructions answers: both AGENTS.md files and the projects that can have one. */
type InstructionFiles = { global: string; globalFile: string; workspace: string | null; workspaceFile: string | null;
  projects: { id: string; name: string; path: string }[] };

/** One AGENTS.md: the text, where it is kept, and Save once it differs from what is on disk. */
function InstructionEditor({ label, file, value, saved, placeholder, onChange, onSave }: { label: string; file: string | null; value: string;
  saved: string; placeholder: string; onChange: (next: string) => void; onSave: () => void }) {
  const dirty = value !== saved;
  return <div className="cxs-instructions">
    <textarea className="cxs-textarea" aria-label={label} value={value} placeholder={placeholder} spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); if (dirty) onSave(); } }} />
    <div className="cxs-instructions-foot">
      <span className="cxs-instructions-file" title={file ?? undefined}>{file ?? ""}</span>
      <span className="cxs-instructions-state">{dirty ? "Unsaved changes" : saved.trim() ? "Saved" : ""}</span>
      <button type="button" className="cxs-button" disabled={!dirty} onClick={onSave}>Save</button>
    </div>
  </div>;
}

/**
 * Settings › Instructions, as Codex's custom instructions: the global AGENTS.md every agent follows
 * in every project, and the open project's own AGENTS.md. Every new agent's first message starts
 * with both, and a running agent's next message once either changed (agent-instructions.cjs).
 */
function InstructionsSection({ workspaceId, onError }: { workspaceId?: string | null; onError: (message: string) => void }) {
  const [files, setFiles] = useState<InstructionFiles | null>(null);
  const [project, setProject] = useState<string | null>(workspaceId ?? null);
  const [global, setGlobal] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [failed, setFailed] = useState(false);
  const take = (next: InstructionFiles, keep: { global?: boolean; workspace?: boolean } = {}) => {
    setFiles(next);
    if (!keep.global) setGlobal(next.global);
    if (!keep.workspace) setWorkspace(next.workspace ?? "");
  };
  useEffect(() => {
    let live = true;
    void chatCall("agent_instructions", project ? { workspaceId: project } : {}).then((result) => {
      if (!live) return;
      const next = result as unknown as InstructionFiles;
      // A project picked by default that has no folder gives way to the first that has one.
      if (!project && next.projects?.length) { setProject(next.projects[0].id); return; }
      take(next, { global: files !== null });
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [project]);
  const save = (scope: "global" | "workspace") => {
    void chatCall("agent_instructions", { scope, text: scope === "global" ? global : workspace, ...(project ? { workspaceId: project } : {}) })
      .then((result) => take(result as unknown as InstructionFiles, scope === "global" ? { workspace: true } : { global: true }),
        (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  const choose = (next: string) => {
    if (files && workspace !== (files.workspace ?? "") && !window.confirm("Discard the unsaved changes to this project's AGENTS.md?")) return;
    setProject(next);
  };
  if (failed) return <Group><Row label="Unable to load the instructions."><span /></Row></Group>;
  const projects = files?.projects ?? [];
  return <>
    <Group title="Global AGENTS.md">
      <Row label="For every agent, in every project" description="Every new agent starts with these instructions, and a running agent gets them again with your next message once you change them"><span /></Row>
      <InstructionEditor label="Global AGENTS.md" file={files?.globalFile ?? null} value={global} saved={files?.global ?? ""}
        placeholder={"# How I work\n\n- Answer in English\n- Run the tests before you say it works"} onChange={setGlobal} onSave={() => save("global")} />
    </Group>
    <Group title="Workspace AGENTS.md">
      <Row label="Project" description="The AGENTS.md at the root of the project's folder. Agents in this project get it after the global one">
        <select className="cxs-select" aria-label="Project" value={project ?? ""} disabled={!projects.length}
          onChange={(event) => choose(event.target.value)}>
          {projects.length ? null : <option value="">No project folders</option>}
          {projects.map((item) => <option key={item.id} value={item.id} title={item.path}>{item.name}</option>)}
        </select>
      </Row>
      {files?.workspaceFile ? <InstructionEditor label="Workspace AGENTS.md" file={files.workspaceFile} value={workspace} saved={files.workspace ?? ""}
        placeholder={"# This project\n\n- Build with bun run build\n- Never commit to main"} onChange={setWorkspace} onSave={() => save("workspace")} />
        : <Row label={files ? "This project has no folder" : "Loading…"}><span /></Row>}
    </Group>
  </>;
}

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

// How full a chat gets before its next message compacts it first; the bridge takes 20 to 100
// (chat_auto_compact), and /autocompact any share in between.
const COMPACT_CHOICES = [50, 60, 70, 80, 90, 95, 100];

/** The chat's own preferences, kept by the bridge (agent-orchestrator-workflow.cjs), as Claude Code's settings. */
type ChatPreferences = { autoCompact: boolean; percent: number; autoRetry: boolean; modelJudges: boolean; questionTimeout: number };
// "Agent questions": how long a question waits before it is answered for you (chat_question_timeout).
// 0 keeps it, and the agent paused on it, until you answer.
const QUESTION_TIMEOUT_DEFAULT = 30;
const QUESTION_TIMEOUT_MAX = 24 * 60 * 60;
const questionSeconds = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : QUESTION_TIMEOUT_DEFAULT);

/** The seconds an "Agent questions" wait is typed in, saved when it is left or Enter is pressed. */
function QuestionSeconds({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (seconds: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const seconds = Number(text);
    if (Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= QUESTION_TIMEOUT_MAX) { if (seconds !== value) onChange(seconds); }
    else setText(String(value));
  };
  return <input className="cxs-select cxs-seconds" type="number" min={1} max={QUESTION_TIMEOUT_MAX} step={1} inputMode="numeric"
    aria-label="Seconds before the agent's question is answered for you" value={text} disabled={disabled}
    onChange={(event) => setText(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />;
}
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

function PageShortcut({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <input className="cxs-shortcut" aria-label={label} value={value} readOnly disabled={disabled}
    title="Focus here and press a modified letter, number, arrow or function key. Escape cancels."
    onKeyDown={(event) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { event.currentTarget.blur(); return; }
      const shortcut = recordPageShortcut(event.nativeEvent);
      if (shortcut) onChange(shortcut);
    }} />;
}

/**
 * `onArchiveChanged` tells the chat list the archive days changed, so its Archived section and
 * popover read them again.
 */
export function ChatSettingsPage({ onClose, onArchiveChanged, workspaceId = null }: { onClose: () => void; onArchiveChanged?: () => void; workspaceId?: string | null }) {
  const api = window.codexWebLauncher;
  const [section, setSection] = useState<Section>("general");
  const [state, setState] = useState<LauncherState | null>(null);
  const [updates, setUpdates] = useState<UpdateSettings | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [error, setError] = useState("");
  const [chat, setChat] = useState<ChatPreferences | null>(null);
  const pages = useChatPagePreferences();
  const setPagePreference = (patch: Partial<ChatPagePreferences>) => {
    try { saveChatPagePreferences(patch); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

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
    void Promise.all([chatCall("chat_auto_compact"), chatCall("chat_auto_retry"), chatCall("chat_model_judges"), chatCall("chat_question_timeout")])
      .then(([compact, retry, judges, questions]) => {
        if (live) setChat({ autoCompact: compact.autoCompact !== false, percent: Number(compact.percent) || 95, autoRetry: retry.autoRetry === true, modelJudges: judges.modelJudges === true,
          questionTimeout: questionSeconds(questions.seconds) });
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
      ...(operation === "chat_question_timeout" ? { questionTimeout: questionSeconds(result.seconds) } : {}),
    })));
  };
  // The chat list's own settings, shared with its popover in the sidebar.
  const [list, setList] = useState(readChatListSettings);
  useEffect(() => onChatListSettings(setList), []);
  // The archive days, kept by the bridge (chat-archive.cjs) like the preferences above.
  const [archive, setArchive] = useState<{ days: number; idleDays: number } | null>(null);
  useEffect(() => {
    let live = true;
    void chatCall("archive_settings").then((result) => { if (live) setArchive({ days: Number(result.days) || 0, idleDays: Number(result.idleDays) || 0 }); }, () => undefined);
    return () => { live = false; };
  }, []);
  const setArchiveDays = (change: { days?: number; idleDays?: number }) => {
    run(chatCall("archive_settings", change).then((result) => {
      setArchive({ days: Number(result.days) || 0, idleDays: Number(result.idleDays) || 0 });
      onArchiveChanged?.();
    }));
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
          </div> : section === "chat" ? <div className="cxs-sections">
            <Group title="Chat list">
              <Row label="Chats shown per project" description="The rest stay under Show more. Chats open in split view always show">
                <select className="cxs-select" aria-label="Chats shown per project" value={list.visible}
                  onChange={(event) => setList(saveChatListSettings({ visible: Number(event.target.value) }))}>
                  {(VISIBLE_CHOICES.includes(list.visible) ? VISIBLE_CHOICES : [...VISIBLE_CHOICES, list.visible].sort((a, b) => a - b))
                    .map((count) => <option key={count} value={count}>{count} chats</option>)}
                </select>
              </Row>
              <Row label="Keep running chats on top" description="Chats that are working or waiting on you rise to the top of their project. A chat you drag keeps its place until it runs again">
                <Toggle label="Keep running chats on top" checked={list.keepActiveOnTop}
                  onChange={(keepActiveOnTop) => setList(saveChatListSettings({ keepActiveOnTop }))} />
              </Row>
            </Group>
            <Group title="Archive and delete">
              <Row label="Archive inactive chats" description="A chat with no activity for this long leaves the project list. Working, scheduled and goal chats stay. Restore brings it back">
                <select className="cxs-select" aria-label="Archive inactive chats after" value={archive?.idleDays ?? 7} disabled={!archive}
                  onChange={(event) => setArchiveDays({ idleDays: Number(event.target.value) })}>
                  {dayChoices(archive?.idleDays ?? 7).map((days) => <option key={days} value={days}>{days ? `After ${archiveDayLabel(days)}` : "Never"}</option>)}
                </select>
              </Row>
              <Row label="Delete archived chats" description="An archived chat moves to Recently deleted after this long. Restore still brings it back from there">
                <select className="cxs-select" aria-label="Delete archived chats after" value={archive?.days ?? 5} disabled={!archive}
                  onChange={(event) => setArchiveDays({ days: Number(event.target.value) })}>
                  {dayChoices(archive?.days ?? 5).map((days) => <option key={days} value={days}>{days ? `After ${archiveDayLabel(days)}` : "Never"}</option>)}
                </select>
              </Row>
            </Group>
            <Group title="Chat pages">
              <Row label="Show page tabs" description="Keep separate sets of chat sessions on pages. Hiding the tabs keeps your current page and running chats">
                <Toggle label="Show page tabs" checked={pages.enabled} onChange={(enabled) => setPagePreference({ enabled })} />
              </Row>
              <Row label="Open pages" description={`${pages.pageCount} of ${CHAT_PAGE_LIMIT} pages. Each new page starts with a new chat and keeps its own split layout`}>
                <button type="button" className="cxs-button" disabled={!pages.enabled || pages.pageCount >= CHAT_PAGE_LIMIT}
                  onClick={() => setPagePreference({ pageCount: pages.pageCount + 1 })}>Add page</button>
              </Row>
              <Row label="Scroll over the page bar to switch" description="Over the page bar, scroll up for the previous page and down for the next. Scrolling messages stays unchanged">
                <Toggle label="Scroll over the page bar to switch" checked={pages.wheel} disabled={!pages.enabled}
                  onChange={(wheel) => setPagePreference({ wheel })} />
              </Row>
              <Row label="Page keyboard shortcuts" description="Switch pages without clicking. Shortcuts pause while typing or using a dialog">
                <Toggle label="Page keyboard shortcuts" checked={pages.keyboard} disabled={!pages.enabled}
                  onChange={(keyboard) => setPagePreference({ keyboard })} />
              </Row>
              <Row label="Previous page shortcut" description="Focus the shortcut, then press the key combination you want">
                <PageShortcut label="Previous page shortcut" value={pages.previous} disabled={!pages.enabled || !pages.keyboard}
                  onChange={(previous) => setPagePreference(previous === pages.next ? { previous, next: pages.previous } : { previous })} />
              </Row>
              <Row label="Next page shortcut" description="Pressing the previous page's shortcut here swaps the two">
                <PageShortcut label="Next page shortcut" value={pages.next} disabled={!pages.enabled || !pages.keyboard}
                  onChange={(next) => setPagePreference(next === pages.previous ? { next, previous: pages.next } : { next })} />
              </Row>
            </Group>
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
              <Row label="Agent questions" description={chat?.questionTimeout === 0
                ? "A question the agent asks waits for your answer, and the agent pauses until you answer it"
                : "With Approve for me or Full access, a question nobody answers gets its recommended answer after this many seconds"}>
                <span className="cxs-inline">
                  <select className="cxs-select" aria-label="Agent questions" value={chat?.questionTimeout === 0 ? "wait" : "timeout"} disabled={!chat}
                    onChange={(event) => setChatPreference("chat_question_timeout", { seconds: event.target.value === "wait" ? 0 : QUESTION_TIMEOUT_DEFAULT })}>
                    <option value="wait">Wait for my answer</option>
                    <option value="timeout">Answer for me after</option>
                  </select>
                  {chat && chat.questionTimeout > 0 ? <><QuestionSeconds value={chat.questionTimeout} disabled={!chat}
                    onChange={(seconds) => setChatPreference("chat_question_timeout", { seconds })} /><span className="cxs-unit">s</span></> : null}
                </span>
              </Row>
            </Group>
            <Group title="Keyboard shortcuts">
              {LIST_SHORTCUTS.map((item) => <Row key={item.label} label={item.label}>
                <kbd className="cxs-kbd">{item.keys}</kbd>
              </Row>)}
            </Group>
          </div> : section === "instructions" ? <div className="cxs-sections">
            <InstructionsSection workspaceId={workspaceId} onError={setError} />
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
