const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createBrowserAccounts: openBrowserAccounts, signedInFromCookies, FIRST_ACCOUNT_ID, MAX_ACCOUNTS } = require("../electron/browser-accounts.cjs");
const { browserAccountPartition, isBrowserAccountPartition } = require("../electron/profile.cjs");
const { BrowserHost, makeTabRoom } = require("../electron/browser-host.cjs");

const BASE = "persist:coding-tools-chatgpt";

// Accounts save off the main thread: a test's folder goes once every store it opened is written.
const opened = new Set();
function createBrowserAccounts(options) {
  const accounts = openBrowserAccounts(options);
  opened.add(accounts);
  return accounts;
}

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function tempRoot(t) {
  const root = path.join(__dirname, "..", "..", "aiTemp", "browser-accounts-tests", crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(async () => {
    await Promise.all([...opened].map((accounts) => accounts.saved()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "browser-accounts");
}

test("the first account keeps the original partition, so an existing sign-in carries over", (t) => {
  const accounts = createBrowserAccounts({ dataRoot: tempRoot(t), profile: "production" });
  assert.equal(accounts.activeId(), FIRST_ACCOUNT_ID);
  assert.equal(accounts.activePartition(), BASE);
  assert.deepEqual(accounts.status().accounts.map(entry => entry.id), [FIRST_ACCOUNT_ID]);
});

test("each added account gets its own partition, and the choice survives a restart", async (t) => {
  const dataRoot = tempRoot(t);
  const accounts = createBrowserAccounts({ dataRoot, profile: "production" });
  const id = accounts.add();
  assert.match(id, /^[a-z0-9]{12}$/);
  assert.equal(accounts.partitionOf(id), `${BASE}-${id}`);
  assert.equal(accounts.activeId(), FIRST_ACCOUNT_ID, "adding does not switch by itself");
  accounts.setActive(id);
  accounts.setEmail(id, "team@example.com");

  await accounts.saved();
  const reopened = createBrowserAccounts({ dataRoot, profile: "production" });
  assert.equal(reopened.activeId(), id);
  assert.equal(reopened.activePartition(), `${BASE}-${id}`);
  assert.equal(reopened.status().accounts.find(entry => entry.id === id).email, "team@example.com");
});

test("changes save off the main thread: a burst of them lands as the last state", async (t) => {
  const dataRoot = tempRoot(t);
  const accounts = createBrowserAccounts({ dataRoot, profile: "production" });
  const second = accounts.add();
  for (const maxTabs of [1, 2, 3, 4]) accounts.setAccountSettings(second, { maxTabs });
  accounts.setActive(second);
  assert.equal(accounts.activeId(), second, "the change holds at once, before the write");
  await accounts.saved();
  const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, "accounts.json"), "utf8"));
  assert.equal(saved.activeId, second);
  assert.equal(saved.accounts.find((entry) => entry.id === second).maxTabs, 4);
  assert.deepEqual(fs.readdirSync(dataRoot), ["accounts.json"], "no temporary file left behind");
});

test("a save that fails is logged, and the change still holds in memory", async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.writeFileSync(root, "a file where the accounts folder goes");
  const warnings = [];
  const accounts = createBrowserAccounts({ dataRoot: root, profile: "production", logger: { warn: (event) => warnings.push(event) } });
  const id = accounts.add();
  await accounts.saved();
  assert.ok(accounts.has(id));
  assert.deepEqual(warnings, ["browser_accounts.save_failed"]);
});

test("the active account cannot be removed in place, and removal hands back the partition to erase", (t) => {
  const accounts = createBrowserAccounts({ dataRoot: tempRoot(t), profile: "production" });
  const id = accounts.add();
  accounts.setActive(id);
  assert.throws(() => accounts.remove(id), /Switch to another account/);
  assert.equal(accounts.remove(FIRST_ACCOUNT_ID), BASE);
  assert.deepEqual(accounts.status().accounts.map(entry => entry.id), [id]);
  assert.throws(() => accounts.partitionOf(FIRST_ACCOUNT_ID), /Unknown browser account/);
});

