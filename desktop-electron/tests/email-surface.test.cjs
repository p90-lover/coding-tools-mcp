"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/features/EmailSurface.tsx");
const tree = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Replay the real callbacks with delayed Worker replies, as the chat callback tests do.
function callback(name, globals) {
  let body;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) body ??= node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body ??= node;
    const hook = name.startsWith("layout:") ? "useLayoutEffect" : "useEffect";
    if ((name.startsWith("effect:") || name.startsWith("layout:")) && ts.isCallExpression(node)
      && node.expression.getText(tree) === hook && node.arguments[0]?.getText(tree).includes(name.slice(7))) body ??= node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(body, name);
  const exports = {};
  vm.runInNewContext(ts.transpileModule("exports.value = " + body.getText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, useCallback: fn => fn, ...globals });
  return exports.value;
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(setImmediate);

function fixture() {
  const cache = { origin: "worker-a", generation: 1, lists: new Map(), messages: new Map(), loading: new Map() };
  const activeGeneration = { current: 1 }, calls = [], timers = new Map(), intervals = new Map();
  let intervalId = 0;
  const state = { addresses: [{ id: 2, address: "b@example.test" }], addressCount: 1, addressesLoading: false,
    messages: [{ id: 2, subject: "Worker B" }], messageCount: 1, listLoading: false, listError: null,
    openId: null, openMessage: null, openError: null, pane: "list", confirm: null, pending: null, error: null,
    view: { kind: "all" }, addressQuery: "", filter: "", previewMode: "html", toast: null, status: null, loadError: null };
  const globals = { cache, generation: 1, activeGeneration, api: {}, status: { configured: true }, key: "*", viewAddress: undefined, addressQuery: "", openId: null,
    addressToken: { current: 0 }, listToken: { current: 0 }, openRef: { current: null }, prefetchTimer: { current: null },
    PAGE_SIZE: 20, ADDRESS_PAGE: 50, PREFETCH_DELAY_MS: 150, WAITING_POLL_MS: 5000, NEW_MAIL_POLL_MS: 20000,
    waitingForMail: false, pageHidden: () => false, hidden: () => false, mergeNewest: (_old, newest) => newest,
    window: { setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) },
    setInterval: fn => { globals.tick = fn; intervals.set(++intervalId, fn); return intervalId; }, clearInterval: id => intervals.delete(id), markRead() {},
    loadAddresses: async () => {},
  };
  for (const key of Object.keys(state)) globals[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
    state[key] = typeof value === "function" ? value(state[key]) : value;
  };
  globals.current = callback("current", { cache, activeGeneration });
  globals.forgetMessage = callback("forgetMessage", { cache });
  globals.forgetAddress = callback("forgetAddress", { cache });
  globals.showMessage = message => { state.openMessage = message; };
  globals.act = callback("act", globals);
  const switchWorker = () => {
    cache.generation += 1; cache.origin = "worker-b"; activeGeneration.current = cache.generation;
    cache.lists.clear(); cache.messages.clear(); cache.loading.clear();
    state.addressesLoading = true; state.listLoading = true;
  };
  return { globals, state, cache, calls, timers, intervals, switchWorker };
}

test("Email's new-mail poll and relative clock pause while hidden and resume when shown", async () => {
  const f = fixture(); let hidden = true, reads = 0, clockUpdates = 0;
  f.globals.hidden = () => hidden; f.globals.setNow = () => { clockUpdates += 1; };
  f.globals.api.listEmailMessages = async () => { reads += 1; return { messages: [], count: 0 }; };
  const clockCleanup = callback("effect:setNow(Date.now())", f.globals)(), clock = f.globals.tick;
  const pollCleanup = callback("effect:waitingForMail ? WAITING_POLL_MS", f.globals)(), poll = f.globals.tick;
  try {
    clock(); poll(); await settle(); assert.equal(reads, 0); assert.equal(clockUpdates, 0);
    hidden = false; clock(); poll(); await settle(); assert.equal(reads, 1); assert.equal(clockUpdates, 1);
    hidden = true; clock(); poll(); await settle(); assert.equal(reads, 1); assert.equal(clockUpdates, 1);
    hidden = false; clock(); poll(); await settle(); assert.equal(reads, 2); assert.equal(clockUpdates, 2);
  } finally { clockCleanup(); pollCleanup(); }
  assert.equal(f.intervals.size, 0);
});

