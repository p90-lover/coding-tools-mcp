const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
// main.cjs's write handlers first wait a moment for a late focus event (assertFocusedMainWindowSettled):
// in a sandbox that is its own focus check.
const settledFocus = (context) => Object.assign(context, { assertFocusedMainWindowSettled: context.assertFocusedMainWindowSettled
  ?? (async (...args) => context.assertFocusedMainWindow(...args)) });
const { createBrowserAccountMcpSync } = require("../electron/browser-account-mcp.cjs");
const { readChatGptAuthSession } = require("../electron/chatgpt-auth-session.cjs");

const cookie = value => [{ name: "__Secure-next-auth.session-token", value, session: true }];
function pending() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const state = { allowed: true, time: 1, target: "configured-tunnel", operation: null };
  const accounts = [{ id: "one", partition: "persist:one" }, { id: "two", partition: "persist:two" }];
  const cookies = new Map(accounts.map(account => [account.partition, cookie(account.id)]));
  const verified = [], connected = [], warnings = [];
  const deps = {
    accounts: () => accounts,
    canRun: ({ connecting = false } = {}) => state.allowed && (!state.operation || connecting && state.operation === "MCP connector creation"),
    target: () => state.target,
    now: () => state.time,
    readCookies: async partition => cookies.get(partition) ?? [],
    verifySignIn: async partition => { verified.push(partition); return { sessionAuthenticated: true, sessionCheckError: null }; },
    connect: async (id, current) => { assert(current()); connected.push(id); return { connected: true }; },
    logger: { warn: (event, fields) => warnings.push({ event, ...fields }) },
  };
  const sync = createBrowserAccountMcpSync(deps);
  return { state, accounts, cookies, verified, connected, warnings, deps, sync };
}

test("cookie candidates require fresh session proof; security failures never open setup", async () => {
  const f = fixture();
  f.cookies.set("persist:two", []);
  f.deps.verifySignIn = async partition => { f.verified.push(partition); return { sessionAuthenticated: false, sessionCheckError: "Security check" }; };
  await f.sync.sync();
  await f.sync.sync();
  assert.deepEqual(f.verified, ["persist:one"]);
  assert.deepEqual(f.connected, []);
  f.state.time += 60_000;
  f.deps.verifySignIn = async () => ({ sessionAuthenticated: true, sessionCheckError: null });
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one"]);
});

test("each isolated account connects once; historical okAt cannot skip this run's verification", async () => {
  const f = fixture();
  f.accounts[0].connector = { okAt: Date.now() };
  await f.sync.sync();
  await f.sync.sync();
  assert.deepEqual(f.verified, ["persist:one", "persist:two"]);
  assert.deepEqual(f.connected, ["one", "two"]);
});

test("one failure continues to other accounts; neither its own recorded failure nor a later one cuts its wait short", async () => {
  const f = fixture();
  f.deps.connect = async id => {
    f.connected.push(id);
    if (id === "one") {
      f.accounts[0].connector = { errorAt: f.state.time++ };
      throw new Error("Workspace owner required");
    }
    return { connected: true };
  };
  await f.sync.sync();
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two"]);
  assert.equal(f.warnings.length, 1);
  // A Connect by hand that failed again, or a turn, recorded a newer failure: the account was failing
  // anyway, so that alone starts no setup (before 2026-11-19 it started one at once).
  f.accounts[0].connector.errorAt = ++f.state.time;
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two"]);
  f.state.time += 10 * 60_000;
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one"], "it waits its 10 minutes");
});

