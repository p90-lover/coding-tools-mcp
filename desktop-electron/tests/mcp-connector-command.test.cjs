const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { isMcpConnectorCommand, mcpConnectorCommandAction, createMcpConnectorCommand } = require("../electron/mcp-connector-command.cjs");

test("only the exact background connector flag requests creation", () => {
  assert.equal(isMcpConnectorCommand(["app", "--hidden", "--create-mcp-connector"]), true);
  assert.equal(isMcpConnectorCommand(["app", "--hidden", "--open-mcp-tunnel-settings"]), true);
  assert.equal(mcpConnectorCommandAction(["--open-primary-mcp-tunnel-settings"]), "primary-tunnel-settings");
  assert.equal(mcpConnectorCommandAction(["app", "--hidden", "--add-mcp-tunnel"]), "add-tunnel");
  for (const argv of [[], ["--create-mcp-connector=other"], ["--create-mcp"], ["--create-mcp-connector-extra"], ["--open-mcp-tunnel-settings=other"], ["--open-primary-mcp-tunnel-settings=other"], ["--add-mcp-tunnel=other"], ["--add-mcp-tunnel-extra"]]) {
    assert.equal(isMcpConnectorCommand(argv), false);
  }
});

test("the real main action uses the current account-switch state before creating", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("  if (!mcpConnectorCommand) mcpConnectorCommand =");
  const end = source.indexOf("\n  dispatchMcpConnectorCommand();", start);
  assert(start >= 0 && end > start);
  let run, created = 0, settingsOpened = 0, switching = false;
  const host = { partition: "persist:primary", ready: async () => {} };
  const context = {
    app: {}, BrowserWindow: function () {}, mcpConnectorCommand: null, LAUNCHER_PROFILE: { browserPartition: "persist:original" },
    createMcpConnectorCommand: options => { run = options.run; return {}; },
    IS_DEV_PROFILE: false, runtimeStartupInFlight: Promise.resolve(), quitting: false,
    shutdownInProgress: false, browserAccountsStatus: () => ({ switching }),
    browserAccounts: { accountIdOfPartition: () => "main" }, runtimeSupervisor: null,
    runtimeHost: { currentOperation: () => null }, browserHost: host,
    createConfiguredConnector: async options => { assert.equal(options.browserHost, host); created++; return { created: true }; },
    openConfiguredTunnelSettings: async options => {
      assert.equal(options.browserHost, host);
      assert.equal(options.partition, settingsOpened === 0 ? host.partition : "persist:original");
      settingsOpened++;
      return { opened: true };
    },
    stateStore: { update: value => value }, publishOperation() {}, send() {}, logger: {},
    startCatalogVerificationMonitor() {}, automaticMcpAttemptPid: 1,
  };
  vm.runInNewContext(source.slice(start, end), context);
  await run();
  assert.equal(created, 1);
  await run("tunnel-settings");
  assert.equal(settingsOpened, 1);
  assert.equal(created, 1, "opening tunnel settings must not submit a connector");
  await run("primary-tunnel-settings");
  assert.equal(settingsOpened, 2);
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

test("the real main action selects the captured account's tunnel and waits for readiness", async t => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("  if (!mcpConnectorCommand) mcpConnectorCommand =");
  const end = source.indexOf("\n  dispatchMcpConnectorCommand();", start);
  assert(start >= 0 && end > start);
  for (const scenario of [
    { name: "targets and records the matching ready account tunnel", accountId: "account-2", state: "ready", extra: true },
    { name: "ignores another account's tunnel", accountId: "account-1", state: "ready", extra: false },
    { name: "reconnects the matching account tunnel before submission", accountId: "account-2", state: "stopped", extra: true },
    { name: "aborts when the account switches during reconnect", accountId: "account-2", state: "stopped", switches: true },
    { name: "rejects a tunnel that is still unready after reconnect", accountId: "account-2", state: "failed", staysUnready: true },
  ]) await t.test(scenario.name, async () => {
    let run, monitors = 0;
    const created = [], bindings = [], reconnected = [], stateUpdates = [];
    const host = { partition: "persist:account-2", ready: async () => {} };
    const tunnel = { id: "extra-id", tunnelId: "tunnel_account_2", accountId: scenario.accountId, state: scenario.state };
    const extraTunnels = {
      status: () => [tunnel],
      reconnect: async id => {
        reconnected.push(id);
        if (!scenario.staysUnready) tunnel.state = "ready";
        if (scenario.switches) host.partition = "persist:account-1";
        return { ...tunnel };
      },
      setConnector: (id, href) => bindings.push([id, href]),
    };
    const context = {
      app: {}, BrowserWindow: function () {}, mcpConnectorCommand: null,
      createMcpConnectorCommand: options => { run = options.run; return {}; },
      IS_DEV_PROFILE: false, runtimeStartupInFlight: Promise.resolve(), quitting: false,
      shutdownInProgress: false, browserAccountsStatus: () => ({ switching: false }),
      browserAccounts: { accountIdOfPartition: partition => partition === "persist:account-2" ? "account-2" : "account-1" },
      runtimeSupervisor: { extraTunnels }, runtimeHost: { currentOperation: () => null }, browserHost: host,
      createConfiguredConnector: async options => { created.push(options); return { created: true, href: "/plugins/account-2" }; },
      stateStore: { update: value => { stateUpdates.push(value); return value; } }, publishOperation() {}, send() {}, logger: {},
      startCatalogVerificationMonitor: () => { monitors++; }, automaticMcpAttemptPid: 1,
    };
    vm.runInNewContext(source.slice(start, end), context);
    if (scenario.switches || scenario.staysUnready) {
      await assert.rejects(run(), scenario.switches ? /switch/ : /ready/);
      assert.equal(created.length, 0, "reconnect must not submit into a changed or unready account");
      assert.equal(bindings.length, 0);
    } else {
      await run();
      assert.equal(created.length, 1);
      assert.equal(created[0].browserHost, host);
      if (scenario.extra) {
        assert.equal(created[0].target?.tunnelId, tunnel.tunnelId);
        assert.equal(created[0].target?.partition, "persist:account-2");
        assert.deepEqual(bindings, [[tunnel.id, "/plugins/account-2"]]);
      } else {
        assert.equal(created[0].target, undefined, "another account's tunnel cannot replace the primary path");
        assert.equal(bindings.length, 0);
      }
    }
    const usesPrimary = scenario.extra === false;
    assert.equal(stateUpdates.length, usesPrimary ? 1 : 0, "extra tunnel creation cannot mark the main connector state");
    assert.equal(monitors, usesPrimary ? 1 : 0, "extra tunnel creation cannot start main connector verification");
    assert.deepEqual(reconnected, scenario.state === "ready" ? [] : [tunnel.id]);
  });
});

