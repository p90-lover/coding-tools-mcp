"use strict";

// Launch upgrades the managed runtime once (startManagedRuntime in main.cjs). The upgrade's setup
// checks ChatGPT in the launcher's browser, so a page that is not ChatGPT fails it: 0.8.67 and
// 0.8.68 sat on Cloudflare's "Just a moment..." check past setup's 60 s sign-in wait (2026-11-03).
// The config then still named the old bridge, every start answered "needs-setup", and the bridge
// stayed down until Setup → Install models or a restart.
//
// This runs that startup once more: when ChatGPT next becomes signed in, or shortly after the
// failure when it already is. It waits while the runtime or the browser is busy (a setup, a
// sign-in, a ChatGPT turn), checking every CHECK_MS up to MAX_CHECKS times; after that the next
// sign-in starts the wait again. A second failure is not retried: its message names what to do.

const CHECK_MS = 10_000;
const MAX_CHECKS = 60; // ten minutes

const messageOf = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * `signedIn()` and `busy()` read memory only; `upgradePending()` reads the runtime config from
 * disk, so it is asked last and rarely. `run()` starts the runtime startup and returns its promise.
 */
function createRuntimeStartupRetry({ upgradePending, signedIn, busy, run, logger, checkMs = CHECK_MS, maxChecks = MAX_CHECKS }) {
  // "idle" until launch's startup ends with the upgrade still pending, "armed" until the retry
  // starts (or is no longer needed), then "used".
  let state = "idle";
  let timer = null;
  let checks = 0;

  const pending = () => {
    try {
      return upgradePending() === true;
    } catch (error) {
      logger.warn("runtime.startup_retry_check_failed", { message: messageOf(error) });
      return false;
    }
  };
  const schedule = () => {
    timer = setTimeout(attempt, checkMs);
    timer.unref?.();
  };
  function attempt() {
    timer = null;
    // Signed out again meanwhile: the next sign-in wakes this.
    if (state !== "armed" || !signedIn()) return;
    if (busy()) {
      checks += 1;
      if (checks < maxChecks) schedule();
      else logger.warn("runtime.startup_retry_waiting", { checks });
      return;
    }
    state = "used";
    // Setup → Install models (or the person's own restart of the runtime) got there first.
    if (!pending()) {
      logger.info("runtime.startup_retry_not_needed");
      return;
    }
    logger.info("runtime.startup_retry");
    Promise.resolve().then(run).catch((error) => logger.warn("runtime.startup_retry_failed", { message: messageOf(error) }));
  }
  const wake = () => {
    if (state !== "armed" || timer) return;
    checks = 0;
    schedule();
  };

  return {
    /** Launch's startup has settled; with its upgrade still pending, the one retry is armed. */
    startupSettled() {
      if (state !== "idle" || !pending()) return;
      state = "armed";
      const signedInNow = signedIn();
      logger.warn("runtime.startup_retry_armed", { signedIn: signedInNow });
      // Signed in already (it happened while the startup ran, or the failure had another cause).
      if (signedInNow) wake();
    },
    /** ChatGPT became signed in, in the browser the bridge uses. */
    browserSignedIn: wake,
  };
}

module.exports = { createRuntimeStartupRetry };
