"use strict";

// Keeps the main window usable when its page fails without the renderer process dying. Electron
// already reports a crashed renderer (render-process-gone, reloaded by main.cjs); these went
// unnoticed and left the window black until the app was restarted:
// - A render error unmounts the whole React tree: the page stays loaded with an empty #root.
//   Two checks in a row finding it empty reload the page (`recover`).
// - A renderer that stops responding (an endless loop) never recovers by itself: after
//   UNRESPONSIVE_MS it is crashed on purpose, so the crash path reloads it.
// - Console errors are logged (a few a minute), so the next blank window says why.

const CHECK_MS = 15_000;
const GRACE_MS = 20_000;
const UNRESPONSIVE_MS = 15_000;
const ERRORS_PER_MINUTE = 20;
// Why a page counts as blank: no #root content. -1 (no #root) is a page that is not the app's.
const ROOT_PROBE = "(() => { const root = document.getElementById(\"root\"); return root ? root.childElementCount : -1; })()";

function createRendererWatchdog({ window, logger, recover, setTimer = setTimeout, clearTimer = clearTimeout,
  setRepeat = setInterval, clearRepeat = clearInterval, now = Date.now } = {}) {
  const contents = window.webContents;
  let checker = null, graceTimer = null, unresponsiveTimer = null, emptyChecks = 0, disposed = false;
  const errors = [];
  const stopChecks = () => {
    if (checker) clearRepeat(checker);
    if (graceTimer) clearTimer(graceTimer);
    checker = null; graceTimer = null; emptyChecks = 0;
  };
  const alive = () => !disposed && !window.isDestroyed() && !contents.isDestroyed();
  const check = async () => {
    if (!alive() || contents.isLoading()) return;
    let children;
    try { children = await contents.executeJavaScript(ROOT_PROBE, true); } catch { return; }
    if (children !== 0) { emptyChecks = 0; return; }
    emptyChecks += 1;
    if (emptyChecks < 2) return;
    stopChecks();
    logger?.warn?.("launcher.renderer_blank", { url: contents.getURL() });
    recover("blank");
  };
  // Checks start once a page has loaded and had time to draw; a new load starts them over.
  const onLoaded = () => {
    stopChecks();
    graceTimer = setTimer(() => { graceTimer = null; if (alive()) checker = setRepeat(() => { void check(); }, CHECK_MS); }, GRACE_MS);
  };
  const onStartLoading = () => stopChecks();
  const onUnresponsive = () => {
    logger?.warn?.("launcher.renderer_unresponsive", {});
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimer(() => {
      unresponsiveTimer = null;
      if (!alive()) return;
      logger?.warn?.("launcher.renderer_hung", { seconds: Math.round(UNRESPONSIVE_MS / 1000) });
      // render-process-gone follows, and main.cjs reloads the page from there.
      try { contents.forcefullyCrashRenderer(); } catch { recover("hung"); }
    }, UNRESPONSIVE_MS);
  };
  const onResponsive = () => { if (unresponsiveTimer) clearTimer(unresponsiveTimer); unresponsiveTimer = null; };
  const onConsole = (...args) => {
    // Electron 35+ passes one event with level/message/lineNumber/sourceId; older ones passed them as arguments.
    const event = args[0] ?? {};
    const level = event.level ?? args[1];
    if (!(level === "error" || level === 3)) return;
    const at = now();
    while (errors.length && at - errors[0] > 60_000) errors.shift();
    if (errors.length >= ERRORS_PER_MINUTE) return;
    errors.push(at);
    const message = String(event.message ?? args[2] ?? "").slice(0, 500);
    const source = String(event.sourceId ?? args[4] ?? "").split(/[\\/]/).pop();
    logger?.warn?.("launcher.renderer_console_error", { message, source: `${source}:${event.lineNumber ?? args[3] ?? 0}` });
  };
  contents.on("did-finish-load", onLoaded);
  contents.on("did-start-loading", onStartLoading);
  contents.on("console-message", onConsole);
  window.on("unresponsive", onUnresponsive);
  window.on("responsive", onResponsive);
  return {
    /** For tests: run one blank check now. */
    check,
    dispose() {
      disposed = true;
      stopChecks();
      onResponsive();
    },
  };
}

module.exports = { createRendererWatchdog, CHECK_MS, GRACE_MS, UNRESPONSIVE_MS };
