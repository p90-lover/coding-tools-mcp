import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
import { Caret, Icon } from "../icons";
import { contextFraction, tokensShort, type ChatAgentSession } from "./ao-chat";
import { costLabel, costSourceLabel, readCpaUsage, type CpaUsage, type CpaUsageRange } from "./cpa-usage";
import { onWindowFocus, windowUnfocused } from "./page-visibility";

// The chat's side panel, as Codex shows one beside a thread: tabs for the page the chat's agent
// opened in its own browser (a native view drawn over the pane's slot), the changes in its
// worktree, its files, and a terminal (its commands, with live output, and the user's own shell),
// plus a new-tab page with those tools and the pages this chat opened. Everything acts for the
// user: navigating, stopping a command or typing into it needs no approval, since the user does it.

export type WorkbenchTab = "overview" | "preview" | "terminal" | "changes" | "files" | "new";
type PanelTab = { id: string; kind: WorkbenchTab };

type PreviewState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; errors: number };
// "app": started through the app's exec_command (live output, stoppable, takes input). "agent": a
// shell command the agent ran with its own tool (Bash, PowerShell), read from its AO conversation
// with the tail of its output; read-only. One it ran in the background (a dev server) has status
// "background" and the live tail of the output file Claude Code writes for it.
type Command = {
  id: string; cmd: string; workdir: string; startedAt: number; status: string; exitCode: number | null; user?: boolean;
  source?: "app" | "agent"; output?: string; background?: boolean;
};
const isAgentShell = (command: Command | undefined) => command?.source === "agent";
/** A pane the agent asked the chat to bring forward (its show_in_chat tool), newest per session. */
type ShowRequest = { id: string; pane: "terminal" | "preview"; commandId?: string; at?: number };
/** Still running: an app command, an agent's command mid-call, or one it left running in the background. */
const isLive = (command: Command | undefined) => command?.status === "running" || command?.status === "background";
// Commands that start something which keeps serving: dev servers, file servers, watchers.
const SERVER_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|npx\s+(?:vite|next|serve|http-server|live-server)\b|vite(?:\s+(?:dev|serve|preview))?(?:\s|$)|next\s+(?:dev|start)\b|nodemon\b|webpack(?:-dev-server|\s+serve)\b|uvicorn\b|gunicorn\b|flask\s+run\b|manage\.py\s+runserver\b|http\.server\b|php\s+-S\b|rails\s+s(?:erver)?\b|hugo\s+server\b|jekyll\s+serve\b|cargo\s+watch\b|dotnet\s+watch\b|docker(?:-|\s+)compose\s+up\b)/i;
/**
 * Whether a command is a server process: the agent left it running in the background, or it starts
 * a dev or file server. Only those open the side panel by themselves; the agent's one-off commands
 * (a status poll, a build, a test run) filled the screen with the Terminal while it worked.
 */
export function isServerProcess(command: Pick<Command, "cmd" | "status" | "background">): boolean {
  return command.status === "background" || command.background === true || SERVER_COMMAND.test(String(command.cmd ?? ""));
}

const TAB_TITLES: Record<WorkbenchTab, string> = { overview: "Overview", preview: "Preview", terminal: "Terminal", changes: "Changes", files: "Files", new: "New tab" };
const PANEL_WIDTH_KEY = "coding-tools:ao:workbench-width";
let tabSequence = 0;
const newTab = (kind: WorkbenchTab): PanelTab => ({ id: `tab-${++tabSequence}`, kind });
// The pages each chat agent's preview showed, newest first, for the new-tab page's Recents.
const RECENT_PAGES = new Map<string, { url: string; title: string; at: number }[]>();
function rememberPage(sessionId: string, url: string, title: string) {
  if (!url || url === "about:blank" || url.startsWith("data:")) return;
  const list = (RECENT_PAGES.get(sessionId) ?? []).filter((page) => page.url !== url);
  RECENT_PAGES.set(sessionId, [{ url, title, at: Date.now() }, ...list].slice(0, 12));
}

/**
 * Which tab the side panel should show for what a chat's agents just did (`fresh`: new pages,
 * `page:...`, and new commands, `cmd:...`), or null to leave the panel as it is. A page the agent
 * opens always brings the Preview pane forward, opening the panel or switching it from another tab:
 * agents start their dev server first, which opened the Terminal, and the page they then opened
 * with preview_open stayed behind it, so the user never saw the browser. A new command opens the
 * Terminal only while the panel is closed, never taking the place of what the user looks at.
 */
export function autoOpenTab(fresh: string[], open: boolean): WorkbenchTab | null {
  // The agent asked to show a pane (show_in_chat, `show:<id>:<pane>`): that pane, open or not.
  const shown = fresh.filter((item) => item.startsWith("show:")).at(-1);
  if (shown) return shown.endsWith(":preview") ? "preview" : "terminal";
  if (fresh.some((item) => item.startsWith("page:"))) return "preview";
  return !open && fresh.length ? "terminal" : null;
}

/**
 * Whether an agent's command is worth bringing the Terminal pane forward for. The pane is for
 * processes that keep running (a dev server, a watcher), whose output the user follows there; a
 * one-off tool call (`git status`, `ls`) already shows its command and output in the chat, and
 * opening the pane for each one took the side of the screen for nothing. Called on every poll
 * (about every 4 s) with the poll's time, for commands the agent (not the user) started.
 * A command has `status` ("running", "background" when the agent left it running in the background,
 * or an ended state), `startedAt` (ms), `background` and `source` ("app" for exec_command, "agent"
 * for its own shell tool).
 */
