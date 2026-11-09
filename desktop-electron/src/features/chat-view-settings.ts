/**
 * How a chat draws its work, kept on this computer: whether a chat on a mission keeps its work
 * expanded (Settings › Chat), its thoughts and steps open while it works and through every round of
 * the goal it pursues. Every open chat follows a change at once, made here or in another window.
 */

export const MISSION_WORK_KEY = "coding-tools:ao:mission-work";
const CHANGED = "coding-tools:mission-work";
/** This window's choice when the browser's storage cannot keep it: it holds until a restart. */
let session: boolean | null = null;

export function readMissionWork(): boolean {
  if (session !== null) return session;
  try { return localStorage.getItem(MISSION_WORK_KEY) !== "off"; } catch { return true; }
}

export function saveMissionWork(on: boolean): boolean {
  try { localStorage.setItem(MISSION_WORK_KEY, on ? "on" : "off"); session = null; } catch { session = on; }
  try { window.dispatchEvent(new Event(CHANGED)); } catch { /* no window (tests) */ }
  return on;
}

/** Calls `listener` with the setting whenever it changes, here or in another window. Returns the unsubscribe. */
export function onMissionWork(listener: (on: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const local = () => listener(readMissionWork());
  const storage = (event: StorageEvent) => {
    if (event.key === MISSION_WORK_KEY || event.key === null) { session = null; local(); }
  };
  window.addEventListener(CHANGED, local);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(CHANGED, local); window.removeEventListener("storage", storage); };
}
