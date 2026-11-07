const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function fixture() {
  const text = fs.readFileSync(process.env.CODEX_STARTUP_SOURCE || path.join(__dirname, "../electron/main.cjs"), "utf8");
  const file = ts.createSourceFile("main.cjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let automatic;
  let manual;
  let restart;
  let retryDelays;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "autoConnectExistingMcpIfReady") automatic = node.getText(file);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "restartAutomaticMcpVerification") restart = node.getText(file);
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "performMcpVerification") manual = node.initializer.getText(file);
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "AUTOMATIC_MCP_RETRY_DELAYS_MS") retryDelays = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(automatic && manual, "automatic and manual paths reuse the same verifier");
  assert(restart && retryDelays, "a new round and the retry delays are defined beside it");
  const state = { autoConnectExistingMcp: true, coreSetupComplete: true, browserInteractionMode: "automatic", mcpSetupComplete: false };
  const calls = [];
  const health = { service: "codex-chatgpt-web", status: "ok", pid: 123, version: "5.0.6", mode: "full", accepting_turns: true, successful_model_catalog_requests: 1, active_http_turns: 0, active_browser_turns: 0 };
  const browser = { authenticated: true, surfaceActive: false };
  const options = {
    logger: { info() {}, warn() {} },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    health,
  };
  const context = vm.createContext({
    ...options, IS_DEV_PROFILE: false, quitting: false, shutdownInProgress: false,
    automaticMcpAttempt: null, mcpVerificationInFlight: null, catalogVerificationTimer: null,
    // The signed-in accounts' MCP sync (#1089): a new round makes it look again.
    accountSyncs: [], automaticAccountMcp: { invalidate() { context.accountSyncs.push("invalidate"); }, async sync() { context.accountSyncs.push("sync"); } },
    send() {}, publishOperation: op => calls.push(op.status), mainWindow: null,
    runtimeSupervisor: { readConfig: () => ({ mode: "full", releaseVersion: "5.0.6" }), readState: () => ({ daemonPid: 123 }) },
    runtimeHost: { currentOperation: () => null, mcpCredentialsConfigured: () => true,
      doctor: async () => { calls.push("doctor"); return { ok: true, checks: [] }; },
      mcpConnectorName: () => "Saved connector", setupMcp: () => { throw Error("Must not run setup"); } },
    browserHost: { activeTraceId: null, snapshot: () => browser, currentOperation: () => null,
      view: { webContents: { isDestroyed: () => false, executeJavaScript: async () => false } },
      verifyConnector: async name => { assert.equal(name, "Saved connector"); calls.push("connector"); } },
  });
  context.AUTOMATIC_MCP_RETRY_DELAYS_MS = vm.runInContext(`(${retryDelays})`, context);
  context.verifyMcpConnection = vm.runInContext(`(${manual})`, context);
  const monitors = [];
  context.startCatalogVerificationMonitor = () => monitors.push("monitor");
  const run = vm.runInContext(`(${automatic})`, context);
  const restartRound = vm.runInContext(`(${restart})`, context);
  return {
    state, browser, health, context, calls, monitors,
    run: (extra = {}) => run({ ...options, ...extra }),
    restart: reason => restartRound({ ...options, reason }),
    // The retry is due: what the clock reaching retryAt does.
    retryNow: () => { context.automaticMcpAttempt.retryAt = 0; },
  };
}

/** The draft check run against a page with no composer, at `hostname`. */
async function draftWithoutComposer(f, hostname) {
  let script;
  f.context.browserHost.view.webContents.executeJavaScript = async (source) => { script = source; return false; };
  await f.run();
  return vm.runInNewContext(script, { document: { querySelector: () => null, querySelectorAll: () => [] }, location: { hostname } });
}

