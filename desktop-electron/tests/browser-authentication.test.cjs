const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");

const HOME = "https://chatgpt.com/";
const tick = () => new Promise(resolve => setImmediate(resolve));
const surface = authenticated => ({ url: HOME, composer: true, savedHome: true, temporary: false, readyState: "complete", sessionAuthenticated: authenticated, sessionAnswered: true, sessionStatus: 200, sessionCheckError: null });
function session() { return { resolveProxy: async () => "DIRECT", cookies: new EventEmitter(), webRequest: { onCompleted() {} } }; }
function fixture(browserSession = session()) {
  const contents = new EventEmitter();
  let url = HOME;
  Object.assign(contents, { session: browserSession, isDestroyed: () => false, isCrashed: () => false, getURL: () => url, executeJavaScript: async () => surface(true), loadURL: async value => { url = value; }, close() {} });
  const records = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents }, partition: "persist:coding-tools-chatgpt-aaaaaaaaaaaa", state: { authenticated: false },
    getBrowserInteractionMode: () => "automatic", logger: { info() {}, warn() {}, error() {} },
    recoverySessions: new Set(), turnTabs: new Map(), userTabs: new Map(), parkedHomes: new Map(), shellZoomShortcutBindings: new Map(), powerSaveBlockerId: null,
    window: { off() {}, contentView: { removeChildView() {} } },
    snapshot() { return { ...this.state }; }, setState(value) { Object.assign(this.state, value); records.push({ ...this.state }); },
  });
  return { host, contents, records, browserSession };
}

test("overlapping authentication checks issue one page probe and allow the next check", async () => {
  const { host, contents } = fixture();
  let release, calls = 0;
  contents.executeJavaScript = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = host.probeAuthentication(), second = host.probeAuthentication();
  await tick();
  try { assert.equal(calls, 1); }
  finally { release(surface(true)); }
  await Promise.all([first, second]);
  contents.executeJavaScript = async () => { calls++; return surface(false); };
  assert.equal((await host.probeAuthentication()).authenticated, false);
  assert.equal(calls, 2);
});

test("a cookie removal invalidates an older successful page probe before it publishes", async () => {
  const { host, contents, browserSession, records } = fixture();
  host.bindChatGptBackendRecovery(browserSession);
  let release, calls = 0;
  contents.executeJavaScript = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(surface(false));
  const pending = host.probeAuthentication(); await tick();
  browserSession.cookies.emit("changed", {}, { httpOnly: true, domain: ".chatgpt.com" }, "explicit", true);
  release(surface(true)); await pending;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(host.state.authenticated, false);
  assert.equal(records.some(value => value.authenticated === true), false);
  assert.equal(calls, 2);
});

test("an old account check cannot return the newly selected account's authenticated state", async () => {
  const { host, contents } = fixture();
  let release;
  contents.executeJavaScript = () => new Promise(resolve => { release = resolve; });
  const pending = host.probeAuthentication(); await tick();
  host.view = fixture().host.view;
  host.partition = "persist:coding-tools-chatgpt-bbbbbbbbbbbb";
  host.state.authenticated = true;
  release(surface(true));
  assert.equal((await pending).authenticated, false);
  assert.equal(host.state.authenticated, true);
});

test("parked-account cookie changes do not check the active account and listeners are removed", async () => {
  const { host, contents, browserSession } = fixture(), parked = session();
  let calls = 0;
  contents.executeJavaScript = async () => { calls++; return surface(true); };
  host.bindChatGptBackendRecovery(browserSession); host.bindChatGptBackendRecovery(parked);
  assert.equal(browserSession.cookies.listenerCount("changed"), 1);
  assert.equal(parked.cookies.listenerCount("changed"), 1);
  parked.cookies.emit("changed", {}, { httpOnly: true, domain: ".chatgpt.com" }, "explicit", true);
  await tick(); assert.equal(calls, 0);
  browserSession.cookies.emit("changed", {}, { httpOnly: true, domain: ".chatgpt.com" }, "explicit", true);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls, 1); assert.equal(host.state.authenticated, true);
  host.destroy();
  assert.equal(browserSession.cookies.listenerCount("changed"), 0);
  assert.equal(parked.cookies.listenerCount("changed"), 0);
});

test("a pending embedded login can hand its existing operation to passkey login", async () => {
  const { host } = fixture();
  let entered, release, imports = 0;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  Object.assign(host, {
    show() {}, activateHomeSurface() {}, withManualOperation: async (_name, run) => run(),
    probeAuthentication: async () => ({ authenticated: false }),
    waitForAuthenticated: async (_timeout, switchMode) => { entered(); await gate; return switchMode?.() ? null : { authenticated: false }; },
    loginWithPasskey: async () => { imports++; return { transferId: "fixture-transfer" }; },
    installPasskeyLogin: async () => ({ authenticated: true }), runSessionInspection: async () => {},
  });
  const embedded = host.openLogin(); await waiting;
  const passkey = host.openPasskeyLogin();
  try { assert.equal(passkey, embedded); } finally { release(); }
  assert.equal((await passkey).authenticated, true);
  assert.equal(imports, 1);
});

