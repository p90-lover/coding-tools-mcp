import { createContext, useSyncExternalStore, type ComponentType } from "react";

export const CHAT_PAGES_STORE = "coding-tools:ao:chat-pages";
export const CHAT_PAGE_ACTIVE = `${CHAT_PAGES_STORE}:active`;
export const CHAT_PAGE_LIMIT = 12;
export type ChatPagePreferences = {
  enabled: boolean; pageCount: number; keyboard: boolean; wheel: boolean; previous: string; next: string;
};
// Pages are on unless turned off in Settings. Off by default (#903) hid them all: the page tabs,
// Shift+Q / Shift+R, the wheel and a full page's New chat going to the next page (2026-11-08).
export const DEFAULT_CHAT_PAGES: ChatPagePreferences = {
  enabled: true, pageCount: 1, keyboard: true, wheel: true, previous: "Shift+Q", next: "Shift+R",
};
// #903's defaults, written into the store by every page change since: they read as today's (Shift+Q / Shift+R).
const LEGACY_DEFAULT_KEYS = { previous: "Shift+R", next: "Shift+E" };
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];
const NAMED_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Space"];

/** A modified letter, number, arrow, navigation or function key. Plain text is never a shortcut. */
export function normalizePageShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("+");
  if (parts.length < 2 || parts.length > 5) return null;
  const last = parts.pop()!.trim();
  const key = /^[a-z0-9]$/i.test(last) || /^F(?:[1-9]|1\d|2[0-4])$/i.test(last) ? last.toUpperCase()
    : NAMED_KEYS.find((name) => name.toLowerCase() === last.toLowerCase());
  const modifiers = parts.map((part) => MODIFIERS.find((name) => name.toLowerCase() === part.trim().toLowerCase()));
  if (!key || modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length) return null;
  return [...MODIFIERS.filter((name) => modifiers.includes(name)), key].join("+");
}

export function recordPageShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "getModifierState">): string | null {
  if (event.isComposing || event.getModifierState?.("AltGraph")) return null;
  return normalizePageShortcut([
    ...(event.ctrlKey ? ["Ctrl"] : []), ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []), ...(event.metaKey ? ["Meta"] : []),
    event.key === " " ? "Space" : event.key,
  ].join("+"));
}

export function parseChatPagePreferences(raw: string | null): ChatPagePreferences {
  let value: Partial<ChatPagePreferences> | null = null;
  try { value = JSON.parse(raw || "null"); } catch { /* Use the default layout. */ }
  let previous = normalizePageShortcut(value?.previous) ?? DEFAULT_CHAT_PAGES.previous;
  let next = normalizePageShortcut(value?.next) ?? DEFAULT_CHAT_PAGES.next;
  if (previous === LEGACY_DEFAULT_KEYS.previous && next === LEGACY_DEFAULT_KEYS.next) ({ previous, next } = DEFAULT_CHAT_PAGES);
  return {
    enabled: value?.enabled !== false,
    pageCount: Number.isInteger(value?.pageCount) && value!.pageCount! >= 1 && value!.pageCount! <= CHAT_PAGE_LIMIT ? value!.pageCount! : 1,
    keyboard: value?.keyboard !== false, wheel: value?.wheel !== false,
    previous: previous === next ? DEFAULT_CHAT_PAGES.previous : previous,
    next: previous === next ? DEFAULT_CHAT_PAGES.next : next,
  };
}

// Like log-store, Settings and the page host share one small renderer store.
let snapshot: ChatPagePreferences | undefined;
const listeners = new Set<() => void>();
function readPreferences(): ChatPagePreferences {
  if (!snapshot) {
    try { snapshot = parseChatPagePreferences(localStorage.getItem(CHAT_PAGES_STORE)); }
    catch { snapshot = { ...DEFAULT_CHAT_PAGES }; }
  }
  return snapshot;
}
function changed(event: StorageEvent) {
  if (event.key !== CHAT_PAGES_STORE && event.key !== null) return;
  snapshot = undefined;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", changed);
  };
}
export function useChatPagePreferences(): ChatPagePreferences {
  return useSyncExternalStore(subscribe, readPreferences, () => DEFAULT_CHAT_PAGES);
}
export function saveChatPagePreferences(patch: Partial<ChatPagePreferences>): void {
  const next = { ...readPreferences(), ...patch };
  if (!Number.isInteger(next.pageCount) || next.pageCount < 1 || next.pageCount > CHAT_PAGE_LIMIT) throw new Error(`Use between 1 and ${CHAT_PAGE_LIMIT} chat pages`);
  if (!normalizePageShortcut(next.previous) || !normalizePageShortcut(next.next)) throw new Error("Press a modified letter, number, arrow or function key");
  next.previous = normalizePageShortcut(next.previous)!;
  next.next = normalizePageShortcut(next.next)!;
  if (next.previous === next.next) throw new Error("Next and previous page need different shortcuts");
  // A failed write leaves the published snapshot alone and is shown by the caller.
  localStorage.setItem(CHAT_PAGES_STORE, JSON.stringify(next));
  snapshot = next;
  for (const listener of listeners) listener();
}

