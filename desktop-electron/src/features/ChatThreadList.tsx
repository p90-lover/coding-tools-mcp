import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../icons";
import { ChatMenu, FloatingLayer, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
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
  /** A new chat in another project, its composer holding this chat's messages. */
  continueIn: (taskId: string, workspaceId: string) => void;
  /** Saves the conversation as a Markdown file. */
  share: (taskId: string) => void;
  /** A read-only live copy of the chat in its own window. */
  openWindow: (taskId: string) => void;
};

/** A Codex sidebar section: a named group of chats, kept on this computer like pins. */
type ChatSection = { id: string; name: string; taskIds: string[] };
const SECTIONS_KEY = "coding-tools:ao:chat-sections";
function readSections(): ChatSection[] {
  try {
    const value = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.taskIds)) : [];
  } catch { return []; }
}

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
  /** Chats whose rename or lifecycle action is in flight. */
  busyTaskIds: string[];
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
  const { workspaces, workspaceId, chats, archived, selectedTaskId, now, pinned, unread, actions, busyTaskIds } = props;
  const chatBusy = (taskId: string) => busyTaskIds.includes(taskId);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("coding-tools:ao:collapsed-projects") || "[]")); } catch { return new Set(); }
  });
  const [renaming, setRenaming] = useState<{ taskId: string; title: string } | null>(null);
  const [menu, setMenu] = useState<ChatMenuState>(null);
  const [hover, setHover] = useState<{ chat: ChatSummary; top: number; left: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sections, setSections] = useState<ChatSection[]>(readSections);
  /** Naming a new section (optionally filing a chat into it) or renaming an existing one. */
  const [naming, setNaming] = useState<{ sectionId?: string; taskId?: string; name: string } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const saveSections = (next: ChatSection[]) => {
    setSections(next);
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* per-session only */ }
  };
  // A chat is filed in at most one section, as in Codex; null takes it out of its section.
  const fileChat = (taskId: string, sectionId: string | null, from = sections) => saveSections(from.map((section) => ({
    ...section, taskIds: section.id === sectionId ? [taskId, ...section.taskIds.filter((id) => id !== taskId)] : section.taskIds.filter((id) => id !== taskId),
  })));
  const commitNaming = () => {
    if (!naming) return;
    const name = naming.name.trim().slice(0, 80);
    setNaming(null);
    if (!name) return;
    if (naming.sectionId) { saveSections(sections.map((section) => section.id === naming.sectionId ? { ...section, name } : section)); return; }
    const created: ChatSection = { id: crypto.randomUUID(), name, taskIds: [] };
    if (naming.taskId) fileChat(naming.taskId, created.id, [...sections, created]); else saveSections([...sections, created]);
  };
  const sectionOf = (taskId: string) => sections.find((section) => section.taskIds.includes(taskId));
  const sectionMenu = (section: ChatSection): ChatMenuItem[] => [
    { label: "Rename section", icon: "rename", run: () => setNaming({ sectionId: section.id, name: section.name }) },
    { label: "New section…", icon: "plus", run: () => setNaming({ name: "" }) },
    { kind: "separator" },
    { label: "Delete section", icon: "delete", danger: true, run: () => saveSections(sections.filter((item) => item.id !== section.id)) },
  ];
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
    const lifecycleBusy = chatBusy(chat.taskId);
    // Codex's order and glyphs. Schedule start is ours; it sits with Fork as another way to run it again.
    return [
      { label: "Rename", icon: "rename", shortcut: SHORTCUTS.rename, run: () => startRename(chat) },
      { label: isPinned ? "Unpin" : "Pin", icon: "pin", shortcut: SHORTCUTS.pin, run: () => props.togglePin(chat.taskId) },
      { label: isUnread ? "Mark as read" : "Mark as unread", icon: "unread", shortcut: SHORTCUTS.unread, run: () => props.setUnread(chat.taskId, !isUnread) },
      { kind: "separator" },
      // A chat's runs stay in its own project; another project gets a new chat carrying its messages.
      workspaces.length > 1
        ? { label: "Project", icon: "project", items: workspaces.map((item): ChatMenuItem => item.id === workspaceId
          ? { label: item.name, checked: true, reason: "This chat's project" }
          : { label: `Continue in ${item.name}`, run: () => actions.continueIn(chat.taskId, item.id) }) }
        : { label: "Project", icon: "project", reason: "Add another project to continue this chat there" },
      { label: "Section", icon: "section", items: [
        ...sections.map((section): ChatMenuItem => ({ label: section.name, checked: section.taskIds.includes(chat.taskId),
          run: () => fileChat(chat.taskId, section.taskIds.includes(chat.taskId) ? null : section.id) })),
        ...(sections.length ? [{ kind: "separator" } as const] : []),
        { label: "New section…", icon: "plus", run: () => setNaming({ taskId: chat.taskId, name: "" }) },
        ...(sectionOf(chat.taskId) ? [{ label: "Remove from section", run: () => fileChat(chat.taskId, null) }] : []),
      ] },
      { kind: "separator" },
      { label: "Fork", icon: "fork", items: [
        { label: "From the whole conversation", run: () => actions.fork(chat.taskId, "start") },
        { label: "From the first message", run: () => actions.fork(chat.taskId, "first") },
      ] },
      scheduled
        ? { label: "Cancel scheduled start", icon: "schedule", run: () => actions.lifecycle(chat.taskId, "cancel_schedule") }
        : running ? { label: "Schedule start…", icon: "schedule", reason: "Stop this mission before scheduling a start" }
          : { label: "Schedule start…", icon: "schedule", run: () => actions.lifecycle(chat.taskId, "schedule") },
      { kind: "separator" },
      { label: "Share", icon: "share", run: () => actions.share(chat.taskId) },
      { label: "Copy", icon: "copy", items: [
        { label: "Title", run: () => actions.copy(chat.taskId, "title") },
        { label: "Conversation as Markdown", run: () => actions.copy(chat.taskId, "conversation") },
        { label: "Last answer", run: () => actions.copy(chat.taskId, "answer") },
        { label: "Chat ID", run: () => actions.copy(chat.taskId, "id") },
      ] },
      { kind: "separator" },
      { label: "Open in new window", icon: "window", run: () => actions.openWindow(chat.taskId) },
      { label: "Open in", icon: "openIn", items: [
        { label: "Structure", run: () => actions.openStructure(chat.taskId) },
        { label: "Mission Board", run: () => actions.openBoard() },
      ] },
      { kind: "separator" },
      // Archive and delete stop the chat's own running work after a confirmation; both can be restored.
      lifecycleBusy ? { label: "Archive", icon: "archive", shortcut: SHORTCUTS.archive, reason: "This chat is being updated" }
        : { label: "Archive", icon: "archive", shortcut: SHORTCUTS.archive, run: () => actions.lifecycle(chat.taskId, "archive") },
      lifecycleBusy ? { label: "Delete", icon: "delete", danger: true, reason: "This chat is being updated" }
        : { label: "Delete", icon: "delete", danger: true, run: () => actions.lifecycle(chat.taskId, "delete") },
    ];
  };
  const projectMenu = (item: ThreadWorkspace): ChatMenuItem[] => {
    const current = item.id === workspaceId;
    return [
      { label: props.pinnedProjects.includes(item.id) ? "Unpin" : "Pin", icon: "pin", run: () => props.toggleProjectPin(item.id) },
      { label: "Edit", icon: "edit", reason: "Rename and configure projects on the Workspace page" },
      { label: "New section…", icon: "section", run: () => setNaming({ name: "" }) },
      item.path && actions.openFolder
        ? { label: "Open in Explorer", icon: "folder", run: () => actions.openFolder!(item) }
        : { label: "Open in Explorer", icon: "folder", reason: "This project's folder isn't known" },
      current && chats.length
        ? { label: "Archive chats", icon: "archive", run: () => actions.archiveAll() }
        : { label: "Archive chats", icon: "archive", reason: current ? "This project has no chats" : "Open this project first" },
      { kind: "separator" },
      { label: "Remove project", icon: "delete", danger: true, reason: "Remove projects on the Workspace page" },
    ];
  };
  const openMenu = (event: ReactMouseEvent, items: ChatMenuItem[], label: string) => {
    event.preventDefault();
    // A pending hover card must not appear over the menu.
    window.clearTimeout(hoverTimer.current);
    setHover(null);
    setMenu({ x: event.clientX, y: event.clientY, items, label });
  };

  // Codex's shortcuts act on the open chat.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const chat = chats.find((entry) => entry.taskId === selectedTaskId);
      const target = event.target as HTMLElement | null;
      if (!chat || target?.isContentEditable || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !event.altKey)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.altKey && key === "r") { event.preventDefault(); startRename(chat); }
      else if (event.ctrlKey && event.altKey && key === "p") { event.preventDefault(); props.togglePin(chat.taskId); }
      else if (event.ctrlKey && event.shiftKey && key === "u") { event.preventDefault(); props.setUnread(chat.taskId, !unread.includes(chat.taskId)); }
      else if (event.ctrlKey && event.shiftKey && key === "a" && !chatBusy(chat.taskId)) { event.preventDefault(); actions.lifecycle(chat.taskId, "archive"); }
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
          disabled={chatBusy(chat.taskId)} onClick={() => actions.lifecycle(chat.taskId, "archive")}>🗄</button>
      </span>
    </li>;
  };

  const pinnedChats = chats.filter((chat) => pinned.includes(chat.taskId));
  const nameInput = (label: string) => <input className="cx-section-input" autoFocus aria-label={label} placeholder={label} maxLength={80}
    value={naming?.name ?? ""} onChange={(event) => setNaming((current) => current && { ...current, name: event.target.value })}
    onKeyDown={(event) => { if (event.key === "Enter") commitNaming(); if (event.key === "Escape") setNaming(null); }}
    onBlur={commitNaming} />;
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
        {sections.map((section) => {
          const key = `section:${section.id}`;
          const open = !collapsed.has(key);
          const members = chats.filter((chat) => section.taskIds.includes(chat.taskId) && !pinned.includes(chat.taskId));
          return <section key={section.id} className="cx-thread-group">
            {naming?.sectionId === section.id ? nameInput("Section name")
              : <button type="button" className="cx-project cx-section-head" aria-expanded={open}
                onClick={() => { const next = new Set(collapsed); if (open) next.add(key); else next.delete(key); saveCollapsed(next); }}
                onContextMenu={(event) => openMenu(event, sectionMenu(section), section.name)}>
                <Icon name="chevron" width="12" height="12" className={open ? "is-open" : undefined} />
                <span className="cx-thread-title">{section.name}</span>
              </button>}
            {open ? <ul>{members.map(row)}{!members.length ? <li className="cx-thread-empty">No chats from this project here</li> : null}</ul> : null}
          </section>;
        })}
        {naming && !naming.sectionId ? <section className="cx-thread-group">{nameInput("New section name")}</section> : null}
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
                  {chats.filter((chat) => !pinned.includes(chat.taskId) && !sectionOf(chat.taskId)).map(row)}
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
            <button type="button" className="cx-restore" disabled={chatBusy(chat.taskId)} onClick={() => actions.lifecycle(chat.taskId, "restore")}>Restore</button>
          </li>)}</ul> : null}
        </section> : null}
      </nav>
      {hover && !menu ? <FloatingLayer className="cx-hover-card" role="tooltip" style={{ top: hover.top, left: hover.left }}>
        <strong>{hover.chat.title}</strong>
        <span>{STATUS_LABEL[hover.chat.status]}{hover.chat.updatedAtMs ? ` · updated ${chatRelativeTime(hover.chat.updatedAtMs, now)} ago`.replace("now ago", "just now") : ""}</span>
        {hover.chat.schedule?.state === "scheduled" ? <span>◷ {scheduledStartLabel(hover.chat.schedule.due_at_ms, now)}</span> : null}
        <span>📁 {workspace?.name}</span>
        {workspace?.path ? <span className="cx-hover-path">{workspace.path}</span> : null}
        <span>{hover.chat.runIds.length} {hover.chat.runIds.length === 1 ? "run" : "runs"}</span>
      </FloatingLayer> : null}
      <ChatMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}
