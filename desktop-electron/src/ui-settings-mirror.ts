import type { UiSettingsMirrorLoad } from "./types";

// The window's own localStorage settings (split view, chat pages, projects, sections, toolbar,
// terminal, last chat route, response style and the rest) keep a copy in userData through main
// (electron/ui-settings-mirror.cjs). On 2026-11-27 Bitdefender quarantined two files of the store;
// Chromium started an empty one and every setting was gone. When the page starts with none of the
// app's keys, the copy is put back before any screen reads the store.

export const MIRROR_DEBOUNCE_MS = 1500;
export const MIRROR_MAX_WAIT_MS = 10_000;
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_LENGTH = 256 * 1024;
const MAX_TOTAL_LENGTH = 2 * 1024 * 1024;

// The same rule as electron/ui-settings-mirror.cjs (a test keeps the two equal): the app's own keys,
// and never one whose name says it holds a secret.
const MIRRORED_PREFIXES = ["coding-tools:", "coding-tools-", "native-codex:", "email.read."];
const MIRRORED_KEYS = new Set(["cdx-image-toolbar-position"]);
const SECRET_WORDS = /secret|token|passw|credential|api[-_]?key|cookie|bearer|private[-_]?key/i;

export function isMirroredUiKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH
    && (MIRRORED_KEYS.has(key) || MIRRORED_PREFIXES.some((prefix) => key.startsWith(prefix)))
    && !SECRET_WORDS.test(key);
}

export interface UiSettingsBridge {
  loadUiSettingsMirror?(): UiSettingsMirrorLoad;
  saveUiSettingsMirror?(entries: Record<string, string>): void;
}

export interface UiSettingsMirrorOptions {
  storage: Storage;
  bridge: UiSettingsBridge | undefined;
  /** Where pagehide and beforeunload are heard (the window). */
  target?: { addEventListener(type: string, listener: () => void): void };
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/** The app's keys in the store, sorted; over the size cap the biggest values stay out so the small settings fit. */
export function appEntries(storage: Storage): Record<string, string> {
  const found: [string, string][] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!isMirroredUiKey(key)) continue;
    const value = storage.getItem(key);
    if (typeof value === "string" && value.length <= MAX_VALUE_LENGTH) found.push([key, value]);
  }
  const size = ([key, value]: [string, string]) => key.length + value.length;
  let total = found.reduce((sum, entry) => sum + size(entry), 0);
  if (total > MAX_TOTAL_LENGTH) {
    found.sort((a, b) => size(b) - size(a));
    while (total > MAX_TOTAL_LENGTH && found.length) total -= size(found.shift()!);
  }
  found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(found);
}

function hasAppKey(storage: Storage): boolean {
  for (let index = 0; index < storage.length; index += 1) if (isMirroredUiKey(storage.key(index))) return true;
  return false;
}

// The page's own Storage writes, seen in one place: about 45 call sites in 21 files write the store
// directly, and its "storage" event never fires in the page that wrote. Wrapped once per prototype;
// a second install (hot reload) only swaps the listener.
const HOOK = Symbol.for("coding-tools.ui-settings-mirror");
type HookedStorage = Storage & { [HOOK]?: (storage: Storage, key: string | null) => void };

function hookWrites(proto: HookedStorage, listener: (storage: Storage, key: string | null) => void) {
  if (!proto[HOOK]) {
    const { setItem, removeItem, clear } = proto;
    proto.setItem = function setItemMirrored(this: Storage, key: string, value: string) {
      setItem.call(this, key, value);
      proto[HOOK]?.(this, String(key));
    };
    proto.removeItem = function removeItemMirrored(this: Storage, key: string) {
      removeItem.call(this, key);
      proto[HOOK]?.(this, String(key));
    };
    proto.clear = function clearMirrored(this: Storage) {
      clear.call(this);
      proto[HOOK]?.(this, null);
    };
  }
  proto[HOOK] = listener;
}

export function installUiSettingsMirror({
  storage,
  bridge,
  target,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now = () => Date.now(),
}: UiSettingsMirrorOptions): { restored: number; mirroring: boolean; flush: () => void } {
  let restored = 0;
  let mirroring = typeof bridge?.saveUiSettingsMirror === "function";
  if (!hasAppKey(storage)) {
    // None of the app's keys: the store was reset (or this is the first start). An unreadable copy
    // stays untouched for this run: mirroring this near-empty store would replace the only copy.
    const loaded = bridge?.loadUiSettingsMirror?.();
    if (!loaded || loaded.ok !== true) mirroring = false;
    else {
      for (const [key, value] of Object.entries(loaded.entries ?? {})) {
        if (!isMirroredUiKey(key) || typeof value !== "string") continue;
        try {
          storage.setItem(key, value);
          restored += 1;
        } catch { /* The store is full; the rest stays in the copy. */ }
      }
      if (restored) console.info(`Coding Tools restored ${restored} window settings from its copy after the store was reset`);
    }
  }
  let timer: unknown = null;
  let firstAt = 0;
  let lastSent: string | null = null;
  const send = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const entries = appEntries(storage);
    const text = JSON.stringify(entries);
    if (text === lastSent) return;
    lastSent = text;
    try {
      bridge?.saveUiSettingsMirror?.(entries);
    } catch {
      lastSent = null;
    }
  };
  // Quiet for 1.5 s, or at most every 10 s while changes keep coming (a divider being dragged).
  const schedule = () => {
    const at = now();
    if (timer === null) firstAt = at;
    else clearTimer(timer);
    timer = setTimer(send, Math.max(0, Math.min(MIRROR_DEBOUNCE_MS, firstAt + MIRROR_MAX_WAIT_MS - at)));
  };
  const flush = () => {
    if (timer !== null) send();
  };
  if (mirroring) {
    hookWrites(Object.getPrototypeOf(storage) as HookedStorage, (written, key) => {
      if (written === storage && (key === null || isMirroredUiKey(key))) schedule();
    });
    // A change made just before the window closes or reloads is sent at once.
    target?.addEventListener("pagehide", flush);
    target?.addEventListener("beforeunload", flush);
  }
  return { restored, mirroring, flush };
}
