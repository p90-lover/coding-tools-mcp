import { createContext, useCallback, useContext, useRef } from "react";

/**
 * True while the window is hidden in the tray or minimized. The main process serves app calls
 * only to a visible main window, so background polls skip those ticks instead of failing (and
 * reporting an error the user never caused). Screens refresh on the next tick once shown again.
 */
export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Whether the tab a screen is drawn in is hidden: tabs stay mounted after a visit (App's keepAlive). */
export const SurfaceHiddenContext = createContext(false);

/**
 * For a screen's polls: true while the window is hidden or the screen's own tab is. A tab stays
 * mounted once visited, and its polls kept running behind every other tab; the chat's alone read
 * the headless service several times a second (~45% of a core there) with nobody looking. A
 * stable function, so a poll set up once still sees the tab come and go.
 */
export function useSurfaceHidden(): () => boolean {
  const hidden = useContext(SurfaceHiddenContext);
  const current = useRef(hidden);
  current.current = hidden;
  return useCallback(() => pageHidden() || current.current, []);
}

/**
 * For polls that run git (each a walk of the working tree on disk): true while you are in another
 * app. On a busy hard disk those polls kept git reading the whole tree every few seconds with
 * nobody looking at the result; they refresh when the window has focus again (onWindowFocus).
 */
export function windowUnfocused(): boolean {
  return typeof document !== "undefined" && typeof document.hasFocus === "function" && !document.hasFocus();
}

/** Runs `refresh` when the window gets focus back. Returns the unsubscribe. */
export function onWindowFocus(refresh: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  window.addEventListener("focus", refresh);
  return () => window.removeEventListener("focus", refresh);
}

/**
 * Runs `refresh` as soon as AO pushes a change (a role's message, reasoning or tool call, or a
 * mission's run state), so screens update without waiting for their next poll. Polls stay as the
 * fallback when the push is unavailable. Returns the unsubscribe.
 */
export function onAoPush(refresh: (change: { sessions: string[]; runs: string[]; moved?: { from: string; to: string; taskId: string }[] }) => void): () => void {
  const launcher = typeof window === "undefined" ? undefined : window.codexWebLauncher;
  return launcher?.onAoChanged?.(refresh) ?? (() => {});
}