export function opensTerminal(command: Command, _now: number): boolean {
  // A server process (isServerProcess), or a project's own app launcher (the user's run_app.cmd).
  return isLive(command) && (isServerProcess(command) || APP_LAUNCHER.test(String(command.cmd ?? "")));
}
// A script that starts the project's app: run_app.cmd, start-app.ps1, run_server.bat and the like.
const APP_LAUNCHER = /(?:^|[\\/\s])(?:run|start)[_-]?(?:app|server|dev)\b/i;

/**
 * Whether a poll of `sessionIds` starts over for another chat (none of its sessions was polled
 * before), so what its agents already did when it was opened does not open the panel by itself.
 * A session joining the same chat (a new agent, a restarted one) is not a new chat: what it does
 * counts at once.
 */
export function startsNewChat(sessionIds: string[], polled: Set<string>): boolean {
  return !sessionIds.some((id) => polled.has(id));
}

/**
 * Opens the side panel the first time a chat agent opens a page in its preview or starts a server
 * process (isServerProcess), as Codex shows the browser or terminal when its agent uses one. A command counts whether it went
 * through the app's exec_command or the agent's own shell tool (source "agent"). Each page and command opens it
 * once; closing the panel is respected until the agent does something new (see autoOpenTab).
 */
export function useWorkbenchAutoOpen(sessionIds: string[], open: boolean, onOpen: (tab: WorkbenchTab) => void, workspaceId?: string): LivePage | null {
  // The page an agent's browser shows now, if any: the chat offers it back when the panel is hidden.
  const [livePage, setLivePage] = useState<LivePage | null>(null);
  const seen = useRef(new Set<string>());
  const polled = useRef(new Set<string>());
  // The latest panel state and callback, read by the poll without restarting it: a restart on each
  // open/close swallowed whatever the agent did in its first tick.
  const openNow = useRef(open);
  openNow.current = open;
  const onOpenNow = useRef(onOpen);
  onOpenNow.current = onOpen;
  const key = sessionIds.join(",");
  useEffect(() => {
    setLivePage(null);
    if (!sessionIds.length) return undefined;
    let live = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const [previews, processes] = await Promise.all([
          paneCall("chat_preview_state", { sessionIds }), paneCall("chat_processes", { sessionIds, ...(workspaceId ? { workspaceId } : {}) }),
        ]);
        if (!live) return;
        const shown = Object.entries((previews.previews as Record<string, PreviewState> | undefined) ?? {})
          .find(([, state]) => state.url && state.url !== "about:blank");
        setLivePage((current) => {
          const next = shown ? { sessionId: shown[0], url: shown[1].url, title: shown[1].title } : null;
          return current?.url === next?.url && current?.title === next?.title && current?.sessionId === next?.sessionId ? current : next;
        });
        const pages = Object.entries((previews.previews as Record<string, PreviewState> | undefined) ?? {})
          .filter(([, state]) => state.url && state.url !== "about:blank").map(([id, state]) => `page:${id}:${new URL(state.url).origin}`);
        // Asked again on every tick, so a command that turns out to be long-running (a server) can
        // open the pane later even though it was too young to the first time it was seen.
        const at = Date.now();
        const listed = (processes.sessions as { commands: Command[]; show?: ShowRequest }[] | undefined) ?? [];
        const commands = listed.flatMap((session) => session.commands).filter((command) => !command.user && opensTerminal(command, at)).map((command) => `cmd:${command.id}`);
        // What the agent asked the chat to show (show_in_chat), whatever the process is.
        const shows = listed.map((session) => session.show).filter((show): show is ShowRequest => Boolean(show?.id))
          .map((show) => `show:${show.id}:${show.pane}`);
        const fresh = [...pages, ...commands, ...shows].filter((item) => !seen.current.has(item));
        for (const item of fresh) seen.current.add(item);
        // What was already there when the chat opened does not open the panel by itself.
        const newChat = startsNewChat(sessionIds, polled.current);
        if (newChat) polled.current = new Set(sessionIds);
        else for (const id of sessionIds) polled.current.add(id);
        if (newChat) return;
        const tab = autoOpenTab(fresh, openNow.current);
        if (tab) onOpenNow.current(tab);
      } catch { /* the next tick tries again */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    return () => { live = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return livePage;
}

/** A page a chat agent's browser has open (its preview keeps running while the panel is hidden). */
export type LivePage = { sessionId: string; url: string; title: string };

const PREVIEW_POLL_MS = 1500;
const COMMANDS_POLL_MS = 2000;
const OUTPUT_POLL_MS = 1000;
const MAX_OUTPUT_CHARS = 200_000;
// A command chosen in the pane starts at its newest output, as a terminal shows it, not its first byte.
const TAIL_BYTES = 32 * 1024;
// Terminal colours and cursor movement, OSC titles and links: the pane shows plain text.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

async function paneCall(operation: string, args: JsonObject = {}) {
  const outer = await getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation, arguments: args });
  const result = (outer.result && typeof outer.result === "object" ? outer.result : {}) as Record<string, unknown>;
  if (outer.ok === false || result.ok === false) throw new Error(String(result.error || result.reason || "Something went wrong. Try again."));
  return result;
}

const plain = (text: string) => text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");

function since(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

export function ChatWorkbench({ sessions, tab, onTab, onClose, workspaceId }: {
  sessions: ChatAgentSession[];
  /** The chat's workspace: reaches an agent's worktree even when the app holds no lease for it. */
  workspaceId?: string;
  /** The tab to show: asking for a kind brings its tab forward, opening one if needed. */
  tab: WorkbenchTab;
  onTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  useEffect(() => {
    if (!sessions.some((session) => session.id === sessionId)) setSessionId(sessions[0]?.id ?? "");
  }, [sessions, sessionId]);
  const [tabs, setTabs] = useState<PanelTab[]>(() => [newTab(tab)]);
  const [active, setActive] = useState(() => tabs[0].id);
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const activeNow = useRef(active);
  activeNow.current = active;
  // A kind asked for from outside (the header button, the agent opening a page) comes forward; the
  // shown tab already being that kind (one of two new tabs, say) stays as it is.
  useEffect(() => {
    if (tabsNow.current.find((item) => item.id === activeNow.current)?.kind === tab) return;
    const existing = tabsNow.current.find((item) => item.kind === tab);
    if (existing) { setActive(existing.id); return; }
    const added = newTab(tab);
    setTabs((list) => [...list, added]);
    setActive(added.id);
  }, [tab]);
  const current = tabs.find((item) => item.id === active) ?? tabs[0];
  const show = (kind: WorkbenchTab) => {
    // From the new-tab page a tool takes that tab's place, as in Codex; elsewhere it opens its own.
    const existing = tabs.find((item) => item.kind === kind && kind !== "new");
    if (existing) { setActive(existing.id); onTab(kind); return; }
    if (current?.kind === "new") {
      setTabs((list) => list.map((item) => (item.id === current.id ? { ...item, kind } : item)));
    } else {
      const added = newTab(kind);
      setTabs((list) => [...list, added]);
      setActive(added.id);
    }
    onTab(kind);
  };
  const close = (id: string) => {
    const index = tabs.findIndex((item) => item.id === id);
    const rest = tabs.filter((item) => item.id !== id);
    if (!rest.length) { onClose(); return; }
    setTabs(rest);
    if (id === active) {
      const next = rest[Math.max(0, index - 1)];
      setActive(next.id);
      // The chat's state follows, or asking for the closed kind again (the browser chip, the
      // header button) found it "already shown" and did nothing.
      onTab(next.kind);
    }
  };
  const addTab = () => { const added = newTab("new"); setTabs((list) => [...list, added]); setActive(added.id); onTab("new"); };

  // The panel's width is dragged from its left edge, as the cards panel's is, and kept per viewer.
  const [width, setWidth] = useState<number | null>(() => {
    try { const value = Number(localStorage.getItem(PANEL_WIDTH_KEY)); return Number.isFinite(value) && value >= 360 ? value : null; } catch { return null; }
  });
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    event.preventDefault();
    const right = panel.getBoundingClientRect().right;
    const limit = Math.max(420, (panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth) - 360);
    let next = width;
    const move = (moveEvent: PointerEvent) => { next = Math.min(limit, Math.max(360, right - moveEvent.clientX)); setWidth(next); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try { if (next) localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(next))); } catch { /* kept for this view only */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return <aside className="cx-structure cx-workbench" aria-label="Side panel" style={width ? { flexBasis: width } : undefined}>
    <div className="cx-structure-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize · double-click to reset"
      onPointerDown={startResize} onDoubleClick={() => { setWidth(null); try { localStorage.removeItem(PANEL_WIDTH_KEY); } catch { /* fine */ } }} />
    <header className="cx-workbench-head">
      <div className="cx-workbench-tabstrip" role="tablist" aria-label="Side panel tabs">
        {tabs.map((item) => <div key={item.id} className={`cx-workbench-tab${item.id === current?.id ? " is-active" : ""}`}>
          <button type="button" role="tab" aria-selected={item.id === current?.id} onClick={() => { setActive(item.id); onTab(item.kind); }}>
            {TAB_TITLES[item.kind]}</button>
          <button type="button" className="cx-workbench-tab-close" aria-label={`Close ${TAB_TITLES[item.kind]}`}
            title={item.kind === "preview" ? "Hide browser. It keeps running for the agent" : `Close ${TAB_TITLES[item.kind]}`}
            onClick={() => close(item.id)}>×</button>
        </div>)}
        <button type="button" className="cx-icon-button cx-workbench-add" aria-label="New tab" title="New tab" onClick={addTab}>
          <Icon name="plus" width="14" height="14" /></button>
      </div>
      {sessions.length > 1 ? <select className="cx-workbench-agent" aria-label="Agent" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
      </select> : null}
      <button type="button" className="cx-icon-button" aria-label="Hide side panel" title="Hide side panel" onClick={onClose}>
        <Icon name="close" width="14" height="14" /></button>
    </header>
    {!sessionId
      ? <p className="cx-workbench-empty">No agent yet. Its pages, changes, files and commands show here.</p>
      : current?.kind === "overview" ? <OverviewPane key={sessionId} session={sessions.find((item) => item.id === sessionId)} sessionId={sessionId} workspaceId={workspaceId} onTool={show} />
      : current?.kind === "preview" ? <PreviewPane key={sessionId} sessionId={sessionId} />
        : current?.kind === "terminal" ? <TerminalPane key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
          : current?.kind === "changes" ? <ChangesPane key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
            : current?.kind === "files" ? <FilesPane key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
              : <NewTabPage sessionId={sessionId} onTool={show} />}
  </aside>;
}

/** Loads a page in the chat agent's preview browser; the caller shows the Preview tab. */
export function navigatePreview(sessionId: string, url: string) {
  void paneCall("chat_preview_navigate", { sessionId, url }).catch(() => undefined);
}

/** The new-tab page: the panel's tools and the pages this chat's agent opened. */
function NewTabPage({ sessionId, onTool }: { sessionId: string; onTool: (kind: WorkbenchTab) => void }) {
  const recents = RECENT_PAGES.get(sessionId) ?? [];
  const open = (url: string) => {
    navigatePreview(sessionId, url);
    onTool("preview");
  };
  return <div className="cx-newtab">
    <p className="cx-newtab-label">Tools</p>
    <div className="cx-newtab-tools">
      {(["overview", "preview", "changes", "terminal", "files"] as const).map((kind) => <button key={kind} type="button" onClick={() => onTool(kind)}>
        <span>{TAB_TITLES[kind]}</span><small>{kind === "overview" ? "Context, changes, tasks and usage" : kind === "preview" ? "The agent's browser" : kind === "changes" ? "Its worktree's diff" : kind === "terminal" ? "Commands and a shell" : "Browse its worktree"}</small>
      </button>)}
    </div>
    <p className="cx-newtab-label">Recents</p>
    {recents.length ? <ul className="cx-newtab-recents">{recents.map((page) => <li key={page.url}>
      <button type="button" onClick={() => open(page.url)}><span>{page.title || page.url}</span><small>{page.url}</small>
        <time>{new Date(page.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></button>
    </li>)}</ul> : <p className="cx-workbench-empty">Pages the agent opens show here.</p>}
  </div>;
}

const OVERVIEW_POLL_MS = 5_000;

/**
 * The chat at a glance, as Claude Code's side column shows one: where its agent works, how full its
 * context is, what it changed, what still runs, and what its provider accounts spent. Each block
 * opens the tab with the detail. Usage is CPA's per-account report (cpa_usage); keys the app holds
 * for other providers report no usage, which the block says rather than guessing.
 */
function OverviewPane({ session, sessionId, workspaceId, onTool }: {
  session?: ChatAgentSession; sessionId: string; workspaceId?: string; onTool: (kind: WorkbenchTab) => void;
}) {
  const [context, setContext] = useState<{ used: number | null; window: number | null; controller: string | null } | null>(null);
  const [changes, setChanges] = useState<{ root: string; branch: string; count: number } | null>(null);
  const [tasks, setTasks] = useState<Command[]>([]);
  const [range, setRange] = useState<CpaUsageRange>("24h");
  const [usage, setUsage] = useState<CpaUsage | null>(null);
  useEffect(() => {
    let live = true;
    const scope: JsonObject = workspaceId ? { workspaceId } : {};
    // The changed-file count runs git status over the whole worktree (untracked files too): one at a
    // time, not while you are in another app (refreshed when you come back), and without the diff,
    // which this block never shows (`summary`). Every 5 s it kept a busy hard disk walking the tree.
    let counting = false;
    const countChanges = () => {
      if (counting || windowUnfocused()) return;
      counting = true;
      void paneCall("chat_changes", { sessionId, ...scope, summary: true }).then((result) => {
        if (live) setChanges({ root: String(result.root ?? ""), branch: String(result.branch ?? ""), count: Array.isArray(result.entries) ? result.entries.length : 0 });
      }).catch(() => undefined).finally(() => { counting = false; });
    };
    const read = () => {
      if (document.visibilityState !== "visible") return;
      void paneCall("chat_context", { sessionIds: [sessionId] }).then((result) => {
        const found = (result.sessions as Record<string, { controller?: string | null; usage?: { contextUsed: number | null; contextWindow: number | null } | null }> | undefined)?.[sessionId];
        if (live) setContext({ used: found?.usage?.contextUsed ?? null, window: found?.usage?.contextWindow ?? session?.contextWindow ?? null, controller: found?.controller ?? null });
      }).catch(() => undefined);
      countChanges();
      void paneCall("chat_processes", { sessionIds: [sessionId], ...scope }).then((result) => {
        if (live) setTasks((((result.sessions as { commands: Command[] }[] | undefined)?.[0]?.commands) ?? []).filter(isLive));
      }).catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, OVERVIEW_POLL_MS);
    const offFocus = onWindowFocus(read);
    return () => { live = false; window.clearInterval(timer); offFocus(); };
  }, [sessionId, workspaceId, session?.contextWindow]);
  // Usage changes slowly and the main process caches it for 20 s: once per range, then each minute.
  useEffect(() => {
    let live = true;
    const read = () => { void readCpaUsage(range).then((next) => { if (live) setUsage(next); }).catch(() => undefined); };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [range]);

  const fraction = contextFraction(context ? { contextUsed: context.used, contextWindow: context.window } : null);
  const busy = Boolean(context?.controller && /busy|running|working/i.test(context.controller));
  const accounts = (usage?.available ? usage.accounts ?? [] : []).filter((account) => account.requests > 0)
    .sort((left, right) => (right.cost ?? 0) - (left.cost ?? 0) || right.totalTokens - left.totalTokens);
  return <div className="cx-overview">
    <section className="cx-overview-block">
      <h4>Environment</h4>
      <p className="cx-overview-row"><span>Agent</span><b title={session?.model}>{session?.label || "—"}</b></p>
      {session?.model ? <p className="cx-overview-row"><span>Model</span><b title={session.model}>{session.model.slice(session.model.lastIndexOf("/") + 1)}</b></p> : null}
      {changes?.branch ? <p className="cx-overview-row"><span>Branch</span><b>{changes.branch}</b></p> : null}
      {changes?.root ? <p className="cx-overview-row"><span>Folder</span><b className="is-path" title={changes.root}>{changes.root}</b></p> : null}
      {context?.controller ? <p className="cx-overview-row"><span>Status</span><b className={busy ? "is-busy" : undefined} title={context.controller}>{busy ? "Working" : "Idle"}</b></p> : null}
    </section>
    <section className="cx-overview-block">
      <h4>Context<small>{fraction === null ? "" : `${Math.round(fraction * 100)}%`}</small></h4>
      <div className={`cx-ctx-bar is-${fraction === null ? "unknown" : fraction >= 0.85 ? "high" : fraction >= 0.6 ? "mid" : "low"}`}>
        <span style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} /></div>
      <p className="cx-overview-note">{context?.used === null || context?.used === undefined ? "Context not reported yet."
        : `${tokensShort(context.used)} of ${tokensShort(context.window)} used`}</p>
    </section>
    <section className="cx-overview-block">
      <h4>Changes<small>{changes ? `${changes.count} ${changes.count === 1 ? "file" : "files"}` : ""}</small></h4>
      <button type="button" className="cx-overview-link" onClick={() => onTool("changes")}>
        {changes?.count ? "Review the diff" : "No uncommitted changes"}</button>
    </section>
    <section className="cx-overview-block">
      <h4>Background tasks<small>{tasks.length ? `${tasks.length} running` : ""}</small></h4>
      {tasks.length ? <ul className="cx-overview-tasks">{tasks.slice(0, 4).map((task) => <li key={task.id}>
        <button type="button" title={task.cmd} onClick={() => onTool("terminal")}><i aria-hidden="true" /><span>{task.cmd}</span></button>
      </li>)}</ul> : <p className="cx-overview-note">Nothing running.</p>}
    </section>
    <section className="cx-overview-block">
      <h4>Usage
        <span className="cx-overview-range" role="group" aria-label="Usage period">
          {(["24h", "7d", "30d"] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>
            {value === "24h" ? "Today" : value}</button>)}
        </span></h4>
      {!usage ? <p className="cx-overview-note">Reading usage…</p>
        : !usage.available ? <p className="cx-overview-note">{usage.reason || "Usage is unavailable."}</p> : <>
          {usage.totals ? <p className="cx-overview-total" title={costSourceLabel(usage.totals.costSource, usage.totals.costPartial, false)}>
            <b>{costLabel(usage.totals.cost, usage.totals.costPartial)}</b>
            <span>{tokensShort(usage.totals.totalTokens)} tokens · {usage.totals.requests.toLocaleString()} requests</span></p> : null}
          {accounts.length ? <ul className="cx-overview-usage">{accounts.slice(0, 8).map((account) => <li key={account.id}
            title={`In ${tokensShort(account.inputTokens)} · out ${tokensShort(account.outputTokens)} · cached ${tokensShort(account.cachedTokens)}\n${costSourceLabel(account.costSource, account.costPartial, false)}`}>
            <span><b>{account.label}</b><small>{account.provider ?? ""}</small></span>
            <span><b>{costLabel(account.cost, account.costPartial)}</b><small>{tokensShort(account.totalTokens)} · {account.requests.toLocaleString()} req</small></span>
          </li>)}</ul> : <p className="cx-overview-note">No requests in this period.</p>}
          <p className="cx-overview-note">Costs are estimates at API list prices. Subscriptions aren't billed per token. Keys used outside CPA report no usage.</p>
        </>}
    </section>
  </div>;
}

function PreviewPane({ sessionId }: { sessionId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PreviewState | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const tick = () => void paneCall("chat_preview_state", { sessionIds: [sessionId] })
      .then((result) => {
        if (!live) return;
        const next = (result.previews as Record<string, PreviewState> | undefined)?.[sessionId] ?? null;
        if (next) rememberPage(sessionId, next.url, next.title);
        setState(next);
      })
      .catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, PREVIEW_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);
  useEffect(() => { if (!editing) setAddress(state?.url && state.url !== "about:blank" ? state.url : ""); }, [state?.url, editing]);

  // The page is a native view: keep it on the slot while the pane shows, and take it off after.
  const hasPage = Boolean(state);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element || !hasPage) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        // The chat page stays mounted behind other pages (hidden): its slot then has no size, and
        // the native view must leave the screen with it, or it stayed drawn over CPA, Settings and
        // every other page with no way to close it. It comes back when the slot does.
        if (rect.width < 2 || rect.height < 2) { void paneCall("chat_preview_hide").catch(() => undefined); return; }
        void paneCall("chat_preview_show", { sessionId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).catch(() => undefined);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      void paneCall("chat_preview_hide").catch(() => undefined);
    };
  }, [sessionId, hasPage]);

  const navigate = (request: JsonObject) => {
    setError("");
    void paneCall("chat_preview_navigate", { sessionId, ...request }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const open = () => {
    const raw = address.trim();
    if (!raw) return;
    setEditing(false);
    navigate({ url: /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}` });
  };

  return <div className="cx-preview">
    <form className="cx-preview-bar" onSubmit={(event) => { event.preventDefault(); open(); }}>
      <button type="button" className="cx-icon-button" aria-label="Back" disabled={!state?.canGoBack} onClick={() => navigate({ action: "back" })}>
        <Icon name="back" width="14" height="14" /></button>
      <button type="button" className="cx-icon-button" aria-label="Forward" disabled={!state?.canGoForward} onClick={() => navigate({ action: "forward" })}>
        <Icon name="forward" width="14" height="14" /></button>
      <button type="button" className="cx-icon-button" aria-label="Reload" disabled={!state} onClick={() => navigate({ action: "reload" })}>
        <Icon name="reload" width="14" height="14" /></button>
      <input aria-label="Address" placeholder="http://localhost:5173" value={address} spellCheck={false}
        onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(event) => setAddress(event.target.value)} />
      {state?.errors ? <span className="cx-preview-errors" title="Console errors and failed requests">{state.errors} errors</span> : null}
    </form>
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    {state ? <div ref={slot} className="cx-preview-slot" aria-label={state.title || state.url} />
      : <p className="cx-workbench-empty">No page open yet. The agent opens its dev server here, or you can enter a localhost address above.</p>}
  </div>;
}

function TerminalPane({ sessionId, workspaceId }: { sessionId: string; workspaceId?: string }) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [selected, setSelected] = useState("");
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  // Finished commands are the agent's tool calls (already in the chat): folded away unless asked for.
  const [showHistory, setShowHistory] = useState(false);
  const offsets = useRef({ stdout: 0, stderr: 0 });
  const screen = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const shownRequest = useRef("");

  useEffect(() => {
    let live = true;
    const tick = () => {
      // A minimized or hidden window does not poll.
      if (document.visibilityState !== "visible") return;
      void paneCall("chat_processes", { sessionIds: [sessionId], ...(workspaceId ? { workspaceId } : {}) }).then((result) => {
        if (!live) return;
        const listed = (result.sessions as { commands: Command[]; show?: ShowRequest }[] | undefined)?.[0];
        // What still runs comes first (a dev server started long ago above the newest one-off
        // commands), newest first within each.
        const found = [...(listed?.commands ?? [])]
          .sort((left, right) => Number(isLive(right)) - Number(isLive(left)));
        setCommands(found);
        setNow(Date.now());
        // The agent asked to show one command here (show_in_chat): it is the one shown, finished or not.
        const show: ShowRequest | undefined = listed?.show;
        if (show?.pane === "terminal" && show.commandId && show.id !== shownRequest.current) {
          const wanted = found.find((command) => command.id === show.commandId);
          if (wanted) {
            shownRequest.current = show.id;
            setSelected(wanted.id);
            if (!isLive(wanted)) setShowHistory(true);
            return;
          }
        }
        // First choice: a running app the agent started (not the user's own shell), then anything
        // live. With nothing running nothing is picked: a finished tool call is not the app.
        setSelected((current) => (found.some((command) => command.id === current) ? current
          : (found.find((command) => isLive(command) && !command.user) ?? found.find(isLive))?.id ?? ""));
      }).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, COMMANDS_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);

  const command = commands.find((item) => item.id === selected);
  const running = isLive(command);
  const agentShell = isAgentShell(command);
  // An agent shell command's output tail comes with the listing; only app commands are read here.
  const selectedAgentShell = selected.startsWith("agent:");
  useEffect(() => {
    offsets.current = { stdout: 0, stderr: 0 };
    setOutput("");
    pinned.current = true;
    if (!selected || selectedAgentShell) return undefined;
    let live = true;
    let busy = false;
    let started = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        let added = "";
        if (!started) {
          // Where each stream ends now (an offset past the end reads nothing and reports the end).
          let skipped = false;
          for (const stream of ["stdout", "stderr"] as const) {
            const end = await paneCall("chat_process_output", { sessionId, ...(workspaceId ? { workspaceId } : {}), commandId: selected, stream, offset: Number.MAX_SAFE_INTEGER });
            if (!live) return;
            const last = Number(end.nextOffset) || 0;
            offsets.current[stream] = Math.max(0, last - TAIL_BYTES);
            skipped ||= last > TAIL_BYTES;
          }
          started = true;
          if (skipped) added += "[earlier output not shown]\n";
        }
        for (const stream of ["stdout", "stderr"] as const) {
          const result = await paneCall("chat_process_output", { sessionId, ...(workspaceId ? { workspaceId } : {}), commandId: selected, stream, offset: offsets.current[stream] });
          if (!live) return;
          offsets.current[stream] = Number(result.nextOffset) || offsets.current[stream];
          if (result.gap === true) added += "\n[earlier output was dropped]\n";
          if (typeof result.content === "string" && result.content) added += plain(result.content);
        }
        if (live && added) setOutput((current) => (current + added).slice(-MAX_OUTPUT_CHARS));
      } catch { /* the next tick tries again */ } finally { busy = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), OUTPUT_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId, selected]);
  const shown = agentShell ? plain(command?.output ?? "") : output;
  useLayoutEffect(() => {
    if (pinned.current && screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [shown]);

  const stop = () => {
    setError("");
    void paneCall("chat_process_stop", { sessionId, ...(workspaceId ? { workspaceId } : {}), commandId: selected }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const send = () => {
    if (!input && !command?.user) return;
    setError("");
    // The user's own shell runs on a terminal, where Enter is a carriage return.
    const text = `${input}${command?.user ? "\r" : "\n"}`;
    setInput("");
    void paneCall("chat_process_input", { sessionId, ...(workspaceId ? { workspaceId } : {}), commandId: selected, text }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const [starting, setStarting] = useState(false);
  const startShell = () => {
    setError("");
    setStarting(true);
    void paneCall("chat_terminal_start", { sessionId, ...(workspaceId ? { workspaceId } : {}) })
      .then((result) => { if (typeof result.commandId === "string") setSelected(result.commandId); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setStarting(false));
  };
  const shellButton = <button type="button" className="cx-terminal-new" disabled={starting} onClick={startShell}
    title="Open PowerShell in the agent's worktree">{starting ? "Starting…" : "New terminal"}</button>;

  const live = commands.filter((item) => isLive(item));
  const history = commands.filter((item) => !isLive(item));
  const agentShellLabel = <span className="cx-terminal-source" title="Run by the agent. Read-only">agent shell</span>;
  const row = (item: Command) => <li key={item.id}>
    <button type="button" aria-pressed={item.id === selected} title={[item.cmd, item.workdir].filter(Boolean).join("\n")} onClick={() => setSelected(item.id)}>
      <span className={`cx-terminal-dot is-${isLive(item) ? "running" : item.exitCode === 0 || (isAgentShell(item) && item.exitCode === null && item.status === "completed") ? "ok" : "failed"}`} aria-hidden="true" />
      <code>{item.user ? "Your terminal" : item.cmd}</code>
      {isAgentShell(item) ? agentShellLabel : null}
      <small>{isLive(item) ? `${item.status === "background" ? "background · " : ""}${since(item.startedAt, now)}` : item.exitCode !== null ? `exit ${item.exitCode}` : item.status}</small>
    </button>
  </li>;
  return <div className="cx-terminal">
    <div className="cx-terminal-bar">
      <strong>{live.length ? `Running · ${live.length}` : "Nothing running"}</strong>
      <span className="cx-head-spacer" />
      {shellButton}
    </div>
    {live.length ? <ul className="cx-terminal-list" aria-label="Running">{live.map(row)}</ul>
      : <p className="cx-terminal-idle">Dev servers and other long-running commands show here with live output. One-off commands are in the chat.
        For live output and Stop, turn on Settings → "Let chat agents run commands through the app's terminal".
        New terminal opens your own shell.</p>}
    {history.length ? <div className="cx-terminal-history">
      <button type="button" className="cx-terminal-history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)}>
        <Caret />{showHistory ? "Hide" : "Show"} finished commands ({history.length})</button>
      {showHistory ? <ul className="cx-terminal-list is-history" aria-label="Finished commands">{history.map(row)}</ul> : null}
    </div> : null}
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    {command ? <>
      <div className="cx-terminal-head">
        <span className={`cx-terminal-dot is-${running ? "running" : command.exitCode === 0 || (agentShell && command.exitCode === null && command.status === "completed") ? "ok" : "failed"}`} aria-hidden="true" />
        <div className="cx-terminal-title">
          <code title={command.cmd}>{command.user ? "Your terminal" : command.cmd}</code>
          {command.workdir ? <small title={command.workdir}>{command.workdir}</small> : null}
        </div>
        {agentShell ? agentShellLabel : null}
        <small className="cx-terminal-status" role="status">{running
          ? `${command.status === "background" ? "running in the background" : "running"} · ${since(command.startedAt, now)}`
          : command.exitCode !== null ? `exited ${command.exitCode}` : command.status}</small>
        {running && !agentShell ? <button type="button" className="cx-terminal-stop" onClick={stop}>Stop</button> : null}
      </div>
      <pre ref={screen} className="cx-terminal-output" aria-live="off"
        onScroll={(event) => { const box = event.currentTarget; pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>
        {shown || (running ? "Waiting for output…" : "No output.")}
      </pre>
      {running && !agentShell ? <form className="cx-terminal-input" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <input aria-label={command?.user ? "Type a command" : "Type into the command"} placeholder={command?.user ? "PS> type a command, Enter runs it" : "Type into the command, Enter sends"}
          value={input} spellCheck={false} onChange={(event) => setInput(event.target.value)} />
      </form> : null}
    </> : null}
  </div>;
}

type DiffFile = { path: string; added: number; removed: number; lines: { kind: "add" | "del" | "hunk" | "ctx" | "meta"; text: string; old?: number; new?: number }[] };

/** A unified diff split into files, each line with its old and new line numbers. */
function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) { file = { path: header[2], added: 0, removed: 0, lines: [] }; files.push(file); continue; }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); file.lines.push({ kind: "hunk", text: line }); continue; }
    if (/^(?:index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line)) {
      if (/^(?:new file|deleted file|rename |Binary files)/.test(line)) file.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) { file.added += 1; file.lines.push({ kind: "add", text: line.slice(1), new: newLine++ }); }
    else if (line.startsWith("-")) { file.removed += 1; file.lines.push({ kind: "del", text: line.slice(1), old: oldLine++ }); }
    else if (line.startsWith(" ")) file.lines.push({ kind: "ctx", text: line.slice(1), old: oldLine++, new: newLine++ });
  }
  return files;
}

/** The Changes tab: the agent worktree's diff, one file at a time, with every changed file listed. */
function ChangesPane({ sessionId, workspaceId }: { sessionId: string; workspaceId?: string }) {
  const [data, setData] = useState<{ branch: string; entries: { path: string; index_status: string; worktree_status: string }[]; diff: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [fresh, setFresh] = useState<{ path: string; content: string } | null>(null);
  const load = () => {
    setLoading(true);
    setError("");
    void paneCall("chat_changes", { sessionId, ...(workspaceId ? { workspaceId } : {}) })
      .then((result) => setData({ branch: String(result.branch ?? ""), entries: (result.entries as never[]) ?? [], diff: String(result.diff ?? ""), truncated: result.truncated === true }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sessionId]);
  const files = useMemo(() => parseDiff(data?.diff ?? ""), [data?.diff]);
  // New files git does not track yet have no diff; they are listed and read whole when chosen.
  const untracked = (data?.entries ?? []).filter((entry) => entry.worktree_status === "?" && !files.some((file) => file.path === entry.path));
  const listed = [...files.map((file) => ({ path: file.path, added: file.added, removed: file.removed, isNew: false })),
    ...untracked.map((entry) => ({ path: entry.path, added: 0, removed: 0, isNew: true }))]
    .filter((item) => !filter || item.path.toLowerCase().includes(filter.toLowerCase()));
  const current = files.find((file) => file.path === selected) ?? (selected ? null : files[0] ?? null);
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  useEffect(() => {
    setFresh(null);
    if (!selected || files.some((file) => file.path === selected)) return;
    void paneCall("chat_file", { sessionId, ...(workspaceId ? { workspaceId } : {}), path: selected }).then((result) => setFresh({ path: selected, content: String(result.content ?? "") })).catch(() => undefined);
  }, [selected, sessionId, files]);
  return <div className="cx-changes">
    <div className="cx-changes-bar">
      <span className="cx-changes-branch">{data?.branch || "worktree"}</span>
      <span className="cx-changes-add">+{totals.added}</span><span className="cx-changes-del">−{totals.removed}</span>
      <span className="cx-head-spacer" />
      <button type="button" className="cx-icon-button" aria-label="Refresh changes" disabled={loading} onClick={load}><Icon name="reload" width="14" height="14" /></button>
    </div>
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    {data && !listed.length && !filter ? <p className="cx-workbench-empty">No changes in the agent's worktree yet.</p> : null}
    <div className="cx-changes-body">
      <div className="cx-diff" aria-label="Diff">
        {current ? <>
          <div className="cx-diff-file"><code>{current.path}</code><span className="cx-changes-add">+{current.added}</span><span className="cx-changes-del">−{current.removed}</span></div>
          <table><tbody>{current.lines.map((line, index) => <tr key={index} className={`is-${line.kind}`}>
            <td className="cx-diff-num">{line.kind === "hunk" || line.kind === "meta" ? "" : line.old ?? ""}</td>
            <td className="cx-diff-num">{line.kind === "hunk" || line.kind === "meta" ? "" : line.new ?? ""}</td>
            <td className="cx-diff-text">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}{line.text}</td>
          </tr>)}</tbody></table>
        </> : fresh ? <>
          <div className="cx-diff-file"><code>{fresh.path}</code><span className="cx-changes-add">new file</span></div>
          <table><tbody>{fresh.content.split("\n").map((text, index) => <tr key={index} className="is-add">
            <td className="cx-diff-num" /><td className="cx-diff-num">{index + 1}</td><td className="cx-diff-text">+{text}</td></tr>)}</tbody></table>
        </> : null}
        {data?.truncated ? <p className="cx-workbench-empty">Large diff. Showing the first part.</p> : null}
      </div>
      <div className="cx-changes-files">
        <input aria-label="Filter files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <ul>{listed.map((item) => <li key={item.path}>
          <button type="button" aria-pressed={(current?.path ?? fresh?.path) === item.path} title={item.path} onClick={() => setSelected(item.path)}>
            <span>{item.path}</span>{item.isNew ? <small className="cx-changes-add">new</small>
              : <small><span className="cx-changes-add">+{item.added}</span> <span className="cx-changes-del">−{item.removed}</span></small>}
          </button></li>)}</ul>
      </div>
    </div>
  </div>;
}

type FileEntry = { name: string; path: string; type: string };

/** The Files tab: the agent worktree's tree, opened folder by folder, and the chosen file's text. */
function FilesPane({ sessionId, workspaceId }: { sessionId: string; workspaceId?: string }) {
  const [folders, setFolders] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set(["."]));
  const [file, setFile] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const load = (folder: string) => {
    if (folders[folder]) return;
    void paneCall("chat_files", { sessionId, ...(workspaceId ? { workspaceId } : {}), path: folder })
      .then((result) => setFolders((current) => ({ ...current, [folder]: ((result.entries as FileEntry[]) ?? [])
        .sort((left, right) => Number(right.type === "directory") - Number(left.type === "directory") || left.name.localeCompare(right.name)) })))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  useEffect(() => { load("."); }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (folder: string) => {
    setOpen((current) => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else { next.add(folder); load(folder); } return next; });
  };
  const view = (path: string) => {
    setError("");
    void paneCall("chat_file", { sessionId, ...(workspaceId ? { workspaceId } : {}), path })
      .then((result) => setFile({ path, content: String(result.content ?? ""), truncated: result.truncated === true }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const rows = (folder: string, depth: number): ReactElement[] => (folders[folder] ?? [])
    .filter((entry) => !filter || entry.type === "directory" || entry.name.toLowerCase().includes(filter.toLowerCase()))
    .flatMap((entry) => {
      const isDir = entry.type === "directory";
      const row = <li key={entry.path} style={{ paddingLeft: 8 + depth * 14 }}>
        <button type="button" aria-expanded={isDir ? open.has(entry.path) : undefined} aria-pressed={!isDir && file?.path === entry.path}
          onClick={() => (isDir ? toggle(entry.path) : view(entry.path))}>
          <span className="cx-files-icon" aria-hidden="true">{isDir ? (open.has(entry.path) ? "▾" : "▸") : ""}</span>{entry.name}
        </button></li>;
      return isDir && open.has(entry.path) ? [row, ...rows(entry.path, depth + 1)] : [row];
    });
  return <div className="cx-files">
    <div className="cx-files-view">
      {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
      {file ? <>
        <div className="cx-diff-file"><code>{file.path}</code>{file.truncated ? <small>first part</small> : null}</div>
        <table className="cx-files-code"><tbody>{file.content.split("\n").map((text, index) => <tr key={index}>
          <td className="cx-diff-num">{index + 1}</td><td className="cx-diff-text">{text}</td></tr>)}</tbody></table>
      </> : <p className="cx-workbench-empty">Choose a file from the agent's worktree.</p>}
    </div>
    <div className="cx-changes-files">
      <input aria-label="Filter files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <ul>{rows(".", 0)}</ul>
    </div>
  </div>;
}
