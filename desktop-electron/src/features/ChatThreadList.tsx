import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../icons";
import { ChatGlyph, ChatMenu, FloatingLayer, type ChatMenuItem, type ChatMenuState } from "./ChatMenu";
import { chatRelativeTime, scheduledStartLabel, type ChatStatus, type ChatSummary } from "./ao-chat";
import { SPLIT_DRAG_TYPE } from "./chat-split";

const STATUS_LABEL: Record<ChatStatus, string> = {
  queued: "Starting", scheduled: "Scheduled", running: "Running", paused: "Paused", attention: "Needs you", stopped: "Stopped", done: "Done",
};

export type ThreadWorkspace = { id: string; name: string; path?: string };

/** A project folder in git (main process readGitInfo): a repository, a worktree of one, a folder inside one, not git, or gone. */
export type ThreadProjectGit = { kind: "repo" | "worktree" | "inside" | "none" | "missing"; root: string | null; mainRepo: string | null; branch: string | null };

/**
 * A project's git label, as Claude Code tells a repository from its worktrees: a short tag for its
 * row (none for a repository's root, the usual case) and a line for its card. Agent chats work in
 * a worktree of the project's repository, so a folder that is not a repository's root is flagged.
 */
export function projectGitLabel(git: ThreadProjectGit | null | undefined): { tag: string | null; line: string; warn: boolean } | null {
  if (!git) return null;
  const on = git.branch ? ` · ${git.branch}` : "";
  switch (git.kind) {
    case "repo": return { tag: null, line: `Git repository${on}`, warn: false };
    case "worktree": return { tag: "worktree", line: `Worktree of ${git.mainRepo ?? "another repository"}${on}`, warn: false };
    case "inside": return { tag: "subfolder", line: `A folder inside the repository ${git.root ?? ""}${on}. Agent chats need the repository's root folder.`, warn: true };
    case "none": return { tag: "not git", line: "Not a git repository. Agent chats need a repository's root folder.", warn: true };
    case "missing": return { tag: "missing", line: "This folder no longer exists.", warn: true };
    default: return null;
  }
}

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
  /** Opens Settings (the sidebar footer's gear row). */
  openSettings?: () => void;
  openFolder?: (workspace: ThreadWorkspace) => void;
  /** A new chat in that project (the project row's pencil, as in Codex). */
  newChatIn: (workspaceId: string) => void;
  /** Opens the Edit project dialog (name and source folders). */
  editProject: (workspaceId: string) => void;
  /** Asks to remove the project from this app's list; its files are never deleted. */
  removeProject?: (workspaceId: string) => void;
  /** A new chat in another project, its composer holding this chat's messages. */
  continueIn: (taskId: string, workspaceId: string) => void;
  /** Saves the conversation as a Markdown file. */
  share: (taskId: string) => void;
  /** A read-only live copy of the chat in its own window. */
  openWindow: (taskId: string) => void;
  /** Opens the chat in a split view pane beside the open one (Claude Code's "Open in ▸ Split view"). */
  openSplit?: (workspaceId: string, taskId: string) => void;
  /** Opens a chat of another project the list shows open: switches to that project, then the chat. */
  selectIn?: (workspaceId: string, taskId: string) => void;
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
  /** Chats open in the window or one of its split view panes: "Split view" is not offered for them. */
  openTaskIds?: string[];
  /** A new chat being created, shown at once at the top of its project. */
  pendingTitle?: string;
  actions: ThreadActions;
  /** A project folder's git remote as "owner/repo" (for the project card), when the app can tell. */
  projectRemote?: (folder: string) => Promise<string | null>;
  /** What each project folder is in git, for its row's label (read when the list shows it). */
  projectGit?: (folder: string) => Promise<ThreadProjectGit | null>;
  /**
   * Archived and deleted chats of every project, the days an archived chat stays (0: for good), and
   * the days without activity before an open chat is archived (idleDays, 0: never).
   */
  archivedAll?: { days: number; idleDays?: number; chats: ArchivedChat[] };
  restoreArchived?: (workspaceId: string, taskId: string) => void;
  setArchiveDays?: (change: { days?: number; idleDays?: number }) => void;
  /** Another project's chats, for a project opened in the list without switching to it (Codex). */
  loadProjectChats?: (workspaceId: string) => Promise<ChatSummary[]>;
  /** The open project's chats are still being read (just switched to it): `chats` is not yet its list. */
  chatsLoading?: boolean;
};

/** An archived chat of any project; `archivedAt` (ms) is when its days started counting. */
export type ArchivedChat = { workspaceId: string; taskId: string; title: string; visibility: "archived" | "deleted"; archivedAt?: number };
const DAY_MS = 86_400_000;

/**
 * The Archived section's groups: a folder per project in the list's own order, then "Chats" for
 * chats with no project folder (a project without a folder, or one no longer in the list).
 */
export function archivedGroups(chats: ArchivedChat[], workspaces: ThreadWorkspace[]): { key: string; name: string; project: boolean; chats: ArchivedChat[] }[] {
  const groups = new Map<string, { key: string; name: string; project: boolean; chats: ArchivedChat[] }>();
  for (const item of workspaces) if (item.path) groups.set(item.id, { key: item.id, name: item.name, project: true, chats: [] });
  const loose = { key: "chats", name: "Chats", project: false, chats: [] as ArchivedChat[] };
  for (const chat of chats) (groups.get(chat.workspaceId) ?? loose).chats.push(chat);
  return [...groups.values(), loose].filter((group) => group.chats.length);
}

const SHORTCUTS = { rename: "Alt+Ctrl+R", pin: "Alt+Ctrl+P", unread: "Ctrl+Shift+U", archive: "Ctrl+Shift+A" };

/** Chats that are doing something or waiting on you (a project card's "N active"). */
const ACTIVE: ReadonlySet<ChatStatus> = new Set(["running", "queued", "attention"]);
/** Chats that are working right now; they stay on top while that setting is on. */
const WORKING: ReadonlySet<ChatStatus> = new Set(["running", "queued"]);

/**
 * The list's order: working chats and chats waiting on you first (when keepActiveOnTop), unless you
 * moved them yourself; then chats you haven't placed yet, newest first, so a new chat appears at the
 * top as in Codex; then the order you dragged chats into. Each group keeps that order.
 *
 * Such a chat was always kept on top, so it could never be dragged anywhere else: it jumped back at
 * once (a running chat as well as one waiting on you, which can sit for days). One you moved
 * (`placed`: dragged, or moved with Alt+Shift+↑/↓) stays where you put it; its next run releases it
 * (releaseUsedChats). A drag saves the whole list's order, so a position alone does not mean the
 * chat was moved: the other running chats stay on top.
 */