test("automatic MCP waits for an owned accepting bridge and real Codex catalog observation", async () => {
  for (const change of [{ successful_model_catalog_requests: 0 }, { pid: 999 }, { accepting_turns: false }, { mode: "browser-only" }]) {
    const f = fixture();
    Object.assign(f.health, change);
    await f.run();
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.mcpSetupComplete, false);
  }
  for (const skip of [f => { f.state.autoConnectExistingMcp = false; }, f => { f.context.IS_DEV_PROFILE = true; }, f => { f.state.browserInteractionMode = "manual"; }, f => { f.context.runtimeHost.mcpCredentialsConfigured = () => false; }]) {
    const f = fixture(); skip(f); await f.run(); assert.deepEqual(f.calls, []);
  }
});

test("automatic MCP defers browser turns and drafts then verifies once in doctor-connector order", async () => {
  const f = fixture();
  f.health.active_browser_turns = 1;
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls, []);
  f.health.active_browser_turns = 0;
  f.context.browserHost.view.webContents.executeJavaScript = async () => true;
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls, []);
  f.context.browserHost.view.webContents.executeJavaScript = async () => false;
  assert.equal(await f.run(), false);
  assert.deepEqual(f.calls.filter(x => ["doctor", "connector"].includes(x)), ["doctor", "connector"]);
  assert.equal(f.state.mcpSetupComplete, true);
  await f.run();
  assert.equal(f.calls.filter(x => x === "doctor").length, 1);
});

test("automatic MCP verifies while Codex holds its bridge connections open", async () => {
  // Seen live 2026-11-02: 9-12 open HTTP turns at every sample, none in the browser, so the old
  // all-idle gate never let the check run while any chat was open.
  const f = fixture();
  f.health.active_http_turns = 11;
  assert.equal(await f.run(), false);
  assert.deepEqual(f.calls.filter(x => ["doctor", "connector"].includes(x)), ["doctor", "connector"]);
  assert.equal(f.state.mcpSetupComplete, true);
});

test("the blank page the browser parks on is not a draft; a loading ChatGPT page still is", async () => {
  assert.equal(await draftWithoutComposer(fixture(), ""), false);
  assert.equal(await draftWithoutComposer(fixture(), "chatgpt.com"), true);
});

test("automatic MCP retries a failed check on its delays, then stops, without setup or connector changes", async () => {
  const f = fixture();
  const doctors = () => f.calls.filter(x => x === "doctor").length;
  f.context.runtimeHost.doctor = async () => { f.calls.push("doctor"); return { ok: false, checks: [{ status: "error", message: "Tunnel unavailable" }] }; };
  assert.equal(await f.run(), true, "a retry is scheduled");
  assert.equal(f.state.mcpSetupComplete, false);
  assert.deepEqual(f.calls, ["running", "doctor", "failed"]);
  assert.equal(await f.run(), true, "waiting for the retry");
  assert.equal(doctors(), 1, "nothing runs before the retry is due");
  const delays = f.context.AUTOMATIC_MCP_RETRY_DELAYS_MS;
  assert(delays.length >= 3 && delays.every((delay, i) => i === 0 || delay > delays[i - 1]), "growing delays");
  for (let i = 1; i < delays.length; i += 1) {
    f.retryNow();
    assert.equal(await f.run(), true);
    assert.equal(doctors(), i + 1);
  }
  f.retryNow();
  assert.equal(await f.run(), false, "out of retries: the monitor stops");
  assert.equal(doctors(), delays.length + 1);
  assert.equal(await f.run(), false);
  assert.equal(doctors(), delays.length + 1, "no endless retries");
});

test("a failed check that passes on retry stops retrying", async () => {
  const f = fixture();
  let ok = false;
  f.context.runtimeHost.doctor = async () => { f.calls.push("doctor"); return ok ? { ok: true, checks: [] } : { ok: false, checks: [{ status: "error", message: "slow" }] }; };
  assert.equal(await f.run(), true);
  ok = true;
  f.retryNow();
  assert.equal(await f.run(), false);
  assert.equal(f.state.mcpSetupComplete, true);
  assert.equal(await f.run(), false);
  assert.equal(f.calls.filter(x => x === "doctor").length, 2);
});

