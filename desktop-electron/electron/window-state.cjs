const fs = require("node:fs");
const { writePrivateFileAtomic, writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

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

function trackWindowState(window, filePath, onError) {
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
  // Closing saves synchronously, so the position is on disk before the app can exit. The same state
  // is queued after any save still in flight, so an older one cannot land last.
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (window.isDestroyed()) return;
    try {
      const content = `${JSON.stringify(captureWindowState(window), null, 2)}\n`;
      writePrivateFileAtomic(filePath, content);
      writePrivateFileAtomicAsync(filePath, content).catch(() => {});
    } catch (error) {
      onError?.(error);
    }
  });
}

module.exports = {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_BOUNDS,
  captureWindowState,
  normalizeWindowState,
  readWindowState,
  trackWindowState,
  writeWindowState,
};
