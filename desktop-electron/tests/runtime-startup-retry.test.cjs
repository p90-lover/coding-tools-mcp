"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createRuntimeStartupRetry } = require("../electron/runtime-startup-retry.cjs");

const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function silentLogger() {
  const entries = [];
  const log = (level) => (event, detail) => entries.push({ level, event, detail });
  return { entries, info: log("info"), warn: log("warn"), error: log("error") };
}

function retryFixture({ pending = true, signedIn = false, busy = false, maxChecks } = {}) {
  const world = { pending, signedIn, busy, runs: 0 };
  const logger = silentLogger();
  const retry = createRuntimeStartupRetry({
    logger,
    upgradePending: () => {
      if (world.pending instanceof Error) throw world.pending;
      return world.pending;
    },
    signedIn: () => world.signedIn,
    busy: () => world.busy,
    run: async () => { world.runs += 1; },
    ...(maxChecks ? { maxChecks } : {}),
  });
  return { world, logger, retry };
}

test("a launch whose upgrade is still pending runs its startup once, on the next sign-in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry, logger } = retryFixture();
  retry.startupSettled();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(world.runs, 0, "signed out (Cloudflare's check): nothing to retry against yet");
  assert.ok(logger.entries.some((entry) => entry.event === "runtime.startup_retry_armed" && entry.detail.signedIn === false));

  world.signedIn = true;
  retry.browserSignedIn();
  t.mock.timers.tick(9_999);
  await settle();
  assert.equal(world.runs, 0, "the sign-in settles first");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(world.runs, 1);

  // The retry failed too: later sign-ins and launch's own settle do not start it again.
  retry.browserSignedIn();
  retry.startupSettled();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(world.runs, 1, "one retry per launch, never a loop");
});

test("a launch that came up, or one with nothing pending, never retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry } = retryFixture({ pending: false, signedIn: true });
  retry.startupSettled();
  retry.browserSignedIn();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(world.runs, 0);
});

test("signed in already when the startup failed: it runs again shortly after", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry } = retryFixture({ signedIn: true });
  retry.startupSettled();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 1);
});

test("a setup, a sign-in or a ChatGPT turn in progress holds the retry; after the limit the next sign-in waits again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry, logger } = retryFixture({ signedIn: true, busy: true, maxChecks: 3 });
  retry.startupSettled();
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 0, "still busy");
  t.mock.timers.tick(10_000);
  await settle();
  assert.ok(logger.entries.some((entry) => entry.event === "runtime.startup_retry_waiting" && entry.detail.checks === 3));
  world.busy = false;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(world.runs, 0, "after the limit nothing is polled");
  retry.browserSignedIn();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 1);
});

test("Setup → Install models upgrading it first leaves nothing to retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry, logger } = retryFixture();
  retry.startupSettled();
  world.pending = false;
  world.signedIn = true;
  retry.browserSignedIn();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 0);
  assert.ok(logger.entries.some((entry) => entry.event === "runtime.startup_retry_not_needed"));
  world.pending = true;
  retry.browserSignedIn();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 0, "a later failure is Setup's to report");
});

test("signed out again before the check: the retry waits for the next sign-in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry } = retryFixture();
  retry.startupSettled();
  world.signedIn = true;
  retry.browserSignedIn();
  world.signedIn = false;
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 0);
  world.signedIn = true;
  retry.browserSignedIn();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(world.runs, 1);
});

test("an unreadable runtime config arms nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, retry, logger } = retryFixture({ pending: new Error("config.json is not valid JSON"), signedIn: true });
  retry.startupSettled();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(world.runs, 0);
  assert.ok(logger.entries.some((entry) => entry.event === "runtime.startup_retry_check_failed"));
});

function loadStartManagedRuntime(context) {
  const file = ts.createSourceFile("main.cjs", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found;
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "startManagedRuntime") found = node;
    ts.forEachChild(node, visit);
  })(file);
  assert(found, "main.cjs has startManagedRuntime");
  return vm.runInNewContext(`(${found.getText(file)})`, context);
}

