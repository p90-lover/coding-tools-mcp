const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(process.env.CODEX_STARTUP_SOURCE || path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, `${name} remains available`);
  return found;
}

function catalogFixture(initial = {}) {
  const state = { coreSetupComplete: true, codexCatalogVerified: false, autoConnectExistingMcp: true, ...initial };
  const calls = [];
  let tick;
  let health = { successful_model_catalog_requests: 0 };
  const forbidden = () => { throw new Error("Automatic account work must not run"); };
  const context = {
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    logger: { info() {}, warn() {}, debug: forbidden },
    catalogVerificationTimer: null, catalogVerificationInFlight: false, lastOperation: null,
    setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval: () => calls.push("stop"),
    runtimeSupervisor: { readConfigAsync: async () => { calls.push("config"); return {}; },
      proxyHealthPayload: async () => { calls.push("health"); return health; } },
    autoConnectExistingMcpIfReady: forbidden, verifyMcpConnection: forbidden,
    automaticAccountMcp: { sync: forbidden }, browserHost: new Proxy({}, { get: forbidden }),
    send() {}, publishOperation: forbidden,
  };
  vm.runInNewContext(`${declaration("stopCatalogVerificationMonitor")}\n${declaration("startCatalogVerificationMonitor")}\nstartCatalogVerificationMonitor({ logger, stateStore });`, context);
  return { state, calls, tick: async () => { tick(); await new Promise(setImmediate); }, health: value => { health = value; } };
}

test("automatic MCP account checking has no production startup, focus, sign-in, tunnel or retry wiring", () => {
  for (const symbol of ["createBrowserAccountMcpSync", "automaticAccountMcp", "syncAccountMcp", "accountMcpTimer",
    "autoConnectExistingMcpIfReady", "restartAutomaticMcpVerification", "automaticMcpAttempt", "AUTOMATIC_MCP_RETRY_DELAYS_MS"]) {
    assert.equal(source.includes(symbol), false, `${symbol} must not remain in production wiring`);
  }
  assert.equal(/autoConnectExistingMcp:\s*true/.test(source), false, "a manual connection must not opt in to background checks");
  assert.equal((source.match(/connectAccountMcp\(/g) || []).length, 1, "only the explicit account Connect handler calls setup");
  assert.match(source, /handle\("launcher:mcp-verify", event => verifyMcpConnection\(event\)\)/);
});

test("catalog readiness stops after local success even with the legacy automatic MCP flag true", async () => {
  const f = catalogFixture();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["config", "health"]);
  assert.equal(f.state.codexCatalogVerified, false);
  f.health({ successful_model_catalog_requests: 1 });
  await f.tick();
  assert.equal(f.state.codexCatalogVerified, true);
  assert.equal(f.state.codexRestartRequired, false);
  assert.deepEqual(f.calls, ["config", "health", "config", "health", "stop"]);
  await f.tick();
  assert.equal(f.calls.filter(call => call === "health").length, 2, "a queued tick cannot keep polling after readiness");
});

test("an already verified catalog performs no health or browser work", async () => {
  const f = catalogFixture({ codexCatalogVerified: true });
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["stop"]);
});

test("legacy MCP preference cannot reenable account checks and retains focus guards", () => {
  const start = source.indexOf('  handle("launcher:set-preference",');
  const end = source.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start > 0 && end > start);
  const updates = [], focus = [];
  let handler;
  const context = {
    handle: (_, fn) => { handler = fn; },
    assertFocusedMainWindow: (...args) => focus.push(args),
    stateStore: { update: patch => { updates.push(patch); return patch; } }, send() {}, logger: {},
    startCatalogVerificationMonitor() {},
  };
  vm.runInNewContext(source.slice(start, end), context);
  assert.throws(() => handler({}, "autoConnectExistingMcp", true), /disabled.*Connect or Verify/);
  assert.equal(updates.length, 0);
  assert.equal(focus.length, 1);
  assert.equal(handler({}, "autoConnectExistingMcp", false).autoConnectExistingMcp, false);
  assert.equal(handler({}, "keepRunningOnClose", true).keepRunningOnClose, true);
  handler({}, "chatAgentDesktopTools", true);
  handler({}, "confirmAgentToolRequests", false);
  assert.equal(focus.length, 4, "disabling the old flag and changing privileged tool consent still require focus");
  assert.throws(() => handler({}, "unknown", true), /Unknown preference/);
});
