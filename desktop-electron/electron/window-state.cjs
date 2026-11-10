const fs = require("node:fs");
const path = require("node:path");
const { asyncWritePending, writePrivateFileAtomic, writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const DEFAULT_WINDOW_STATE = Object.freeze({
  bounds: { width: 1120, height: 720 },
  maximized: false,
  fullscreen: false,
});
const MIN_WINDOW_BOUNDS = Object.freeze({ width: 720, height: 600 });
const MAX_WINDOW_DIMENSION = 16_384;

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function overlapsDisplay(bounds, displays) {
  return displays.some((display) => {
    const area = display?.workArea;
    if (!area) return false;
    return bounds.x < area.x + area.width
      && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height
      && bounds.y + bounds.height > area.y;
  });
}

function normalizeWindowState(value, displays = []) {
  const saved = value && typeof value === "object" ? value : {};
  const bounds = saved.bounds && typeof saved.bounds === "object" ? saved.bounds : {};
  const state = {
    bounds: {
      width: Math.min(
        MAX_WINDOW_DIMENSION,
        Math.max(MIN_WINDOW_BOUNDS.width, finiteNumber(bounds.width, DEFAULT_WINDOW_STATE.bounds.width)),
      ),
      height: Math.min(
        MAX_WINDOW_DIMENSION,
        Math.max(MIN_WINDOW_BOUNDS.height, finiteNumber(bounds.height, DEFAULT_WINDOW_STATE.bounds.height)),
      ),
    },
    maximized: saved.maximized === true,
    fullscreen: saved.fullscreen === true,
  };
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    const positioned = { ...state.bounds, x: bounds.x, y: bounds.y };
    if (displays.length === 0 || overlapsDisplay(positioned, displays)) {
      state.bounds.x = bounds.x;
      state.bounds.y = bounds.y;
    }
  }
  return state;
}

function readWindowState(filePath, displays = []) {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(filePath, "utf8")), displays);
  } catch {
    return normalizeWindowState(null, displays);
  }
}

function writeWindowState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function captureWindowState(window) {
  return {
    bounds: window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}

/**
 * `quitting`: whether a close is the app exiting. Without it every close counts as one (the old
 * behaviour). A close that only hides the window to the tray saves off the main thread: the
 * synchronous save (six file operations on the data drive, and up to 1.4 s of Atomics.wait retries
 * when Windows holds the file) ran on every close to the tray. Seen 2026-10-22: a 4.0 s stall with
 * the main process nearly idle, as the window was hidden.
 */
function trackWindowState(window, filePath, onError, { quitting = () => true } = {}) {
  let timer = null;
  // While the window is moved or resized, the position is saved off the main thread: each
  // synchronous atomic write (six file operations, and up to 1.4 s of retries when Windows holds
  // the file) stalled the app on a busy disk, every 400 ms of a drag.
  const captureAsync = () => {
    timer = null;
    if (window.isDestroyed()) return;
    let state;
    try { state = captureWindowState(window); } catch (error) { onError?.(error); return; }
    writePrivateFileAtomicAsync(filePath, `${JSON.stringify(state, null, 2)}\n`).catch((error) => onError?.(error));
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(captureAsync, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    window.on(event, schedule);
  }
  // Closing the app saves synchronously, so the position is on disk before it can exit. The same
  // state is queued after a save still in flight, so an older one cannot land last; with none in
  // flight it is not queued again. The app exited during that second save, which left one
  // window-state.json.tmp-* behind at every quit (50 in the data folder by 2026-11-10).
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (window.isDestroyed()) return;
    try {
      const content = `${JSON.stringify(captureWindowState(window), null, 2)}\n`;
      const exiting = quitting();
      if (exiting) writePrivateFileAtomic(filePath, content);
      if (!exiting || asyncWritePending(filePath)) writePrivateFileAtomicAsync(filePath, content).catch((error) => onError?.(error));
    } catch (error) {
      onError?.(error);
    }
  });
  void removeStaleTemporaries(filePath);
}

/**
 * Removes the temp files a save left when the app exited during it, off the main thread. One newer
 * than `olderThanMs` may still be a save in flight, so it stays.
 */
async function removeStaleTemporaries(filePath, { olderThanMs = 10 * 60_000, now = Date.now } = {}) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.tmp-`;
  let names;
  try { names = await fs.promises.readdir(directory); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const temporary = path.join(directory, name);
    try {
      const stats = await fs.promises.lstat(temporary);
      if (!stats.isFile() || now() - stats.mtimeMs < olderThanMs) continue;
      await fs.promises.rm(temporary, { force: true });
      removed += 1;
    } catch { /* gone already, or held: the next start tries again */ }
  }
  return removed;
}

module.exports = {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_BOUNDS,
  captureWindowState,
  normalizeWindowState,
  readWindowState,
  removeStaleTemporaries,
  trackWindowState,
  writeWindowState,
};
