"use strict";

// An update the worker placed is kept (committed) only once the new version shows it works. It used
// to be committed at whenReady, so a version that started and then failed (its window, its backend
// or AO) had already thrown away the old files and could not go back. Until the gate passes, the old
// files stay beside the new ones (app-update-worker.cjs keeps them as `<file>.old-<stamp>`).
//
// Each check answers "pass", "pending" or "fail". All passing commits the update. A gate still not
// passing after the health window (Settings) rolls back to the previous version, unless rollback is
// off (then the update is kept, as before) or a chat is working (it waits: never end running work).

const UPDATE_HEALTH_MINUTES = 10;
const HEALTH_POLL_MS = 5_000;

function createUpdateHealthGate({
  checks, timeoutMs, autoRollback, isBusy, commit, rollBack, logger,
  now = Date.now, setRepeat = setInterval, clearRepeat = clearInterval, pollMs = HEALTH_POLL_MS,
}) {
  let timer = null;
  let startedAt = 0;
  let settled = false;
  let ticking = false;
  let waitingLogged = false;

  const results = () => Object.entries(checks).map(([name, check]) => {
    let result;
    try { result = check(); } catch { result = "fail"; }
    return [name, result === "pass" || result === "fail" ? result : "pending"];
  });

  function settle() {
    settled = true;
    if (timer) clearRepeat(timer);
    timer = null;
  }

  async function tick() {
    if (settled || ticking) return null;
    ticking = true;
    try {
      const failing = results().filter(([, result]) => result !== "pass").map(([name, result]) => `${name} ${result}`);
      const elapsedMs = now() - startedAt;
      if (!failing.length) {
        settle();
        logger?.info("launcher.update_health_passed", { ms: elapsedMs });
        await commit();
        return "committed";
      }
      if (elapsedMs < timeoutMs()) return null;
      if (!autoRollback()) {
        settle();
        logger?.warn("launcher.update_health_kept", { failing });
        await commit();
        return "committed";
      }
      // A busy check that cannot answer counts as busy: never end work it could not see.
      if (await Promise.resolve().then(isBusy).catch(() => true)) {
        if (!waitingLogged) logger?.warn("launcher.update_rollback_waiting", { failing });
        waitingLogged = true;
        return null;
      }
      settle();
      logger?.warn("launcher.update_rollback", { failing });
      await rollBack(`The new version did not become healthy: ${failing.join(", ")}`);
      return "rolled-back";
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer || settled) return;
      startedAt = now();
      timer = setRepeat(() => { void tick(); }, pollMs);
      timer?.unref?.();
      void tick();
    },
    stop: settle,
    tick,
  };
}

module.exports = { createUpdateHealthGate, HEALTH_POLL_MS, UPDATE_HEALTH_MINUTES };
