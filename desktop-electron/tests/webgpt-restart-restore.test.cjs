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
    await options.navigate?.(target);
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
      const tab = { id: "reopened", surfaceId: "surface-reopened", view: { webContents: contents },
        traceId: args[0], helperPid: args[1], conversationKey: args[2], connectorIdentity: args[3],
        nativeThreadId: args[4], partition: args[5]?.partition ?? BASE, status: "running", startRequest: args[6] };
      this.turnTabs.set(tab.id, tab);
      await options.create?.(tab, this);
      return tab;
    },
    async markTurnTabSurface(tab) { marked++; await options.mark?.(tab, this); },
    removeTurnTab(tab) { removed++; if (this.turnTabs.get(tab.id) === tab) this.turnTabs.delete(tab.id); },
    snapshot: () => ({}), syncViewVisibility() {}, publishState() {},
    writeDescriptor() { return options.writeDescriptor?.(this); },
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
  const inMemory = new Map(store?.list().map(entry => [entry.threadId, entry.accountId]) ?? []);
  if (store) {
    store.accountFor = id => inMemory.get(id.toLowerCase()) ?? null;
    store.bind = (...args) => { bindings.push(args); inMemory.set(args[0].toLowerCase(), args[1]); return args[1]; };
    store.unbind = id => inMemory.delete(id.toLowerCase());
  }
  const syncs = new Map();
  const getSync = account => {
    if (!syncs.has(account)) {
      const sync = new CodexChatLifecycleSync({ filePath: "unused", codexHome: "unused",
        io: { existsSync: () => false }, enabled: () => false });
      sync.save = () => {};
      sync.register(THREAD, URL, KEY, "Codex Native2");
      const find = sync.findRetainedConversation.bind(sync);
      sync.findRetainedConversation = (...args) => { lookups.push([account, ...args]); return find(...args); };
      syncs.set(account, sync);
    }
    return syncs.get(account);
  };
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const resolver = main.slice(main.indexOf("async function resolveThreadAccount("), main.indexOf("\n// Codex thread titles"));
  const action = main.slice(main.indexOf("async function codexThreadAction("), main.indexOf("\nfunction publishBrowserAccounts("));
  const forwarding = main.match(/resolveTurnAccount: ([^\r\n]+),/)[1];
  const context = {
    threadAccounts: store, isThreadId, logger: { info() {} }, browserHost: null,
    threadBindingEpochs: new Map(), threadBindingSequence: 0,
    accountLifecycleSyncs: syncs,
    browserAccountExists: options.accountExists ?? (() => state !== "removed"),
    newSessionAccount: () => { fallback++; return options.newSessionAccount ?? "main"; },
    browserAccounts: { partitionOf: id => id === "main" ? BASE : `${BASE}-${id}` },
    routeIdleAccountPartition: async partition => { routes.push(partition); await options.route?.(); },
    lifecycleSyncFor: getSync,
    codexThreadsStatus: async () => ({ threads: [] }),
  };
  const api = vm.runInNewContext(`${resolver}\n${action}\n({ resolveTurnAccount: ${forwarding}, codexThreadAction })`, context);
  return { ...api, context, bindings, routes, lookups, getFallback: () => fallback, store, getSync };
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

for (const change of ["move", "move-back", "forget-rebind"]) {
  test(`ordinary admission rejects ${change} during routing before allocating a tab`, async () => {
    let routed, resume, calls = 0;
    const routing = new Promise(resolve => { routed = resolve; });
    const paused = new Promise(resolve => { resume = resolve; });
    const accounts = accountResolverFixture("bound", {
      newSessionAccount: SECOND,
      route: () => { if (++calls === 1) { routed(); return paused; } },
    });
    const fixture = recoveryFixture(undefined, { resolveTurnAccount: accounts.resolveTurnAccount });
    accounts.context.browserHost = fixture.host;
    const starting = fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "pending", THREAD);
    const rejected = assert.rejects(starting, error => error?.code === "turn_cancelled");
    await routing;
    if (change === "forget-rebind") {
      await accounts.codexThreadAction({ threadId: THREAD, action: "forget" }, accounts.context.logger);
      await accounts.resolveTurnAccount(THREAD);
    } else {
      await accounts.codexThreadAction({ threadId: THREAD, action: "move", accountId: "main" }, accounts.context.logger);
      if (change === "move-back") await accounts.codexThreadAction({ threadId: THREAD, action: "move", accountId: SECOND }, accounts.context.logger);
    }
    resume();
    await rejected;
    assert.equal(fixture.created.length, 0);
    assert.equal(fixture.host.turnTabs.size, 0);
  });
}

