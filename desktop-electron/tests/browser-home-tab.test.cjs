const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const filename = path.resolve(__dirname, "../electron/browser-host.cjs");
const localRequire = createRequire(filename);
const moduleForTest = { exports: {} };
const loads = [];
class FakeView {
  constructor() {
    this.webContents = { on() {}, setZoomFactor() {}, isDestroyed: () => false,
      getURL: () => "https://chatgpt.com/", getTitle: () => "ChatGPT", isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      loadURL: async url => loads.push(url) };
  }
}
vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
  module: moduleForTest, exports: moduleForTest.exports, process, Buffer, URL,
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  require: name => name === "electron" ? { WebContentsView: FakeView } : localRequire(name),
}, { filename });
const { BrowserHost, IDLE_BROWSER_URL } = moduleForTest.exports;

function fixture() {
  const calls = [];
  let url = IDLE_BROWSER_URL;
  const contents = { isDestroyed: () => false, getURL: () => url, getTitle: () => "ChatGPT", isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    focus: () => calls.push("focus"), loadURL: async value => { url = value; calls.push(value); } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    selectedTabId: "home", partition: "account", turnTabs: new Map(), userTabs: new Map(),
    visible: true, surfaceActive: true, boundsReady: true, view: { webContents: contents, setVisible: value => calls.push(["visible", value]) },
    state: { title: "ChatGPT", status: "ready", authenticated: true, zoomFactor: 1 },
    window: { contentView: { addChildView() {}, removeChildView() {} } },
    syncViewVisibility() {}, publishState() {}, writeDescriptor() {}, bindShellZoomShortcuts() {}, bindUserTabContents() {},
    logger: { info() {}, warn() {}, error() {} }, getUseSavedChats: () => false,
    probeAuthentication: async () => calls.push("probe"),
  });
  return { host, calls, setUrl: value => { url = value; } };
}

test("browser home opens chatgpt.com even when task chats are temporary", async () => {
  const { host, calls } = fixture();
  await host.openHomePage();
  assert.deepEqual(calls, ["https://chatgpt.com/", "probe"]);
});

test("reopening a temporary homepage migrates to normal home, never a saved conversation", async () => {
  const { host, calls, setUrl } = fixture();
  setUrl("https://chatgpt.com/?temporary-chat=true");
  await host.openHomePage(false);
  assert.deepEqual(calls, ["https://chatgpt.com/"]);
  calls.length = 0;
  setUrl("https://chatgpt.com/c/00000000-0000-0000-0000-000000000000");
  await host.openHomePage();
  assert.deepEqual(calls, []);
});

test("a home load taken over by a newer navigation still opens the account; a real failure does not", async () => {
  // Seen 2026-11-03: switching account failed with "(-3) loading 'https://chatgpt.com/'" while the
  // page went on to Cloudflare's check.
  const { host, calls } = fixture();
  host.view.webContents.loadURL = async () => { throw Object.assign(new Error("ERR_ABORTED (-3) loading 'https://chatgpt.com/'"), { code: "ERR_ABORTED", errno: -3 }); };
  await host.openHomePage();
  assert.deepEqual(calls, ["probe"], "the switch carries on to its sign-in check");
  host.view.webContents.loadURL = async () => { throw Object.assign(new Error("ERR_PROXY_CONNECTION_FAILED (-130) loading 'https://chatgpt.com/'"), { code: "ERR_PROXY_CONNECTION_FAILED", errno: -130 }); };
  await assert.rejects(host.openHomePage(), /ERR_PROXY_CONNECTION_FAILED/);
});

test("after a switch, ChatGPT opens without holding the switch, and operations wait for the shown page", async () => {
  const { host, calls } = fixture();
  let finish;
  host.view.webContents.loadURL = (value) => new Promise((resolve) => { finish = () => { calls.push(value); resolve(); }; });
  host.show = () => calls.push("show");
  const done = host.presentHome({ show: true, inspectSession: false });
  assert.deepEqual(calls, ["show"], "the Browser tab shows the account before ChatGPT has loaded");
  let opened = false;
  const waited = host.homeOpened().then(() => { opened = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, false, "an operation waits for the page the switch opened");
  finish();
  await done;
  await waited;
  assert.deepEqual(calls, ["show", "https://chatgpt.com/"]);
  assert.equal(host.homeOpening, null);

  // A page parked by a later switch, or one that never loads, holds nothing for long.
  host.view.webContents.loadURL = () => new Promise(() => {});
  void host.presentHome({ inspectSession: false });
  const started = Date.now();
  await host.homeOpened(20);
  assert.ok(Date.now() - started < 1_000, "the wait is bounded");
  host.view = { webContents: host.view.webContents };
  await host.homeOpened(60_000);
});

test("a page that fails to open after a switch is logged, not thrown at the switch", async () => {
  const { host } = fixture();
  const warnings = [];
  host.logger = { info() {}, error() {}, warn: (event, fields) => warnings.push([event, fields.message]) };
  host.view.webContents.loadURL = async () => { throw new Error("ERR_PROXY_CONNECTION_FAILED (-130) loading 'https://chatgpt.com/'"); };
  await host.presentHome();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "browser.home_open_failed");
  assert.match(warnings[0][1], /ERR_PROXY_CONNECTION_FAILED \(-130\)/);
  assert.equal(host.homeOpening, null);
});