test("the real hidden tunnel-add action consumes only successful stable account input", async t => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("  if (!mcpConnectorCommand) mcpConnectorCommand =");
  const end = source.indexOf("\n  dispatchMcpConnectorCommand();", start);
  assert(start >= 0 && end > start);
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scenarios = [
    { name: "adds through the native lifecycle and consumes the private input" },
    { name: "rejects another account's input", mismatch: true },
    { name: "keeps failed input for retry", fails: true },
    { name: "keeps input if the account switches during add", switches: true },
    { name: "preserves replacement input written during add", replaces: true },
    { name: "reuses an already ready matching tunnel", existing: "ready" },
    { name: "reconnects an existing matching tunnel", existing: "stopped" },
    { name: "rejects an oversized input", oversized: true },
    { name: "rejects malformed private JSON", malformed: true },
  ];
  for (const [index, scenario] of scenarios.entries()) await t.test(scenario.name, async () => {
    const coreHome = path.join(root, String(index));
    const inputFile = path.join(coreHome, "secrets", "mcp-tunnel-add.json");
    fs.mkdirSync(path.dirname(inputFile), { recursive: true });
    const input = { accountId: scenario.mismatch ? "account-1" : "account-2", label: "Account 2",
      tunnelId: "tunnel_22222222222222222222222222222222", runtimeKey: "DO_NOT_EXPORT_RUNTIME_KEY" };
    const replacement = JSON.stringify({ ...input, tunnelId: "tunnel_33333333333333333333333333333333", runtimeKey: "NEW_PRIVATE_RUNTIME_KEY" });
    fs.writeFileSync(inputFile, scenario.oversized ? "x".repeat(64 * 1024 + 1)
      : scenario.malformed ? '{"runtimeKey":"DO_NOT_EXPORT_RUNTIME_KEY",' : JSON.stringify(input));
    let run, manual = 0, creates = 0;
    const added = [], reconnected = [], stateUpdates = [];
    let tunnels = scenario.existing ? [{ id: "extra-id", accountId: "account-2", tunnelId: input.tunnelId, state: scenario.existing }] : [];
    const host = { partition: "persist:account-2", ready: async () => {},
      withManualOperation: async (_name, work) => { manual++; return work(); } };
    const extraTunnels = {
      status: () => tunnels,
      add: async value => {
        added.push(value);
        if (scenario.fails) throw new Error("DO_NOT_EXPORT_RUNTIME_KEY private backend error");
        tunnels = [{ id: "extra-id", accountId: value.accountId, tunnelId: value.tunnelId, state: "ready" }];
        if (scenario.switches) host.partition = "persist:account-1";
        if (scenario.replaces) {
          await Promise.resolve();
          fs.writeFileSync(inputFile, replacement);
        }
        return tunnels[0];
      },
      reconnect: async id => { reconnected.push(id); tunnels[0].state = "ready"; return tunnels[0]; },
    };
    const context = {
      fs, path, Buffer, CORE_HOME: coreHome, app: {}, BrowserWindow: function () {}, mcpConnectorCommand: null,
      createMcpConnectorCommand: options => { run = options.run; return {}; },
      IS_DEV_PROFILE: false, runtimeStartupInFlight: Promise.resolve(), quitting: false,
      shutdownInProgress: false, browserAccountsStatus: () => ({ switching: false }),
      browserAccounts: { accountIdOfPartition: partition => partition === "persist:account-2" ? "account-2" : "account-1" },
      runtimeSupervisor: { extraTunnels }, runtimeHost: { currentOperation: () => null }, browserHost: host,
      createConfiguredConnector: async () => { creates++; return { created: true }; },
      stateStore: { update: value => { stateUpdates.push(value); return value; } }, publishOperation() {}, send() {}, logger: {},
      startCatalogVerificationMonitor() {}, automaticMcpAttemptPid: 1,
    };
    vm.runInNewContext(source.slice(start, end), context);
    const fails = scenario.mismatch || scenario.fails || scenario.switches || scenario.replaces || scenario.oversized || scenario.malformed;
    if (fails) await assert.rejects(run("add-tunnel"));
    else assert.equal((await run("add-tunnel")).added, true);
    assert.equal(creates, 0, "adding a tunnel cannot submit a ChatGPT connector");
    assert.equal(manual, 1, "the background action must use the browser operation boundary");
    assert.equal(fs.existsSync(inputFile), Boolean(fails), "only a stable successful add consumes the input");
    assert.equal(added.length, scenario.existing || scenario.mismatch || scenario.oversized || scenario.malformed ? 0 : 1);
    assert.deepEqual(reconnected, scenario.existing === "stopped" ? ["extra-id"] : []);
    assert.equal(stateUpdates.length, 0, "adding an extra tunnel cannot change primary configuration state");
    if (added.length) {
      assert.equal(added[0].accountId, "account-2");
      assert.equal(added[0].runtimeKey, input.runtimeKey);
    }
    if (scenario.replaces) {
      assert.equal(fs.readFileSync(inputFile, "utf8"), replacement, "an earlier add cannot consume a later key input");
      assert.equal(tunnels[0].tunnelId, input.tunnelId);
      assert.equal(tunnels[0].accountId, "account-2");
    }
    if (scenario.switches) {
      host.partition = "persist:account-2";
      assert.equal((await run("add-tunnel")).added, true);
      assert.equal(added.length, 1, "retry after an account switch must reuse the successful native add");
      assert.equal(fs.existsSync(inputFile), false);
    }
  });
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
  const context = { app: { on: (_name, callback) => { handler = callback; } }, isMcpConnectorCommand, mcpConnectorCommandAction,
    pendingMcpConnectorCommand: false, dispatchMcpConnectorCommand: () => { dispatched++; },
    mainWindow: { isDestroyed: () => false, webContents: { isCrashed: () => true } },
    loadRenderer: async () => { recovered++; }, showMainWindow: () => { shown++; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  handler({}, ["app", "--create-mcp-connector"]);
  assert.equal(dispatched, 1);
  assert.equal(shown, 0);
  assert.equal(recovered, 0);
  handler({}, ["app", "--open-mcp-tunnel-settings"]);
  assert.equal(context.pendingMcpConnectorCommand, "tunnel-settings");
  assert.equal(shown, 0);
  assert.equal(recovered, 0);
  handler({}, ["app", "--hidden", "--add-mcp-tunnel"]);
  assert.equal(context.pendingMcpConnectorCommand, "add-tunnel");
  assert.equal(shown, 0);
  assert.equal(recovered, 0);
  handler({}, ["app"]);
  assert.equal(shown, 1);
});

test("tunnel settings commands preserve their intent and do not claim connector creation", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let finish, action;
  const command = createMcpConnectorCommand({
    app: { getPath: () => root, getVersion: () => "test" },
    run: value => { action = value; return new Promise(resolve => { finish = resolve; }); },
  });
  const first = command.request("tunnel-settings");
  assert.equal(first, command.request("tunnel-settings"));
  const otherAction = assert.rejects(command.request(), /busy/);
  await Promise.resolve();
  const reportFile = path.join(root, "mcp-connector-command.json");
  const runningAction = JSON.parse(fs.readFileSync(reportFile)).action;
  finish({ opened: true, created: true, name: "Coding Tools Native2", token: "DO_NOT_EXPORT" });
  await first;
  await otherAction;
  assert.equal(action, "tunnel-settings");
  assert.equal(runningAction, "tunnel-settings");
  const completed = JSON.parse(fs.readFileSync(reportFile));
  assert.deepEqual(completed.result, { opened: true, name: "Coding Tools Native2" });
  assert(!JSON.stringify(completed).includes("DO_NOT_EXPORT"));
  await assert.rejects(command.request("https://example.test"), /action/);
});

