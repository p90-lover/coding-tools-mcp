"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createChatWindows } = require("../electron/chat-windows.cjs");

function fakeElectron() {
  const created = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options; this.destroyed = false; this.loaded = []; this.scripts = []; this.title = options.title;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        executeJavaScript: async (script) => { this.scripts.push(script); return true; },
      });
      created.push(this);
    }
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    setTitle(title) { this.title = title; }
    show() {} focus() {} restore() {}
    close() { this.destroyed = true; this.emit("closed"); }
  }
  return { BrowserWindow, created };
}

const request = (mode = "open", extra = {}) => ({ key: "task-1", title: "Fix the app", page: "<!doctype html><main>v1</main>", body: "v2", mode, ...extra });

test("a chat window is a sandboxed viewer with no preload that cannot navigate or open popups", async () => {
  const { BrowserWindow, created } = fakeElectron();
  const windows = createChatWindows({ BrowserWindow, logger: {} });
  assert.deepEqual(await windows.show(request()), { open: true });
  const [window] = created;
  const prefs = window.options.webPreferences;
  assert.equal(prefs.preload, undefined, "no app API is exposed");
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  assert.deepEqual(window.openHandler(), { action: "deny" });
  let prevented = 0;
  window.webContents.emit("will-navigate", { preventDefault: () => { prevented += 1; } });
  window.webContents.emit("will-redirect", { preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2, "links and redirects never leave the transcript");
  assert.match(window.loaded[0], /^data:text\/html;charset=utf-8,/);
});

test("updates replace the transcript in place, reopen focuses, and a closed window reports open:false", async () => {
  const { BrowserWindow, created } = fakeElectron();
  const windows = createChatWindows({ BrowserWindow, logger: {} });
  assert.deepEqual(await windows.show(request("update")), { open: false }, "an update never opens a window");
  await windows.show(request());
  await windows.show(request("update", { body: "<p>new</p>" }));
  assert.equal(created.length, 1, "one window per chat");
  assert.match(created[0].scripts.at(-1), /"<p>new<\/p>"/, "the body is passed as a JSON string, never spliced as code");
  created[0].close();
  assert.deepEqual(await windows.show(request("update")), { open: false });
});

test("malformed requests are refused", async () => {
  const { BrowserWindow } = fakeElectron();
  const windows = createChatWindows({ BrowserWindow, logger: {} });
  await assert.rejects(windows.show(request("open", { key: "../x" })), /key is invalid/);
  await assert.rejects(windows.show(request("open", { page: 42 })), /page is invalid/);
  await assert.rejects(windows.show(null), /request is invalid/);
});