// Seen live 2026-11-03 on 0.8.67/0.8.68: the launcher's ChatGPT tab sat on Cloudflare's check, the
// 5.0.6 → 6.1.17 upgrade failed, and the bridge stayed down after the person passed the check.
test("main's startup, failed by Cloudflare's check at launch, brings the bridge up after the sign-in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const world = { bridge: "5.0.6", browser: { authenticated: false } };
  const state = { coreSetupComplete: true, codexRoute: true, browserInteractionMode: "automatic" };
  const logger = silentLogger();
  const startManagedRuntime = loadStartManagedRuntime({
    runtimeHost: {
      managedRuntimeUpgradeRequired: () => world.bridge !== "6.1.17",
      upgradeManagedRuntime: async () => {
        events.push("upgrade");
        if (!world.browser.authenticated) {
          throw new Error("ChatGPT is showing a Cloudflare security check. Open the Browser tab, complete the check, then run Setup → Install models.");
        }
        world.bridge = "6.1.17";
        return { updated: true, mode: "full", fromVersion: "5.0.6", toVersion: "6.1.17", connectorMigrated: false };
      },
      runtimeConfigSnapshot: () => ({ configured: true, config: { releaseVersion: world.bridge, useSavedChats: true } }),
    },
    runtimeSupervisor: {
      startIfConfigured: async () => {
        events.push("start");
        return world.bridge === "6.1.17"
          ? { status: "ready" }
          : { status: "needs-setup", detail: "Config requires bridge 5.0.6; bundled bridge is 6.1.17" };
      },
      readConfig: () => ({ mode: "full", releaseVersion: world.bridge }),
    },
    stateStore: { read: () => ({ ...state }), update: (patch) => Object.assign(state, patch) },
    whenRuntimeHostIdle: (_logger, _step, run) => run(),
    connectCodexBridgeAfterAuthentication: async ({ reason }) => {
      events.push(`connect:${reason}`);
      return { connected: true, changed: true };
    },
    restoreCodexRouteAfterRuntimeFailure: async () => ({ restored: false }),
    applyReadyRuntimeAfterBridge: () => events.push("ready-without-connect"),
    publishOperation: (operation) => events.push(`${operation.name}:${operation.status}`),
    send: () => {},
    delay: () => new Promise(() => {}),
    STARTUP_AUTH_WAIT_MS: 20_000,
  });
  let retried = null;
  const retry = createRuntimeStartupRetry({
    logger,
    upgradePending: () => world.bridge !== "6.1.17",
    signedIn: () => world.browser.authenticated,
    busy: () => false,
    run: () => {
      retried = startManagedRuntime({ logger, stateStore: { read: () => ({ ...state }), update: (patch) => Object.assign(state, patch) }, startupAuthenticationRefresh: Promise.resolve(world.browser) });
      return retried;
    },
  });

  await startManagedRuntime({
    logger,
    stateStore: { read: () => ({ ...state }), update: (patch) => Object.assign(state, patch) },
    startupAuthenticationRefresh: Promise.resolve(world.browser),
  }).then(() => retry.startupSettled());
  assert.deepEqual(events, ["upgrade", "runtime-start:failed"]);
  assert.equal(state.coreSetupComplete, false);

  // The person completes the check in the Browser tab; the page signs in.
  world.browser = { authenticated: true };
  retry.browserSignedIn();
  t.mock.timers.tick(10_000);
  await settle();
  assert.ok(retried, "the sign-in started the runtime again");
  await retried;
  assert.deepEqual(events.slice(2), ["upgrade", "start", "connect:startup"]);
  assert.equal(world.bridge, "6.1.17");
  assert.equal(state.coreSetupComplete, true);
  assert.equal(state.codexRestartRequired, true, "Codex picks up the upgraded bridge on its next start");
});

test("main wires the retry to launch's startup and to the browser's sign-in", () => {
  assert.match(mainSource, /runtimeStartupInFlight = startManagedRuntime\(\{ logger, stateStore, startupAuthenticationRefresh \}\)\s*\.then\(\(\) => runtimeStartupRetry\.startupSettled\(\)\)/,
    "the retry is armed only after launch's own startup settles");
  assert.match(mainSource, /if \(authenticated && !wasAuthenticated\) \{[^}]*?runtimeStartupRetry\?\.browserSignedIn\(\);/,
    "the signed-in transition wakes it");
  const busy = mainSource.match(/busy: \(\) => Boolean\(([\s\S]*?)\),\r?\n/)?.[1] ?? "";
  for (const guard of ["runtimeHost.currentOperation()", "codexBridgeConnectInFlight", "browserHost?.currentOperation()",
    "browserHost?.activeTraceId", "browserAccountsStatus().switching", "quitting", "shutdownInProgress"]) {
    assert.ok(busy.includes(guard), `the retry waits for ${guard}`);
  }
  assert.match(mainSource, /run: \(\) => \{\s*runtimeStartupInFlight = startManagedRuntime\(/,
    "the retry is the startup in flight that quit and MCP setup wait for");
});