test("tunnel-add receipts and logger details never export private input or backend errors", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root, getVersion: () => "test" };
  const warnings = [];
  let action;
  const command = createMcpConnectorCommand({ app,
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    run: async value => {
      action = value;
      return { added: true, name: "DO_NOT_EXPORT_RUNTIME_KEY", runtimeKey: "DO_NOT_EXPORT_RUNTIME_KEY", href: "PRIVATE_INPUT_PATH" };
    },
  });
  await command.request("add-tunnel");
  assert.equal(action, "add-tunnel");
  const completed = JSON.parse(fs.readFileSync(path.join(root, "mcp-connector-command.json")));
  assert.deepEqual(completed.result, { added: true });
  assert(!JSON.stringify(completed).includes("DO_NOT_EXPORT_RUNTIME_KEY"));
  assert(!JSON.stringify(completed).includes("PRIVATE_INPUT_PATH"));
  const failure = new Error("DO_NOT_EXPORT_RUNTIME_KEY PRIVATE_INPUT_PATH private backend error");
  const failedCommand = createMcpConnectorCommand({ app,
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    run: async () => { throw failure; },
  });
  await assert.rejects(failedCommand.request("add-tunnel"), error => error === failure);
  const failed = JSON.parse(fs.readFileSync(path.join(root, "mcp-connector-command.json")));
  assert.equal(failed.error.code, "tunnel_add_failed");
  assert(!JSON.stringify([failed, warnings]).includes("DO_NOT_EXPORT_RUNTIME_KEY"));
  assert(!JSON.stringify([failed, warnings]).includes("PRIVATE_INPUT_PATH"));
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