test("a failed setup's log record names the page state it stopped on, beside the fixed message", async () => {
  // Live 2026-11-12: "ChatGPT did not expose one Personal plugins tab." twice in 20 minutes, with
  // nothing to tell a slow tab bar from a hidden or missing one.
  const f = fixture();
  const pageState = { tabs: 2, visibleTabs: 1, personalTabs: 0, directoryLoading: false, frameMs: 16 };
  f.deps.connect = async id => {
    if (id === "one") throw Object.assign(new Error("ChatGPT did not expose one Personal plugins tab."), { pageState });
    throw new Error("ChatGPT did not confirm the exact connector state.");
  };
  await f.sync.sync();
  assert.deepEqual(f.warnings, [
    { event: "browser_accounts.automatic_mcp_failed", message: "ChatGPT did not expose one Personal plugins tab.", pageState },
    { event: "browser_accounts.automatic_mcp_failed", message: "ChatGPT did not confirm the exact connector state." },
  ]);
});

test("a failed setup is tried again later, longer after each failure; one a workspace owner must clear waits an hour", async () => {
  // Live 2026-11-13: one failure ("ChatGPT verification is required…", on a signed-in account) left
  // that account's automatic setup stopped until its sign-in cookie changed, so it never connected.
  const f = fixture();
  f.accounts.splice(1);
  let code = "creation_failed";
  f.deps.connect = async id => {
    f.connected.push(id);
    if (code) {
      f.accounts[0].connector = { errorAt: f.state.time };
      throw Object.assign(new Error("ChatGPT did not confirm the selected workspace."), { code });
    }
    return { connected: true };
  };
  const at = minutes => { f.state.time += minutes * 60_000; return f.sync.sync(); };
  await f.sync.sync();
  assert.equal(f.warnings.at(-1).code, "creation_failed", "the warning says which kind of failure");
  await at(9);
  assert.equal(f.connected.length, 1, "not at once");
  await at(1);
  assert.equal(f.connected.length, 2, "10 minutes after the first failure");
  await at(19);
  assert.equal(f.connected.length, 2);
  await at(1);
  assert.equal(f.connected.length, 3, "20 after the second");
  for (const minutes of [40, 60, 60]) await at(minutes);
  assert.equal(f.connected.length, 6, "then 40, and never more than an hour");
  code = null;
  await at(60);
  assert.equal(f.connected.length, 7, "it connects");
  await at(600);
  assert.equal(f.connected.length, 7, "a connected account waits for new sign-in cookies");

  const person = fixture();
  person.accounts.splice(1);
  person.deps.connect = async id => {
    person.connected.push(id);
    person.accounts[0].connector = { errorAt: person.state.time };
    throw Object.assign(new Error("Only a verified owner of this ChatGPT workspace can create its MCP connector."), { code: "workspace_owner_required" });
  };
  await person.sync.sync();
  person.state.time += 59 * 60_000; await person.sync.sync();
  assert.equal(person.connected.length, 1, "what a workspace owner must do is not retried every 10 minutes");
  person.state.time += 60_000; await person.sync.sync();
  assert.equal(person.connected.length, 2, "but an hour later it looks again");
});

