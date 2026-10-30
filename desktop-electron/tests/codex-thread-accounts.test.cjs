"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createThreadAccounts } = require("../electron/codex-thread-accounts.cjs");
const { CodexChatLifecycleSync, createLifecycleScan } = require("../electron/codex-chat-lifecycle-sync.cjs");
const { ACTION_PAGE_URL, conversationPatchScript, createConversationActions } = require("../electron/chatgpt-conversation-actions.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

const THREAD = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_THREAD = "123e4567-e89b-12d3-a456-426614174001";
const CHAT_ID = "6adf644e-9994-83ea-9463-1f856c9d2595";
const CHAT = `https://chatgpt.com/c/${CHAT_ID}`;
const KEY = "a".repeat(64);
const BASE = "persist:coding-tools-chatgpt";
const SECOND = "abcdefghijkl";

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function fixtureRoot(t) {
  const directory = path.join(__dirname, "..", "..", "aiTemp", "codex-thread-accounts", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a thread keeps the account it was bound to across restarts, and loses it with that account", (t) => {
  const filePath = path.join(fixtureRoot(t), "codex-thread-accounts.json");
  let clock = 1_000;
  const store = createThreadAccounts({ filePath, now: () => clock });
  assert.equal(store.accountFor(THREAD), null);
  store.bind(THREAD, "main");
  clock = 2_000;
  store.bind(OTHER_THREAD, SECOND);
  assert.throws(() => store.bind("not-a-thread", "main"), /Not a Codex thread id/);
  assert.throws(() => store.bind(THREAD, "../evil"), /Not a ChatGPT account id/);

  const reopened = createThreadAccounts({ filePath, now: () => clock });
  assert.equal(reopened.accountFor(THREAD.toUpperCase()), "main", "ids are case-insensitive");
  assert.deepEqual(reopened.list().map(entry => entry.threadId), [OTHER_THREAD, THREAD], "most recent first");
  clock = 3_000;
  reopened.bind(THREAD, "main");
  assert.equal(reopened.list().find(entry => entry.threadId === THREAD).boundAt, 1_000, "re-binding the same account keeps boundAt");
  assert.equal(reopened.removeAccount(SECOND), true);
  assert.equal(reopened.accountFor(OTHER_THREAD), null);
  assert.equal(reopened.unbind(THREAD), true);
  assert.deepEqual(createThreadAccounts({ filePath }).list(), []);
});

test("an unreadable binding file is kept for recovery and never overwritten", (t) => {
  const filePath = path.join(fixtureRoot(t), "codex-thread-accounts.json");
  fs.writeFileSync(filePath, "{ broken");
  const warnings = [];
  const store = createThreadAccounts({ filePath, logger: { warn: (event) => warnings.push(event) } });
  store.bind(THREAD, "main");
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ broken");
  assert.deepEqual(warnings, ["browser.thread_accounts_unavailable"]);
});

function memoryRegistry(entries = []) {
  const sync = new CodexChatLifecycleSync({
    filePath: "unused", codexHome: "unused", io: { existsSync: () => false },
    enabled: () => true, onSync: async () => true,
  });
  sync.save = () => {};
  for (const [thread, url] of entries) sync.register(thread, url, KEY, "Codex");
  return sync;
}

test("one walk of the Codex rollout folders serves every account's registry", async () => {
  const first = memoryRegistry([[THREAD, CHAT]]);
  const second = memoryRegistry([[OTHER_THREAD, "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555"]]);
  const polled = [];
  for (const sync of [first, second]) {
    const poll = sync.poll.bind(sync);
    sync.poll = (scan) => { polled.push(scan); return poll(scan); };
  }
  let reads = 0;
  const io = {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    readdirSync: () => { reads += 1; return []; },
  };
  await createLifecycleScan({ syncs: () => [first, second, memoryRegistry()], codexHome: "codex", io }).tick();
  assert.equal(reads, 2, "sessions and archived_sessions, once each, for both accounts");
  assert.equal(polled.length, 2, "the empty registry is skipped");
  assert.equal(polled[0], polled[1], "both registries read the same scan");
});

test("a chat archived by hand stays archived while its Codex thread is active", async () => {
  const actions = [];
  const sync = memoryRegistry([[THREAD, CHAT]]);
  sync.onSync = async ({ action }) => { actions.push(action); return true; };
  const active = { ready: true, found: new Map([[THREAD, "active"]]) };
  assert.equal(sync.setArchived(THREAD, CHAT, true), true);
  await sync.poll(active);
  assert.deepEqual(actions, [], "no automatic unarchive of a hand-archived chat");
  sync.setArchived(THREAD, CHAT, false);
  assert.deepEqual(sync.entriesFor(THREAD), [{ threadId: THREAD, conversationUrl: CHAT, remoteArchived: false }]);
  await sync.poll({ ready: true, found: new Map([[THREAD, "archived"]]) });
  assert.deepEqual(actions, ["archive"], "Codex's own archive still reaches the chat");
  await sync.poll(active);
  assert.deepEqual(actions, ["archive", "unarchive"], "and what the poll archived, it unarchives");
  assert.equal(sync.forget(THREAD, CHAT), true);
  assert.deepEqual(sync.entriesFor(THREAD), []);
});

test("conversation actions send ChatGPT's own patches, from a hidden page of the account's partition", async () => {
  assert.match(conversationPatchScript(CHAT_ID, "archive"), /\{"is_archived":true\}, false\)$/);
  assert.match(conversationPatchScript(CHAT_ID, "unarchive"), /\{"is_archived":false\}, false\)$/);
  assert.match(conversationPatchScript(CHAT_ID, "delete"), /\{"is_visible":false\}, true\)$/);
  assert.throws(() => conversationPatchScript("../../backend-api/me", "delete"), /Not a ChatGPT conversation id/);
  assert.throws(() => conversationPatchScript(CHAT_ID, "share"), /Unknown ChatGPT conversation action/);

  const pages = [];
  const actions = createConversationActions({
    createContents: (partition) => {
      const page = { partition, loaded: null, closed: false, scripts: [] };
      page.loadURL = async (url) => { page.loaded = url; };
      page.executeJavaScript = async (script) => { page.scripts.push(script); return pages.length === 2 ? { ok: false, status: 403 } : { ok: true, status: 200 }; };
      page.isDestroyed = () => page.closed;
      page.close = () => { page.closed = true; };
      pages.push(page);
      return page;
    },
  });
  assert.equal(await actions.run(`${BASE}-${SECOND}`, CHAT, "archive"), true);
  await assert.rejects(actions.run(BASE, CHAT, "delete"), /HTTP 403/);
  await assert.rejects(actions.run(BASE, "https://example.com/c/x", "delete"), /Not a saved ChatGPT conversation URL/);
  assert.deepEqual(pages.map(page => [page.partition, page.loaded, page.closed]), [
    [`${BASE}-${SECOND}`, ACTION_PAGE_URL, true],
    [BASE, ACTION_PAGE_URL, true],
  ]);
});

