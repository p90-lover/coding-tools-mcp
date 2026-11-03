/**
 * How long the app's own ChatGPT sign-in checks wait after one that did not end signed in. Setup
 * checked every 10 s while it showed "Sign in", and each check that found ChatGPT's cookies opened
 * ChatGPT again. Once ChatGPT refused the page for too many tries, the next check 10 s later opened
 * it again and ChatGPT kept refusing (2026-11-03). A sign-in the person starts never waits.
 */
const SIGN_IN_RETRY_WAIT_MS = 10 * 60_000;

/**
 * Whether a failed try never reached ChatGPT: Chromium's connection errors (-100 to -199: the
 * proxy, DNS, a reset socket) fail before ChatGPT sees a request, so they are not a try it counts.
 * The launch retry for a slow proxy keeps its short steps for them.
 */
function neverReachedChatGpt(error) {
  const errno = typeof error?.errno === "number" ? error.errno
    : Number(/\((-\d+)\) loading\b/.exec(String(error?.message ?? ""))?.[1]);
  return Number.isFinite(errno) && errno <= -100 && errno >= -199;
}

function createSignInRetryWait({ waitMs = SIGN_IN_RETRY_WAIT_MS, now = Date.now } = {}) {
  let until = 0;
  return Object.freeze({
    /** Milliseconds before an automatic check may open ChatGPT again; 0 when it may now. */
    remainingMs: () => Math.max(0, until - now()),
    /**
     * Records how an automatic try ended (its browser state, or the error it threw): signed in
     * clears the wait, anything else starts it, except a failure that never reached ChatGPT.
     */
    settle(outcome, logger) {
      if (outcome?.authenticated === true) {
        until = 0;
        return;
      }
      if (outcome instanceof Error && neverReachedChatGpt(outcome)) return;
      until = now() + waitMs;
      logger?.warn?.("browser.signin_retry_waiting", { minutes: Math.round(waitMs / 60_000) });
    },
    /** Signed in by any path (the person's own sign-in included): checks may run again at once. */
    clear() { until = 0; },
  });
}

module.exports = { SIGN_IN_RETRY_WAIT_MS, createSignInRetryWait, neverReachedChatGpt };
