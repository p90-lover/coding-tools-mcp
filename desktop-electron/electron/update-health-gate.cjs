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
      let failing = results().filter(([, result]) => result !== "pass").map(([name, result]) => `${name} ${result}`);
      let elapsedMs = now() - startedAt;
      if (failing.length && elapsedMs < timeoutMs()) return null;
      let rollbackEnabled = failing.length && autoRollback();
      let busy = false;
      if (rollbackEnabled) {
        // The native read can outlive a stop, a loaded window or a change in Settings.
        busy = await Promise.resolve().then(isBusy).catch(() => true);
        if (settled) return null;
        failing = results().filter(([, result]) => result !== "pass").map(([name, result]) => `${name} ${result}`);
        elapsedMs = now() - startedAt;
        rollbackEnabled = autoRollback();
        if (failing.length && elapsedMs < timeoutMs()) return null;
      }
      if (!failing.length) {
        settle();
        logger?.info("launcher.update_health_passed", { ms: elapsedMs });
        await commit();
        return "committed";
      }
      if (!rollbackEnabled) {
        settle();
        logger?.warn("launcher.update_health_kept", { failing });
        await commit();
        return "committed";
      }
      // A busy check that cannot answer counts as busy: never end work it could not see.
      if (busy) {
        if (!waitingLogged) logger?.warn("launcher.update_rollback_waiting", { failing });
        waitingLogged = true;
        return null;
      }
      try {
        logger?.warn("launcher.update_rollback", { failing });
        // false means no handoff occurred; keep watching until that admission can succeed.
        if (await rollBack(`The new version did not become healthy: ${failing.join(", ")}`) === false) return null;
      } catch (error) {
        // It may already have handed off a worker; an error must not repeat that attempt.
        settle();
        throw error;
      }
      settle();
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

// How long a backend update waits for running chats before it restarts the backend anyway.
const CHAT_WAIT_MS = 30 * 60_000;
const CHAT_WAIT_POLL_MS = 15_000;

/**
 * Resolves once no chat is working, or after `waitMs`: "idle" or "timeout".
 *
 * A backend update restarts Agent Orchestrator, and AO fails every running turn when it stops
 * ("controller ended before the turn completed"). The update used to restart it the moment the new
 * backend arrived, whatever the chats were doing. `working()` answers whether an agent is mid-turn;
 * when it throws, that is not known, and the update waits as it does for a working chat.
 * `onWait(waitedMs)` is told once, when the first wait begins.
 */
async function waitForIdleChats({ working, waitMs = CHAT_WAIT_MS, pollMs = CHAT_WAIT_POLL_MS, now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }), onWait = null } = {}) {
  const startedAt = now();
  let told = false;
  for (;;) {
    let busy = true;
    try { busy = Boolean(await working()); } catch {}
    if (!busy) return "idle";
    if (now() - startedAt >= waitMs) return "timeout";
    if (!told) { told = true; try { onWait?.(now() - startedAt); } catch {} }
    await sleep(pollMs);
  }
}

module.exports = { createUpdateHealthGate, waitForIdleChats, CHAT_WAIT_MS, HEALTH_POLL_MS, UPDATE_HEALTH_MINUTES };