export function orderChats<T extends { taskId: string; status: ChatStatus }>(chats: T[], manual: string[], keepActiveOnTop: boolean, placed: readonly string[] = []): T[] {
  const position = new Map(manual.map((id, index) => [id, index]));
  const moved = new Set(placed);
  const recent = new Map(chats.map((chat, index) => [chat.taskId, index]));
  const rank = (chat: T) => position.get(chat.taskId) ?? (recent.get(chat.taskId) ?? 0) - chats.length;
  const onTop = (chat: T) => (WORKING.has(chat.status) || chat.status === "attention") && !moved.has(chat.taskId);
  return [...chats].sort((a, b) =>
    (keepActiveOnTop ? Number(onTop(b)) - Number(onTop(a)) : 0) || rank(a) - rank(b));
}

/**
 * The Projects list's order: pinned projects first, then the order you dragged projects into, then
 * the list's own order for projects you have not placed. A project no longer moves by itself: it
 * jumped to the top whenever one of its chats got a message (the user: "it shouldnt be change if
 * not me moving it").
 */
export function orderProjects<T extends { id: string }>(items: T[], pinned: string[], manual: string[]): T[] {
  const index = new Map(items.map((item, at) => [item.id, at]));
  const placed = (id: string) => { const at = manual.indexOf(id); return at < 0 ? manual.length + (index.get(id) ?? 0) : at; };
  return [...items].sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) || placed(a.id) - placed(b.id));
}

/**
 * The kept project order with every project not placed yet (new, or still loading when the order
 * was first kept) added at the end, where it then stays: left to the list's own order it could
 * still move. The same array when nothing is new.
 */
export function placeNewProjects(saved: string[], ids: string[]): string[] {
  const unplaced = ids.filter((id) => !saved.includes(id));
  return unplaced.length ? [...saved, ...unplaced] : saved;
}

/** The order a project list had when projects still rose with use: kept once as where they stand. */
export function projectsByLastUse<T extends { id: string }>(items: T[], usedAt: Record<string, number>): string[] {
  const index = new Map(items.map((item, at) => [item.id, at]));
  return [...items].sort((a, b) => (usedAt[b.id] ?? 0) - (usedAt[a.id] ?? 0) || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
    .map((item) => item.id);
}

/**
 * Chats that started a new run since the list last saw them (you sent them a message) leave the
 * order you dragged chats into, so they rise with the newest chats as in Codex instead of staying
 * where you once placed them. Returns the manual order without them, and whether any moved.
 */
export function releaseUsedChats(manual: string[], seenRuns: Record<string, string>, chats: { taskId: string; latestRunId: string }[]): { order: string[]; used: string[] } {
  const used = chats.filter((chat) => seenRuns[chat.taskId] !== undefined && seenRuns[chat.taskId] !== chat.latestRunId).map((chat) => chat.taskId);
  return { order: used.length ? manual.filter((id) => !used.includes(id)) : manual, used };
}

// Where projects stood by last use, from before projects kept their place; read once to keep it.
const PROJECT_USED_KEY = "coding-tools:ao:project-used";
const PROJECT_ORDER_KEY = "coding-tools:ao:project-order";
const OPEN_PROJECTS_KEY = "coding-tools:ao:open-projects";
function readStored<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try { const value = JSON.parse(localStorage.getItem(key) || "null"); return valid(value) ? value : fallback; } catch { return fallback; }
}
const isTimes = (value: unknown): value is Record<string, number> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.values(value as object).every((entry) => typeof entry === "number");
const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Moves `id` to just before `before` (or to the end), in the order the list currently shows. */
export function moveChat(shown: string[], id: string, before: string | null): string[] {
  const rest = shown.filter((item) => item !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  return at < 0 ? shown : [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * A drop of `dragged` on the row `target`: before it on the row's upper half, after it on the lower
 * half, so the last place can be reached (a drop only ever went before the row under the pointer).
 */
export function dropChat(shown: string[], dragged: string, target: string, after: boolean): string[] {
  const rest = shown.filter((item) => item !== dragged);
  const at = rest.indexOf(target);
  return at < 0 ? shown : moveChat(shown, dragged, after ? rest[at + 1] ?? null : target);
}

/**
 * A list in the order you dragged it into, for lists without active chats to keep on top (Pinned,
 * Archived): items you haven't placed first, in the order given (newest first), then your order.
 */
export function inManualOrder<T>(items: T[], manual: string[], id: (item: T) => string): T[] {
  const position = new Map(manual.map((key, index) => [key, index]));
  const given = new Map(items.map((item, index) => [id(item), index]));
  const rank = (item: T) => position.get(id(item)) ?? (given.get(id(item)) ?? 0) - items.length;
  return [...items].sort((a, b) => rank(a) - rank(b));
}

type ListSettings = { visible: number; keepActiveOnTop: boolean };
const SETTINGS_KEY = "coding-tools:ao:chat-list-settings";
function readListSettings(): ListSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const visible = Number.isInteger(value.visible) && value.visible >= 1 && value.visible <= 100 ? value.visible : 5;
    return { visible, keepActiveOnTop: value.keepActiveOnTop !== false };
  } catch { return { visible: 5, keepActiveOnTop: true }; }
}
const orderKey = (workspaceId: string) => `coding-tools:ao:chat-order:${workspaceId}`;
// Pinned and each Archived group keep their own order (a project's chats use orderKey).
const listOrderKey = (list: string) => `coding-tools:ao:list-order:${list}`;
function readIdsAt(key: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value.filter((id) => typeof id === "string") : []; }
  catch { return []; }
}
const readOrder = (workspaceId: string) => readIdsAt(orderKey(workspaceId));
// The chats of a project you moved yourself (orderChats' `placed`).
const placedKey = (workspaceId: string) => `coding-tools:ao:chat-placed:${workspaceId}`;
const readPlaced = (workspaceId: string) => readIdsAt(placedKey(workspaceId));
function writePlaced(workspaceId: string, ids: string[]) {
  try { localStorage.setItem(placedKey(workspaceId), JSON.stringify(ids)); } catch { /* per-session only */ }
}