function accountHost({ retained = [], account }) {
  const created = [];
  const lookups = [];
  const registry = (name) => ({ findRetainedConversation: (...args) => { lookups.push([name, ...args]); return undefined; } });
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    profile: "production",
    partition: BASE,
    turnTabs: new Map(retained.map(tab => [tab.id, tab])),
    userCancelledTurnOwners: new Map(),
    getUseSavedChats: () => true,
    chatLifecycleSync: registry("host"),
    resolveTurnAccount: async () => (account ? { ...account, chatLifecycleSync: registry(account.accountId) } : null),
    async createTurnTab(...args) {
      created.push(args);
      return { id: "new-tab", surfaceId: "surface-new", view: { webContents: {} } };
    },
    syncViewVisibility() {}, publishState() {}, writeDescriptor() {}, snapshot: () => ({}),
    logger: { info() {}, warn() {} },
  });
  return { host, created, lookups };
}

test("a thread's turn opens its tab on the account it is bound to and reads that account's saved chats", async () => {
  const account = { accountId: SECOND, partition: `${BASE}-${SECOND}` };
  // A retained tab of the same conversation key on another account is never reused.
  const elsewhere = {
    id: "old", interactionMode: "automatic", status: "ready", conversationKey: KEY, connectorIdentity: undefined,
    partition: BASE, nativeThreadId: THREAD, view: { webContents: { isDestroyed: () => true } },
  };
  const { host, created, lookups } = accountHost({ retained: [elsewhere], account });
  const lease = await BrowserHost.prototype.beginTurn.call(host, "trace", false, 42, KEY, undefined, false, null, THREAD);
  assert.equal(lease.reused, false);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].at(-1).partition, account.partition, "the new tab gets the thread's account");
  assert.deepEqual(lookups.map(([name]) => name), [SECOND], "the saved chat is looked up on that account");

  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(
      accountHost({ account: { accountId: "evil", partition: "persist:someone-else" } }).host,
      "trace", false, 42, KEY, undefined, false, null, THREAD,
    ),
    /partition does not match this profile/,
  );
});

test("releasing a tab keeps a chat recorded for its thread and deletes one that was not", () => {
  const release = (persistedConversation) => {
    const calls = [];
    const contents = {
      isDestroyed: () => false,
      close: () => calls.push("close"),
      executeJavaScript: async () => { calls.push("delete"); return { ok: true }; },
      getURL: () => CHAT,
    };
    const tab = {
      id: "tab", traceId: "trace", status: "ready", interactionMode: "automatic",
      ownedConversation: CHAT_ID, persistedConversation, view: { webContents: contents },
    };
    const host = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]), getUseSavedChats: () => true, selectedTabId: null,
      window: { contentView: { removeChildView() {} }, isVisible: () => false }, syncPowerSaveBlocker() {},
      syncViewVisibility() {}, publishState() {}, writeDescriptor() {}, snapshot: () => ({}),
      logger: { info() {}, warn() {} },
    });
    BrowserHost.prototype.removeTurnTab.call(host, tab, false);
    return calls;
  };
  assert.deepEqual(release(true), ["close"]);
  assert.deepEqual(release(false), ["delete"]);
});