test("an account ChatGPT or Platform asked to sign in waits for that sign-in, not for the clock", async t => {
  // Live 2026-11-19: "verification_required" (setupCause "ownership check chatgpt:signed_out", ChatGPT's
  // 401) and Cloudflare's check failed again on every pass that let them, each time in hidden windows.
  for (const code of ["verification_required", "platform_sign_in_required"]) await t.test(code, async () => {
    const f = fixture();
    f.accounts.splice(1);
    let failing = true;
    f.deps.connect = async id => {
      f.connected.push(id);
      if (!failing) return { connected: true };
      f.accounts[0].connector = { errorAt: f.state.time };
      throw Object.assign(new Error("ChatGPT signed this account out. Sign in again in the Browser tab."), { code });
    };
    await f.sync.sync();
    for (const hours of [1, 6, 48]) {
      f.state.time += hours * 60 * 60_000;
      await f.sync.sync();
    }
    assert.equal(f.connected.length, 1, "no time ends the wait");
    assert.deepEqual(f.verified, ["persist:one"], "a waiting account is not even checked over HTTP");
    f.cookies.set("persist:one", cookie("signed-in-again"));
    failing = false;
    await f.sync.sync();
    assert.equal(f.connected.length, 2, "a new sign-in in its partition starts it at once");
    await f.sync.sync();
    assert.equal(f.connected.length, 2, "and once connected it is left alone");
  });

  await t.test("a sign-out ends the wait: the next sign-in is a new one", async () => {
    const f = fixture();
    f.accounts.splice(1);
    f.deps.connect = async id => {
      f.connected.push(id);
      throw Object.assign(new Error("signed out"), { code: "verification_required" });
    };
    await f.sync.sync();
    f.cookies.set("persist:one", []);
    await f.sync.sync();
    f.cookies.set("persist:one", cookie("one")); // signed in again; this test's cookie happens to match
    await f.sync.sync();
    assert.equal(f.connected.length, 2);
  });

  await t.test("the setup's own refresh of the sign-in cookie is no new sign-in", async () => {
    const f = fixture();
    f.accounts.splice(1);
    let refreshes = 0;
    f.deps.connect = async id => {
      f.connected.push(id);
      // Loading chatgpt.com in the setup's hidden window may hand the partition a new session cookie.
      f.cookies.set("persist:one", cookie(`refreshed-${++refreshes}`));
      throw Object.assign(new Error("signed out"), { code: "verification_required" });
    };
    await f.sync.sync();
    await f.sync.sync();
    assert.equal(f.connected.length, 1);
  });

  await t.test("a Connect by hand that connects it ends the wait without another setup", async () => {
    const f = fixture();
    f.accounts.splice(1);
    f.accounts[0].connector = { okAt: 5 }; // connected in an earlier run
    f.deps.connect = async id => {
      f.connected.push(id);
      f.accounts[0].connector = { ...f.accounts[0].connector, errorAt: f.state.time };
      throw Object.assign(new Error("signed out"), { code: "verification_required" });
    };
    await f.sync.sync();
    f.accounts[0].connector = { okAt: ++f.state.time, errorAt: null }; // the person's Connect (or a turn) bound it
    await f.sync.sync();
    await f.sync.sync();
    assert.equal(f.connected.length, 1, "a connected account needs no setup");
    f.accounts[0].connector = { okAt: f.state.time, errorAt: ++f.state.time }; // a turn later found it broken
    f.deps.connect = async id => { f.connected.push(id); return { connected: true }; };
    await f.sync.sync();
    assert.equal(f.connected.length, 2, "and it is set up again like any connected account");
  });
});

test("a runtime restart that adopts the same tunnel starts no setup for a failing account", async () => {
  // Live 2026-11-19: each account switch ran core setup, which restarted the runtime; each restart adopted
  // the running tunnel (runtime.tunnel_adopted) and invalidate() cleared every wait, so every failing
  // account loaded chatgpt.com again in hidden windows, one after another.
  const f = fixture();
  const codes = { one: "verification_required", two: "creation_failed" };
  f.accounts.push({ id: "three", partition: "persist:three" });
  f.cookies.set("persist:three", cookie("three"));
  f.deps.connect = async id => {
    f.connected.push(id);
    if (!codes[id]) return { connected: true };
    throw Object.assign(new Error(`failed ${id}`), { code: codes[id] });
  };
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "three"]);
  for (let restart = 0; restart < 3; restart++) {
    f.sync.invalidate({ tunnelStarted: false });
    await f.sync.sync();
  }
  assert.deepEqual(f.connected, ["one", "two", "three", "three", "three", "three"],
    "only the connected account checks its connector again; the failing ones keep waiting");
  assert.deepEqual(f.verified.filter(partition => partition !== "persist:three"), ["persist:one", "persist:two"],
    "the failing ones are not even checked over HTTP");

  f.sync.invalidate({ tunnelStarted: true });
  await f.sync.sync();
  assert.deepEqual(f.connected.slice(6), ["two", "three"],
    "a started tunnel retries a failure it can fix, never one waiting for the person's sign-in");
  f.sync.invalidate();
  await f.sync.sync();
  assert.deepEqual(f.connected.slice(8), ["three"], "invalidate() alone is an adoption: the retried failure waits again");
});