test("an old Worker's list, poll, and address replies cannot update the new Worker", async t => {
  for (const kind of ["list", "poll", "addresses"]) await t.test(kind, async () => {
    const f = fixture(), reply = deferred();
    f.globals.api.listEmailMessages = () => reply.promise;
    f.globals.api.listEmailMailboxes = () => reply.promise;
    let request;
    if (kind === "poll") {
      callback("effect:waitingForMail ? WAITING_POLL_MS", f.globals)();
      f.globals.tick();
    } else request = callback(kind === "list" ? "loadList" : "loadAddresses", f.globals)(...(kind === "list" ? [0] : ["", 0]));
    f.switchWorker();
    reply.resolve({ messages: [{ id: 1, subject: "Worker A" }], mailboxes: [{ id: 1, address: "a@example.test" }], count: 8 });
    await request; await settle();
    assert.equal(f.state.messages[0].id, 2);
    assert.equal(f.state.addresses[0].id, 2);
    assert.equal(f.state.messageCount, 1);
    assert.equal(f.state.addressCount, 1);
    assert.equal(f.cache.lists.size, 0);
    assert.equal(f.state.listLoading, true);
    assert.equal(f.state.addressesLoading, true);
  });
});

test("an already queued hover prefetch cannot issue an old id against a new Worker", () => {
  const f = fixture();
  f.globals.fetchMessage = (_api, id) => { f.calls.push([f.cache.origin, id]); return Promise.resolve(null); };
  callback("prefetch", f.globals)(7);
  const queued = [...f.timers.values()][0].fn;
  f.switchWorker(); queued();
  assert.deepEqual(f.calls, []);
});

test("an old message completion cannot report an error on the new Worker's same numeric id", async () => {
  const f = fixture(), reply = deferred();
  f.globals.fetchMessage = () => reply.promise;
  callback("openById", f.globals)(7);
  f.switchWorker();
  f.globals.openRef.current = 7; f.state.openError = "new Worker state";
  reply.resolve(null); await settle();
  assert.equal(f.state.openError, "new Worker state");
});

test("a previous Worker's confirmation cannot delete the new Worker's same numeric id", async () => {
  const f = fixture();
  f.globals.confirm = { kind: "delete-message", id: 7, subject: "Worker A" };
  f.globals.api.deleteEmailMessage = async ({ id }) => { f.calls.push([f.cache.origin, id]); };
  const confirm = callback("runConfirm", f.globals);
  f.switchWorker(); await confirm();
  assert.deepEqual(f.calls, []);
});

test("Worker layout handoff clears reader, selected mailbox, and confirmations before the new controls paint", () => {
  const f = fixture();
  const cleanup = callback("layout:activeGeneration.current = generation", f.globals)();
  Object.assign(f.state, { openId: 7, openMessage: { id: 7, subject: "Worker A" }, openError: "old error", pane: "message",
    view: { kind: "address", address: "a@example.test", mailbox: { id: 7 } }, confirm: { kind: "clear-inbox", mailbox: { id: 7 } },
    addresses: [{ id: 7 }], messages: [{ id: 7 }], addressQuery: "old search", filter: "old filter", loadError: "old status error" });
  f.globals.openRef.current = 7;
  f.globals.prefetchTimer.current = f.globals.window.setTimeout(() => {}, 150);
  f.switchWorker(); cleanup();
  f.globals.generation = f.cache.generation;
  const unmount = callback("layout:activeGeneration.current = generation", f.globals)();
  assert.equal(f.state.openId, null); assert.equal(f.state.openMessage, null); assert.equal(f.state.openError, null);
  assert.equal(f.state.confirm, null); assert.equal(f.state.view.kind, "all"); assert.equal(f.state.pane, "list");
  assert.equal(f.state.addresses.length, 0); assert.equal(f.state.messages.length, 0);
  assert.equal(f.state.addressQuery, ""); assert.equal(f.state.filter, "");
  assert.equal(f.state.loadError, null);
  assert.equal(f.globals.openRef.current, null); assert.equal(f.timers.size, 0);
  assert.equal(f.globals.current(f.cache.generation), true);
  unmount(); assert.equal(f.globals.current(f.cache.generation), false);
});