test("a tunnel restart or sign-in starts a new round that checks the connector again", async () => {
  const f = fixture();
  assert.equal(await f.run(), false);
  assert.equal(f.calls.filter(x => x === "connector").length, 1);
  f.restart("tunnel-started");
  assert.deepEqual(f.monitors, ["monitor"], "the stopped monitor starts again");
  assert.deepEqual(f.context.accountSyncs, ["invalidate", "sync"], "and the signed-in accounts' MCP is checked again");
  assert.equal(await f.run(), false);
  assert.equal(f.calls.filter(x => x === "connector").length, 2, "checked again, which reloads ChatGPT's connector list");
  f.context.catalogVerificationTimer = {};
  f.restart("browser-login");
  assert.deepEqual(f.monitors, ["monitor"], "a running monitor is reused");
  f.state.autoConnectExistingMcp = false;
  f.context.catalogVerificationTimer = null;
  f.restart("tunnel-started");
  assert.deepEqual(f.monitors, ["monitor"], "nothing starts with the setting off");
});

test("a new round that begins during a check runs a fresh check next", async () => {
  const f = fixture();
  f.context.browserHost.verifyConnector = async () => { f.calls.push("connector"); f.restart("tunnel-started"); };
  assert.equal(await f.run(), true, "keeps the monitor for the new round");
  f.context.browserHost.verifyConnector = async () => { f.calls.push("connector"); };
  assert.equal(await f.run(), false);
  assert.equal(f.calls.filter(x => x === "connector").length, 2);
});

test("automatic MCP reads no file while the browser is busy, and uses the config the monitor read", async () => {
  // It waits for as long as the browser is in use, asked every 15 s; each synchronous file check on
  // the app's busy hard disk could freeze every window (3 s for one stat, 2026-10-24).
  const f = fixture();
  const reads = [];
  f.context.runtimeSupervisor = { readConfig: () => { reads.push("config"); return { mode: "full", releaseVersion: "5.0.6" }; },
    readState: () => { reads.push("state"); return { daemonPid: 123 }; } };
  f.context.runtimeHost.mcpCredentialsConfigured = () => { reads.push("credentials"); return true; };
  f.browser.surfaceActive = true;
  assert.equal(await f.run(), true, "still waiting");
  f.browser.surfaceActive = false;
  f.health.active_browser_turns = 1;
  assert.equal(await f.run(), true, "still waiting");
  assert.deepEqual(reads, [], "nothing read while the browser is in use");
  // A config the monitor already read: a browser-only setup stops waiting without any read.
  assert.equal(await f.run({ config: { mode: "browser-only" } }), false);
  assert.deepEqual(reads, []);
  // Once idle it checks the files, then connects.
  f.health.active_browser_turns = 0;
  assert.equal(await f.run(), false);
  assert.deepEqual(reads, ["credentials", "config", "state"]);
  assert.equal(f.state.mcpSetupComplete, true);
});

test("automatic MCP checks the saved credentials of the config the monitor read without a synchronous disk call", async () => {
  // Seen live 2026-10-31: the credentials check read config.json again synchronously, and its statSync
  // froze every window for up to 26 s on the app's busy hard disk.
  const f = fixture();
  const reads = [];
  const config = { mode: "full", releaseVersion: "5.0.6" };
  f.context.runtimeHost.mcpCredentialsConfigured = () => { reads.push("sync credentials"); return true; };
  f.context.runtimeHost.mcpCredentialsConfiguredAsync = async (known) => { reads.push(known === config ? "monitor config" : "other config"); return true; };
  assert.equal(await f.run({ config }), false);
  assert.deepEqual(reads, ["monitor config"]);
  assert.equal(f.state.mcpSetupComplete, true);
  const none = fixture();
  none.context.runtimeHost.mcpCredentialsConfiguredAsync = async () => false;
  assert.equal(await none.run({ config }), false);
  assert.deepEqual(none.calls, [], "no saved credentials: nothing to connect");
});
