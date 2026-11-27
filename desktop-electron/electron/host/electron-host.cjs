"use strict";

// The backend's one door to Electron's desktop services and windows (docs/specs/electron-host-seam
// and electron-host-seam-windows: slices 1 and 2 of the WebView2 plan's phase 1). It hands out the
// methods the backend actually calls, under
// Electron's own names, and nothing else: call sites keep working unchanged, a new use of another
// Electron method fails in tests instead of tying the backend to Electron again, and the coming
// Tauri / WebView2 host implements this same small surface.
//
// Under plain Node (the test harness) require("electron") is the binary's path, not its API: every
// service is then null, as the callers already allow. A service an injected stand-in lacks a
// method of simply lacks it here too, so `typeof x.method === "function"` checks keep their meaning.

/** Each plain service and the methods the backend calls on it (measured 2026-11-27). */
const HOST_SERVICES = Object.freeze({
  safeStorage: Object.freeze(["isEncryptionAvailable", "encryptString", "decryptString"]),
  clipboard: Object.freeze(["writeText"]),
  shell: Object.freeze(["openExternal", "openPath", "showItemInFolder"]),
  powerMonitor: Object.freeze(["on", "removeListener", "getSystemIdleTime"]),
  powerSaveBlocker: Object.freeze(["start", "stop", "isStarted"]),
  // Slice 2 (docs/specs/electron-host-seam-windows): the modules around windows.
  screen: Object.freeze(["getPrimaryDisplay", "getDisplayNearestPoint", "getCursorScreenPoint", "getAllDisplays", "dipToScreenRect"]),
  dialog: Object.freeze(["showMessageBox", "showOpenDialog", "showSaveDialog", "showErrorBox"]),
  Menu: Object.freeze(["buildFromTemplate"]),
  nativeImage: Object.freeze(["createFromPath", "createFromDataURL"]),
});
/**
 * The window classes pass through as Electron's own (slice 2): their instances must stay real
 * Electron windows until the WebView2 host exists, and Electron hands them back in events. Listed
 * here with the statics the backend calls; design.md records the methods called on their
 * instances, the contract the WebView2 host meets.
 */
const HOST_CLASSES = Object.freeze({
  BrowserWindow: Object.freeze(["fromWebContents", "getAllWindows"]),
  BaseWindow: Object.freeze([]),
  Tray: Object.freeze([]),
});
/** The other two, which are not plain method sets: a settable property and a class. */
const HOST_SPECIAL = Object.freeze({
  nativeTheme: Object.freeze(["themeSource"]),
  Notification: Object.freeze(["isSupported", "new", "show", "on"]),
});

/**
 * `source`'s listed methods, each calling through to it (so `this` stays the source). Each is
 * looked up when it is read, as the callers' own `powerMonitor.on` was: some of Electron's
 * services must not be touched before the app is ready, and building the host happens at load.
 * A method the source lacks reads as undefined.
 */
function pick(source, methods) {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return null;
  const picked = {};
  for (const name of methods) {
    Object.defineProperty(picked, name, {
      enumerable: true,
      get: () => (typeof source[name] === "function" ? (...args) => source[name](...args) : undefined),
    });
  }
  return Object.freeze(picked);
}

/** nativeTheme's one property the backend sets and reads. */
function themeOf(nativeTheme) {
  if (!nativeTheme || typeof nativeTheme !== "object") return null;
  return Object.freeze(Object.defineProperty({}, "themeSource", {
    enumerable: true,
    get: () => nativeTheme.themeSource,
    set: (value) => { nativeTheme.themeSource = value; },
  }));
}

/** A desktop notification class with Electron's shape: isSupported(), new (options), show(), on(). */
function notificationOf(Native) {
  if (typeof Native !== "function") return null;
  return class Notification {
    static isSupported() {
      return typeof Native.isSupported === "function" ? Native.isSupported() === true : false;
    }
    constructor(options) {
      this.native = new Native(options);
    }
    show() {
      this.native.show();
    }
    on(event, listener) {
      this.native.on(event, listener);
      return this;
    }
  };
}

/** The host's desktop services, built from an Electron module (or a stand-in with the same shape). */
function createElectronHost(electron) {
  const api = electron && typeof electron === "object" ? electron : {};
  return Object.freeze({
    safeStorage: pick(api.safeStorage, HOST_SERVICES.safeStorage),
    clipboard: pick(api.clipboard, HOST_SERVICES.clipboard),
    shell: pick(api.shell, HOST_SERVICES.shell),
    powerMonitor: pick(api.powerMonitor, HOST_SERVICES.powerMonitor),
    powerSaveBlocker: pick(api.powerSaveBlocker, HOST_SERVICES.powerSaveBlocker),
    nativeTheme: themeOf(api.nativeTheme),
    Notification: notificationOf(api.Notification),
    screen: pick(api.screen, HOST_SERVICES.screen),
    dialog: pick(api.dialog, HOST_SERVICES.dialog),
    Menu: pick(api.Menu, HOST_SERVICES.Menu),
    nativeImage: pick(api.nativeImage, HOST_SERVICES.nativeImage),
    BrowserWindow: classOf(api.BrowserWindow),
    BaseWindow: classOf(api.BaseWindow),
    Tray: classOf(api.Tray),
  });
}

/** Electron's own class, or null under plain Node. */
function classOf(Native) {
  return typeof Native === "function" ? Native : null;
}

// No shared instance: each caller builds its host from the require("electron") it loaded, as it
// destructured Electron before. A test that reloads a module with another Electron stand-in then
// gets that stand-in's services, not a previous one's.
module.exports = { HOST_SERVICES, HOST_SPECIAL, HOST_CLASSES, createElectronHost };
