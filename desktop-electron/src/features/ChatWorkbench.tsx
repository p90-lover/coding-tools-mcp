import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
import { Icon } from "../icons";
import type { ChatAgentSession } from "./ao-chat";

// The chat's side panel, as Codex shows one beside a thread: tabs for the page the chat's agent
// opened in its own browser (a native view drawn over the pane's slot), the changes in its
// worktree, its files, and a terminal (its commands, with live output, and the user's own shell),
// plus a new-tab page with those tools and the pages this chat opened. Everything acts for the
// user: navigating, stopping a command or typing into it needs no approval, since the user does it.

export type WorkbenchTab = "preview" | "terminal" | "changes" | "files" | "new";
type PanelTab = { id: string; kind: WorkbenchTab };

type PreviewState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; errors: number };
type Command = { id: string; cmd: string; workdir: string; startedAt: number; status: string; exitCode: number | null; user?: boolean };

const TAB_TITLES: Record<WorkbenchTab, string> = { preview: "Preview", terminal: "Terminal", changes: "Changes", files: "Files", new: "New tab" };
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
 * Opens the side panel the first time a chat agent opens a page in its preview or starts a command,
 * as Codex shows the browser or terminal when its agent uses one. Each page and command opens it
 * once; closing the panel is respected until the agent does something new.
 */
export function useWorkbenchAutoOpen(sessionIds: string[], open: boolean, onOpen: (tab: WorkbenchTab) => void, workspaceId?: string) {
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  const key = sessionIds.join(",");
  useEffect(() => {
    primed.current = false;
    if (!sessionIds.length) return undefined;
    let live = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const [previews, processes] = await Promise.all([
          paneCall("chat_preview_state", { sessionIds }), paneCall("chat_processes", { sessionIds, ...(workspaceId ? { workspaceId } : {}) }),
        ]);
        if (!live) return;
        const pages = Object.entries((previews.previews as Record<string, PreviewState> | undefined) ?? {})
          .filter(([, state]) => state.url && state.url !== "about:blank").map(([id, state]) => `page:${id}:${new URL(state.url).origin}`);
        const commands = ((processes.sessions as { commands: Command[] }[] | undefined) ?? [])
          .flatMap((session) => session.commands).filter((command) => command.status === "running" && !command.user).map((command) => `cmd:${command.id}`);
        const fresh = [...pages, ...commands].filter((item) => !seen.current.has(item));
        for (const item of fresh) seen.current.add(item);
        // What was already there when the chat opened does not open the panel by itself.
        if (!primed.current) { primed.current = true; return; }
        if (!open && fresh.length) onOpen(fresh.some((item) => item.startsWith("page:")) ? "preview" : "terminal");
      } catch { /* the next tick tries again */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    return () => { live = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);
}

const PREVIEW_POLL_MS = 1500;
const COMMANDS_POLL_MS = 2000;
const OUTPUT_POLL_MS = 1000;
const MAX_OUTPUT_CHARS = 200_000;
// Terminal colours and cursor movement, OSC titles and links: the pane shows plain text.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

async function paneCall(operation: string, args: JsonObject = {}) {
  const outer = await getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation, arguments: args });
  const result = (outer.result && typeof outer.result === "object" ? outer.result : {}) as Record<string, unknown>;
  if (outer.ok === false || result.ok === false) throw new Error(String(result.error || result.reason || "That did not work"));
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
  // A kind asked for from outside (the header button, the agent opening a page) comes forward.
  useEffect(() => {
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
    if (id === active) setActive(rest[Math.max(0, index - 1)].id);
  };
  const addTab = () => { const added = newTab("new"); setTabs((list) => [...list, added]); setActive(added.id); };

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
          <button type="button" className="cx-workbench-tab-close" aria-label={`Close ${TAB_TITLES[item.kind]}`} onClick={() => close(item.id)}>×</button>
        </div>)}
        <button type="button" className="cx-icon-button cx-workbench-add" aria-label="New tab" title="New tab" onClick={addTab}>
          <Icon name="plus" width="14" height="14" /></button>
      </div>
      {sessions.length > 1 ? <select className="cx-workbench-agent" aria-label="Agent" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
      </select> : null}
      <button type="button" className="cx-icon-button" aria-label="Hide side panel" onClick={onClose}>
        <Icon name="close" width="14" height="14" /></button>
    </header>
    {!sessionId
      ? <p className="cx-workbench-empty">No agent has started in this chat yet. The pages it opens, its changes, files and commands show here.</p>
      : current?.kind === "preview" ? <PreviewPane key={sessionId} sessionId={sessionId} />
        : current?.kind === "terminal" ? <TerminalPane key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
          : current?.kind === "changes" ? <ChangesPane key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
            : current?.kind === "files" ? <FilesPane key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
              : <NewTabPage sessionId={sessionId} onTool={show} />}
  </aside>;
}