test("Windows sign-in opens the isolated Chrome flow without navigating the embedded page", async () => {
  const { host, contents } = fixture();
  let opened = 0;
  host.externalLogin = true;
  host.openPasskeyLogin = async () => { opened++; return { authenticated: false }; };
  contents.loadURL = async () => assert.fail("sign-in must not navigate the embedded browser");
  await host.openLogin();
  assert.equal(opened, 1);
});

test("a Chrome transfer cannot be imported after its account surface changes", async () => {
  const { host } = fixture();
  let cleaned = 0, imported = 0;
  host.loginWithPasskey = async partition => {
    assert.equal(partition, "fixture-account");
    host.partition = "another-account";
    return { cleanup: async () => { cleaned++; } };
  };
  host.partition = "fixture-account";
  host.installPasskeyLogin = async () => { imported++; };
  await assert.rejects(host.runPasskeyLogin(), /account.*changed/i);
  assert.equal(cleaned, 1);
  assert.equal(imported, 0);
});

test("Chrome login refuses per-host proxy differences before opening or importing", async () => {
  const { host, browserSession } = fixture();
  browserSession.resolveProxy = async url => new URL(url).hostname === "accounts.google.com" ? "DIRECT" : "PROXY 127.0.0.1:32123";
  host.loginWithPasskey = async () => assert.fail("must not sign in on a different route");
  await assert.rejects(host.runPasskeyLogin(), /different proxy routes/);
});

test("recent authentication history cannot turn an inconclusive readiness check into a pass", async () => {
  const { host } = fixture();
  host.lastAuthenticatedAt = Date.now();
  host.checkAuthenticationReadiness = async () => ({ authenticated: null, ready: false });
  assert.deepEqual(await host.authenticationReadiness(), { authenticated: null, ready: false });
  host.checkAuthenticationReadiness = async () => ({ authenticated: true, ready: true });
  assert.deepEqual(await host.authenticationReadiness(), { authenticated: true, ready: true });
});

test("the inactive primary view remains drawable outside the app instead of losing its target", () => {
  const calls = [], outside = { x: 1001, y: 801, width: 1000, height: 800 };
  const host = { surfaceActive: false, homeTabClosed: false, bounds: { x: 20, y: 80, width: 900, height: 700 }, hiddenTurnBounds: () => outside,
    view: { setBounds: value => calls.push(["bounds", value]), setVisible: value => calls.push(["visible", value]) }, hideView: () => calls.push(["visible", false]) };
  BrowserHost.prototype.presentPrimaryView.call(host, false);
  assert.deepEqual(calls, [["bounds", outside], ["visible", true]]);
  calls.length = 0; host.surfaceActive = true;
  BrowserHost.prototype.presentPrimaryView.call(host, true);
  assert.deepEqual(calls, [["bounds", host.bounds], ["visible", true]]);
});

test("session verification accepts only the exact JSON session response", async () => {
  const { readChatGptAuthSession } = require("../electron/chatgpt-auth-session.cjs");
  const valid = { user: { id: "fixture-user" }, expires: new Date(Date.now() + 60000).toISOString() };
  const fetchResponse = payload => async (url, options) => {
    assert.equal(url, HOME + "api/auth/session"); assert.equal(options.redirect, "error"); assert.equal(options.credentials, "include");
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(await readChatGptAuthSession(fetchResponse(valid), HOME.slice(0, -1), 30), { sessionAuthenticated: true, sessionCheckError: null });
  for (const payload of [{}, { user: {} }, { ...valid, error: "expired" }, { ...valid, expires: "2000-01-01" }]) {
    assert.equal((await readChatGptAuthSession(fetchResponse(payload), HOME.slice(0, -1), 30)).sessionAuthenticated, false);
  }
  for (const response of [new Response("blocked", { status: 403 }), new Response("<html>", { headers: { "content-type": "text/html" } }), new Response("invalid", { headers: { "content-type": "application/json" } })]) {
    const result = await readChatGptAuthSession(async () => response, HOME.slice(0, -1), 30);
    assert.equal(result.sessionAuthenticated, false); assert.ok(result.sessionCheckError);
  }
});

test("page checks reject navigation and stop waiting for a dead renderer", async () => {
  const { runBrowserPageScript } = require("../electron/browser-page-script.cjs");
  const { contents } = fixture(); contents.executeJavaScript = () => new Promise(() => {});
  const changed = runBrowserPageScript(contents, "fixture", 100);
  contents.emit("did-start-navigation", {}, HOME, false, true);
  await assert.rejects(changed, /changed/);
  const dead = runBrowserPageScript(contents, "fixture", 100);
  contents.emit("render-process-gone");
  await assert.rejects(dead, /renderer/);
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(runBrowserPageScript(contents, "fixture", 5), /timed out/); }
  finally { clearTimeout(keepAlive); }
});
