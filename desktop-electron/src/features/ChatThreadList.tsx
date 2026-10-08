import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../icons";
import { ChatMenu, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
import { chatRelativeTime, scheduledStartLabel, type ChatStatus, type ChatSummary } from "./ao-chat";

const STATUS_LABEL: Record<ChatStatus, string> = {
  queued: "Starting", scheduled: "Scheduled", running: "Running", paused: "Paused", attention: "Needs you", stopped: "Stopped", done: "Done",
};

export type ThreadWorkspace = { id: string; name: string; path?: string };

/** Everything a thread list action does; each one is a real operation of the surface. */
export type ThreadActions = {
  select: (taskId: string) => void;
  newChat: () => void;
  rename: (taskId: string, title: string) => Promise<void>;
  /** The task lifecycle: a one-time delayed start, archive, recoverable delete and restore. */
  lifecycle: (taskId: string, action: "schedule" | "cancel_schedule" | "archive" | "delete" | "restore") => void;
  archiveAll: () => void;
  fork: (taskId: string, from: "start" | "first") => void;
  copy: (taskId: string, what: "title" | "conversation" | "answer" | "id") => void;
  openStructure: (taskId: string) => void;
  openBoard: () => void;
  openFolder?: (workspace: ThreadWorkspace) => void;
};

export type ThreadListProps = {
  workspaces: ThreadWorkspace[];
  workspaceId: string;
  onWorkspace: (workspaceId: string) => void;
  chats: ChatSummary[];
  archived: ChatSummary[];
  selectedTaskId: string;
  now: number;
  pinned: string[];
  togglePin: (taskId: string) => void;
  unread: string[];
  setUnread: (taskId: string, unread: boolean) => void;
  pinnedProjects: string[];
  toggleProjectPin: (workspaceId: string) => void;
  busy: boolean;
  /** The chat whose lifecycle action is in flight. */
  busyTaskId?: string;
  /** A new chat being created, shown at once at the top of its project. */
  pendingTitle?: string;
  actions: ThreadActions;
};

const SHORTCUTS = { rename: "Alt+Ctrl+R", pin: "Alt+Ctrl+P", unread: "Ctrl+Shift+U", archive: "Ctrl+Shift+A" };

/**
 * Codex's sidebar: New chat, Pinned, then projects that collapse on click, each with its chats.
 * Only the open project's chats are loaded, so opening another project switches to it.
 */
export function ChatThreadList(props: ThreadListProps) {
  const { workspaces, workspaceId, chats, archived, selectedTaskId, now, pinned, unread, actions, busy, busyTaskId } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("coding-tools:ao:collapsed-projects") || "[]")); } catch { return new Set(); }
  });
  const [renaming, setRenaming] = useState<{ taskId: string; title: string } | null>(null);
  const [menu, setMenu] = useState<ChatMenuState>(null);
  const [hover, setHover] = useState<{ chat: ChatSummary; top: number; left: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const workspace = workspaces.find((item) => item.id === workspaceId);

  const saveCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    try { localStorage.setItem("coding-tools:ao:collapsed-projects", JSON.stringify([...next])); } catch { /* per-session only */ }
  };
  const clickProject = (id: string) => {
    if (id !== workspaceId) {
      const next = new Set(collapsed); next.delete(id); saveCollapsed(next);
      props.onWorkspace(id);
      return;
    }
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveCollapsed(next);
  };
  const startRename = (chat: ChatSummary) => setRenaming({ taskId: chat.taskId, title: chat.title });
  const commitRename = async () => {
    if (!renaming) return;
    const current = chats.find((chat) => chat.taskId === renaming.taskId)?.title;
    const title = renaming.title.trim();
    setRenaming(null);
    if (title && title !== current) await actions.rename(renaming.taskId, title).catch(() => {});
  };

  const chatMenu = (chat: ChatSummary): ChatMenuItem[] => {
    const isPinned = pinned.includes(chat.taskId);
    const isUnread = unread.includes(chat.taskId);
    const running = chat.status === "running";
    const scheduled = chat.schedule?.state === "scheduled";
    const lifecycleBusy = busyTaskId === chat.taskId;
    return [
      { label: "Rename", shortcut: SHORTCUTS.rename, run: () => startRename(chat) },
      { label: isPinned ? "Unpin" : "Pin", shortcut: SHORTCUTS.pin, run: () => props.togglePin(chat.taskId) },
      { label: isUnread ? "Mark as read" : "Mark as unread", shortcut: SHORTCUTS.unread, run: () => props.setUnread(chat.taskId, !isUnread) },
      { kind: "separator" },
      { label: "Project", reason: "A chat's runs belong to its project's workspace, so chats can't move between projects" },
      { label: "Section", reason: "Sections aren't available yet; pin a chat to keep it on top" },
      { label: "Fork", items: [
        { label: "From the whole conversation", run: () => actions.fork(chat.taskId, "start") },
        { label: "From the first message", run: () => actions.fork(chat.taskId, "first") },
      ] },
      scheduled
        ? { label: "Cancel scheduled start", run: () => actions.lifecycle(chat.taskId, "cancel_schedule") }
        : running ? { label: "Schedule start…", reason: "Stop this mission before scheduling a start" }
          : { label: "Schedule start…", run: () => actions.lifecycle(chat.taskId, "schedule") },
      { label: "Share", reason: "Chats stay on this computer; sharing isn't available" },
      { label: "Copy", items: [
        { label: "Title", run: () => actions.copy(chat.taskId, "title") },
        { label: "Conversation as Markdown", run: () => actions.copy(chat.taskId, "conversation") },
        { label: "Last answer", run: () => actions.copy(chat.taskId, "answer") },
        { label: "Chat ID", run: () => actions.copy(chat.taskId, "id") },
      ] },
      { kind: "separator" },
      { label: "Open in new window", reason: "Coding Tools shows chats in its main window only" },
      { label: "Open in", items: [
        { label: "Structure", run: () => actions.openStructure(chat.taskId) },
        { label: "Mission Board", run: () => actions.openBoard() },
      ] },
      { kind: "separator" },
      // Archive and delete stop the chat's own running work after a confirmation; both can be restored.
      lifecycleBusy ? { label: "Archive", shortcut: SHORTCUTS.archive, reason: "This chat is being updated" }
        : { label: "Archive", shortcut: SHORTCUTS.archive, run: () => actions.lifecycle(chat.taskId, "archive") },
      lifecycleBusy ? { label: "Delete (recoverable)", danger: true, reason: "This chat is being updated" }
        : { label: "Delete (recoverable)", danger: true, run: () => actions.lifecycle(chat.taskId, "delete") },
    ];
  };
  const projectMenu = (item: ThreadWorkspace): ChatMenuItem[] => {
    const current = item.id === workspaceId;
    return [
      { label: props.pinnedProjects.includes(item.id) ? "Unpin" : "Pin", run: () => props.toggleProjectPin(item.id) },
      { label: "Edit", reason: "Rename and configure projects on the Workspace page" },
      { label: "Section", reason: "Sections aren't available yet; pin a project to keep it on top" },
      item.path && actions.openFolder
        ? { label: "Open in Explorer", run: () => actions.openFolder!(item) }
        : { label: "Open in Explorer", reason: "This project's folder isn't known" },
      current && chats.length
        ? { label: "Archive chats", run: () => actions.archiveAll() }
        : { label: "Archive chats", reason: current ? "This project has no chats" : "Open this project first" },
      { kind: "separator" },
      { label: "Remove project", danger: true, reason: "Remove projects on the Workspace page" },
    ];
  };
  const openMenu = (event: ReactMouseEvent, items: ChatMenuItem[], label: string) => {
    event.preventDefault();
    setHover(null);
    setMenu({ x: event.clientX, y: event.clientY, items, label });
  };

  // Codex's shortcuts act on the open chat.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const chat = chats.find((entry) => entry.taskId === selectedTaskId);
      const target = event.target as HTMLElement | null;
      if (!chat || busy || target?.isContentEditable || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !event.altKey)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.altKey && key === "r") { event.preventDefault(); startRename(chat); }
      else if (event.ctrlKey && event.altKey && key === "p") { event.preventDefault(); props.togglePin(chat.taskId); }
      else if (event.ctrlKey && event.shiftKey && key === "u") { event.preventDefault(); props.setUnread(chat.taskId, !unread.includes(chat.taskId)); }
      else if (event.ctrlKey && event.shiftKey && key === "a" && busyTaskId !== chat.taskId) { event.preventDefault(); actions.lifecycle(chat.taskId, "archive"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const row = (chat: ChatSummary) => {
    const isPinned = pinned.includes(chat.taskId);
    const isUnread = unread.includes(chat.taskId) && chat.taskId !== selectedTaskId;
    if (renaming?.taskId === chat.taskId) {
      return <li key={chat.taskId} className="cx-thread-row is-renaming">
        <input autoFocus aria-label="Chat name" maxLength={240} value={renaming.title}
          onChange={(event) => setRenaming({ ...renaming, title: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") setRenaming(null); }}
          onBlur={() => void commitRename()} />
      </li>;
    }
    return <li key={chat.taskId} className={`cx-thread-row${isUnread ? " is-unread" : ""}`}
      onContextMenu={(event) => openMenu(event, chatMenu(chat), chat.title)}
      onMouseEnter={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(() => setHover({ chat, top: box.top, left: box.right + 8 }), 600);
      }}
      onMouseLeave={() => { window.clearTimeout(hoverTimer.current); setHover(null); }}>
      <button type="button" className="cx-thread-select" aria-current={chat.taskId === selectedTaskId} onClick={() => actions.select(chat.taskId)}>
        <span className={`cx-thread-dot status-${chat.status}`} aria-label={STATUS_LABEL[chat.status]} />
        <span className="cx-thread-title">{chat.title}</span>
        <span className="cx-thread-age">{chat.schedule?.state === "scheduled" ? "◷" : chatRelativeTime(chat.updatedAtMs, now)}</span>
      </button>
      <span className="cx-thread-hover">
        <button type="button" aria-label={isPinned ? "Unpin chat" : "Pin chat"} title={isPinned ? "Unpin chat" : "Pin chat"} aria-pressed={isPinned}
          onClick={() => props.togglePin(chat.taskId)}>📌</button>
        <button type="button" aria-label="Archive chat" title="Archive chat"
          disabled={busy || busyTaskId === chat.taskId} onClick={() => actions.lifecycle(chat.taskId, "archive")}>🗄</button>
      </span>
    </li>;
  };

  const pinnedChats = chats.filter((chat) => pinned.includes(chat.taskId));
  const projectOrder = [...workspaces].sort((a, b) => Number(props.pinnedProjects.includes(b.id)) - Number(props.pinnedProjects.includes(a.id)));
  return (
    <aside className="cx-threads" aria-label="Projects and chats">
      <button type="button" className="cx-new-chat" aria-pressed={!selectedTaskId} onClick={actions.newChat}>
        <Icon name="plus" width="15" height="15" />New chat
      </button>
      <nav className="cx-thread-scroll">
        {pinnedChats.length ? <section className="cx-thread-group">
          <h3>Pinned</h3>
          <ul>{pinnedChats.map(row)}</ul>
        </section> : null}
        <section className="cx-thread-group">
          <h3>Projects</h3>
          <ul className="cx-projects">
            {projectOrder.map((item) => {
              const open = item.id === workspaceId && !collapsed.has(item.id);
              return <li key={item.id}>
                <button type="button" className="cx-project" aria-expanded={open} title={item.path || item.name}
                  onClick={() => clickProject(item.id)} onContextMenu={(event) => openMenu(event, projectMenu(item), item.name)}>
                  <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} />
                  <span className="cx-thread-title">{item.name}</span>
                  {props.pinnedProjects.includes(item.id) ? <span className="cx-project-pin" aria-label="Pinned project">📌</span> : null}
                </button>
                {open ? <ul>
                  {props.pendingTitle ? <li className="cx-thread-row is-pending"><span className="cx-thread-select" aria-current="true">
                    <span className="cx-thread-dot status-queued" aria-label="Starting" /><span className="cx-thread-title">{props.pendingTitle}</span>
                  </span></li> : null}
                  {chats.filter((chat) => !pinned.includes(chat.taskId)).map(row)}
                  {!chats.length ? <li className="cx-thread-empty">No chats yet</li> : null}
                </ul> : null}
              </li>;
            })}
          </ul>
        </section>
        {archived.length ? <section className="cx-thread-group">
          <button type="button" className="cx-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
            Archived ({archived.length})
          </button>
          {showArchived ? <ul>{archived.map((chat) => <li key={chat.taskId} className="cx-thread-row is-archived">
            <span className="cx-thread-title" title={chat.title}>{chat.title}</span>
            {chat.visibility === "deleted" ? <span className="cx-thread-badge">Deleted</span> : null}
            <button type="button" className="cx-restore" disabled={busy || busyTaskId === chat.taskId} onClick={() => actions.lifecycle(chat.taskId, "restore")}>Restore</button>
          </li>)}</ul> : null}
        </section> : null}
      </nav>
      {hover ? <div className="cx-hover-card" role="tooltip" style={{ top: hover.top, left: hover.left }}>
        <strong>{hover.chat.title}</strong>
        <span>{STATUS_LABEL[hover.chat.status]}{hover.chat.updatedAtMs ? ` · updated ${chatRelativeTime(hover.chat.updatedAtMs, now)} ago`.replace("now ago", "just now") : ""}</span>
        {hover.chat.schedule?.state === "scheduled" ? <span>◷ {scheduledStartLabel(hover.chat.schedule.due_at_ms, now)}</span> : null}
        <span>📁 {workspace?.name}</span>
        {workspace?.path ? <span className="cx-hover-path">{workspace.path}</span> : null}
        <span>{hover.chat.runIds.length} {hover.chat.runIds.length === 1 ? "run" : "runs"}</span>
      </div> : null}
      <ChatMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}
