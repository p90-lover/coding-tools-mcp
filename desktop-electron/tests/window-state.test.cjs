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
