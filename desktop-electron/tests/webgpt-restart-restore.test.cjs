const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");
const { CodexChatLifecycleSync } = require("../electron/codex-chat-lifecycle-sync.cjs");
const { createThreadAccounts, isThreadId } = require("../electron/codex-thread-accounts.cjs");

const THREAD = "123e4567-e89b-12d3-a456-426614174000";
const URL = "https://chatgpt.com/c/6adf644e-9994-83ea-9463-1f856c9d2595";
const KEY = "a".repeat(64);
const BASE = "persist:coding-tools-chatgpt";
const SECOND = "abcdefghijkl";

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

function recoveryFixture(navigate, options = {}) {
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
  const created = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    profile: "production", partition: BASE,
    manualOperation: null,
    turnTabs: new Map(), userCancelledTurnOwners: new Map(),
    getUseSavedChats: () => true,
    chatLifecycleSync: options.chatLifecycleSync ?? { findRetainedConversation: () => URL },
    resolveTurnAccount: options.resolveTurnAccount,
    async createTurnTab(...args) {
      created.push(args);
      return { id: "reopened", surfaceId: "surface-reopened", view: { webContents: contents } };
    },
    async markTurnTabSurface() { marked++; },
    removeTurnTab() { removed++; },
    snapshot: () => ({}), syncViewVisibility() {}, publishState() {}, writeDescriptor() {},
    logger: { info() {} },
  });
  return { host, created, getMarked: () => marked, getRemoved: () => removed };
}

function accountResolverFixture(state = "bound", options = {}) {
  const bindings = [], routes = [], lookups = [];
  let fallback = 0;
  const store = state === "unavailable" ? null : createThreadAccounts({
    filePath: "unused",
    io: {
      existsSync: () => state !== "missing",
      readFileSync: () => state === "corrupt" ? "{ broken" : JSON.stringify({
        version: 1, threads: state === "unbound" ? {} : { [THREAD]: { accountId: SECOND } },
      }),
    },
  });
  let boundAccount = store?.accountFor(THREAD) ?? null;
  if (store) {
    store.accountFor = () => boundAccount;
    store.bind = (...args) => { bindings.push(args); return boundAccount = args[1]; };
    store.unbind = () => { boundAccount = null; };
  }
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const resolver = main.slice(main.indexOf("async function resolveThreadAccount("), main.indexOf("\n// Codex thread titles"));
  const action = main.slice(main.indexOf("async function codexThreadAction("), main.indexOf("\nfunction publishBrowserAccounts("));
  const forwarding = main.match(/resolveTurnAccount: ([^\r\n]+),/)[1];
  const context = {
    threadAccounts: store, isThreadId, logger: { info() {} }, browserHost: null,
    browserAccountExists: options.accountExists ?? (() => state !== "removed"),
    newSessionAccount: () => { fallback++; return "main"; },
    browserAccounts: { partitionOf: id => id === "main" ? BASE : `${BASE}-${id}` },
    routeIdleAccountPartition: async partition => { routes.push(partition); await options.route?.(); },
    lifecycleSyncFor: account => ({ findRetainedConversation: (...args) => { lookups.push([account, ...args]); return URL; } }),
    codexThreadsStatus: async () => ({ threads: [] }),
  };
  const api = vm.runInNewContext(`${resolver}\n${action}\n({ resolveTurnAccount: ${forwarding}, codexThreadAction })`, context);
  return { ...api, context, bindings, routes, lookups, getFallback: () => fallback, store };
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

test("retained restart restores the bound account's exact saved URL while another account is current", async () => {
  const accounts = accountResolverFixture();
  const fixture = recoveryFixture(undefined, {
    resolveTurnAccount: accounts.resolveTurnAccount,
    chatLifecycleSync: { findRetainedConversation() { assert.fail("The current account registry must not be used"); } },
  });
  const lease = await fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", true, null, THREAD);
  assert.equal(lease.reused, true);
  assert.equal(lease.conversationUrl, URL);
  assert.deepEqual(accounts.lookups, [[SECOND, THREAD, KEY, "Codex Native2"]]);
  assert.deepEqual(accounts.routes, [`${BASE}-${SECOND}`]);
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.created[0][5].partition, `${BASE}-${SECOND}`);
  assert.equal(accounts.getFallback(), 0);
});

for (const state of ["missing", "corrupt", "unbound", "removed", "unavailable"]) {
  test(`retained restart fails before rebinding or routing when the original account binding is ${state}`, async () => {
    const accounts = accountResolverFixture(state);
    const fixture = recoveryFixture(undefined, { resolveTurnAccount: accounts.resolveTurnAccount });
    await assert.rejects(
      fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", true, null, THREAD),
      error => error?.code === "retained_conversation_unavailable",
    );
    assert.deepEqual(accounts.bindings, []);
    assert.deepEqual(accounts.routes, []);
    assert.deepEqual(accounts.lookups, []);
    assert.equal(accounts.getFallback(), 0);
    assert.equal(fixture.created.length, 0);
    assert.equal(accounts.store?.accountFor(THREAD) ?? null, state === "removed" ? SECOND : null);
  });
}

test("an ordinary first turn still binds and routes to the current new-session account", async () => {
  const accounts = accountResolverFixture("unbound");
  const account = await accounts.resolveTurnAccount(THREAD, { requireRetainedConversation: false });
  assert.equal(account.accountId, "main");
  assert.deepEqual(accounts.bindings, [[THREAD, "main"]]);
  assert.deepEqual(accounts.routes, [BASE]);
  assert.equal(accounts.getFallback(), 1);
});

for (const action of ["forget", "move", "remove-account"]) {
  test(`retained restart rejects ${action} while the original account route is pending`, async () => {
    let routed, resume;
    const routing = new Promise(resolve => { routed = resolve; });
    const paused = new Promise(resolve => { resume = resolve; });
    let accountPresent = true;
    const accounts = accountResolverFixture("bound", {
      route: () => { routed(); return paused; },
      accountExists: () => accountPresent,
    });
    const fixture = recoveryFixture(undefined, { resolveTurnAccount: accounts.resolveTurnAccount });
    accounts.context.browserHost = fixture.host;
    const restoring = fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", true, null, THREAD);
    const rejected = assert.rejects(restoring, error => error?.code === "retained_conversation_unavailable");
    await routing;
    assert.equal(fixture.host.threadRunning(THREAD), false, "routing has not registered a running tab yet");
    if (action === "remove-account") accountPresent = false;
    else await accounts.codexThreadAction({ threadId: THREAD, action, accountId: "main" }, accounts.context.logger);
    resume();
    await rejected;
    assert.equal(accounts.store.accountFor(THREAD), action === "forget" ? null : action === "move" ? "main" : SECOND);
    assert.deepEqual(accounts.bindings, action === "move" ? [[THREAD, SECOND], [THREAD, "main"]] : [[THREAD, SECOND]]);
    assert.deepEqual(accounts.lookups, []);
    assert.equal(fixture.created.length, 0, "no saved URL or tab is admitted after ownership changes");
  });
}
