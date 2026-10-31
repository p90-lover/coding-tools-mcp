"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let quitSource;
const listeners = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "requestQuit") quitSource = node.getText(file);
  if (ts.isCallExpression(node) && /^app\.(on|once)$/.test(node.expression.getText(file))
    && node.arguments[0]?.text === "before-quit") listeners.push(node.arguments[1].getText(file));
  ts.forEachChild(node, visit);
}
visit(file);

function fixture({ active = null, browserActive = null, failCleanup = false, restoreFails = false, quitAnyway = false, registerShutdownFails = false, browserSaveFails = false } = {}) {
  const disposed = [];
  const chatHosts = [];
  const nativeStops = [];
  const quits = [];
  const order = [], recovered = [], goalSaves = [], accountSaves = [];
  const controller = name => ({ dispose() {
    disposed.push(name);
    if (failCleanup && name === "external") throw new Error("Owned process cleanup failed");
  } });
  const context = vm.createContext({
    shutdownInProgress: false, exitCommitted: false, quitting: false,
    runtimeStartupInFlight: null, codexBridgeConnectInFlight: null,
    // Goal changes are saved off the main thread; a quit waits for the last one.
    missionWorkflowRuntime: { goalsSaved: async () => { goalSaves.push(true); } },
    // So is the browser account list (browser-accounts.cjs).
    browserAccounts: { saved: async () => { accountSaves.push(true); } },
    runtimeHost: { currentOperation: () => active, restoreBridgeRoute: async () => {
      order.push("restore-route");
      if (restoreFails) throw new Error("Route restore failed");
    } },
    browserHost: { currentOperation: () => null, activeTraceId: browserActive, state: { status: "running" },
      persistSession: async () => { if (browserSaveFails) throw new Error("Browser save failed"); }, destroy() {} },
    runtimeSupervisor: { detach: async () => ({ status: "detached" }), shutdown: async () => { order.push("stop-runtime"); nativeStops.push("runtime"); } },
    headlessHost: { shutdown: async () => {} }, browserControl: { close: async () => {} },
    registerHost: { shutdown: async () => { order.push("stop-register"); if (registerShutdownFails) throw new Error("Register stop failed"); },
      recoverAfterCancelledQuit: async () => { recovered.push(context.quitting); } },
    stopCatalogVerificationMonitor() {}, updateController: { stopPeriodicChecks() {} }, autoInstaller: { stop() {} }, cpaUpdater: { stop() {} },
    stopBridgeWatchdog() {}, backendBundles: { stopWatching() {} },
    agentOrchestratorUpstream: { stop: async () => { chatHosts.push("stop-ao"); }, endChatHosts: async () => { chatHosts.push("end-chat-hosts"); } },
    antigravityReauth: { stop() {} },
    // ProxyBridge Nova (provider-bootstrap.cjs) ends with a full quit, after everything that may use its gateway.
    stopProxyBridgeNova: async () => { chatHosts.push("stop-nova"); },
    // The docked ChatGPT desktop host (main.cjs `chatgptDesktop`) is shut down on every quit.
    chatgptDesktop: { shutdown: async () => { order.push("stop-chatgpt-desktop"); } },
    managedBootstrapController: controller("bootstrap"), originalUiController: controller("visuals"),
    externalServicesController: controller("external"), upstreamToolController: controller("upstream"),
    // requestQuit runs each shutdown step under quit-steps.cjs's deadline (main.cjs requires it).
    boundedQuitStep: require("../electron/quit-steps.cjs").boundedQuitStep,
    quitLogger: null, antigravityAuthBrowser: { closeAll() {} },
    // The forced-exit timer after app.quit() must never fire in a test.
    QUIT_EXIT_GRACE_MS: 0, setTimeout: () => ({ unref() {} }),
    showMainWindow() {}, publishOperation() {}, app: { quit: () => quits.push(true) },
    dialog: { showMessageBox: async () => ({ response: quitAnyway ? 1 : 0 }) },
    mainWindow: { isDestroyed: () => false },
  });
  const quit = vm.runInContext(`(${quitSource})`, context);
  let result;
  context.requestQuit = () => (result = quit());
  return { disposed, chatHosts, nativeStops, quits, order, recovered, goalSaves, accountSaves, browser: context.browserHost, quit, async beforeQuit() {
    let prevented = 0;
    for (const listener of listeners) vm.runInContext(`(${listener})`, context)({ preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1);
    return result;
  } };
}

test("rejected app quit does not dispose integrations before the active-operation guard", async () => {
  const f = fixture({ active: "mcp-setup" });
  const result = await f.beforeQuit();
  assert.equal(result.ok, false);
  assert.deepEqual(f.disposed, []);
  assert.deepEqual(f.nativeStops, []);
  assert.deepEqual(f.quits, []);
  assert.deepEqual(f.order, []);
});

test("a keep-bridge restart refuses a live browser turn, then closes once it ends despite a stale running status", async () => {
  const f = fixture({ browserActive: "live-turn" });
  const refused = await f.quit({ keepBridge: true });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /ChatGPT turn.*finish before quitting/);
  assert.deepEqual(f.disposed, []);
  assert.deepEqual(f.quits, []);

  f.browser.activeTraceId = null;
  assert.equal(f.browser.state.status, "running");
  assert.equal((await f.quit({ keepBridge: true })).ok, true, "the refused quit clears its guard so the update can be retried immediately");
  assert.equal(f.quits.length, 1);
});