test("signInWait names a sign-in wait while the account's sign-in is unchanged, and nothing else", async () => {
  const f = fixture();
  const codes = { one: "verification_required", two: "creation_failed" };
  f.deps.connect = async id => { f.connected.push(id); throw Object.assign(new Error("failed"), { code: codes[id] }); };
  assert.equal(await f.sync.signInWait("one"), null, "nothing known yet");
  await f.sync.sync();
  assert.equal(await f.sync.signInWait("one"), "verification_required");
  assert.equal(await f.sync.signInWait("two"), null, "a failure the clock or a tunnel can end is no sign-in wait");
  assert.equal(await f.sync.signInWait("missing"), null);
  f.cookies.set("persist:one", cookie("signed-in-again"));
  assert.equal(await f.sync.signInWait("one"), null, "a new sign-in ends it");
  f.cookies.set("persist:one", []);
  assert.equal(await f.sync.signInWait("one"), null, "so does a sign-out");
});

test("a setup that gave way to an account switch runs again, though the switch is already over", async () => {
  const f = fixture();
  let interrupt = true;
  f.deps.connect = async id => {
    f.connected.push(id);
    if (id === "one" && interrupt) {
      interrupt = false;
      throw Object.assign(new Error("The browser account changed during MCP setup."), { gaveWay: true });
    }
    return { connected: true };
  };
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two"]);
  assert.deepEqual(f.warnings.map(entry => entry.event), ["browser_accounts.automatic_mcp_deferred"]);
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one"], "the account it gave way on is tried again");
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one"], "and once connected, left alone");
});

test("a setup that keeps giving way waits longer each time, and one that finishes starts the count again", async () => {
  // Seen 2026-11-10: with busy chats a round gave way every 1-2 minutes, each time after hidden
  // chatgpt.com windows had loaded, and it never connected anything.
  const f = fixture();
  let interrupt = true;
  f.deps.connect = async id => {
    f.connected.push(id);
    if (id === "one" && interrupt) throw Object.assign(new Error("Automatic MCP setup is waiting for an idle browser and the current account."), { gaveWay: true });
    return { connected: true };
  };
  const tries = () => f.connected.filter(id => id === "one").length;
  const verifiedOne = () => f.verified.filter(partition => partition === "persist:one").length;
  await f.sync.sync();
  assert.equal(tries(), 1);
  await f.sync.sync();
  assert.equal(tries(), 2, "one interruption is tried again on the next pass");
  const waits = [2, 4, 8, 16, 30, 30].map(minutes => minutes * 60_000);
  for (const wait of waits) {
    const before = tries(), checks = verifiedOne();
    f.state.time += wait - 1;
    await f.sync.sync();
    assert.equal(tries(), before, `still waiting just before ${wait / 60_000} min`);
    assert.equal(verifiedOne(), checks, "a waiting account is not even checked over HTTP");
    f.state.time += 1;
    await f.sync.sync();
    assert.equal(tries(), before + 1, `tried again after ${wait / 60_000} min`);
  }
  assert.deepEqual(f.connected.filter(id => id === "two"), ["two"], "the other account connected on the first pass");
  interrupt = false;
  f.state.time += 30 * 60_000;
  await f.sync.sync();
  assert.equal(tries(), waits.length + 3, "it connects once admitted long enough");
  interrupt = true;
  f.accounts[0].connector = { errorAt: ++f.state.time }; // a later check reports a new failure
  await f.sync.sync();
  await f.sync.sync();
  assert.equal(tries(), waits.length + 5, "after a finished setup, one interruption is tried again at once");
});