test("the store holds at most MAX_ACCOUNTS and ignores entries it did not write", (t) => {
  const dataRoot = tempRoot(t);
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "accounts.json"), JSON.stringify({
    activeId: "../escape",
    accounts: [{ id: "../escape", label: "x" }, { id: "abcdefghijkl", label: "  Work  " }, { id: "abcdefghijkl", label: "dup" }],
  }));
  const accounts = createBrowserAccounts({ dataRoot, profile: "production" });
  assert.deepEqual(accounts.status().accounts, [{
    id: "abcdefghijkl", label: "Work", email: null, proxyProfileId: null,
    maxTabs: 5, acceptsNewSessions: true, plan: null, connector: null,
  }]);
  assert.equal(accounts.activeId(), "abcdefghijkl");
  while (accounts.status().accounts.length < MAX_ACCOUNTS) accounts.add();
  assert.throws(() => accounts.add(), /up to 12 accounts/);
});

test("a partition is a browser account's only when it is the base or the base plus a 12-character id", () => {
  assert.equal(browserAccountPartition("development", null), "persist:coding-tools-dev-chatgpt");
  assert.equal(isBrowserAccountPartition("production", BASE), true);
  assert.equal(isBrowserAccountPartition("production", `${BASE}-a1b2c3d4e5f6`), true);
  for (const partition of [`${BASE}-A1B2C3D4E5F6`, `${BASE}-short`, `${BASE}a1b2c3d4e5f6`, "persist:coding-tools-dev-chatgpt", null]) {
    assert.equal(isBrowserAccountPartition("production", partition), false, String(partition));
  }
  assert.throws(() => browserAccountPartition("production", "../x"), /invalid/);
});

test("a running turn, a manual operation or a sign-in blocks an account switch", () => {
  const blocker = (fields) => BrowserHost.prototype.accountSwitchBlocker.call(Object.assign(
    Object.create(BrowserHost.prototype),
    { turnTabs: new Map(), manualOperation: null, loginOperation: null },
    fields,
  ));
  assert.equal(blocker({}), null);
  assert.equal(blocker({ turnTabs: new Map([["t", { status: "retained", traceId: "a" }]]) }), null, "a retained tab is idle");
  assert.match(blocker({ turnTabs: new Map([["t", { status: "running", traceId: "a" }]]) }), /chat turn is running/);
  assert.match(blocker({ manualOperation: "session inspection" }), /session inspection is running/);
  assert.match(blocker({ loginOperation: Promise.resolve() }), /sign-in/);
});

test("only what owns the shown page blocks showing another account; Codex turns keep running", () => {
  const blocker = (fields) => BrowserHost.prototype.homeSwitchBlocker.call(Object.assign(
    Object.create(BrowserHost.prototype),
    { turnTabs: new Map(), manualOperation: null, loginOperation: null, authView: null },
    fields,
  ));
  assert.equal(blocker({ turnTabs: new Map([["t", { status: "running", traceId: "a", interactionMode: "automatic" }]]) }), null);
  assert.match(blocker({ turnTabs: new Map([["t", { status: "running", traceId: "a", interactionMode: "manual" }]]) }), /Zero Risk/);
  assert.match(blocker({ manualOperation: "session inspection" }), /session inspection is running/);
  assert.match(blocker({ loginOperation: Promise.resolve() }), /sign-in/);
  assert.match(blocker({ authView: {} }), /sign-in/);
});

// A BrowserHost with fake pages: enough for switchAccount, without Electron.
function switchingHost({ failNewPage = false } = {}) {
  const views = [];
  const fakeView = (partition) => {
    const view = { partition, visible: true, closed: false, zoom: null };
    view.setVisible = (value) => { view.visible = value; };
    view.webContents = {
      isDestroyed: () => view.closed,
      close: () => { view.closed = true; },
      setZoomFactor: (value) => { view.zoom = value; },
    };
    views.push(view);
    return view;
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    profile: "production",
    partition: BASE,
    view: fakeView(BASE),
    surfaceId: "home-surface-of-main",
    userTabs: new Map([["u1", { id: "u1", view: fakeView(BASE) }]]),
    selectedTabId: "u1",
    turnTabs: new Map([["t1", { id: "t1", status: "running", interactionMode: "automatic", partition: `${BASE}-zzzzzzzzzzzz`, view: fakeView("turn") }]]),
    parkedHomes: new Map(),
    state: { status: "ready", authenticated: true, url: "https://chatgpt.com/", title: "ChatGPT", zoomFactor: 1.25 },
    visible: true,
    surfaceActive: true,
    manualOperation: null,
    loginOperation: null,
    authView: null,
    initializationReady: Promise.resolve(),
    window: { contentView: { removeChildView: () => {} } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getBrowserInteractionMode: () => "manual",
    descriptorWrites: 0,
    created: [],
  });
  host.createHomeView = (partition) => { host.created.push(partition); return fakeView(partition); };
  host.initializePrimaryView = async () => { if (failNewPage) throw new Error("page did not load"); };
  host.syncViewVisibility = () => {};
  host.snapshot = () => ({ partition: host.partition });
  host.writeDescriptor = () => { host.descriptorWrites += 1; };
  return { host, views };
}

