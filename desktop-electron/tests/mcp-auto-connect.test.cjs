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
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "autoConnectExistingMcpIfReady") automatic = node.getText(file);
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "performMcpVerification") manual = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(automatic && manual, "automatic and manual paths reuse the same verifier");
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
    automaticMcpAttemptPid: null, mcpVerificationInFlight: null,
    send() {}, publishOperation: op => calls.push(op.status), mainWindow: null,
    runtimeSupervisor: { readConfig: () => ({ mode: "full", releaseVersion: "5.0.6" }), readState: () => ({ daemonPid: 123 }) },
    runtimeHost: { currentOperation: () => null, mcpCredentialsConfigured: () => true,
      doctor: async () => { calls.push("doctor"); return { ok: true, checks: [] }; },
      mcpConnectorName: () => "Saved connector", setupMcp: () => { throw Error("Must not run setup"); } },
    browserHost: { activeTraceId: null, snapshot: () => browser, currentOperation: () => null,
      view: { webContents: { isDestroyed: () => false, executeJavaScript: async () => false } },
      verifyConnector: async name => { assert.equal(name, "Saved connector"); calls.push("connector"); } },
  });
  context.verifyMcpConnection = vm.runInContext(`(${manual})`, context);
  const run = vm.runInContext(`(${automatic})`, context);
  return { state, browser, health, context, calls, run: () => run(options) };
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

test("automatic MCP defers active turns and drafts then verifies once in doctor-connector order", async () => {
  const f = fixture();
  f.health.active_http_turns = 1;
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls, []);
  f.health.active_http_turns = 0;
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

test("automatic MCP reports doctor failure without setup, connector changes, or endless retries", async () => {
  const f = fixture();
  f.context.runtimeHost.doctor = async () => { f.calls.push("doctor"); return { ok: false, checks: [{ status: "error", message: "Tunnel unavailable" }] }; };
  assert.equal(await f.run(), false);
  assert.equal(f.state.mcpSetupComplete, false);
  assert.deepEqual(f.calls, ["running", "doctor", "failed"]);
  await f.run();
  assert.equal(f.calls.filter(x => x === "doctor").length, 1);
});