test("new user tabs default to normal ChatGPT without changing the task privacy setting", () => {
  const { host } = fixture();
  host.show = () => {};
  loads.length = 0;
  host.createUserTab();
  assert.equal(host.getUseSavedChats(), false);
  assert.deepEqual(loads, ["https://chatgpt.com/"]);
  assert.equal([...host.userTabs.values()][0].url, "https://chatgpt.com/");
});

test("first tab is closable and closing the last tab hides it until browser reopen", async () => {
  const { host } = fixture();
  assert.equal(host.snapshot().tabs[0].closable, true);
  const result = await host.closeTab("home");
  assert.equal(result.tabs.length, 0);
  assert.equal(result.visible, false);
  assert.equal(host.homeTabClosed, true);
  host.show = () => { host.visible = true; };
  const reopened = await host.reveal(false);
  assert.equal(reopened.tabs[0].id, "home");
  assert.equal(reopened.visible, true);
});

test("closing home selects a remaining tab and never cancels running turns or closes account contents", async () => {
  const { host } = fixture();
  const view = host.view;
  const turn = { id: "turn", partition: "account", traceId: "trace", status: "running", view };
  host.turnTabs.set(turn.id, turn);
  host.cancelTurn = async () => { throw new Error("must not cancel turn"); };
  await host.closeTab("home");
  assert.equal(host.selectedTabId, turn.id);
  assert.equal(host.turnTabs.get(turn.id), turn);
  assert.equal(host.view, view);
  assert.ok(!host.snapshot().tabs.some(tab => tab.id === "home"));
});

test("closing home never selects a task tab on a different account", async () => {
  const { host } = fixture();
  host.turnTabs.set("other", { id: "other", partition: "another-account", status: "running", view: host.view });
  await host.closeTab("home");
  assert.equal(host.selectedTabId, "home");
  assert.equal(host.visible, false);
  assert.equal(host.turnTabs.size, 1);
});

test("closing an inactive first tab leaves the selected user page unchanged", async () => {
  const { host } = fixture();
  host.userTabs.set("user", { id: "user", status: "ready", view: host.view });
  host.selectedTabId = "user";
  await host.closeTab("home");
  assert.equal(host.selectedTabId, "user");
  assert.deepEqual(Array.from(host.snapshot().tabs, tab => tab.id), ["user"]);
});

test("closed home stays offscreen after the last user tab closes and can be explicitly selected again", async () => {
  const { host, calls } = fixture();
  host.homeTabClosed = true;
  host.view.webContents.close = () => {};
  const user = { id: "user", status: "ready", view: host.view };
  host.userTabs.set(user.id, user);
  host.selectedTabId = user.id;
  await host.closeTab(user.id);
  assert.equal(host.snapshot().tabs.length, 0);
  const hiddenBounds = { x: 801, y: 0, width: 800, height: 600 };
  const bounds = [];
  host.hiddenTurnBounds = () => hiddenBounds;
  host.view.setBounds = value => bounds.push(value);
  host.presentPrimaryView(true);
  assert.deepEqual(bounds, [hiddenBounds], "the closed tab cannot cover the launcher");
  assert.deepEqual(calls.at(-1), ["visible", true], "the internal account renderer stays drawable offscreen");
  host.selectTab("home");
  assert.equal(host.snapshot().tabs[0].id, "home");
});

test("home cannot close during login or a verification operation", async () => {
  const { host } = fixture();
  host.manualOperation = "ChatGPT login";
  await assert.rejects(host.closeTab("home"), /cannot close during/);
  assert.notEqual(host.homeTabClosed, true);
});

test("closed-home preference is parked per account and a new account starts open", () => {
  const { host } = fixture();
  host.view.webContents.setZoomFactor = () => {};
  host.clearHomeNavigationTimeout = () => {};
  host.homeTabClosed = true;
  const parked = host.parkHome();
  assert.equal(parked.homeTabClosed, true);
  host.restoreHome({ ...parked, homeTabClosed: undefined });
  assert.equal(host.homeTabClosed, false);
  host.restoreHome(parked);
  assert.equal(host.homeTabClosed, true);
});
