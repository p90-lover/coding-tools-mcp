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
