const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { isMcpConnectorCommand, createMcpConnectorCommand } = require("../electron/mcp-connector-command.cjs");

test("only the exact background connector flag requests creation", () => {
  assert.equal(isMcpConnectorCommand(["app", "--hidden", "--create-mcp-connector"]), true);
  for (const argv of [[], ["--create-mcp-connector=other"], ["--create-mcp"], ["--create-mcp-connector-extra"]]) {
    assert.equal(isMcpConnectorCommand(argv), false);
  }
});

test("the real main action uses the current account-switch state before creating", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("  if (!mcpConnectorCommand) mcpConnectorCommand =");
  const end = source.indexOf("\n  dispatchMcpConnectorCommand();", start);
  assert(start >= 0 && end > start);
  let run, created = 0, switching = false;
  const host = { partition: "persist:primary", ready: async () => {} };
  const context = {
    app: {}, BrowserWindow: function () {}, mcpConnectorCommand: null,
    createMcpConnectorCommand: options => { run = options.run; return {}; },
    IS_DEV_PROFILE: false, runtimeStartupInFlight: Promise.resolve(), quitting: false,
    shutdownInProgress: false, browserAccountsStatus: () => ({ switching }),
    runtimeHost: { currentOperation: () => null }, browserHost: host,
    createConfiguredConnector: async options => { assert.equal(options.browserHost, host); created++; return { created: true }; },
    stateStore: { update: value => value }, publishOperation() {}, send() {}, logger: {},
    startCatalogVerificationMonitor() {}, automaticMcpAttemptPid: 1,
  };
  vm.runInNewContext(source.slice(start, end), context);
  await run();
  assert.equal(created, 1);
  switching = true;
  await assert.rejects(run(), /busy|switch/);
  assert.equal(created, 1, "switching cannot submit another connector");
  switching = false;
  host.ready = async () => { context.browserHost = { ready: async () => {} }; };
  await assert.rejects(run(), /switch/);
  assert.equal(created, 1, "a replaced account host cannot submit");
  context.browserHost = host;
  host.ready = async () => { host.partition = "persist:other-account"; };
  await assert.rejects(run(), /switch/);
  assert.equal(created, 1, "an in-place account switch cannot submit");
});

test("real hidden startup defers maximized/fullscreen restoration and tracking until reveal", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf('  for (const event of ["enter-full-screen"');
  const end = source.indexOf('  logger.info("launcher.window_created"', start);
  assert(start >= 0 && end > start);
  let visible = false, maximized = false, fullscreen = false, tracking = 0;
  const window = Object.assign(new EventEmitter(), {
    show() { visible = true; this.emit("show"); },
    maximize() { maximized = true; this.show(); },
    setFullScreen(value) { fullscreen = value; if (value) this.show(); },
    center() {},
  });
  const context = {
    window, state: { onboardingComplete: true }, windowState: { bounds: { x: 0 }, maximized: true, fullscreen: true },
    mainWindow: window, mainWindowReadyToShow: false, mainWindowShowRequested: false,
    startHidden: true, showMainWindow: () => window.show(), trackWindowState: () => { tracking++; },
    windowStatePath: "unused", windowStateSnapshot: () => ({}), send() {}, logger: { warn() {} }, quitting: false,
  };
  vm.runInNewContext(source.slice(start, end), context);
  window.emit("ready-to-show");
  assert.equal(visible, false, "restoring a maximized window must not expose background startup");
  assert.equal(tracking, 0, "hidden shutdown must preserve the saved layout");
  window.show();
  assert.equal(maximized, true);
  assert.equal(fullscreen, true);
  assert.equal(tracking, 1);
});