/**
 * A list a row can be dragged within: its key, the ids in the order shown, and how to keep a new
 * order (`moved` is the chat that was dragged).
 */
type DragList = { list: string; order: string[]; save: (next: string[], moved: string) => void };

/**
 * Codex's sidebar: New chat, Pinned, then projects that collapse on click, each with its chats.
 * Only the open project's chats are loaded, so opening another project switches to it.
 */
export function ChatThreadList(props: ThreadListProps) {
  const { workspaces, workspaceId, chats, archived, selectedTaskId, now, pinned, unread, actions, busyTaskIds } = props;
  const openTaskIds = new Set(props.openTaskIds ?? [selectedTaskId]);
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
  const [settings, setSettings] = useState<ListSettings>(readListSettings);
  const [settingsAt, setSettingsAt] = useState<{ top: number; left: number } | null>(null);
  const [manualOrder, setManualOrder] = useState<string[]>(() => readOrder(workspaceId));
  const [orderFor, setOrderFor] = useState(workspaceId);
  if (orderFor !== workspaceId) { setOrderFor(workspaceId); setManualOrder(readOrder(workspaceId)); }
  /** Projects showing all their chats ("Show more"); the rest show the first `visible`. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The chat being dragged and the list it is dragged within; where it would land, for the drop line. */
  const [dragging, setDragging] = useState<{ list: string; id: string; drag: DragList; listEl: HTMLElement | null } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  // Another list's order was saved (Pinned, an Archived group, another open project): render again.
  const [, setOrderTick] = useState(0);
  const saveListOrder = (key: string, next: string[]) => {
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* per-session only */ }
    setOrderTick((tick) => tick + 1);
  };
  // Codex's project card: shown after a short hover beside the row, kept open while the pointer is
  // on the row or the card (it has a pin toggle and Edit project), closed shortly after leaving.
  const [projectCard, setProjectCard] = useState<{ item: ThreadWorkspace; top: number; left: number } | null>(null);
  const [remotes, setRemotes] = useState<Record<string, string | null>>({});
  // Each project folder's git kind, read once per folder while the list shows it.
  const [gits, setGits] = useState<Record<string, ThreadProjectGit | null>>({});
  const { projectGit } = props;
  const gitFolders = workspaces.map((item) => item.path).filter((folder): folder is string => Boolean(folder)).join("\n");
  useEffect(() => {
    if (!projectGit || !gitFolders) return undefined;
    let live = true;
    for (const folder of gitFolders.split("\n")) {
      void projectGit(folder).then((git) => { if (live) setGits((current) => ({ ...current, [folder]: git })); }, () => undefined);
    }
    return () => { live = false; };
  }, [projectGit, gitFolders]);
  const cardTimer = useRef<number | undefined>(undefined);
  const hoverProject = (item: ThreadWorkspace, row: HTMLElement) => {
    window.clearTimeout(cardTimer.current);
    if (menu) return;
    const box = row.getBoundingClientRect();
    cardTimer.current = window.setTimeout(() => {
      setProjectCard({ item, top: box.top, left: box.right + 8 });
      if (item.path && props.projectRemote && !(item.path in remotes)) {
        void props.projectRemote(item.path).then((remote) => setRemotes((current) => ({ ...current, [item.path!]: remote })), () => undefined);
      }
    }, 500);
  };
  const leaveProject = () => { window.clearTimeout(cardTimer.current); cardTimer.current = window.setTimeout(() => setProjectCard(null), 200); };
  const keepProjectCard = () => window.clearTimeout(cardTimer.current);
  const saveSettings = (next: ListSettings) => {
    setSettings(next);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* per-session only */ }
  };
  const saveOrder = (next: string[]) => {
    setManualOrder(next);
    try { localStorage.setItem(orderKey(workspaceId), JSON.stringify(next)); } catch { /* per-session only */ }
  };
  /** A chat of `projectId` you moved: it keeps its place even while it runs or waits on you. */
  const place = (projectId: string, id: string) => {
    const placed = readPlaced(projectId);
    if (!placed.includes(id)) writePlaced(projectId, [...placed, id]);
  };
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
  // Codex opens a project's chats under its row without leaving the open chat; several projects
  // can be open at once. The current project keeps its collapse state; others open here.
  const [openOthers, setOpenOthers] = useState<Set<string>>(() => new Set(readStored(OPEN_PROJECTS_KEY, [], isIds)));
  const saveOpenOthers = (next: Set<string>) => {
    setOpenOthers(next);
    try { localStorage.setItem(OPEN_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* per-session only */ }
  };
  const clickProject = (id: string) => {
    if (id !== workspaceId) {
      const next = new Set(openOthers);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveOpenOthers(next);
      return;
    }
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveCollapsed(next);
  };
  // After switching projects (a chat opened from another project), the one you left stays open
  // and the new one shows its chats, as an open Codex project does.
  const previousWorkspace = useRef(workspaceId);
  useEffect(() => {
    const left = previousWorkspace.current;
    previousWorkspace.current = workspaceId;
    if (left === workspaceId) return;
    // A chat's hover card outlived its row (the row became another project's) and then named the
    // new project's folder for a chat of the old one.
    setHover(null);
    const others = new Set(openOthers);
    if (left && !collapsed.has(left)) others.add(left);
    others.delete(workspaceId);
    saveOpenOthers(others);
    if (collapsed.has(workspaceId)) { const next = new Set(collapsed); next.delete(workspaceId); saveCollapsed(next); }
  }, [workspaceId]);
  // Every other project's chats, read when one opens and refreshed with the list's clock (a minute,
  // paused while the window is hidden). Collapsed projects are read too: their row's badge (running,
  // waiting on you, unread) comes from them, and only opened projects were read, so a collapsed
  // project with chats running showed nothing.
  const [otherChats, setOtherChats] = useState<Record<string, ChatSummary[]>>({});
  const { loadProjectChats } = props;
  const openOtherIds = [...openOthers].filter((id) => id !== workspaceId && workspaces.some((item) => item.id === id)).join("\n");
  const otherIds = workspaces.map((item) => item.id).filter((id) => id !== workspaceId).join("\n");
  useEffect(() => {
    if (!loadProjectChats || !otherIds) return undefined;
    let live = true;
    for (const id of otherIds.split("\n")) {
      void loadProjectChats(id).then((list) => { if (live) setOtherChats((current) => ({ ...current, [id]: list })); }, () => undefined);
    }
    return () => { live = false; };
  }, [loadProjectChats, otherIds, openOtherIds, now]);
  // The order you dragged projects into. Before there was one, projects rose as they were used; the
  // first list seen keeps that order, so nothing moves on the update.
  const [projectOrderSaved, setProjectOrderSaved] = useState<string[] | null>(() => {
    try { return localStorage.getItem(PROJECT_ORDER_KEY) === null ? null : readStored(PROJECT_ORDER_KEY, [], isIds); } catch { return []; }
  });
  const saveProjectOrder = (next: string[]) => {
    setProjectOrderSaved(next);
    try { localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(next)); localStorage.removeItem(PROJECT_USED_KEY); } catch { /* per-session only */ }
  };
  useEffect(() => {
    if (!workspaces.length) return;
    if (projectOrderSaved === null) {
      saveProjectOrder(projectsByLastUse(workspaces, readStored(PROJECT_USED_KEY, {}, isTimes)));
      return;
    }
    const placed = placeNewProjects(projectOrderSaved, workspaces.map((item) => item.id));
    if (placed !== projectOrderSaved) saveProjectOrder(placed);
  }, [projectOrderSaved, workspaces]);
  // A chat that got a new run was just used: it rises to the top of its project, as in Codex. Its
  // project stays where it is; projects move only when you drag them.
  const seenRuns = useRef<{ workspaceId: string; runs: Record<string, string> }>({ workspaceId, runs: {} });
  useEffect(() => {
    if (seenRuns.current.workspaceId !== workspaceId) seenRuns.current = { workspaceId, runs: {} };
    // A switch empties the list before the new project's chats arrive; that load is not a use.
    if (!chats.length) { seenRuns.current.runs = {}; return; }
    const known = seenRuns.current.runs;
    const { order, used } = releaseUsedChats(manualOrder, known, chats);
    for (const chat of chats) known[chat.taskId] = chat.latestRunId;
    // A new run releases a chat you moved, too: running again, it goes back on top.
    if (used.length) {
      const placed = readPlaced(workspaceId);
      if (placed.some((id) => used.includes(id))) writePlaced(workspaceId, placed.filter((id) => !used.includes(id)));
    }
    if (order !== manualOrder) saveOrder(order);
  }, [chats, workspaceId]);
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
        : running ? { label: "Schedule start…", icon: "schedule", reason: "Stop this chat before scheduling a start" }
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
      // Claude Code's "Open in": its layouts first, numbered (1, 2), then the other places.
      { label: "Open in", icon: "openIn", items: [
        ...(actions.openSplit && !props.openTaskIds?.includes(chat.taskId)
          ? [{ label: "Split view", shortcut: "1", run: () => actions.openSplit!(workspaceId, chat.taskId) }] : []),
        { label: "New window", shortcut: actions.openSplit && !props.openTaskIds?.includes(chat.taskId) ? "2" : "1", run: () => actions.openWindow(chat.taskId) },
        { kind: "separator" },
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
      { label: "New chat", icon: "plus", run: () => actions.newChatIn(item.id) },
      { label: props.pinnedProjects.includes(item.id) ? "Unpin" : "Pin", icon: "pin", run: () => props.toggleProjectPin(item.id) },
      { label: "Edit", icon: "edit", run: () => actions.editProject(item.id) },
      { label: "New section…", icon: "section", run: () => setNaming({ name: "" }) },
      item.path && actions.openFolder
        ? { label: "Open in Explorer", icon: "folder", run: () => actions.openFolder!(item) }
        : { label: "Open in Explorer", icon: "folder", reason: "This project's folder isn't known" },
      current && chats.length
        ? { label: "Archive chats", icon: "archive", run: () => actions.archiveAll() }
        : { label: "Archive chats", icon: "archive", reason: current ? "This project has no chats" : "Open this project first" },
      { kind: "separator" },
      actions.removeProject
        ? { label: "Remove project", icon: "delete", danger: true, run: () => actions.removeProject!(item.id) }
        : { label: "Remove project", icon: "delete", danger: true, reason: "Remove projects on the Workspace page" },
    ];
  };
  const openMenu = (event: ReactMouseEvent, items: ChatMenuItem[], label: string) => {
    event.preventDefault();
    // A pending hover card must not appear over the menu.
    window.clearTimeout(hoverTimer.current);
    setHover(null);
    setMenu({ x: event.clientX, y: event.clientY, items, label });
  };

  // The settings popover closes on a click outside it or Escape.
  useEffect(() => {
    if (!settingsAt) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".cx-popover, .cx-list-settings")) setSettingsAt(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSettingsAt(null); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [settingsAt]);

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
      else if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        // Moves the open chat one place within its project's list.
        const at = shownOrder.indexOf(chat.taskId);
        const to = at + (event.key === "ArrowUp" ? -1 : 1);
        if (at < 0 || to < 0 || to >= shownOrder.length) return;
        event.preventDefault();
        place(workspaceId, chat.taskId);
        saveOrder(moveChat(shownOrder, chat.taskId, event.key === "ArrowUp" ? shownOrder[to] : shownOrder[to + 1] ?? null));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /**
   * A row's drag handlers, as Codex lets you drag chats into your own order: in every list (a project,
   * one without a folder, Pinned, a section, Archived), and only within it; moving a chat to another
   * project is "Continue in" on its menu. The upper half of a row drops before it, the lower half after.
   */
  const endDrag = () => { setDragging(null); setDropAt(null); };
  /**
   * A drop anywhere over the list the chat came from (its rows, the gaps between them, below the
   * last one): the place the drop line last showed. Only a row took the drop before, so letting go
   * between rows, below the last one or on the dragged row itself was refused (the no-entry cursor)
   * and nothing moved, which made placing a chat fiddly. Outside that list (another project, Pinned,
   * Archived, a button) the line goes away and the drop is refused, as before.
   */
  const inSourceList = (event: ReactDragEvent<HTMLElement>) => {
    const list = dragging?.listEl;
    return !list || Boolean(event.target && list.contains(event.target as Node));
  };
  const listDragOver = dragging ? (event: ReactDragEvent<HTMLElement>) => {
    if (!inSourceList(event)) { if (dropAt) setDropAt(null); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  } : undefined;
  const listDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    if (dragging && dropAt && dropAt.id !== dragging.id && inSourceList(event)) {
      dragging.drag.save(dropChat(dragging.drag.order, dragging.id, dropAt.id, dropAt.after), dragging.id);
    }
    endDrag();
  };
  const dragRow = (id: string, drag: DragList | undefined, project = workspaceId) => {
    if (!drag) return { onDragEnd: endDrag };
    const sameList = dragging?.list === drag.list;
    const lower = (event: ReactDragEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      return event.clientY > box.top + box.height / 2;
    };
    return {
      draggable: true,
      "data-drop": sameList && dragging?.id !== id && dropAt?.id === id ? (dropAt.after ? "after" : "before") : undefined,
      onDragStart: (event: ReactDragEvent<HTMLElement>) => {
        // A chat row sits inside its project's row, which drags too: the drag is the chat's only.
        event.stopPropagation();
        // The list element the row sits in: drops count only over it (inSourceList).
        setDragging({ list: drag.list, id, drag, listEl: event.currentTarget.parentElement ?? null });
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
        // Dropped on the chat area it opens in split view (ChatSplit), as Claude Code's sidebar drag does.
        if (actions.openSplit) event.dataTransfer.setData(SPLIT_DRAG_TYPE, JSON.stringify({ workspaceId: project, taskId: id }));
        // The browser's own drag image is a see-through copy of the row a few pixels off it, which
        // read as the chat crossed out and hid the drop line; a small label beside the pointer instead.
        if (typeof document !== "undefined" && typeof event.dataTransfer.setDragImage === "function") {
          const ghost = document.createElement("div");
          ghost.className = "cx-drag-ghost";
          ghost.textContent = event.currentTarget.querySelector(".cx-thread-title")?.textContent ?? "Chat";
          document.body.appendChild(ghost);
          event.dataTransfer.setDragImage(ghost, -14, -6);
          window.setTimeout(() => ghost.remove(), 0);
        }
      },
      // Over the dragged row itself the line goes away: letting go there leaves the chat in place.
      onDragOver: sameList ? (event: ReactDragEvent<HTMLElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dragging?.id === id) { if (dropAt) setDropAt(null); return; }
        const after = lower(event);
        if (dropAt?.id !== id || dropAt.after !== after) setDropAt({ id, after });
      } : undefined,
      onDragEnd: endDrag,
    };
  };
  const isDragged = (id: string, drag: DragList | undefined) => Boolean(drag && dragging?.list === drag.list && dragging.id === id);

  const row = (chat: ChatSummary, drag?: DragList) => {
    const isUnread = unread.includes(chat.taskId) && chat.taskId !== selectedTaskId;
    if (renaming?.taskId === chat.taskId) {
      return <li key={chat.taskId} className="cx-thread-row is-renaming">
        <input autoFocus aria-label="Chat name" maxLength={240} value={renaming.title}
          onChange={(event) => setRenaming({ ...renaming, title: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") setRenaming(null); }}
          onBlur={() => void commitRename()} />
      </li>;
    }
    return <li key={chat.taskId} className={`cx-thread-row${isUnread ? " is-unread" : ""}${isDragged(chat.taskId, drag) ? " is-dragging" : ""}`}
      {...dragRow(chat.taskId, drag)}
      onContextMenu={(event) => openMenu(event, chatMenu(chat), chat.title)}
      onMouseEnter={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(() => setHover({ chat, top: box.top, left: box.right + 8 }), 600);
      }}
      onMouseLeave={() => { window.clearTimeout(hoverTimer.current); setHover(null); }}>
      <button type="button" className="cx-thread-select" aria-current={chat.taskId === selectedTaskId} data-open={openTaskIds.has(chat.taskId) || undefined}
        // Ctrl-click opens it in split view, as in Claude Code.
        onClick={(event) => event?.ctrlKey && actions.openSplit ? actions.openSplit(workspaceId, chat.taskId) : actions.select(chat.taskId)}>
        <span className="cx-thread-title">{chat.title || "Untitled"}</span>
        {chat.schedule?.state === "scheduled" ? <span className="cx-thread-age" aria-label="Scheduled">◷</span> : null}
        <span className={`cx-thread-dot status-${chat.status}`} aria-label={STATUS_LABEL[chat.status]} />
      </button>
      {/* Claude Code's session row: on hover its status dot gives way to one "More options" button,
          which holds Pin, Archive and the rest (the row's own menu). */}
      <button type="button" className="cx-thread-more" aria-label={`More options for ${chat.title || "Untitled"}`} title="More options" aria-haspopup="menu"
        onClick={(event) => { const owner = event.currentTarget, box = owner.getBoundingClientRect();
          setMenu((current) => current?.owner === owner ? null : { x: box.left, y: box.bottom + 4, items: chatMenu(chat), label: chat.title, owner }); }}>
        <ChatGlyph name="more" size={16} />
      </button>
    </li>;
  };

  const pinnedKey = listOrderKey("pinned");
  const pinnedChats = inManualOrder(chats.filter((chat) => pinned.includes(chat.taskId)), readIdsAt(pinnedKey), (chat) => chat.taskId);
  const pinnedDrag: DragList = { list: "pinned", order: pinnedChats.map((chat) => chat.taskId), save: (next) => saveListOrder(pinnedKey, next) };
  const projectChats = orderChats(chats.filter((chat) => !pinned.includes(chat.taskId) && !sectionOf(chat.taskId)), manualOrder, settings.keepActiveOnTop,
    readPlaced(workspaceId));
  const shownOrder = projectChats.map((chat) => chat.taskId);
  const projectDrag: DragList = { list: `project:${workspaceId}`, order: shownOrder,
    save: (next, moved) => { place(workspaceId, moved); saveOrder(next); } };
  // Open split-pane chats stay visible even when the rest of their project is collapsed.
  const showAll = expanded.has(workspaceId);
  const visibleChats = showAll ? projectChats : projectChats.filter((chat, index) => index < settings.visible || openTaskIds.has(chat.taskId));
  const toggleShowAll = (id = workspaceId) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // Another open project's chats: Codex's rows; opening one switches to its project first.
  const otherRows = (projectId: string) => {
    const list = otherChats[projectId];
    if (!list) return <li className="cx-thread-empty">Loading chats…</li>;
    if (!list.length) return <li className="cx-thread-empty">No chats yet</li>;
    const ordered = orderChats(list.filter((chat) => !pinned.includes(chat.taskId)), readOrder(projectId), settings.keepActiveOnTop, readPlaced(projectId));
    // Its order is the one the project keeps when it is the open one.
    const drag: DragList = { list: `project:${projectId}`, order: ordered.map((chat) => chat.taskId),
      save: (next, moved) => { place(projectId, moved); saveListOrder(orderKey(projectId), next); } };
    const all = expanded.has(projectId);
    return <>
      {(all ? ordered : ordered.filter((chat, index) => index < settings.visible || openTaskIds.has(chat.taskId))).map((chat) => <li key={chat.taskId} {...dragRow(chat.taskId, drag, projectId)}
        className={`cx-thread-row${unread.includes(chat.taskId) ? " is-unread" : ""}${isDragged(chat.taskId, drag) ? " is-dragging" : ""}`}>
        <button type="button" className="cx-thread-select" aria-current={chat.taskId === selectedTaskId} data-open={openTaskIds.has(chat.taskId) || undefined}
          onClick={(event) => event?.ctrlKey && actions.openSplit ? actions.openSplit(projectId, chat.taskId)
            : actions.selectIn ? actions.selectIn(projectId, chat.taskId) : props.onWorkspace(projectId)}>
          <span className="cx-thread-title">{chat.title}</span>
          {chat.schedule?.state === "scheduled" ? <span className="cx-thread-age" aria-label="Scheduled">◷</span> : null}
          <span className={`cx-thread-dot status-${chat.status}`} aria-label={STATUS_LABEL[chat.status]} />
        </button>
      </li>)}
      {ordered.length > settings.visible
        ? <li><button type="button" className="cx-show-more" onClick={() => toggleShowAll(projectId)}>{all ? "Show less" : "Show more"}</button></li>
        : null}
    </>;
  };
  const nameInput = (label: string) => <input className="cx-section-input" autoFocus aria-label={label} placeholder={label} maxLength={80}
    value={naming?.name ?? ""} onChange={(event) => setNaming((current) => current && { ...current, name: event.target.value })}
    onKeyDown={(event) => { if (event.key === "Enter") commitNaming(); if (event.key === "Escape") setNaming(null); }}
    onBlur={commitNaming} />;
  const projectOrder = orderProjects(workspaces, props.pinnedProjects, projectOrderSaved ?? []);
  // Projects are dragged into place like chats, and only within Projects; that order is kept.
  const projectsDrag: DragList = { list: "projects", order: projectOrder.map((item) => item.id), save: saveProjectOrder };
  return (
    <aside className="cx-threads" aria-label="Projects and chats" onDragOver={listDragOver} onDrop={listDrop}>
      {/* The Codex sidebar uses the compose glyph for New chat. */}
      <button type="button" className="cx-new-chat" aria-pressed={!selectedTaskId} onClick={actions.newChat} title="New chat (Ctrl+N)">
        <span className="cx-new-circle" aria-hidden="true"><ChatGlyph name="compose" size={16} /></span>New chat
      </button>
      <nav className="cx-thread-scroll">
        {pinnedChats.length ? <section className="cx-thread-group">
          <h3>Pinned</h3>
          <ul>{pinnedChats.map((chat) => row(chat, pinnedDrag))}</ul>
        </section> : null}
        {sections.map((section) => {
          const key = `section:${section.id}`;
          const open = !collapsed.has(key);
          // A section shows its chats in its own order, the one you drag them into.
          const members = chats.filter((chat) => section.taskIds.includes(chat.taskId) && !pinned.includes(chat.taskId))
            .sort((a, b) => section.taskIds.indexOf(a.taskId) - section.taskIds.indexOf(b.taskId));
          const sectionDrag: DragList = { list: key, order: members.map((chat) => chat.taskId), save: (next) => saveSections(sections.map((item) => item.id === section.id
            ? { ...item, taskIds: [...next, ...item.taskIds.filter((id) => !next.includes(id))] } : item)) };
          return <section key={section.id} className="cx-thread-group">
            {naming?.sectionId === section.id ? nameInput("Section name")
              : <button type="button" className="cx-project cx-section-head" aria-expanded={open}
                onClick={() => { const next = new Set(collapsed); if (open) next.add(key); else next.delete(key); saveCollapsed(next); }}
                onContextMenu={(event) => openMenu(event, sectionMenu(section), section.name)}>
                <span className="cx-thread-title">{section.name}</span>
                <Icon name="chevron" width="12" height="12" className={`cx-caret${open ? " is-open" : ""}`} />
              </button>}
            {open ? <ul>{members.map((chat) => row(chat, sectionDrag))}{!members.length ? <li className="cx-thread-empty">No chats from this project here</li> : null}</ul> : null}
          </section>;
        })}
        {naming && !naming.sectionId ? <section className="cx-thread-group">{nameInput("New section name")}</section> : null}
        <section className="cx-thread-group">
          <div className="cx-group-head">
            <h3>Projects</h3>
            <button type="button" className="cx-list-settings" aria-label="Chat list settings" title="Chat list settings" aria-expanded={Boolean(settingsAt)}
              onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setSettingsAt(settingsAt ? null : { top: box.bottom + 4, left: box.left }); }}>
              <ChatGlyph name="more" size={16} />
            </button>
          </div>
          <ul className="cx-projects">
            {projectOrder.map((item) => {
              const current = item.id === workspaceId;
              const open = current ? !collapsed.has(item.id) : openOthers.has(item.id);
              const git = projectGitLabel(item.path ? gits[item.path] : null);
              // Collapsed, the project shows the most urgent state of its chats: a dot, or Codex's spinner while one runs.
              const members = current ? chats : otherChats[item.id] ?? [];
              const badge = open ? null : members.some((chat) => chat.status === "attention") ? "attention"
                : members.some((chat) => chat.status === "running" || chat.status === "queued") ? "running"
                : members.some((chat) => unread.includes(chat.taskId)) ? "unread" : null;
              return <li key={item.id} {...dragRow(item.id, projectsDrag)} className={`cx-project-item${isDragged(item.id, projectsDrag) ? " is-dragging" : ""}`}>
                <div className="cx-project-row" onMouseEnter={(event) => hoverProject(item, event.currentTarget)} onMouseLeave={leaveProject}>
                  {/* Codex's project row: an open folder when its chats show, a closed one when not, then the name. */}
                  <button type="button" className="cx-project" aria-expanded={open}
                    onClick={() => clickProject(item.id)} onContextMenu={(event) => openMenu(event, projectMenu(item), item.name)}>
                    <span className="cx-project-folder"><ChatGlyph name={open ? "folderOpen" : "folder"} size={16} /></span>
                    <span className="cx-thread-title">{item.name}</span>
                    {badge ? <span className={`cx-project-badge is-${badge}`} aria-label={badge === "attention" ? "A chat in this project is waiting on you"
                      : badge === "running" ? "Running" : "Unread response"} /> : null}
                    {git?.warn ? <span className="cx-project-tag is-warn" title={git.line}>{git.tag}</span> : null}
                    {props.pinnedProjects.includes(item.id) ? <span className="cx-project-pin" aria-label="Pinned project">📌</span> : null}
                  </button>
                  {/* Codex's project options are available by both click and right-click; New chat sits
                      beside them, as Codex's compose button, so a project's chat is one click away. */}
                  <span className="cx-project-hover">
                    <button type="button" aria-label={`New chat in ${item.name}`} title={`New chat in ${item.name}`}
                      onClick={() => { setProjectCard(null); actions.newChatIn(item.id); }}>
                      <ChatGlyph name="compose" size={16} /></button>
                    <button type="button" aria-label={`More options for ${item.name}`} title={`More options for ${item.name}`}
                      onClick={(event) => openMenu(event, projectMenu(item), item.name)}>
                      <ChatGlyph name="more" size={16} /></button>
                  </span>
                </div>
                {open && !current ? <ul>{otherRows(item.id)}</ul> : null}
                {open && current ? <ul>
                  {props.pendingTitle ? <li className="cx-thread-row is-pending"><span className="cx-thread-select" aria-current="true">
                    <span className="cx-thread-dot status-queued" aria-label="Starting" /><span className="cx-thread-title">{props.pendingTitle}</span>
                  </span></li> : null}
                  {visibleChats.map((chat) => row(chat, projectDrag))}
                  {projectChats.length > settings.visible
                    ? <li><button type="button" className="cx-show-more" onClick={() => toggleShowAll()}>{showAll ? "Show less" : "Show more"}</button></li>
                    : null}
                  {/* Just switched here: the chats this list read while the project was open in place
                      stand in until its own load lands, and an empty list says it is loading, not "No chats yet". */}
                  {!chats.length && props.chatsLoading
                    ? otherChats[item.id]?.length ? otherRows(item.id) : <li className="cx-thread-empty">Loading chats…</li>
                    : !chats.length ? <li className="cx-thread-empty">No chats yet</li> : null}
                </ul> : null}
              </li>;
            })}
          </ul>
        </section>
        {(() => {
          // Every project's archived chats once read (archivedAll); until then this project's.
          const all: ArchivedChat[] = props.archivedAll?.chats ?? archived.map((chat) => ({ workspaceId, taskId: chat.taskId, title: chat.title,
            visibility: chat.visibility === "deleted" ? "deleted" as const : "archived" as const }));
          if (!all.length) return null;
          const days = props.archivedAll?.days ?? 0;
          const restore = (chat: ArchivedChat) => props.restoreArchived ? props.restoreArchived(chat.workspaceId, chat.taskId) : actions.lifecycle(chat.taskId, "restore");
          const left = (chat: ArchivedChat) => {
            if (!days || !chat.archivedAt) return null;
            const due = chat.archivedAt + days * DAY_MS, remaining = Math.max(0, due - now);
            const text = remaining < DAY_MS ? "<1d" : `${Math.ceil(remaining / DAY_MS)}d`;
            return <span className="cx-thread-badge is-quiet" title={`Moves to Recently deleted on ${new Date(due).toLocaleDateString()}`}>{text}</span>;
          };
          // Each Archived group (a project, "Chats", Recently deleted) keeps the order you drag it into.
          const archivedDrag = (group: string, list: ArchivedChat[]) => {
            const key = listOrderKey(`archived:${group}`);
            const chats = inManualOrder(list, readIdsAt(key), (chat) => chat.taskId);
            return { chats, drag: { list: `archived:${group}`, order: chats.map((chat) => chat.taskId), save: (next: string[]) => saveListOrder(key, next) } };
          };
          const archivedRow = (chat: ArchivedChat, drag: DragList) => <li key={`${chat.workspaceId}:${chat.taskId}`} {...dragRow(chat.taskId, drag)}
            className={`cx-thread-row is-archived${isDragged(chat.taskId, drag) ? " is-dragging" : ""}`}>
            <span className="cx-thread-title" title={chat.title}>{chat.title || "Untitled chat"}</span>
            {chat.visibility === "archived" ? left(chat) : null}
            <button type="button" className="cx-restore" disabled={chatBusy(chat.taskId)} onClick={() => restore(chat)}>Restore</button>
          </li>;
          const kept = all.filter((chat) => chat.visibility === "archived"), gone = all.filter((chat) => chat.visibility === "deleted");
          const toggle = (key: string) => { const next = new Set(collapsed); if (next.has(key)) next.delete(key); else next.add(key); saveCollapsed(next); };
          return <section className="cx-thread-group">
            <button type="button" className="cx-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
              Archived ({kept.length})
            </button>
            {showArchived ? <ul className="cx-projects">
              {/* A folder per project, as in the Projects list, then "Chats" for chats with no project. */}
              {archivedGroups(kept, workspaces).map((group) => {
                const key = `archived:${group.key}`, open = !collapsed.has(key);
                const { chats: shown, drag } = archivedDrag(group.key, group.chats);
                return <li key={group.key}>
                  <button type="button" className="cx-project" aria-expanded={open} onClick={() => toggle(key)}>
                    <span className="cx-thread-title">{group.name}</span>
                    <Icon name="chevron" width="12" height="12" className={`cx-caret${open ? " is-open" : ""}`} />
                    <span className="cx-archived-count">{group.chats.length}</span>
                  </button>
                  {open ? <ul>{shown.map((chat) => archivedRow(chat, drag))}</ul> : null}
                </li>;
              })}
              {gone.length ? <li>
                <button type="button" className="cx-project cx-deleted-head" aria-expanded={!collapsed.has("archived:deleted")} onClick={() => toggle("archived:deleted")}>
                  <span className="cx-thread-title">Recently deleted</span>
                  <Icon name="chevron" width="12" height="12" className={`cx-caret${!collapsed.has("archived:deleted") ? " is-open" : ""}`} />
                  <span className="cx-archived-count">{gone.length}</span>
                </button>
                {!collapsed.has("archived:deleted") ? (() => {
                  const { chats: shown, drag } = archivedDrag("deleted", gone);
                  return <ul>{shown.map((chat) => archivedRow(chat, drag))}</ul>;
                })() : null}
              </li> : null}
            </ul> : null}
          </section>;
        })()}
      </nav>
      {/* In split view the chat pet's house stands here, under the list (ChatPet draws it in). */}
      <div className="cx-pet-yard" />
      {/* Codex's sidebar footer: Settings with its gear (also Ctrl+,). */}
      {actions.openSettings ? <div className="cx-threads-foot">
        <button type="button" className="cx-settings-link" aria-label="Open settings" title="Settings (Ctrl+,)" onClick={actions.openSettings}>
          <span className="cx-settings-icon"><ChatGlyph name="gear" size={16} /></span>
          <span>Settings</span>
        </button>
      </div> : null}
      {hover && !menu ? <FloatingLayer className="cx-hover-card" role="tooltip" style={{ top: hover.top, left: hover.left }}>
        <strong>{hover.chat.title}</strong>
        <span>{STATUS_LABEL[hover.chat.status]}{hover.chat.updatedAtMs ? ` · updated ${chatRelativeTime(hover.chat.updatedAtMs, now)} ago`.replace("now ago", "just now") : ""}</span>
        {hover.chat.schedule?.state === "scheduled" ? <span>◷ {scheduledStartLabel(hover.chat.schedule.due_at_ms, now)}</span> : null}
        <span>📁 {workspace?.name}</span>
        {workspace?.path ? <span className="cx-hover-path">{workspace.path}</span> : null}
        <span>{hover.chat.runIds.length} {hover.chat.runIds.length === 1 ? "run" : "runs"}</span>
      </FloatingLayer> : null}
      {projectCard && !menu ? (() => {
        const { item } = projectCard;
        const isOpen = item.id === workspaceId;
        const active = isOpen ? chats.filter((chat) => ACTIVE.has(chat.status)).length : 0;
        const remote = item.path ? remotes[item.path] : null;
        return <FloatingLayer className="cx-project-card" role="dialog" style={{ top: projectCard.top, left: projectCard.left }}
          onMouseEnter={keepProjectCard} onMouseLeave={leaveProject}>
          <div className="cx-project-card-head">
            <strong>{item.name}</strong>
            <button type="button" aria-pressed={props.pinnedProjects.includes(item.id)} aria-label={props.pinnedProjects.includes(item.id) ? "Unpin project" : "Pin project"}
              title={props.pinnedProjects.includes(item.id) ? "Unpin project" : "Pin project"} onClick={() => props.toggleProjectPin(item.id)}>
              <ChatGlyph name="pin" size={13} /></button>
          </div>
          {isOpen ? <span className="cx-project-card-line"><span className={`cx-thread-dot status-${active ? "running" : "done"}`} aria-hidden="true" />
            {chats.length} {chats.length === 1 ? "task" : "tasks"} · {active} active</span> : null}
          {remote ? <span className="cx-project-card-line"><ChatGlyph name="repo" size={13} />{remote}</span> : null}
          {(() => {
            const git = projectGitLabel(item.path ? gits[item.path] : null);
            return git ? <span className={`cx-project-card-line is-git${git.warn ? " is-warn" : ""}`}><ChatGlyph name="repo" size={13} />{git.line}</span> : null;
          })()}
          {item.path ? <span className="cx-project-card-line is-path"><ChatGlyph name="folder" size={13} />{item.path}</span> : null}
          <hr />
          <button type="button" className="cx-project-card-action" onClick={() => { setProjectCard(null); actions.newChatIn(item.id); }}>
            <ChatGlyph name="compose" size={13} />New chat</button>
          <button type="button" className="cx-project-card-action" onClick={() => { setProjectCard(null); actions.editProject(item.id); }}>
            <ChatGlyph name="settings" size={13} />Edit project</button>
        </FloatingLayer>;
      })() : null}
      {settingsAt ? <FloatingLayer className="cx-popover" role="dialog" style={{ top: settingsAt.top, left: settingsAt.left }}>
        <strong>Chat list</strong>
        <label className="cx-popover-row">
          <span>Chats shown per project</span>
          <input type="number" min={1} max={100} value={settings.visible} aria-label="Chats shown per project"
            onChange={(event) => { const value = Math.round(Number(event.target.value)); if (value >= 1 && value <= 100) saveSettings({ ...settings, visible: value }); }} />
        </label>
        <label className="cx-popover-row">
          <input type="checkbox" checked={settings.keepActiveOnTop} aria-label="Keep active chats on top"
            onChange={(event) => saveSettings({ ...settings, keepActiveOnTop: event.target.checked })} />
          <span>Keep running and waiting chats on top</span>
        </label>
        {props.setArchiveDays ? <label className="cx-popover-row">
          <span>Archive chats with no activity for</span>
          <input type="number" min={0} max={365} key={`idle-${props.archivedAll?.idleDays ?? 7}`} defaultValue={props.archivedAll?.idleDays ?? 7} aria-label="Days without activity before a chat is archived"
            onBlur={(event) => { const value = Math.round(Number(event.target.value)); if (value >= 0 && value <= 365 && value !== (props.archivedAll?.idleDays ?? 7)) props.setArchiveDays?.({ idleDays: value }); }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <span>days</span>
        </label> : null}
        {props.setArchiveDays ? <p className="cx-popover-hint">0 keeps them open. Archived chats leave the project list until restored.</p> : null}
        {props.setArchiveDays ? <label className="cx-popover-row">
          <span>Move archived chats to Recently deleted after</span>
          <input type="number" min={0} max={365} key={props.archivedAll?.days ?? 5} defaultValue={props.archivedAll?.days ?? 5} aria-label="Days before archived chats are deleted"
            onBlur={(event) => { const value = Math.round(Number(event.target.value)); if (value >= 0 && value <= 365 && value !== (props.archivedAll?.days ?? 5)) props.setArchiveDays?.({ days: value }); }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <span>days</span>
        </label> : null}
        {props.setArchiveDays ? <p className="cx-popover-hint">0 keeps them archived. Deleted chats can still be restored.</p> : null}
        <p className="cx-popover-hint">Drag chats to reorder any list, or press Alt+Shift+↑/↓ on the open chat.</p>
        {manualOrder.length ? <button type="button" className="cx-popover-reset" onClick={() => saveOrder([])}>Reset to newest first</button> : null}
      </FloatingLayer> : null}
      <ChatMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}