test("switching shows the other account in place; the account left stays loaded for an instant switch back", async () => {
  const { host } = switchingHost();
  const other = `${BASE}-abcdefghijkl`;
  const mainView = host.view;
  const mainTab = host.userTabs.get("u1");

  await host.switchAccount(other);
  assert.deepEqual(host.created, [other], "a new account gets its own page");
  assert.equal(host.partition, other);
  assert.notEqual(host.surfaceId, "home-surface-of-main", "each account's page has its own surface");
  assert.equal(host.userTabs.size, 0);
  assert.equal(host.state.authenticated, false, "the new account's sign-in is its own");
  assert.equal(mainView.visible, false);
  assert.equal(mainView.webContents.isDestroyed(), false, "the account left is parked, not closed");
  assert.equal(host.turnTabs.get("t1").view.webContents.isDestroyed(), false, "a running Codex turn keeps running");
  assert.ok(host.livePartitions().includes(BASE), "the parked account stays routed");

  await host.switchAccount(BASE);
  assert.deepEqual(host.created, [other], "switching back builds nothing");
  assert.equal(host.view, mainView);
  assert.equal(host.surfaceId, "home-surface-of-main");
  assert.equal(host.userTabs.get("u1"), mainTab, "its own tabs come back");
  assert.equal(host.selectedTabId, "u1");
  assert.equal(host.state.authenticated, true);
  assert.equal(mainView.zoom, 1.25, "a parked page takes the current zoom");
  assert.deepEqual([...host.parkedHomes.keys()], [other]);
  assert.ok(host.descriptorWrites >= 2, "the bridge sees the shown account's page");
});

test("an account whose page cannot load leaves the Browser tab on the account it was on", async () => {
  const { host, views } = switchingHost({ failNewPage: true });
  const mainView = host.view;
  await assert.rejects(host.switchAccount(`${BASE}-abcdefghijkl`), /page did not load/);
  assert.equal(host.partition, BASE);
  assert.equal(host.view, mainView);
  assert.equal(host.surfaceId, "home-surface-of-main");
  assert.equal(host.parkedHomes.size, 0);
  assert.equal(views.find((view) => view.partition === `${BASE}-abcdefghijkl`).closed, true, "the failed page is closed");
});

test("past the warm limit, a parked account a turn runs on stays; a bare signed-out page goes before an older signed-in one", () => {
  const { parkedHomeToUnload } = require("../electron/browser-host.cjs");
  const home = (partition, parkedAt, { tabs = 0, authenticated = false } = {}) =>
    ({ partition, parkedAt, userTabs: new Map(Array.from({ length: tabs }, (_, index) => [index, {}])), state: { authenticated } });
  const parked = [home("a", 1, { authenticated: true }), home("b", 2, { tabs: 1 }), home("c", 3), home("d", 4)];
  assert.equal(parkedHomeToUnload(parked, new Set()).partition, "c", "the oldest page with no tabs and no sign-in");
  assert.equal(parkedHomeToUnload(parked, new Set(["c"])).partition, "d", "never one a turn runs on");
  assert.equal(parkedHomeToUnload(parked.slice(0, 2), new Set()).partition, "a", "a sign-in costs less to reload than the user's tabs");
  assert.equal(parkedHomeToUnload(parked, new Set(["a", "b", "c", "d"])), null, "every one busy: all stay");
});

