"use strict";

// Shared by ui-settings-mirror.test.cjs and the split view test in ao-chat.test.cjs: the page's
// mirror module (src/ui-settings-mirror.ts) in a vm, a Storage stand-in, a clock, and main's
// handlers (electron/ui-settings-mirror.cjs) behind a fake IPC.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const main = require("../../electron/ui-settings-mirror.cjs");

// The repository's aiTemp, as the other tests use: never the system temp folder (C: here).
const scratchRoot = path.resolve(__dirname, "..", "..", "..", "aiTemp");

/** A folder for one test's mirror file, removed when the test ends. */
function mirrorDir(t) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchRoot, "ui-settings-mirror-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A Storage stand-in whose methods live on its prototype, as the real one's do. One class per test. */
function storageType() {
  return class Storage {
    #values = new Map();
    constructor(initial = {}) {
      for (const [key, value] of Object.entries(initial)) this.#values.set(key, String(value));
    }
    get length() { return this.#values.size; }
    key(index) { return [...this.#values.keys()][index] ?? null; }
    getItem(key) { return this.#values.has(String(key)) ? this.#values.get(String(key)) : null; }
    setItem(key, value) { this.#values.set(String(key), String(value)); }
    removeItem(key) { this.#values.delete(String(key)); }
    clear() { this.#values.clear(); }
    toJSON() { return Object.fromEntries([...this.#values].sort(([a], [b]) => (a < b ? -1 : 1))); }
  };
}

function loadPageMirror() {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/ui-settings-mirror.ts"), "utf8");
  const exports = {};
  const logs = [];
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: () => ({}), console: { info: (line) => logs.push(line) }, setTimeout, clearTimeout });
  return Object.assign(exports, { logs });
}

/** Timers that run only when the test moves the clock. */
function fakeClock() {
  let at = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => at,
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { callback, due: at + ms });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const until = at + ms;
      for (;;) {
        const [next] = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due);
        if (!next) break;
        timers.delete(next[0]);
        at = next[1].due;
        next[1].callback();
      }
      at = until;
    },
  };
}

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    fire: (type) => (listeners.get(type) ?? []).forEach((listener) => listener()),
  };
}

/** main's two channels behind a fake ipcMain, and a bridge that clones across them as IPC does. */
function connectMain(mirror, { appFrame = () => true } = {}) {
  const handlers = new Map();
  const channels = main.installUiSettingsMirrorIpc({
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) },
    mirror: () => mirror,
    isAppFrame: (event) => appFrame(event),
  });
  const calls = { loads: 0, saves: [] };
  const bridge = {
    loadUiSettingsMirror() {
      calls.loads += 1;
      const event = { sender: {} };
      handlers.get(main.LOAD_CHANNEL)(event);
      return structuredClone(event.returnValue);
    },
    saveUiSettingsMirror(entries) {
      const copy = structuredClone(entries);
      calls.saves.push(copy);
      handlers.get(main.SAVE_CHANNEL)({ sender: {} }, copy);
    },
  };
  return { bridge, calls, channels, handlers };
}

module.exports = { connectMain, fakeClock, fakeWindow, loadPageMirror, main, mirrorDir, storageType };
