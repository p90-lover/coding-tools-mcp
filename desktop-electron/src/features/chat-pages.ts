import { createContext, useSyncExternalStore, type ComponentType } from "react";

export const CHAT_PAGES_STORE = "coding-tools:ao:chat-pages";
export const CHAT_PAGE_ACTIVE = `${CHAT_PAGES_STORE}:active`;
export const CHAT_PAGE_LIMIT = 12;
/**
 * `keyboard`: Ctrl+1 … Ctrl+0 open pages 1 to 10. `wheel`: Alt+scroll (and a scroll over the page
 * tabs, or a touchpad's sideways swipe) turns pages.
 */
export type ChatPagePreferences = { enabled: boolean; pageCount: number; keyboard: boolean; wheel: boolean };
// Pages are on unless turned off in Settings. Off by default (#903) hid them all: the page tabs,
// their keys, the wheel and a full page's New chat going to the next page (2026-11-08).
export const DEFAULT_CHAT_PAGES: ChatPagePreferences = { enabled: true, pageCount: 1, keyboard: true, wheel: true };

/** Saved preferences; the previous/next keys stores still hold (Shift+Q / Shift+R, 2026-11-09) are dropped. */
export function parseChatPagePreferences(raw: string | null): ChatPagePreferences {
  let value: Partial<ChatPagePreferences> | null = null;
  try { value = JSON.parse(raw || "null"); } catch { /* Use the default layout. */ }
  return {
    enabled: value?.enabled !== false,
    pageCount: Number.isInteger(value?.pageCount) && value!.pageCount! >= 1 && value!.pageCount! <= CHAT_PAGE_LIMIT ? value!.pageCount! : 1,
    keyboard: value?.keyboard !== false, wheel: value?.wheel !== false,
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

/** Where typing goes, or a dialog or menu: a sideways swipe there stays its own. */
export const PAGE_KEYS_PAUSED = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="dialog"], [role="menu"]';
/** A dialog, menu or list: the page keys and Alt+scroll leave it alone. */
export const PAGE_TURN_PAUSED = '[role="dialog"], [role="menu"], [role="listbox"]';
/**
 * The page Ctrl+1 … Ctrl+9 and Ctrl+0 open (pages 1 to 10), or 0 for any other key. They type
 * nothing, so they work while you type in a chat (Shift+Q / Shift+R did not, 2026-11-09); not in a
 * dialog or menu, for a held key, during IME composition, or for a page that is not open.
 */
export function pageNumberKey(event: KeyboardEvent, preferences: ChatPagePreferences): number {
  if (!preferences.enabled || !preferences.keyboard || preferences.pageCount < 2 || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return 0;
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return 0;
  // The digit row by position (any layout); the number pad only as digits (NumLock off, Numpad1 is End).
  const digit = /^Digit([0-9])$/.exec(event.code ?? "")?.[1] ?? (/^[0-9]$/.test(event.key) ? event.key : null);
  if (digit === null) return 0;
  const page = Number(digit) || 10;
  if (page > preferences.pageCount) return 0;
  const target = event.target as Element | null;
  return target?.closest?.(PAGE_TURN_PAUSED) ? 0 : page;
}
export function adjacentChatPage(page: number, direction: number, count: number): number {
  return ((page - 1 + direction) % count + count) % count + 1;
}

type PageWheel = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;
/**
 * How far a wheel event goes through the pages (more than 0 towards the next page; 0: no page turn).
 * Alt+wheel turns pages anywhere: up for the previous page, down for the next. Over the page tabs
 * any scroll counts, down or right for the next page. Anywhere else only a plain sideways swipe
 * does (a touchpad, a tilted wheel), so scrolling messages, or sideways with Shift+wheel, never
 * turns a page. Ctrl/Meta+wheel zooms.
 */
export function pageWheelDelta(event: PageWheel, overTabs: boolean): number {
  if (event.ctrlKey || event.metaKey) return 0;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  let x = event.deltaX * unit;
  let y = event.deltaY * unit;
  if (event.altKey) return event.shiftKey ? 0 : Math.abs(x) > Math.abs(y) ? x : y;
  // Shift+wheel scrolls sideways: Chromium reports it as deltaX, a plain deltaY elsewhere.
  if (event.shiftKey && !x) [x, y] = [y, 0];
  if (overTabs) return Math.abs(x) > Math.abs(y) ? x : y;
  return !event.shiftKey && Math.abs(x) > Math.abs(y) * 1.5 ? x : 0;
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
  /** `keys`: Ctrl+1 … Ctrl+0 open pages 1 to 10 (the tabs name them). */
  active: number; count: number; canAdd: boolean; keys: boolean;
  select: (page: number) => void; add: () => void;
};
export const ChatPagerContext = createContext<ChatPager | null>(null);

/**
 * The page a chat goes to when page `from` (of `count`) has no screen left for it: a page from
 * 1..count that `hasRoom` (pages not opened yet count as having room), `count + 1` to add a page
 * when `canAdd`, or null when there is nowhere for it (the chat then opens on `from` as before).
 */
export function overflowPage(from: number, count: number, hasRoom: (page: number) => boolean, canAdd: boolean): number | null {
  // "Next" as Alt+scroll down means it: the pages after this one, wrapping round; a page is added only when all are full.
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
