require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeWindowState,
  readWindowState,
  trackWindowState,
  writeWindowState,
} = require("../electron/window-state.cjs");

test("a moved window is saved off the main thread, and closing saves the final position at once", async () => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-track-"));
  const file = path.join(root, "window-state.json");
  let bounds = { x: 10, y: 10, width: 1000, height: 700 };
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
    getBounds: () => ({ ...bounds }), getNormalBounds: () => ({ ...bounds }),
  });
  const errors = [];
  const { writeFileSync } = fs;
  let syncWrites = 0;
  try {
    trackWindowState(window, file, (error) => errors.push(error));
    fs.writeFileSync = function (target, ...rest) { if (String(target).startsWith(file)) syncWrites += 1; return writeFileSync.call(this, target, ...rest); };
    window.emit("move");
    await new Promise((resolve) => setTimeout(resolve, 700));
    // The background save lands after the delay; on a busy machine it can take longer.
    for (const stop = Date.now() + 5_000; !fs.existsSync(file) && Date.now() < stop;) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(syncWrites, 0, "a drag is not saved synchronously");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds);
    bounds = { x: 50, y: 60, width: 1100, height: 720 };
    window.emit("move");
    window.emit("close");
    assert.equal(syncWrites, 1, "closing saves before the app can exit");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds, "no older save lands afterwards");
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync = writeFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closing the window to the tray saves off the main thread; only quitting saves at once", async () => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-tray-"));
  const file = path.join(root, "window-state.json");
  let bounds = { x: 10, y: 10, width: 1000, height: 700 };
  let quitting = false;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
    getBounds: () => ({ ...bounds }), getNormalBounds: () => ({ ...bounds }),
  });
  const errors = [];
  const { writeFileSync } = fs;
  let syncWrites = 0;
  try {
    trackWindowState(window, file, (error) => errors.push(error), { quitting: () => quitting });
    fs.writeFileSync = function (target, ...rest) { if (String(target).startsWith(file)) syncWrites += 1; return writeFileSync.call(this, target, ...rest); };
    window.emit("close");
    assert.equal(syncWrites, 0, "hiding to the tray never blocks the app on the disk");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds, "the position is still saved");
    bounds = { x: 70, y: 80, width: 1200, height: 760 };
    quitting = true;
    window.emit("close");
    assert.equal(syncWrites, 1, "quitting saves before the app can exit");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync = writeFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function trackedWindow(bounds) {
  const { EventEmitter } = require("node:events");
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
    getBounds: () => ({ ...bounds.current }), getNormalBounds: () => ({ ...bounds.current }),
  });
}

test("quitting saves once and leaves no temp file behind", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-quit-"));
  const file = path.join(root, "window-state.json");
  const bounds = { current: { x: 30, y: 40, width: 1000, height: 700 } };
  const window = trackedWindow(bounds);
  const errors = [];
  const { writeFile } = fs.promises;
  let asyncWrites = 0;
  try {
    trackWindowState(window, file, (error) => errors.push(error), { quitting: () => true });
    fs.promises.writeFile = function (target, ...rest) { if (String(target).startsWith(file)) asyncWrites += 1; return writeFile.call(this, target, ...rest); };
    window.emit("close");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds.current, "the position is on disk before the app exits");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The app exits right after close: a second save then would be cut off with its temp file left.
    assert.equal(asyncWrites, 0, "nothing else is written after the quitting save");
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes(".tmp-")), []);
    assert.deepEqual(errors, []);
  } finally {
    fs.promises.writeFile = writeFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a save still in flight when the app quits cannot land last", async () => {
  const { asyncWritePending } = require("../electron/atomic-file.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-inflight-"));
  const file = path.join(root, "window-state.json");
  const bounds = { current: { x: 10, y: 10, width: 1000, height: 700 } };
  const window = trackedWindow(bounds);
  const errors = [];
  const { rename } = fs.promises;
  try {
    trackWindowState(window, file, (error) => errors.push(error), { quitting: () => true });
    // The drag's save is held at its rename, so it is still in flight at the quit.
    fs.promises.rename = async function (from, to, ...rest) {
      if (String(to) === file) await new Promise((resolve) => setTimeout(resolve, 300));
      return rename.call(this, from, to, ...rest);
    };
    window.emit("move");
    for (const stop = Date.now() + 5_000; !asyncWritePending(file) && Date.now() < stop;) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asyncWritePending(file), true, "the drag's save is in flight");
    bounds.current = { x: 90, y: 100, width: 1200, height: 760 };
    window.emit("close");
    for (const stop = Date.now() + 5_000; asyncWritePending(file) && Date.now() < stop;) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).bounds, bounds.current, "the older save did not land last");
    assert.deepEqual(errors, []);
  } finally {
    fs.promises.rename = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("temp files left by earlier quits are removed off the main thread; a recent one stays", async () => {
  const { removeStaleTemporaries } = require("../electron/window-state.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-stale-"));
  const file = path.join(root, "window-state.json");
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const make = (name, old) => {
    fs.writeFileSync(path.join(root, name), "{}");
    if (old) fs.utimesSync(path.join(root, name), hourAgo, hourAgo);
  };
  make("window-state.json", true);
  make("window-state.json.tmp-13984-1792972638233-257", true);
  make("window-state.json.tmp-47952-1793052284643-46", true);
  make("window-state.json.tmp-51316-1794270355291-21", false);
  make("launcher-state.json.tmp-1-1-1", true);
  const { readdirSync, rmSync, unlinkSync } = fs;
  let syncCalls = 0;
  try {
    Object.assign(fs, {
      readdirSync: (...args) => { syncCalls += 1; return readdirSync(...args); },
      rmSync: (...args) => { syncCalls += 1; return rmSync(...args); },
      unlinkSync: (...args) => { syncCalls += 1; return unlinkSync(...args); },
    });
    assert.equal(await removeStaleTemporaries(file), 2);
  } finally { Object.assign(fs, { readdirSync, rmSync, unlinkSync }); }
  try {
    assert.equal(syncCalls, 0);
    assert.deepEqual(fs.readdirSync(root).sort(), [
      "launcher-state.json.tmp-1-1-1", "window-state.json", "window-state.json.tmp-51316-1794270355291-21",
    ], "only this file's old temp files go");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const displays = [{ workArea: { x: 0, y: 0, width: 1512, height: 982 } }];

test("window state preserves visible bounds and desktop modes", () => {
  assert.deepEqual(normalizeWindowState({
    bounds: { x: 120, y: 80, width: 1280, height: 800 },
    maximized: true,
    fullscreen: false,
  }, displays), {
    bounds: { x: 120, y: 80, width: 1280, height: 800 },
    maximized: true,
    fullscreen: false,
  });
});

test("window state drops off-screen positions and enforces minimum dimensions", () => {
  assert.deepEqual(normalizeWindowState({
    bounds: { x: 9000, y: 9000, width: 200, height: 100 },
  }, displays), {
    bounds: { width: 720, height: 600 },
    maximized: false,
    fullscreen: false,
  });
});

test("window state caps corrupt oversized dimensions", () => {
  const state = normalizeWindowState({
    bounds: { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
  }, displays);
  assert.deepEqual(state.bounds, { width: 16_384, height: 16_384 });
});

test("window state is stored atomically with owner-only permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-state-"));
  const file = path.join(root, "window-state.json");
  try {
    const state = {
      bounds: { x: 20, y: 30, width: 1120, height: 720 },
      maximized: false,
      fullscreen: false,
    };
    writeWindowState(file, state);
    assert.deepEqual(readWindowState(file, displays), state);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