test("same-account and metadata refreshes leave pending admission valid, independent of other threads", async () => {
  let routed, resume, calls = 0;
  const routing = new Promise(resolve => { routed = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  const accounts = accountResolverFixture("bound", { route: () => { if (++calls === 1) { routed(); return paused; } } });
  const fixture = recoveryFixture(undefined, { resolveTurnAccount: accounts.resolveTurnAccount });
  accounts.context.browserHost = fixture.host;
  const starting = fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "pending", THREAD);
  await routing;
  await accounts.codexThreadAction({ threadId: THREAD, action: "move", accountId: SECOND }, accounts.context.logger);
  const sync = accounts.getSync(SECOND);
  sync.register(THREAD.toUpperCase(), URL, KEY, "Codex Native2");
  sync.setArchived(THREAD, URL, true);
  for (const [key, entry] of sync.entries) sync.entries.set(key, { ...entry, everSeen: true, missingSince: 123, updatedAt: 456 });
  const other = "123e4567-e89b-12d3-a456-426614174001";
  await accounts.resolveTurnAccount(other);
  await accounts.codexThreadAction({ threadId: other, action: "move", accountId: SECOND }, accounts.context.logger);
  sync.register(other, URL.replace("2595", "2596"), KEY, "Codex Native2");
  resume();
  assert.equal((await starting).conversationUrl, URL);
  assert.equal(fixture.created.length, 1);
});

test("ordinary admission rechecks the binding after an initializing tab disappears", async () => {
  let waiting, resume;
  const entered = new Promise(resolve => { waiting = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  const accounts = accountResolverFixture();
  const fixture = recoveryFixture(undefined, { resolveTurnAccount: accounts.resolveTurnAccount });
  accounts.context.browserHost = fixture.host;
  fixture.host.turnTabs.set("loading", { id: "loading", traceId: "trace", nativeThreadId: THREAD,
    conversationKey: KEY, connectorIdentity: "Codex Native2", interactionMode: "automatic", status: "running",
    initializingSurface: true, surfaceReady: { catch(handler) { waiting(); return paused.catch(handler); } } });
  const starting = fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "pending", THREAD);
  const rejected = assert.rejects(starting, error => error?.code === "turn_cancelled");
  await entered;
  fixture.host.turnTabs.delete("loading");
  await accounts.codexThreadAction({ threadId: THREAD, action: "move", accountId: "main" }, accounts.context.logger);
  resume();
  await rejected;
  assert.equal(fixture.created.length, 0);
});

test("same-account conversation replacement during tab initialization cancels the stale URL", async () => {
  const accounts = accountResolverFixture();
  const fixture = recoveryFixture(undefined, {
    resolveTurnAccount: accounts.resolveTurnAccount,
    create() {
      const sync = accounts.getSync(SECOND);
      sync.forget(THREAD, URL);
      sync.register(THREAD, URL.replace("2595", "2596"), KEY, "Codex Native2");
    },
  });
  await assert.rejects(fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "pending", THREAD),
    error => error?.code === "turn_cancelled");
  assert.equal(fixture.getRemoved(), 1);
  assert.equal(fixture.host.turnTabs.size, 0);
});

for (const change of ["epoch", "reset-back", "poll-delete", "failed-save"]) {
  test(`real lifecycle ${change} invalidates the main admission snapshot`, async () => {
    const accounts = accountResolverFixture();
    const account = await accounts.resolveTurnAccount(THREAD.toUpperCase());
    const sync = accounts.getSync(SECOND);
    if (change === "epoch") sync.register(THREAD, URL, "b".repeat(64), "Codex Native2");
    else if (change === "reset-back") {
      sync.forget(THREAD, URL);
      sync.register(THREAD, URL, KEY, "Codex Native2");
    } else if (change === "failed-save") {
      sync.save = () => { throw new Error("Disk unavailable"); };
      assert.throws(() => sync.forget(THREAD, URL), /Disk unavailable/);
    } else {
      const entry = [...sync.entries.values()][0];
      entry.everSeen = true;
      entry.missingSince = 1;
      sync.now = () => 100_001;
      sync.enabled = () => true;
      sync.indexedThread = () => "absent";
      sync.onSync = async () => true;
      await sync.poll({ ready: true, found: new Map() });
      assert.equal(sync.entries.size, 0);
    }
    assert.throws(() => account.assertCurrent(), error => error?.code === "turn_cancelled");
  });
}

for (const stage of ["navigate", "mark"]) {
  test(`lineage changes during restored-page ${stage} cancel before returning a lease`, async () => {
    const accounts = accountResolverFixture();
    const fixture = recoveryFixture(undefined, {
      resolveTurnAccount: accounts.resolveTurnAccount,
      [stage]() { accounts.getSync(SECOND).forget(THREAD, URL); },
    });
    await assert.rejects(fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "pending", THREAD),
      error => error?.code === "turn_cancelled");
    assert.equal(fixture.getRemoved(), 1);
    assert.equal(fixture.host.turnTabs.size, 0);
  });
}

for (const replaced of [false, true]) {
  test(`failed descriptor admission ${replaced ? "preserves a later request's tab" : "releases only its own tab"}`, async () => {
    const fixture = recoveryFixture(undefined, {
      writeDescriptor(host) {
        const tab = host.turnTabs.get("reopened");
        assert.equal(tab.startRequest, "pending", "the request owns the tab before any admission await");
        if (replaced) tab.startRequest = "newer";
        throw new Error("Descriptor unavailable");
      },
    });
    fixture.host.getUseSavedChats = () => false;
    await assert.rejects(fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "pending", THREAD), /Descriptor unavailable/);
    assert.equal(fixture.getRemoved(), replaced ? 0 : 1);
    assert.equal(fixture.host.turnTabs.size, replaced ? 1 : 0);
  });
}

test("a failed route leaves no tab and a new explicit start uses the current binding", async () => {
  let calls = 0;
  const accounts = accountResolverFixture("bound", { route() { if (++calls === 1) throw new Error("Route unavailable"); } });
  const fixture = recoveryFixture(undefined, { resolveTurnAccount: accounts.resolveTurnAccount });
  accounts.context.browserHost = fixture.host;
  await assert.rejects(fixture.host.beginTurn("trace", false, 42, KEY, "Codex Native2", false, "failed", THREAD), /Route unavailable/);
  assert.equal(fixture.host.turnTabs.size, 0);
  await accounts.codexThreadAction({ threadId: THREAD, action: "move", accountId: "main" }, accounts.context.logger);
  assert.equal((await fixture.host.beginTurn("retry", false, 42, KEY, "Codex Native2", false, "explicit", THREAD)).conversationUrl, URL);
  assert.equal(fixture.created[0][5].accountId, "main");
});
