/**
 * The chat list's own settings (how many chats a project shows, whether working chats stay on
 * top), kept on this computer. The sidebar's "Chat list" popover and Settings › Chat both change
 * them, so each reads them here and follows a change made in the other at once: the sidebar read
 * them once when it mounted, so a change in Settings showed only after a restart.
 */

export type ChatListSettings = { visible: number; keepActiveOnTop: boolean };
export const CHAT_LIST_SETTINGS_KEY = "coding-tools:ao:chat-list-settings";
export const DEFAULT_CHAT_LIST_SETTINGS: ChatListSettings = { visible: 5, keepActiveOnTop: true };
const CHANGED = "coding-tools:chat-list-settings";

export function parseChatListSettings(raw: string | null): ChatListSettings {
  let value: Partial<ChatListSettings> | null = null;
  try { value = JSON.parse(raw || "null"); } catch { /* The defaults. */ }
  const visible = Number.isInteger(value?.visible) && value!.visible! >= 1 && value!.visible! <= 100 ? value!.visible! : DEFAULT_CHAT_LIST_SETTINGS.visible;
  return { visible, keepActiveOnTop: value?.keepActiveOnTop !== false };
}

export function readChatListSettings(): ChatListSettings {
  try { return parseChatListSettings(localStorage.getItem(CHAT_LIST_SETTINGS_KEY)); } catch { return { ...DEFAULT_CHAT_LIST_SETTINGS }; }
}

export function saveChatListSettings(patch: Partial<ChatListSettings>): ChatListSettings {
  const next = parseChatListSettings(JSON.stringify({ ...readChatListSettings(), ...patch }));
  try { localStorage.setItem(CHAT_LIST_SETTINGS_KEY, JSON.stringify(next)); } catch { /* per-session only */ }
  try { window.dispatchEvent(new Event(CHANGED)); } catch { /* no window (tests) */ }
  return next;
}

/** The choices for the archive days (archive_settings takes any whole day from 0 to 365). */
export const ARCHIVE_DAY_CHOICES = [0, 1, 2, 3, 5, 7, 14, 30, 60, 90, 180, 365];
/** "Never" for 0, else "1 day" / "7 days". */
export const archiveDayLabel = (days: number) => (days === 0 ? "Never" : days === 1 ? "1 day" : `${days} days`);
/** The choices offered with the one now set (a value set before these choices existed). */
export const dayChoices = (value: number) => (ARCHIVE_DAY_CHOICES.includes(value) ? ARCHIVE_DAY_CHOICES : [...ARCHIVE_DAY_CHOICES, value].sort((a, b) => a - b));
export const VISIBLE_CHOICES = [3, 5, 8, 10, 15, 20, 30, 50, 100];

/** Calls `listener` with the settings whenever they change, here or in another window. Returns the unsubscribe. */
export function onChatListSettings(listener: (settings: ChatListSettings) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const local = () => listener(readChatListSettings());
  const storage = (event: StorageEvent) => { if (event.key === CHAT_LIST_SETTINGS_KEY || event.key === null) local(); };
  window.addEventListener(CHANGED, local);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(CHANGED, local); window.removeEventListener("storage", storage); };
}