test("a Connect the user asked for holds the sync: none starts, and one connecting gives way", async () => {
  const f = fixture();
  const release = f.sync.hold();
  await f.sync.sync();
  assert.deepEqual(f.verified, [], "a held sync reads nothing and opens no setup");
  release();
  release(); // A second release must not let a later hold through.

  const started = pending(), gate = pending();
  f.deps.connect = async (id, current) => {
    f.connected.push(id);
    if (id === "one") { started.resolve(); await gate.promise; }
    // main.cjs's connect checks admission at each step and reports a lost one as gaveWay.
    if (!current()) throw Object.assign(new Error("Automatic MCP setup is waiting for an idle browser and the current account."), { gaveWay: true });
    return { connected: true };
  };
  const running = f.sync.sync();
  await started.promise;
  const manual = f.sync.hold();
  const second = f.sync.hold();
  gate.resolve();
  await running;
  assert.deepEqual(f.connected, ["one"], "it gave way on its account and started no other");
  assert.deepEqual(f.warnings.map(entry => entry.event), ["browser_accounts.automatic_mcp_deferred"]);
  manual();
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one"], "still held by the other Connect");
  second();
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "one", "two"], "once released, the account it gave way on is tried again");
});

test("main's account Connect holds the automatic sync, waits for the browser, and always lets go", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf('  handle("launcher:mcp-create-connector",');
  const close = /\r?\n {2}\}\);\r?\n/g;
  close.lastIndex = start;
  const match = close.exec(source);
  const end = match ? match.index + match[0].length : -1;
  assert(start > 0 && end > start);
  const order = [];
  let handler;
  const context = {
    MANUAL_MCP_CONNECT_WAIT_MS: 60_000,
    browserHost: { manualOperation: "MCP connector creation" },
    assertFocusedMainWindow: () => order.push("focus"),
    mcpConnectorCommand: { request: async () => order.push("settings") },
    automaticAccountMcp: { hold: () => { order.push("hold"); return () => order.push("release"); } },
    waitForManualOperation: async (host, timeoutMs) => { order.push(`wait ${timeoutMs}`); assert.equal(host, context.browserHost); },
    connectAccountMcp: async id => { order.push(`connect ${id}`); if (id === "bad") throw new Error("busy"); return { connected: true }; },
    handle: (channel, fn) => { assert.equal(channel, "launcher:mcp-create-connector"); handler = fn; },
  };
  vm.runInNewContext(source.slice(start, end), settledFocus(context));
  assert.deepEqual(await handler({}, "one"), { connected: true });
  assert.deepEqual(order, ["focus", "hold", "wait 60000", "connect one", "release"]);
  order.length = 0;
  await assert.rejects(handler({}, "bad"), /busy/);
  assert.deepEqual(order, ["focus", "hold", "wait 60000", "connect bad", "release"], "a failed Connect releases the hold too");
  order.length = 0;
  await handler({}, undefined);
  assert.deepEqual(order, ["focus", "settings"], "the Settings connector is unchanged");
});

test("new login cookies, changed target and a real sign-out permit a fresh attempt", async () => {
  const f = fixture();
  await f.sync.sync();
  f.cookies.set("persist:one", cookie("new-session"));
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one"]);
  f.state.target = "replacement-tunnel";
  await f.sync.sync();
  f.cookies.set("persist:two", []);
  await f.sync.sync();
  f.cookies.set("persist:two", cookie("two"));
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one", "one", "two", "two"]);
});

test("concurrent triggers share one pass and setup is sequential", async () => {
  const f = fixture(), gate = pending(), started = pending();
  let running = 0, maximum = 0;
  f.deps.connect = async id => {
    maximum = Math.max(maximum, ++running);
    f.connected.push(id);
    if (id === "one") { started.resolve(); await gate.promise; }
    running--;
    return { connected: true };
  };
  const first = f.sync.sync();
  await started.promise;
  assert.equal(f.sync.sync(), first);
  assert.deepEqual(f.connected, ["one"]);
  gate.resolve();
  await first;
  assert.equal(maximum, 1);
  assert.deepEqual(f.connected, ["one", "two"]);
});