test("queued list and address state updaters cannot repopulate another Worker's cache", async t => {
  for (const kind of ["list", "addresses"]) await t.test(kind, async () => {
    const f = fixture(), queued = [];
    f.globals.api.listEmailMessages = async () => ({ messages: [{ id: 1 }], count: 1 });
    f.globals.api.listEmailMailboxes = async () => ({ mailboxes: [{ id: 1 }], count: 1 });
    f.globals[kind === "list" ? "setMessages" : "setAddresses"] = update => queued.push(update);
    await callback(kind === "list" ? "loadList" : "loadAddresses", f.globals)(...(kind === "list" ? [0] : ["", 0]));
    assert.equal(queued.length, 1);
    f.switchWorker();
    const rows = kind === "list" ? f.state.messages : f.state.addresses;
    assert.equal(queued[0](rows), rows);
    assert.equal(f.cache.lists.size, 0);
  });
});

test("a completed old action cannot clear the new Worker's pending state or publish its error", async () => {
  const f = fixture(), reply = deferred();
  const pending = f.globals.act("old action", () => reply.promise);
  f.switchWorker(); f.state.pending = "new action"; f.state.error = "new error";
  reply.reject(new Error("old failure")); await pending;
  assert.equal(f.state.pending, "new action"); assert.equal(f.state.error, "new error");
});

test("an old status response cannot replace the newly selected Worker", async () => {
  const f = fixture(), reply = deferred();
  f.globals.api.emailStatus = () => reply.promise;
  callback("loadStatus", f.globals)();
  f.switchWorker(); f.state.status = { origin: "worker-b" };
  reply.resolve({ origin: "worker-a" }); await settle();
  assert.equal(f.state.status.origin, "worker-b");
});

test("the current Worker can still load and delete its own message", async () => {
  const f = fixture();
  f.globals.api.listEmailMessages = async () => ({ messages: [{ id: 7 }], count: 1 });
  await callback("loadList", f.globals)(0);
  assert.equal(f.state.messages[0].id, 7); assert.equal(f.cache.lists.get("*").messages[0].id, 7);
  f.globals.confirm = { kind: "delete-message", id: 7, subject: "Current Worker" };
  f.globals.api.deleteEmailMessage = async ({ id }) => { f.calls.push([f.cache.origin, id]); };
  await callback("runConfirm", f.globals)();
  assert.deepEqual(f.calls, [["worker-a", 7]]);
  assert.equal(f.state.messages.length, 0); assert.equal(f.cache.lists.get("*").messages.length, 0);
});

test("completed old deletions cannot remove the new Worker's rows or cached mail", async t => {
  for (const kind of ["delete-message", "clear-inbox", "remove-mailbox"]) await t.test(kind, async () => {
    const f = fixture(), reply = deferred();
    f.globals.confirm = kind === "delete-message" ? { kind, id: 7 } : { kind, mailbox: { id: 7, address: "a@example.test" } };
    const operation = kind === "delete-message" ? "deleteEmailMessage" : kind === "clear-inbox" ? "clearEmailInbox" : "removeEmailMailbox";
    f.globals.api[operation] = () => reply.promise;
    const pending = callback("runConfirm", f.globals)();
    f.switchWorker();
    const rows = [{ id: 7, subject: "Worker B" }];
    f.state.messages = rows; f.state.view = { kind: "address", address: "b@example.test" };
    f.cache.lists.set("*", { messages: rows, count: 1 }); f.cache.messages.set(7, rows[0]);
    reply.resolve({}); await pending;
    assert.equal(f.state.messages, rows); assert.equal(f.state.messageCount, 1);
    assert.equal(f.state.view.address, "b@example.test"); assert.equal(f.cache.messages.has(7), true);
    assert.equal(f.cache.lists.get("*").messages, rows);
  });
});

test("an old create-address completion cannot reopen its inbox on the new Worker", async () => {
  const f = fixture(), reply = deferred();
  f.globals.api.createEmailAddress = () => reply.promise;
  f.globals.copy = () => f.calls.push("copy old address");
  const pending = callback("createAndOpen", f.globals)("address", "example.test");
  f.switchWorker(); f.state.view = { kind: "all" };
  reply.resolve({ address: "a@example.test" }); await pending;
  assert.equal(f.state.view.kind, "all"); assert.deepEqual(f.calls, []);
});
