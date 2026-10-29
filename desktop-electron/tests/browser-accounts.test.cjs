const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBrowserAccounts, FIRST_ACCOUNT_ID, MAX_ACCOUNTS } = require("../electron/browser-accounts.cjs");
const { browserAccountPartition, isBrowserAccountPartition } = require("../electron/profile.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

const BASE = "persist:coding-tools-chatgpt";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-accounts-"));
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
  assert.deepEqual(accounts.status().accounts, [{ id: "abcdefghijkl", label: "Work", email: null, proxyProfileId: null }]);
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
