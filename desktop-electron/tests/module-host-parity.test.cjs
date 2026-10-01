"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map();
const handlers = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(file));
  if (ts.isCallExpression(node) && node.expression.getText(file) === "handle"
    && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
    handlers.set(node.arguments[0].text, node.arguments[1].getText(file));
  }
  ts.forEachChild(node, visit);
}
visit(file);

test("Codex route waits for authenticated browser evidence and retries after login or refresh", async () => {
  assert.ok(functions.has("connectCodexBridgeAfterAuthentication"));
  const calls = [];
  const browser = { authenticated: false };
  const state = { browserInteractionMode: "automatic" };
  const context = vm.createContext({
    quitting: false, shutdownInProgress: false, IS_DEV_PROFILE: false,
    runtimeHost: {
      runtimeConfigSnapshot: () => ({ configured: true }),
      connectBridgeRoute: async () => { calls.push("route"); return { changed: true }; },
    },
    runtimeSupervisor: { startIfConfigured: async () => { calls.push("runtime"); return { status: "ready" }; } },
    browserHost: { snapshot: () => browser },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    logger: { info() {}, warn() {} },
    waitForRuntimeHostIdle: async () => {},
    applyReadyRuntimeAfterBridge() {},
    send() {}, nextSessionRefreshReminderAt: () => 1,
    codexBridgeConnectInFlight: null,
  });
  const connect = vm.runInContext(`(${functions.get("connectCodexBridgeAfterAuthentication")})`, context);
  assert.equal((await connect({ logger: context.logger, stateStore: context.stateStore })).reason, "unauthenticated");
  assert.deepEqual(calls, []);
  browser.authenticated = true;
  assert.equal((await connect({ logger: context.logger, stateStore: context.stateStore })).connected, true);
  assert.deepEqual(calls, ["runtime", "route"]);

  for (const [channel, action] of [
    ["launcher:browser-login", "openLogin"],
    ["launcher:browser-refresh-auth", "refreshAuthentication"],
    ["launcher:browser-passkey-login", "openPasskeyLogin"],
  ]) {
    assert.ok(handlers.has(channel), channel);
    let scheduled = 0;
    const handler = vm.runInNewContext(`(${handlers.get(channel)})`, {
      browserHost: { [action]: async () => ({ authenticated: true }) },
      stateStore: context.stateStore,
      nextSessionRefreshReminderAt: () => 1,
      send() {},
      scheduleCodexBridgeAutoConnect: () => { scheduled += 1; },
      logger: context.logger,
    });
    await handler();
    assert.equal(scheduled, 1, channel);
  }
});

test("host window installs the private CPA panel session on its webContents", () => {
  const createWindow = functions.get("createWindow");
  assert.ok(createWindow);
  const installed = [];
  const contents = { on() {}, setWindowOpenHandler() {} };
  class Window {
    webContents = contents;
    setMenuBarVisibility() {}
    on() {}
    once() {}
  }
  const context = {
    process: { platform: "win32" }, BrowserWindow: Window,
    stateStore: { read: () => ({ onboardingComplete: true }) },
    readWindowState: () => ({ bounds: { width: 1000, height: 700 }, maximized: false, fullscreen: false }),
    screen: { getAllDisplays: () => [] }, MIN_WINDOW_BOUNDS: { width: 500, height: 400 },
    LAUNCHER_PROFILE: { displayName: "Coding Tools" }, APP_ICON_PATH: "icon",
    path, __dirname: "electron", webFrameMain: {},
    externalServicesController: { cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "private" }) },
    installCpaPanelSession: options => installed.push(options),
    rendererNavigationAllowed: () => true, openWebUrl: async () => {},
    quitting: false, tray: null, requestQuit() {}, send() {}, trackWindowState() {},
    logger: { warn() {}, info() {} }, cdpPort: 0,
  };
  const window = vm.runInNewContext(`(${createWindow})`, context)({
    logger: context.logger, stateStore: context.stateStore, windowStatePath: "state", startHidden: true,
  });
  assert.equal(window.webContents, contents);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].webContents, contents);
  assert.deepEqual({ ...installed[0].getConnection() }, {
    baseUrl: "http://127.0.0.1:8317", managementKey: "private",
  });
});