test("real second-instance CLI dispatch returns before showing or recovering the window", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf('  app.on("second-instance"');
  const end = source.indexOf("\n  });", start) + "\n  });".length;
  assert(start >= 0 && end > start);
  let handler, dispatched = 0, shown = 0, recovered = 0;
  const context = { app: { on: (_name, callback) => { handler = callback; } }, isMcpConnectorCommand,
    pendingMcpConnectorCommand: false, dispatchMcpConnectorCommand: () => { dispatched++; },
    mainWindow: { isDestroyed: () => false, webContents: { isCrashed: () => true } },
    loadRenderer: async () => { recovered++; }, showMainWindow: () => { shown++; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  handler({}, ["app", "--create-mcp-connector"]);
  assert.equal(dispatched, 1);
  assert.equal(shown, 0);
  assert.equal(recovered, 0);
  handler({}, ["app"]);
  assert.equal(shown, 1);
});

test("background commands coalesce, replace stale success and write only bounded public results", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportFile = path.join(root, "mcp-connector-command.json");
  fs.writeFileSync(reportFile, JSON.stringify({ status: "completed", id: "stale" }));
  let calls = 0, finish;
  const app = { getPath: kind => { assert.equal(kind, "userData"); return root; }, getVersion: () => "test" };
  const command = createMcpConnectorCommand({ app, run: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } });
  const first = command.request();
  const second = command.request();
  assert.equal(first, second);
  const running = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(running.status, "running");
  assert.notEqual(running.id, "stale");
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ created: true, name: "Coding Tools Native2", href: "/plugins/plugins~Plugin_test", runtimeKey: "DO_NOT_EXPORT" });
  await first;
  const completed = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, running.id);
  assert.deepEqual(completed.result, { created: true, name: "Coding Tools Native2", href: "/plugins/plugins~Plugin_test" });
  assert.equal(completed.pid, process.pid);
  assert(completed.startedAt && completed.finishedAt);
  assert(!JSON.stringify(completed).includes("DO_NOT_EXPORT"));
});

test("each request is logged with what asked for it, and a success with whether it created the connector", async t => {
  // 2026-10-31: three failed attempts left no trace of who started them or whether any succeeded.
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  let finish;
  const command = createMcpConnectorCommand({
    app: { getPath: () => root, getVersion: () => "test" },
    logger: { info: (event, detail) => events.push({ event, ...detail }), warn: (event, detail) => events.push({ event, code: detail.code }) },
    run: () => new Promise(resolve => { finish = resolve; }),
  });
  const first = command.request("settings");
  command.request("command");
  await Promise.resolve();
  finish({ created: false, name: "Coding Tools", href: "/plugins/x" });
  await first;
  assert.deepEqual(events, [
    { event: "mcp.connector_creation_requested", source: "settings" },
    { event: "mcp.connector_creation_requested", source: "command", joined: true },
    { event: "mcp.connector_created", source: "settings", created: false },
  ]);
});

test("an initial receipt write failure rejects without starting or throwing through dispatch", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "mcp-connector-command.json"));
  let calls = 0, pending;
  const command = createMcpConnectorCommand({
    app: { getPath: () => root, getVersion: () => "test" },
    run: async () => { calls++; },
  });
  assert.doesNotThrow(() => { pending = command.request(); });
  await assert.rejects(pending);
  assert.equal(calls, 0);
});

test("background failures retain failure state without exporting private error details", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root, getVersion: () => "test" };
  const message = "The MCP server denied access. SECRET_PRIVATE_PATH";
  for (const failure of [new Error(message), message]) {
    const warnings = [];
    const command = createMcpConnectorCommand({ app,
      logger: { warn: (event, detail) => warnings.push({ event, code: detail.code }) },
      run: async () => { throw failure; },
    });
    await assert.rejects(command.request(), error => error === failure);
    const failed = JSON.parse(fs.readFileSync(path.join(root, "mcp-connector-command.json")));
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "mcp_access_denied");
    assert(!JSON.stringify(failed).includes("SECRET_PRIVATE_PATH"));
    assert.equal(failed.result, undefined);
    assert.deepEqual(warnings, [{ event: "mcp.connector_creation_failed", code: "mcp_access_denied" }]);
  }
});

test("missing ChatGPT form fields do not request a harness configuration change", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root, getVersion: () => "test" };
  for (const [message, code] of [
    ["ChatGPT did not expose the name and Tunnel ID fields.", "creation_failed"],
    ["The active MCP configuration has no tunnel ID.", "configuration_required"],
    ["Connect the saved automatic MCP harness before creating its ChatGPT connector.", "configuration_required"],
  ]) {
    const failure = new Error(message);
    const command = createMcpConnectorCommand({ app, run: async () => { throw failure; } });
    await assert.rejects(command.request(), failure);
    const report = JSON.parse(fs.readFileSync(path.join(root, "mcp-connector-command.json")));
    assert.equal(report.error.code, code);
  }
});