/** The new-tab page: the panel's tools and the pages this chat's agent opened. */
function NewTabPage({ sessionId, onTool }: { sessionId: string; onTool: (kind: WorkbenchTab) => void }) {
  const recents = RECENT_PAGES.get(sessionId) ?? [];
  const open = (url: string) => {
    void paneCall("chat_preview_navigate", { sessionId, url }).catch(() => undefined);
    onTool("preview");
  };
  return <div className="cx-newtab">
    <p className="cx-newtab-label">Tools</p>
    <div className="cx-newtab-tools">
      {(["preview", "changes", "terminal", "files"] as const).map((kind) => <button key={kind} type="button" onClick={() => onTool(kind)}>
        <span>{TAB_TITLES[kind]}</span><small>{kind === "preview" ? "The agent's browser" : kind === "changes" ? "Its worktree's diff" : kind === "terminal" ? "Commands and a shell" : "Browse its worktree"}</small>
      </button>)}
    </div>
    <p className="cx-newtab-label">Recents</p>
    {recents.length ? <ul className="cx-newtab-recents">{recents.map((page) => <li key={page.url}>
      <button type="button" onClick={() => open(page.url)}><span>{page.title || page.url}</span><small>{page.url}</small>
        <time>{new Date(page.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></button>
    </li>)}</ul> : <p className="cx-workbench-empty">Pages the agent opens show here.</p>}
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
        if (rect.width < 2 || rect.height < 2) return;
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
      {state?.errors ? <span className="cx-preview-errors" title="Console errors and failed requests the agent can read with preview_console">{state.errors} errors</span> : null}
    </form>
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    {state ? <div ref={slot} className="cx-preview-slot" aria-label={state.title || state.url} />
      : <p className="cx-workbench-empty">The agent has not opened a page yet. When it starts a dev server it can open it here with preview_open, or enter a localhost address above.</p>}
  </div>;
}

function TerminalPane({ sessionId, workspaceId }: { sessionId: string; workspaceId?: string }) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [selected, setSelected] = useState("");
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const offsets = useRef({ stdout: 0, stderr: 0 });
  const screen = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let live = true;
    const tick = () => void paneCall("chat_processes", { sessionIds: [sessionId], ...(workspaceId ? { workspaceId } : {}) })
      .then((result) => {
        if (!live) return;
        const found = ((result.sessions as { commands: Command[] }[] | undefined)?.[0]?.commands) ?? [];
        setCommands(found);
        setNow(Date.now());
        setSelected((current) => (found.some((command) => command.id === current) ? current
          : (found.find((command) => command.status === "running") ?? found[0])?.id ?? ""));
      })
      .catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, COMMANDS_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);

  const command = commands.find((item) => item.id === selected);
  const running = command?.status === "running";
  useEffect(() => {
    offsets.current = { stdout: 0, stderr: 0 };
    setOutput("");
    pinned.current = true;
    if (!selected) return undefined;
    let live = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        let added = "";
        for (const stream of ["stdout", "stderr"] as const) {
          const result = await paneCall("chat_process_output", { sessionId, ...(workspaceId ? { workspaceId } : {}), commandId: selected, stream, offset: offsets.current[stream] });
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
  useLayoutEffect(() => {
    if (pinned.current && screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [output]);

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
    title="A PowerShell in the agent's worktree, yours to type in">{starting ? "Starting…" : "New terminal"}</button>;

  if (!commands.length) {
    return <div className="cx-terminal">
      <div className="cx-terminal-head">{shellButton}</div>
      {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
      <p className="cx-workbench-empty">No commands yet. Dev servers and other commands the agent starts through the app's terminal show here with their output (Settings → "Let chat agents run commands through the app's terminal"). New terminal opens your own shell in the agent's worktree.</p>
    </div>;
  }
  return <div className="cx-terminal">
    <div className="cx-terminal-head">{shellButton}</div>
    <ul className="cx-terminal-list" aria-label="Commands">
      {commands.map((item) => <li key={item.id}>
        <button type="button" aria-pressed={item.id === selected} title={item.cmd} onClick={() => setSelected(item.id)}>
          <span className={`cx-terminal-dot is-${item.status === "running" ? "running" : item.exitCode === 0 ? "ok" : "failed"}`} aria-hidden="true" />
          <code>{item.user ? "Your terminal" : item.cmd}</code>
          <small>{item.status === "running" ? since(item.startedAt, now) : item.exitCode !== null ? `exit ${item.exitCode}` : item.status}</small>
        </button>
      </li>)}
    </ul>
    {command ? <div className="cx-terminal-head">
      <code title={`${command.workdir}`}>{command.cmd}</code>
      {running ? <button type="button" className="cx-terminal-stop" onClick={stop}>Stop</button> : null}
    </div> : null}
    {error ? <p className="cx-workbench-error" role="alert">{error}</p> : null}
    <pre ref={screen} className="cx-terminal-output" aria-live="off"
      onScroll={(event) => { const box = event.currentTarget; pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>
      {output || (running ? "Waiting for output…" : "No output.")}
    </pre>
    {running ? <form className="cx-terminal-input" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <input aria-label={command?.user ? "Type a command" : "Type into the command"} placeholder={command?.user ? "PS> type a command, Enter runs it" : "Type into the command, Enter sends"}
        value={input} spellCheck={false} onChange={(event) => setInput(event.target.value)} />
    </form> : null}
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
        {data?.truncated ? <p className="cx-workbench-empty">The diff is large; only its first part is shown.</p> : null}
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
