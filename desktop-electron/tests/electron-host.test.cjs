"use strict";

// The host interface's first slice (docs/specs/electron-host-seam): the backend reaches Electron's
// desktop services only through electron/host/electron-host.cjs, and no file starts loading
// Electron again. Phase 1 of the WebView2 plan; a Tauri host implements the same surface later.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HOST_SERVICES, HOST_SPECIAL, createElectronHost } = require("../electron/host/electron-host.cjs");

const ELECTRON_DIR = path.join(__dirname, "..", "electron");

function fakeElectron() {
  const calls = [];
  const record = (name) => function (...args) { calls.push({ name, args, self: this }); return `${name}-result`; };
  const service = (prefix, methods) => Object.fromEntries(methods.map((method) => [method, record(`${prefix}.${method}`)]));
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { calls.push({ name: "Notification.new", args: [options] }); this.handlers = {}; }
    show() { calls.push({ name: "Notification.show", args: [] }); }
    on(event, handler) { this.handlers[event] = handler; calls.push({ name: "Notification.on", args: [event] }); }
  }
  const electron = {
    safeStorage: { ...service("safeStorage", HOST_SERVICES.safeStorage), getSelectedStorageBackend: record("safeStorage.getSelectedStorageBackend") },
    clipboard: { ...service("clipboard", HOST_SERVICES.clipboard), readText: record("clipboard.readText") },
    shell: { ...service("shell", HOST_SERVICES.shell), trashItem: record("shell.trashItem") },
    powerMonitor: service("powerMonitor", HOST_SERVICES.powerMonitor),
    powerSaveBlocker: service("powerSaveBlocker", HOST_SERVICES.powerSaveBlocker),
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
    Notification: FakeNotification,
  };
  return { electron, calls };
}

test("the host hands out only the desktop methods the backend calls, each calling through to Electron", () => {
  const { electron, calls } = fakeElectron();
  const host = createElectronHost(electron);
  for (const [name, methods] of Object.entries(HOST_SERVICES)) {
    assert.deepEqual(Object.keys(host[name]).sort(), [...methods].sort(), `${name} exposes exactly its listed methods`);
  }
  assert.equal(host.clipboard.readText, undefined, "an Electron method the backend doesn't call is not there");
  assert.equal(host.shell.trashItem, undefined);
  assert.equal(host.safeStorage.getSelectedStorageBackend, undefined);
  assert.ok(Object.isFrozen(host) && Object.isFrozen(host.shell));

  assert.equal(host.shell.openExternal("https://example.com", { activate: true }), "shell.openExternal-result");
  host.safeStorage.encryptString("secret");
  host.powerSaveBlocker.start("prevent-app-suspension");
  const forwarded = calls.map(({ name, args }) => [name, args]);
  assert.deepEqual(forwarded, [
    ["shell.openExternal", ["https://example.com", { activate: true }]],
    ["safeStorage.encryptString", ["secret"]],
    ["powerSaveBlocker.start", ["prevent-app-suspension"]],
  ]);
  assert.equal(calls[0].self, electron.shell, "Electron's method runs with its own object as `this`");
});

test("the theme and notifications keep Electron's shapes", () => {
  const { electron, calls } = fakeElectron();
  const host = createElectronHost(electron);
  assert.equal(host.nativeTheme.themeSource, "system");
  host.nativeTheme.themeSource = "dark";
  assert.equal(electron.nativeTheme.themeSource, "dark", "setting it sets Electron's");
  assert.deepEqual(Object.keys(host.nativeTheme), HOST_SPECIAL.nativeTheme);

  assert.equal(host.Notification.isSupported(), true);
  let clicked = false;
  const notice = new host.Notification({ title: "An agent is waiting for your approval" });
  assert.equal(notice.on("click", () => { clicked = true; }), notice, "on() chains as Electron's does");
  notice.show();
  notice.native.handlers.click();
  assert.equal(clicked, true);
  assert.deepEqual(calls.map(({ name }) => name), ["Notification.new", "Notification.on", "Notification.show"]);
});