test("a parked account being removed has its page closed; the shown one must be left first", async () => {
  const { host } = switchingHost();
  const other = `${BASE}-abcdefghijkl`;
  await host.switchAccount(other);
  const parkedView = host.parkedHomes.get(BASE).view;
  assert.throws(() => host.releaseAccountHome(other), /Switch to another account/);
  assert.equal(host.releaseAccountHome(BASE), true);
  assert.equal(parkedView.webContents.isDestroyed(), true);
  assert.equal(host.releaseAccountHome(BASE), false);
});

test("a switch to a partition outside the profile is refused", async () => {
  const { host } = switchingHost();
  await assert.rejects(host.switchAccount("persist:someone-else"), /does not match its profile/);
  assert.equal(host.partition, BASE);
});

test("CPA Codex sign-ins become accounts once each; a removed one stays removed", async (t) => {
  const dataRoot = tempRoot(t);
  const accounts = createBrowserAccounts({ dataRoot, profile: "production" });
  accounts.setEmail(FIRST_ACCOUNT_ID, "Me@Example.com");
  const added = accounts.importOauthAccounts([
    { email: "me@example.com", plan: "plus" },
    { email: "team@example.com", plan: "team" },
    { email: "pro@example.com", plan: null },
    { email: "not-an-email", plan: "plus" },
  ]);
  assert.equal(added.length, 2, "the account already signed in to me@example.com counts as that sign-in");
  const labels = accounts.status().accounts.map((entry) => entry.label);
  assert.ok(labels.includes("team@example.com · team"));
  assert.ok(labels.includes("pro@example.com"));
  assert.deepEqual(accounts.importOauthAccounts([{ email: "TEAM@example.com", plan: "team" }]), [], "seen once, never added again");

  const pro = accounts.status().accounts.find((entry) => entry.label === "pro@example.com").id;
  accounts.remove(pro);
  await accounts.saved();
  const reopened = createBrowserAccounts({ dataRoot, profile: "production" });
  assert.deepEqual(reopened.importOauthAccounts([{ email: "pro@example.com" }]), [], "removing an imported account sticks across restarts");
});

test("CPA sign-ins beyond the account limit wait until there is room", (t) => {
  const accounts = createBrowserAccounts({ dataRoot: tempRoot(t), profile: "production" });
  const emails = Array.from({ length: MAX_ACCOUNTS + 2 }, (_unused, index) => ({ email: `user${String(index).padStart(2, "0")}@example.com` }));
  assert.equal(accounts.importOauthAccounts(emails).length, MAX_ACCOUNTS - 1);
  const removable = accounts.status().accounts.find((entry) => entry.id !== FIRST_ACCOUNT_ID).id;
  accounts.remove(removable);
  assert.deepEqual(accounts.importOauthAccounts(emails).length, 1, "the next one not yet seen takes the freed place");
});

test("account settings: a tab limit of 1 to 5, new sessions on or off, and where new sessions start", async (t) => {
  const dataRoot = tempRoot(t);
  const accounts = createBrowserAccounts({ dataRoot, profile: "production" });
  const second = accounts.add();
  accounts.setAccountSettings(second, { maxTabs: 2, acceptsNewSessions: false });
  assert.throws(() => accounts.setAccountSettings(second, { maxTabs: 6 }), /1 to 5 tabs/);
  assert.throws(() => accounts.setAccountSettings(second, { maxTabs: 0 }), /1 to 5 tabs/);
  assert.equal(accounts.tabLimitForPartition(`${BASE}-${second}`), 2);
  assert.equal(accounts.tabLimitForPartition(BASE), 5);
  assert.equal(accounts.tabLimitForPartition("persist:unknown"), 5);
  accounts.setSettings({ newSessions: second, keepFinishedTabsMinutes: 30 });
  assert.throws(() => accounts.setSettings({ newSessions: "nobody" }), /New sessions start on/);
  assert.throws(() => accounts.setSettings({ keepFinishedTabsMinutes: 7 }), /Finished tabs stay open/);

  await accounts.saved();
  const reopened = createBrowserAccounts({ dataRoot, profile: "production" });
  const saved = reopened.status().accounts.find(entry => entry.id === second);
  assert.equal(saved.maxTabs, 2);
  assert.equal(saved.acceptsNewSessions, false);
  assert.deepEqual(reopened.settings(), { newSessions: second, keepFinishedTabsMinutes: 30 });
  reopened.remove(second);
  assert.equal(reopened.settings().newSessions, "active", "removing the chosen account falls back to the account in use");
});

