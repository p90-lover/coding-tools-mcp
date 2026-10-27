const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");
const { CodexChatLifecycleSync } = require("../electron/codex-chat-lifecycle-sync.cjs");

const THREAD = "123e4567-e89b-12d3-a456-426614174000";
const URL = "https://chatgpt.com/c/6adf644e-9994-83ea-9463-1f856c9d2595";
const KEY = "a".repeat(64);

test("durable task mapping reopens only the matching thread, epoch and connector", () => {
  let persisted;
  const before = new CodexChatLifecycleSync({
    filePath: "unused", codexHome: "unused", io: { existsSync: () => false },
    enabled: () => false,
  });
  before.save = () => { persisted = JSON.stringify({ version: 1, entries: [...before.entries.values()] }); };
  assert.equal(before.register(THREAD, URL, KEY, "Codex Native2"), true);
  const after = new CodexChatLifecycleSync({
    filePath: "unused", codexHome: "unused",
    io: { existsSync: () => true, readFileSync: () => persisted }, enabled: () => false,
  });
  assert.equal(after.findRetainedConversation(THREAD, KEY, "Codex Native2"), URL);
  assert.equal(after.findRetainedConversation(THREAD, KEY, "Wrong Connector"), undefined);
  assert.equal(after.findRetainedConversation(THREAD, "b".repeat(64), "Codex Native2"), undefined);
  assert.equal(after.findRetainedConversation("123e4567-e89b-12d3-a456-426614174001", KEY, "Codex Native2"), undefined);
});

function recoveryFixture(navigate) {
  const contents = new EventEmitter();
  let currentUrl = IDLE_BROWSER_URL;
  contents.getURL = () => currentUrl;
  contents.isDestroyed = () => false;
  contents.loadURL = async target => {
    if (navigate === "fail") throw new Error("Navigation failed");
    currentUrl = target;
    queueMicrotask(() => contents.emit("did-finish-load"));
  };
  contents.stop = () => {};
  let marked = 0;
  let removed = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map(), userCancelledTurnOwners: new Map(),
    getUseSavedChats: () => true,
    chatLifecycleSync: { findRetainedConversation: () => URL },
    async createTurnTab() { return { id: "reopened", surfaceId: "surface-reopened", view: { webContents: contents } }; },
    async markTurnTabSurface() { marked++; },
    removeTurnTab() { removed++; },
    snapshot: () => ({}), syncViewVisibility() {}, publishState() {}, writeDescriptor() {},
    logger: { info() {} },
  });
  return { host, getMarked: () => marked, getRemoved: () => removed };
}

test("restart reloads the exact saved ChatGPT conversation and rebinds its document", async () => {
  const fixture = recoveryFixture();
  const lease = await BrowserHost.prototype.beginTurn.call(
    fixture.host, "trace", false, 42, KEY, "Codex Native2", true, null, THREAD,
  );
  assert.equal(lease.reused, true);
  assert.equal(lease.conversationUrl, URL);
  assert.equal(fixture.getMarked(), 1);
  assert.equal(fixture.getRemoved(), 0);
});

test("failed restoration does not submit into a new chat", async () => {
  const fixture = recoveryFixture("fail");
  await assert.rejects(BrowserHost.prototype.beginTurn.call(
    fixture.host, "trace", false, 42, KEY, "Codex Native2", true, null, THREAD,
  ), error => error?.code === "retained_conversation_unavailable");
  assert.equal(fixture.getRemoved(), 1);
});