test("under plain Node, where require('electron') is a path, every service is null; a stand-in's missing method stays missing", () => {
  const host = createElectronHost("C:\\electron\\electron.exe");
  for (const name of [...Object.keys(HOST_SERVICES), ...Object.keys(HOST_SPECIAL)]) assert.equal(host[name], null, name);
  const partial = createElectronHost({ powerSaveBlocker: { start: () => 1 } });
  assert.equal(typeof partial.powerSaveBlocker.start, "function");
  assert.equal(partial.powerSaveBlocker.isStarted, undefined, "callers' `typeof x.isStarted === 'function'` checks keep their meaning");
  assert.equal(createElectronHost({ Notification: { isSupported: () => true } }).Notification, null, "not a class: no notifications");
});

test("building the host reads no service method; each is looked up when the backend uses it", () => {
  // Some of Electron's services must not be touched before the app is ready, and both main.cjs and
  // browser-host.cjs build their host at load, before ready. Their old `powerMonitor.on` reads
  // happened at use; so do these.
  const reads = [];
  const watched = new Proxy({ on: () => "on" }, { get(target, key) { reads.push(String(key)); return target[key]; } });
  const host = createElectronHost({ powerMonitor: watched });
  assert.deepEqual(reads, [], "nothing read while building");
  assert.equal(typeof host.powerMonitor.on, "function");
  assert.equal(host.powerMonitor.on("resume", () => {}), "on");
  assert.ok(reads.includes("on"), "read when used");
});

// The ratchet. Files that may still load Electron, and the names each may still import from it; each
// slice of the seam removes entries, never adds them. Slice 1 moved the desktop services.
const MAY_LOAD_ELECTRON = new Map([
  ["main.cjs", ["app", "BrowserWindow", "BaseWindow", "WebContentsView", "dialog", "ipcMain", "Menu", "net", "nativeImage", "screen", "session", "Tray", "webFrameMain", "webContents"]],
  ["browser-host.cjs", ["WebContentsView"]],
  ["main-with-provider.cjs", null],
  // The Electron implementation of the host interface: the one place Electron belongs.
  ["host/electron-host.cjs", null],
  ["preload.cjs", ["contextBridge", "ipcRenderer", "webUtils"]],
]);
const MOVED_BEHIND_HOST = ["clipboard", "nativeTheme", "Notification", "safeStorage", "shell", "powerMonitor", "powerSaveBlocker"];

function backendFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : backendFiles(full, base);
    return /\.(c|m)?js$/.test(entry.name) ? [path.relative(base, full).split(path.sep).join("/")] : [];
  });
}

test("no backend file starts loading Electron, and Electron names moved behind the host stay moved", () => {
  const loads = /require\(\s*["']electron["']\s*\)/;
  const offenders = backendFiles(ELECTRON_DIR).filter((file) => loads.test(fs.readFileSync(path.join(ELECTRON_DIR, file), "utf8")) && !MAY_LOAD_ELECTRON.has(file));
  assert.deepEqual(offenders, [], "these files load Electron directly; take the service from the host interface instead");

  for (const [file, allowed] of MAY_LOAD_ELECTRON) {
    if (!allowed) continue;
    const source = fs.readFileSync(path.join(ELECTRON_DIR, file), "utf8");
    const imported = [...source.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(\s*["']electron["']\s*\)/g)]
      .flatMap((match) => match[1].split(",").map((part) => part.trim().split(":")[0].trim()).filter(Boolean));
    assert.ok(imported.length, `${file} still destructures Electron (update this list if that changed)`);
    for (const name of imported) assert.ok(allowed.includes(name), `${file} imports ${name} from Electron; it is not on its list`);
    for (const name of MOVED_BEHIND_HOST) {
      assert.ok(!imported.includes(name), `${file} imports ${name} from Electron; it comes from the host interface`);
      assert.doesNotMatch(source, new RegExp(String.raw`require\(\s*["']electron["']\s*\)\s*\.\s*${name}\b`), `${file} reaches ${name} on Electron directly`);
    }
  }
});