test("an account records its plan and what its turns showed about its connector", (t) => {
  let clock = 1_000_000;
  const accounts = createBrowserAccounts({ dataRoot: tempRoot(t), profile: "production", now: () => clock });
  assert.equal(accounts.recordPlan(FIRST_ACCOUNT_ID, { solAvailable: true }), false, "incomplete evidence is ignored");
  assert.equal(accounts.recordPlan(FIRST_ACCOUNT_ID, { solAvailable: true, proAvailable: true }), true);
  assert.deepEqual(accounts.status().accounts[0].plan, { solAvailable: true, proAvailable: true, checkedAt: 1_000_000 });

  assert.equal(accounts.recordConnector(FIRST_ACCOUNT_ID, { bound: true }), true);
  clock += 60_000;
  assert.equal(accounts.recordConnector(FIRST_ACCOUNT_ID, { bound: true }), false, "a clean record refreshes at most every 5 minutes");
  assert.equal(accounts.recordConnector(FIRST_ACCOUNT_ID, { error: "connector_not_found" }), true);
  assert.deepEqual(accounts.status().accounts[0].connector, { okAt: 1_000_000, error: "connector_not_found", errorAt: 1_060_000 });
  clock += 1_000;
  assert.equal(accounts.recordConnector(FIRST_ACCOUNT_ID, { bound: true }), true, "a bound turn after a failure clears it");
  assert.deepEqual(accounts.status().accounts[0].connector, { okAt: 1_061_000, error: null, errorAt: null });
});

test("each account holds its own tabs up to its limit, and frees only its own retained tab", async () => {
  const SECOND = "abcdefghijkl";
  const other = `${BASE}-${SECOND}`;
  const removed = [];
  const tab = (id, partition, status = "ready", lastHeartbeatAt = 1) => ({ id, partition, status, interactionMode: "automatic", lastHeartbeatAt });
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    partition: BASE,
    userTabs: new Map(),
    turnTabs: new Map([
      ["a1", tab("a1", BASE, "ready", 5)],
      ["b1", tab("b1", other, "running")],
      ["b2", tab("b2", other, "ready", 9)],
    ]),
    tabLimitFor: (partition) => (partition === other ? 2 : 5),
    removeTurnTab(target) { removed.push(target.id); this.turnTabs.delete(target.id); },
  });
  assert.equal(host.tabCount(other), 2);
  assert.equal(host.tabCount(BASE), 1);
  // The second account is at its limit of 2: its retained tab goes, the first account's stays.
  assert.equal(makeTabRoom(host, other), null);
  assert.deepEqual(removed, ["b2"]);
  // With only a running tab left at its limit, the account is full.
  host.turnTabs.set("b3", tab("b3", other, "running"));
  await assert.rejects(
    host.createTurnTab("trace", 1, undefined, undefined, undefined, { partition: other, accountId: SECOND }),
    /already has 2 browser tabs/,
  );
  assert.equal(makeTabRoom(host, other, false), 2);
  assert.deepEqual(removed, ["b2"], "never another account's tab");
});

test("an account counts as signed in while its own partition holds an unexpired ChatGPT session token", () => {
  const now = 1_800_000_000;
  const token = (name, fields = {}) => ({ name, domain: ".chatgpt.com", session: false, expirationDate: now + 90 * 86_400, ...fields });
  // ChatGPT splits the token into .0/.1; either part, or the unsplit name, is a sign-in.
  assert.equal(signedInFromCookies([token("__Secure-next-auth.session-token.0"), token("__Secure-next-auth.session-token.1")], now), true);
  assert.equal(signedInFromCookies([token("__Secure-next-auth.session-token")], now), true);
  // Expired, or only the other NextAuth cookies (CSRF, callback URL): not signed in.
  assert.equal(signedInFromCookies([token("__Secure-next-auth.session-token.0", { expirationDate: now - 1 })], now), false);
  assert.equal(signedInFromCookies([token("__Host-next-auth.csrf-token", { session: true }), token("__Secure-next-auth.callback-url")], now), false);
  assert.equal(signedInFromCookies([token("__Secure-next-auth.session-tokenx")], now), false);
  assert.equal(signedInFromCookies([], now), false);
  assert.equal(signedInFromCookies(undefined, now), false);
});
