"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");

// Seen live: a sign-in's route check ran during startup, and the runtime upgrade step (which
// refuses to run while any operation is active, even when no upgrade is needed) failed the whole
// startup: bridge down, setup marked incomplete, until the watchdog restarted it minutes later.
test("startup's runtime upgrade and start both wait for an idle host and retry a busy refusal", () => {
  assert.match(main, /async function whenRuntimeHostIdle\(logger, step, run\)/);
  assert.match(main, /attempt >= 3 \|\| !message\.startsWith\("Another launcher operation is active"\)\) throw error/,
    "only a busy refusal is retried, at most three times");
  assert.match(main, /const upgrade = await whenRuntimeHostIdle\(logger, "upgrade", \(\) => runtimeHost\.upgradeManagedRuntime\(\)\)/);
  assert.match(main, /const runtime = await whenRuntimeHostIdle\(logger, "start", \(\) => runtimeSupervisor\.startIfConfigured\(\)\)/);
  assert.doesNotMatch(main, /const upgrade = await runtimeHost\.upgradeManagedRuntime\(\)/, "no unguarded upgrade call is left");
});

// Seen live 2026-11-13 00:11Z: a sign-in's bridge connect passed its idle wait, an account switch's
// core-setup began while startIfConfigured ran, and the route connect failed "Another launcher
// operation is active: core-setup".
test("a sign-in's bridge connect refused by an operation that started meanwhile waits and retries", async () => {
  const vm = require("node:vm");
  const between = (start, end) => main.slice(main.indexOf(start), main.indexOf(end));
  const source = between("async function waitForRuntimeHostIdle(", "function applyReadyRuntimeAfterBridge(")
    + between("async function connectCodexBridgeAfterAuthentication(", "function scheduleCodexBridgeAutoConnect(");
  let operation = null;
  let connects = 0;
  const warnings = [];
  const context = {
    Date, Promise, Error, String, setTimeout,
    quitting: false, shutdownInProgress: false, IS_DEV_PROFILE: false,
    codexBridgeConnectInFlight: null, automaticMcpAttempt: null, activeAoWorkflow: null, headlessHost: null,
    browserHost: { snapshot: () => ({ authenticated: true }) },
    runtimeSupervisor: { startIfConfigured: async () => ({ status: "ready" }) },
    runtimeHost: {
      currentOperation: () => operation,
      runtimeConfigSnapshot: () => ({ configured: true }),
      connectBridgeRoute: async () => {
        connects += 1;
        if (connects === 1) {
          operation = "core-setup";
          setTimeout(() => { operation = null; }, 120);
          throw new Error("Another launcher operation is active: core-setup");
        }
        return { changed: false };
      },
    },
    applyReadyRuntimeAfterBridge: () => {},
  };
  vm.runInNewContext(source, context);
  const logger = { info() {}, warn: (event, detail) => warnings.push([event, detail]) };
  const stateStore = { read: () => ({ codexRoute: true, browserInteractionMode: "automatic" }) };
  const result = await context.connectCodexBridgeAfterAuthentication({ logger, stateStore, reason: "browser-authenticated" });
  assert.equal(result.connected, true);
  assert.equal(connects, 2, "the refused connect ran again once the other operation ended");
  assert.deepEqual(warnings.map(([event, detail]) => [event, detail.step]), [["runtime.startup_retry_busy", "bridge-connect"]]);
});

test("setup's preflight gets a minute, not 15 s, before it is cut off", () => {
  const runtime = fs.readFileSync(path.resolve(__dirname, "../electron/runtime.cjs"), "utf8");
  assert.match(runtime, /const SETUP_PREFLIGHT_TIMEOUT_MS = 60_000;/);
  assert.match(runtime, /timeoutMs: Math\.min\(options\.timeoutMs \|\| SETUP_PREFLIGHT_TIMEOUT_MS, SETUP_PREFLIGHT_TIMEOUT_MS\)/);
  assert.doesNotMatch(runtime, /Math\.min\(options\.timeoutMs \|\| 15_000, 15_000\)/);
});
