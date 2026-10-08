/**
 * True while the window is hidden in the tray or minimized. The main process serves app calls
 * only to a visible main window, so background polls skip those ticks instead of failing (and
 * reporting an error the user never caused). Screens refresh on the next tick once shown again.
 */
export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Runs `refresh` as soon as AO pushes a change (a role's message, reasoning or tool call, or a
 * mission's run state), so screens update without waiting for their next poll. Polls stay as the
 * fallback when the push is unavailable. Returns the unsubscribe.
 */
export function onAoPush(refresh: (change: { sessions: string[]; runs: string[] }) => void): () => void {
  const launcher = typeof window === "undefined" ? undefined : window.codexWebLauncher;
  return launcher?.onAoChanged?.(refresh) ?? (() => {});
}
