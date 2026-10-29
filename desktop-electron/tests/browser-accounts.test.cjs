const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createBrowserAccounts, FIRST_ACCOUNT_ID, MAX_ACCOUNTS } = require("../electron/browser-accounts.cjs");
const { browserAccountPartition, isBrowserAccountPartition } = require("../electron/profile.cjs");
const { BrowserHost, makeTabRoom } = require("../electron/browser-host.cjs");

const BASE = "persist:coding-tools-chatgpt";

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function tempRoot(t) {
  const root = path.join(__dirname, "..", "..", "aiTemp", "browser-accounts-tests", crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "browser-accounts");
}

test("the first account keeps the original partition, so an existing sign-in carries over", (t) => {
  const accounts = createBrowserAccounts({ dataRoot: tempRoot(t), profile: "production" });
  assert.equal(accounts.activeId(), FIRST_ACCOUNT_ID);
  assert.equal(accounts.activePartition(), BASE);
  assert.deepEqual(accounts.status().accounts.map(entry => entry.id), [FIRST_ACCOUNT_ID]);
});

test("each added account gets its own partition, and the choice survives a restart", (t) => {
  const dataRoot = tempRoot(t);
  const accounts = createBrowserAccounts({ dataRoot, profile: "production" });
  const id = accounts.add();
  assert.match(id, /^[a-z0-9]{12}$/);
  assert.equal(accounts.partitionOf(id), `${BASE}-${id}`);
  assert.equal(accounts.activeId(), FIRST_ACCOUNT_ID, "adding does not switch by itself");
  accounts.setActive(id);
  accounts.setEmail(id, "team@example.com");

  const reopened = createBrowserAccounts({ dataRoot, profile: "production" });
  assert.equal(reopened.activeId(), id);
  assert.equal(reopened.activePartition(), `${BASE}-${id}`);
  assert.equal(reopened.status().accounts.find(entry => entry.id === id).email, "team@example.com");
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

test("account settings: a tab limit of 1 to 5, new sessions on or off, and where new sessions start", (t) => {
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
