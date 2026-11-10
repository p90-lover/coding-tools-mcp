const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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

test("one failure continues to other accounts and does not retry its own recorded failure", async () => {
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
  f.accounts[0].connector.errorAt = ++f.state.time; // a later tool/explicit check reported a new failure
  await f.sync.sync();
  assert.deepEqual(f.connected, ["one", "two", "one"]);
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
    if (!current()) throw Object.assign(new Error("Automatic MCP setup is waiting for the focused, idle app and current account."), { gaveWay: true });
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
  vm.runInNewContext(source.slice(start, end), context);
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
  const refused = () => { throw new Error("Automatic MCP setup is waiting for the focused, idle app and current account."); };
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
  let focused = false, nativeFocus = false, mode = null, coreReads = 0;
  const probes = [], routes = [], connections = [], callbacks = {};
  const accounts = [{ id: "one" }, { id: "two" }];
  const config = { browserHost: "launcher", mode: "full", appName: "Coding Tools Native2", automaticTunnel: { tunnelId: "configured" } };
  const context = {
    createBrowserAccountMcpSync, readChatGptAuthSession,
    stateStore: { read: () => state }, logger: { warn() {} },
    IS_DEV_PROFILE: false, quitting: false, shutdownInProgress: false,
    browserHost: { partition: "persist:shown", activeTraceId: null, currentOperation: () => mode },
    browserAccounts: { status: () => ({ accounts }), partitionOf: id => `persist:${id}` },
    browserAccountsStatus: () => ({ switching: false }),
    mainWindow: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
      isFocused: () => focused, webContents: { isFocused: () => nativeFocus },
      on: (event, fn) => { callbacks[event] = fn; }, once: (event, fn) => { callbacks[event] = fn; } },
    runtimeHost: { currentOperation: () => null, mcpCredentialsConfiguredAsync: async () => true },
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
  vm.runInNewContext(source.slice(start, end), context);
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
});

test("launcher transport pins owned session reads to the bound proxy and keeps native defaults", async t => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("async function fetchThroughLauncherNetwork(");
  const end = source.indexOf("\nfunction getRegisterHost", start);
  assert(start > 0 && end > start);
  for (const mode of ["bound", "global", "native"]) await t.test(mode, async () => {
    const requests = [];
    const profiles = { bound: { id: "bound", endpoint: { host: "bound.invalid", port: 9001 } }, global: { id: "global", endpoint: { host: "global.invalid", port: 9002 } } };
    const context = {
      providerNetworkReady: async () => ({ store: { snapshot: () => ({ routing: { globalEnabled: true, globalProfileId: "global" } }),
        activeProxy: id => profiles[id], proxySecret: id => ({ username: id, password: "fixture" }) } }),
      browserAccounts: { accountIdOfPartition: p => p === "persist:selected" ? "selected" : null,
        proxyForPartition: () => mode === "bound" ? "bound" : null },
      browserHost: { partition: "persist:shown" }, LAUNCHER_PROFILE: { browserPartition: "persist:default" },
      session: { fromPartition: partition => ({ partition }) }, electronNet: {},
      fetchNativeWithProxyAuth: async options => { requests.push(options); return { status: 200 }; },
    };
    vm.runInNewContext(source.slice(start, end), context);
    await context.fetchThroughLauncherNetwork(mode === "native" ? "https://github.com/update" : "https://chatgpt.com/api/auth/session", { method: "GET" },
      mode === "native" ? undefined : { partition: "persist:selected", useSessionCookies: true });
    assert.equal(requests.length, 1);
    const request = requests[0], profile = profiles[mode === "bound" ? "bound" : "global"];
    assert.equal(request.browserSession.partition, mode === "native" ? "persist:shown" : "persist:selected");
    assert.equal(request.useSessionCookies, mode !== "native");
    assert.equal(request.getProxyCredentials({ host: profile.endpoint.host, port: profile.endpoint.port }).username, profile.id);
    assert.equal(request.getProxyCredentials({ host: "unexpected.invalid", port: profile.endpoint.port }), null);
    assert.equal(request.getProxyCredentials({ host: profile.endpoint.host, port: 1234 }), null);
    await assert.rejects(context.fetchThroughLauncherNetwork("https://chatgpt.com/api/auth/session", { method: "GET" },
      { partition: "persist:unregistered", useSessionCookies: true }), /registered account/i);
    assert.equal(requests.length, 1);
  });
});