test("lost focus, removed accounts and changed targets reject stale session completions", async t => {
  for (const change of ["focus", "removed", "target", "invalidate"]) await t.test(change, async () => {
    const f = fixture(), gate = pending(), started = pending();
    f.accounts.splice(1);
    f.deps.verifySignIn = async () => { started.resolve(); await gate.promise; return { sessionAuthenticated: true }; };
    const run = f.sync.sync();
    await started.promise;
    if (change === "focus") f.state.allowed = false;
    if (change === "removed") f.accounts.length = 0;
    if (change === "target") f.state.target = "changed";
    if (change === "invalidate") f.sync.invalidate();
    gate.resolve();
    await run;
    assert.deepEqual(f.connected, []);
  });
});

test("the coordinator permits its own held operation and resumes when focus returns", async () => {
  const f = fixture();
  f.accounts.splice(1);
  let loseFocus = true;
  f.deps.connect = async (id, current) => {
    f.state.operation = "MCP connector creation";
    assert(current(), "the operation it acquired must not block itself");
    f.connected.push(id);
    f.state.operation = null;
    if (loseFocus) { f.state.allowed = false; throw new Error("Lost focus"); }
    return { connected: true };
  };
  await f.sync.sync();
  f.state.allowed = true; loseFocus = false;
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "one"]);
});

test("disabled/busy setup performs no probing, and asynchronous preparation rechecks admission", async () => {
  const f = fixture();
  let prepared = 0;
  f.deps.prepare = async () => { prepared++; f.state.allowed = false; };
  f.state.operation = "session inspection";
  await f.sync.sync();
  assert.equal(prepared, 0);
  f.state.operation = null;
  await f.sync.sync();
  assert.equal(prepared, 1);
  assert.deepEqual(f.verified, []);
});

test("automatic admission preserves the selected surface while manual defaults and exclusion remain", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/browser-host.cjs"), "utf8");
  const start = source.indexOf("  async withManualOperation(");
  const end = source.indexOf("\n  /**", start);
  assert(start > 0 && end > start);
  const Host = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, { Error, Promise });
  const host = new Host(), throttles = [];
  let selected = "user-chat";
  host.ready = async () => {};
  host.view = { webContents: { isDestroyed: () => false, setBackgroundThrottling: value => throttles.push(value) } };
  host.activateHomeSurface = () => { selected = "home"; };
  host.setState = () => {};
  await host.withManualOperation("MCP connector creation", async () => {
    assert.equal(selected, "user-chat", "background admission must not activate/focus home");
    assert.equal(host.manualOperation, "MCP connector creation");
    assert.equal(host.manualOperationYields, true, "a background setup gives way to an account switch");
    await assert.rejects(host.withManualOperation("another operation", async () => {}), /already busy/);
  }, { preserveSurface: true });
  assert.equal(selected, "user-chat");
  assert.equal(host.manualOperation, null);
  assert.equal(host.manualOperationYields, false);
  await host.withManualOperation("session inspection", async () => {
    assert.equal(selected, "home");
    assert.equal(host.manualOperationYields, false, "one on the shown page still holds switches");
  });
  assert.deepEqual(throttles, [false, true, false, true]);

  // An operation starts once the page an account switch opened is open.
  const order = [];
  let opened;
  host.homeOpened = () => new Promise((resolve) => { opened = () => { order.push("opened"); resolve(); }; });
  const running = host.withManualOperation("ChatGPT login", async () => order.push("login"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  opened();
  await running;
  assert.deepEqual(order, ["opened", "login"]);
});

test("an automatic setup that gave way is told apart from one that failed", () => {
  const { automaticSetupGaveWay } = require("../electron/browser-account-mcp.cjs");
  const admitted = () => {};
  const refused = () => { throw new Error("Automatic MCP setup is waiting for an idle browser and the current account."); };
  assert.equal(automaticSetupGaveWay(undefined, () => true), false, "a setup someone asked for reports every failure");
  assert.equal(automaticSetupGaveWay(admitted, () => false), false, "still admitted, same account: it failed");
  assert.equal(automaticSetupGaveWay(admitted, () => true), true, "the shown account changed under it");
  assert.equal(automaticSetupGaveWay(refused, () => false), true, "it lost admission (focus, a switch, a turn)");
});