// Seen 2026-10-28: "Update to v0.8.30" with a ChatGPT turn running only showed an error toast.
test("a quit or update with a live ChatGPT turn asks, and Quit anyway goes on", async () => {
  const cancelled = fixture({ browserActive: "live-turn" });
  const refused = await cancelled.quit();
  assert.equal(refused.ok, false);
  assert.match(refused.message, /ChatGPT turn.*finish before quitting/);
  assert.deepEqual(cancelled.disposed, []);
  assert.deepEqual(cancelled.quits, []);

  const accepted = fixture({ browserActive: "live-turn", quitAnyway: true });
  assert.equal((await accepted.quit()).ok, true);
  assert.equal(accepted.quits.length, 1);
});

// Seen 2026-10-28: chat hosts from three earlier runs, the oldest four days old, each with its agent.
test("a quit ends AO's chat hosts after AO stops, then Nova; a keep-bridge restart leaves them to be reattached", async () => {
  const quit = fixture();
  assert.equal((await quit.quit()).ok, true);
  assert.deepEqual(quit.chatHosts, ["stop-ao", "end-chat-hosts", "stop-nova"]);

  const restart = fixture();
  assert.equal((await restart.quit({ keepBridge: true })).ok, true);
  assert.deepEqual(restart.chatHosts, ["stop-ao"]);
});

test("accepted app quit disposes each integration controller once", async () => {
  const f = fixture();
  const result = await f.beforeQuit();
  assert.equal(result.ok, true);
  assert.deepEqual(f.disposed, ["bootstrap", "visuals", "external", "upstream"]);
  assert.equal(f.quits.length, 1);
  assert.deepEqual(f.order, ["restore-route", "stop-runtime", "stop-register", "stop-chatgpt-desktop"]);
  assert.deepEqual(f.goalSaves, [true], "the last goal change is on disk before the app goes");
  assert.deepEqual(f.accountSaves, [true], "so is the last browser account change");
});

test("route restoration failure cancels quit unless the user chooses Quit anyway", async () => {
  const cancelled = fixture({ restoreFails: true });
  assert.equal((await cancelled.quit()).ok, false);
  assert.deepEqual(cancelled.order, ["restore-route"]);
  assert.deepEqual(cancelled.quits, []);

  const accepted = fixture({ restoreFails: true, quitAnyway: true });
  assert.equal((await accepted.quit()).ok, true);
  assert.deepEqual(accepted.order, ["restore-route", "stop-runtime", "stop-register", "stop-chatgpt-desktop"]);
  assert.equal(accepted.quits.length, 1);
});

test("cancelled quits recover Register only after the main quitting flag clears", async () => {
  for (const options of [{ registerShutdownFails: true }, { browserSaveFails: true }]) {
    const f = fixture(options), result = await f.quit();
    assert.equal(result.ok, false); assert.deepEqual(f.quits, []);
    assert.deepEqual(f.recovered, [false]); assert.ok(f.order.includes("stop-register"));
  }
  const successful = fixture(); await successful.quit(); assert.deepEqual(successful.recovered, []);
});

test("module cleanup failure leaves the native bridge running and refuses exit", async () => {
  const f = fixture({ failCleanup: true });
  const result = await f.quit();
  assert.equal(result.ok, false);
  assert.match(result.message, /Owned process cleanup failed/);
  assert.deepEqual(f.nativeStops, []);
  assert.deepEqual(f.quits, []);
});