export function chatPageKey(key: string, page = 1): string {
  return page === 1 ? key : `${key}:page-${page}`;
}
export type PageSelection = { workspaceId: string; taskId: string };
export function readPageSelection(page: number): PageSelection | null {
  try {
    const value = JSON.parse(localStorage.getItem(chatPageKey(`${CHAT_PAGES_STORE}:selection`, page)) || "null");
    return value && typeof value.workspaceId === "string" && typeof value.taskId === "string"
      ? { workspaceId: value.workspaceId, taskId: value.taskId } : null;
  } catch { return null; }
}

/** Where typing goes: a page key pressed there is text (Shift+R a capital R), never a page turn. */
export const PAGE_KEYS_PAUSED = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="dialog"], [role="menu"]';
export function pageShortcutDirection(event: KeyboardEvent, preferences: ChatPagePreferences): -1 | 0 | 1 {
  if (!preferences.enabled || !preferences.keyboard || preferences.pageCount < 2 || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return 0;
  const target = event.target as (Element & { isContentEditable?: boolean }) | null;
  if (target?.isContentEditable || target?.closest?.(PAGE_KEYS_PAUSED)) return 0;
  const shortcut = recordPageShortcut(event);
  return shortcut === preferences.next ? 1 : shortcut === preferences.previous ? -1 : 0;
}
export function adjacentChatPage(page: number, direction: number, count: number): number {
  return ((page - 1 + direction) % count + count) % count + 1;
}

type PageWheel = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;
/**
 * How far a wheel event goes through the pages (more than 0 towards the next page; 0: no page turn).
 * Over the page tabs any scroll counts, down or right for the next page. Anywhere else only a
 * sideways one does (a touchpad swipe, a tilted wheel, Shift+wheel), so scrolling messages up and
 * down never turns a page. Ctrl/Meta+wheel zooms and Alt+wheel is the app's own.
 */
export function pageWheelDelta(event: PageWheel, overTabs: boolean): number {
  if (event.ctrlKey || event.metaKey || event.altKey) return 0;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  let x = event.deltaX * unit;
  let y = event.deltaY * unit;
  // Shift+wheel scrolls sideways: Chromium reports it as deltaX, a plain deltaY elsewhere.
  if (event.shiftKey && !x) [x, y] = [y, 0];
  if (overTabs) return Math.abs(x) > Math.abs(y) ? x : y;
  return Math.abs(x) > Math.abs(y) * 1.5 ? x : 0;
}

/** A sideways scroll this long (px) turns one page: a wheel notch (100 px) at once, a touchpad swipe partway. */
export const PAGE_SWIPE_DISTANCE = 50;
/** Wheel events this close together (ms) are one gesture, a touchpad's momentum included. */
export const PAGE_SWIPE_QUIET_MS = 250;
/**
 * One page per gesture. A gesture that starts as an up/down scroll (delta 0) or on something that
 * scrolls sideways itself (`blocked`, asked once per gesture) turns nothing, even if it drifts
 * sideways later; momentum after a turn turns nothing more. Returns the direction to turn.
 */
export function createPageSwipe(distance = PAGE_SWIPE_DISTANCE, quiet = PAGE_SWIPE_QUIET_MS) {
  let total = 0, last = -Infinity, done = false;
  return (delta: number, now: number, blocked?: () => boolean): -1 | 0 | 1 => {
    const fresh = now - last > quiet;
    last = now;
    if (fresh) { total = 0; done = !delta || Boolean(blocked?.()); }
    if (done || !delta) return 0;
    if (Math.sign(total) === -Math.sign(delta)) total = 0;
    total += delta;
    if (Math.abs(total) < distance) return 0;
    done = true;
    return total > 0 ? 1 : -1;
  };
}

/** What the open page's tabs show and do (ChatPages provides it; null while pages are off). */
export type ChatPager = {
  active: number; count: number; canAdd: boolean; keys: { previous: string; next: string } | null;
  select: (page: number) => void; add: () => void;
};
export const ChatPagerContext = createContext<ChatPager | null>(null);

/**
 * The page a chat goes to when page `from` (of `count`) has no screen left for it: a page from
 * 1..count that `hasRoom` (pages not opened yet count as having room), `count + 1` to add a page
 * when `canAdd`, or null when there is nowhere for it (the chat then opens on `from` as before).
 */
export function overflowPage(from: number, count: number, hasRoom: (page: number) => boolean, canAdd: boolean): number | null {
  // "Next" as Shift+R means it: the pages after this one, wrapping round; a page is added only when all are full.
  for (let step = 1; step < count; step++) {
    const page = adjacentChatPage(from, step, count);
    if (hasRoom(page)) return page;
  }
  return canAdd ? count + 1 : null;
}

/**
 * The page host's side of a hand-off, from the saved preferences (`latest`, kept current as pages
 * are added): how many pages there are, whether one more fits, and adding it or turning pages on.
 * A failed save is reported (`fail`) and changes nothing.
 */
export function chatPageLayout(latest: { current: ChatPagePreferences }, fail: (message: string) => void) {
  const change = (patch: Partial<ChatPagePreferences>) => {
    try {
      saveChatPagePreferences(patch);
      latest.current = { ...latest.current, ...patch };
      return true;
    } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  return {
    count: () => latest.current.enabled ? latest.current.pageCount : 0,
    canAdd: () => latest.current.enabled && latest.current.pageCount < CHAT_PAGE_LIMIT,
    add: () => change({ pageCount: latest.current.pageCount + 1 }),
    enable: () => change({ enabled: true }),
  };
}

/** A chat ("" a new one) to start on another page because its own page had no screen for it. */
export type PageOpen = PageSelection & { maxColumns: number; tried: number[]; newScreen?: boolean };
type PageChat = PageSelection & { paneId: string };
type PageRoom = { room?: (maxColumns: number, workspaceId: string, newScreen?: boolean) => boolean; wake?: () => void };
/**
 * One displayed owner for a chat across all pages, including their split panes. With `layout` a
 * full page hands a chat on to another (`openElsewhere`), which takes it once it has loaded.
 */
export function createChatPageRegistry(selectPage: (page: number) => void,
  layout?: { count: () => number; canAdd: () => boolean; add: () => boolean; enable?: () => boolean }) {
  const pages = new Map<number, { chats: PageChat[]; focus: (paneId: string) => void } & PageRoom>();
  const waiting = new Map<number, PageOpen>();
  const owner = (from: number, workspaceId: string, taskId: string) => {
    if (!taskId) return undefined;
    for (const [page, entry] of pages) {
      const chat = page !== from && entry.chats.find((item) => item.workspaceId === workspaceId && item.taskId === taskId);
      if (chat) return { page, entry, chat };
    }
    return undefined;
  };
  return {
    register(page: number, chats: PageChat[], focus: (paneId: string) => void, room: PageRoom = {}) {
      const entry = { chats, focus, ...room };
      pages.set(page, entry);
      return () => { if (pages.get(page) === entry) pages.delete(page); };
    },
    has(from: number, workspaceId: string, taskId: string) { return Boolean(owner(from, workspaceId, taskId)); },
    reveal(from: number, workspaceId: string, taskId: string) {
      const found = owner(from, workspaceId, taskId);
      if (!found) return false;
      selectPage(found.page);
      found.entry.focus(found.chat.paneId);
      return true;
    },
    /**
     * Page `from` is full: the chat goes to the page `overflowPage` picks and waits there until that
     * page takes it. Pages already tried are skipped, so a request passed on never comes back.
     */
    openElsewhere(from: number, open: Omit<PageOpen, "tried"> & { tried?: number[] }) {
      if (!layout) return false;
      if (layout.count() < 1 && (!open.newScreen || !layout.enable?.())) return false;
      const count = layout.count();
      if (count < 1) return false;
      const tried = [...(open.tried ?? []), from];
      const target = overflowPage(from, count, (page) => !tried.includes(page) && !waiting.has(page)
        && (pages.get(page)?.room?.(open.maxColumns, open.workspaceId, open.newScreen) ?? true), layout.canAdd());
      if (target === null || !Number.isInteger(target) || target < 1 || target > count + 1 || tried.includes(target)) return false;
      if (target === count + 1 && !layout.add()) return false;
      waiting.set(target, { workspaceId: open.workspaceId, taskId: open.taskId, maxColumns: open.maxColumns, tried,
        ...(open.newScreen ? { newScreen: true } : {}) });
      selectPage(target);
      pages.get(target)?.wake?.();
      return true;
    },
    /** The chat waiting for this page, once: the page calls it when its saved layout has loaded. */
    takeOpen(page: number) {
      const open = waiting.get(page);
      waiting.delete(page);
      return open;
    },
  };
}
/**
 * The page host's registry, and the page tabs it hands each page to draw in its title-bar strip
 * (`Tabs`): the page's own surface draws them without reading the pager itself, so turning a page
 * redraws the tabs, not every chat on the pages around it.
 */
export type ChatPageRegistry = ReturnType<typeof createChatPageRegistry> & { Tabs?: ComponentType<{ page: number }> };
export const ChatPagesContext = createContext<ChatPageRegistry | null>(null);