test("production wiring uses owned native sessions and actual focus; it leaves active Browser unchanged", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("  let accountMcpConfig = null;");
  const end = source.indexOf('\n  handle("launcher:doctor",', start);
  assert(start > 0 && end > start);
  const state = { autoConnectExistingMcp: true, coreSetupComplete: true, browserInteractionMode: "automatic" };
  let focused = false, nativeFocus = false, mode = null, coreReads = 0, chatStarting = false;
  const probes = [], routes = [], connections = [], callbacks = {};
  const accounts = [{ id: "one" }, { id: "two" }];
  const config = { browserHost: "launcher", mode: "full", appName: "Coding Tools Native2", automaticTunnel: { tunnelId: "configured" } };
  const context = {
    createBrowserAccountMcpSync, readChatGptAuthSession,
    stateStore: { read: () => state }, logger: { warn() {} },
    IS_DEV_PROFILE: false, quitting: false, shutdownInProgress: false,
    browserHost: { partition: "persist:shown", activeTraceId: null, currentOperation: () => mode, chatStarting: () => chatStarting },
    browserAccounts: { status: () => ({ accounts }), partitionOf: id => `persist:${id}` },
    browserAccountsStatus: () => ({ switching: false }),
    mainWindow: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
      isFocused: () => focused, webContents: { isFocused: () => nativeFocus },
      on: (event, fn) => { callbacks[event] = fn; }, once: (event, fn) => { callbacks[event] = fn; } },
    runtimeHost: { currentOperation: () => null, setupOperation: () => null, mcpCredentialsConfiguredAsync: async () => true },
    runtimeSupervisor: { readConfigAsync: async () => { coreReads++; return config; }, extraTunnels: { status: () => [] } },
    routeIdleAccountPartition: async partition => routes.push(partition),
    session: { fromPartition: partition => ({ cookies: { get: async () => cookie(partition) } }) },
    fetchThroughLauncherNetwork: async (url, options, scope) => {
      assert.equal(scope.useSessionCookies, true);
      probes.push([scope.partition, url]); assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
      return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ user: { id: scope.partition } }) };
    },
    connectAccountMcp: async (id, current) => { mode = "MCP connector creation"; current(); connections.push(id); mode = null; return { connected: true }; },
    setInterval: fn => { callbacks.timer = fn; return { unref() {} }; }, clearInterval() {},
  };
  vm.runInNewContext(source.slice(start, end), settledFocus(context));
  await context.automaticAccountMcp.sync();
  assert.equal(coreReads, 0, "no background reads or setup before genuine app focus");
  focused = true;
  await context.automaticAccountMcp.sync();
  assert.equal(probes.length, 0, "native window focus alone cannot replace renderer focus");
  nativeFocus = true; state.coreSetupComplete = false;
  await context.automaticAccountMcp.sync();
  assert.equal(probes.length, 0);
  state.coreSetupComplete = true; state.browserInteractionMode = "manual";
  await context.automaticAccountMcp.sync();
  assert.equal(probes.length, 0);
  state.browserInteractionMode = "automatic";
  await context.automaticAccountMcp.sync();
  assert.deepEqual(connections, ["one", "two"]);
  assert.deepEqual(routes, ["persist:one", "persist:two"]);
  assert.deepEqual(probes, [["persist:one", "https://chatgpt.com/api/auth/session"], ["persist:two", "https://chatgpt.com/api/auth/session"]]);
  assert.equal(context.browserHost.partition, "persist:shown");
  await context.automaticAccountMcp.sync();
  assert.equal(connections.length, 2);

  // The person chose background checks (2026-11-24): once they have used the app this run, checks go on
  // with its window behind others, hidden or minimized. Only browser work holds them: a chat taking the
  // browser (chatStarting) or a running turn.
  focused = false; nativeFocus = false;
  Object.assign(context.mainWindow, { isVisible: () => false, isMinimized: () => true });
  context.automaticAccountMcp.invalidate();
  await context.automaticAccountMcp.sync();
  assert.deepEqual(connections, ["one", "two", "one", "two"], "checks go on in the background");
  context.automaticAccountMcp.invalidate();
  chatStarting = true;
  await context.automaticAccountMcp.sync();
  assert.equal(connections.length, 4, "a chat taking the browser holds them");
  chatStarting = false; context.browserHost.activeTraceId = "turn";
  await context.automaticAccountMcp.sync();
  assert.equal(connections.length, 4, "so does a running turn");
  context.browserHost.activeTraceId = null;
  await context.automaticAccountMcp.sync();
  assert.equal(connections.length, 6);
});

