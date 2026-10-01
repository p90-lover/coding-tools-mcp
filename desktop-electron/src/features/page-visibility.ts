/**
 * True while the window is hidden in the tray or minimized. The main process serves app calls
 * only to a visible main window, so background polls skip those ticks instead of failing (and
 * reporting an error the user never caused). Screens refresh on the next tick once shown again.
 */
export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