// The app's own requests take the App route (Global Routing) through the default session, never the
// route of whichever Browser-tab account is on screen; a session read takes its own account's route.
// Which proxy that is, is the egress router's business: main only answers the router's sign-in.
test("launcher transport sends the app's own requests on the App route and session reads on their account's", async t => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("async function fetchThroughLauncherNetwork(");
  const end = source.indexOf("\nfunction getRegisterHost", start);
  assert(start > 0 && end > start);
  const ROUTER = { isProxy: true, host: "127.0.0.1", port: 17555 };
  for (const mode of ["session", "native"]) await t.test(mode, async () => {
    const requests = [];
    const context = {
      providerNetworkReady: async () => ({
        routerSignIn: (authInfo, target) => (authInfo?.isProxy && authInfo.host === ROUTER.host && authInfo.port === ROUTER.port
          ? { username: target, password: "router-key" } : null),
      }),
      browserAccounts: { accountIdOfPartition: p => p === "persist:selected" ? "selected" : null },
      browserHost: { partition: "persist:shown" }, LAUNCHER_PROFILE: { browserPartition: "persist:default" },
      session: { fromPartition: partition => ({ partition }), defaultSession: { partition: "default" } }, electronNet: {},
      fetchNativeWithProxyAuth: async options => { requests.push(options); return { status: 200 }; },
    };
    vm.runInNewContext(source.slice(start, end), settledFocus(context));
    await context.fetchThroughLauncherNetwork(mode === "native" ? "https://github.com/update" : "https://chatgpt.com/api/auth/session", { method: "GET" },
      mode === "native" ? undefined : { partition: "persist:selected", useSessionCookies: true });
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.browserSession.partition, mode === "native" ? "default" : "persist:selected", "never the account on screen");
    assert.equal(request.useSessionCookies, mode !== "native");
    assert.equal(request.getProxyCredentials(ROUTER).username, mode === "native" ? "app" : "browser:persist:selected");
    assert.equal(request.getProxyCredentials({ ...ROUTER, host: "isp.decodo.test" }), null, "no other proxy gets the router's sign-in");
    assert.equal(request.getProxyCredentials({ ...ROUTER, port: 1234 }), null);
    await assert.rejects(context.fetchThroughLauncherNetwork("https://chatgpt.com/api/auth/session", { method: "GET" },
      { partition: "persist:unregistered", useSessionCookies: true }), /registered account/i);
    assert.equal(requests.length, 1);
  });
});

test("a setup whose own ChatGPT pages refreshed the sign-in cookie does not start again for it", async () => {
  const f = fixture();
  // The setup's chatgpt.com pages re-issue the session cookie (same sign-in, new value).
  f.deps.connect = async (id, current) => {
    assert(current());
    f.connected.push(id);
    f.cookies.set(`persist:${id}`, cookie(`${id}-refreshed-${f.connected.length}`));
    return { connected: true };
  };
  await f.sync.sync();
  await f.sync.sync();
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two"]);
  // A sign-in after that is still a reason to check again.
  f.cookies.set("persist:one", cookie("signed-in-again"));
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one"]);
});
