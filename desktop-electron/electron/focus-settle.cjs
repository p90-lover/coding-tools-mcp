"use strict";

// A click into the app window reaches its page at once, but the window's own focus event is handled
// on Electron main. After a main-thread stall the person's Send could reach main before that event,
// and the focused-window check refused it: "Click into the Coding Tools window" twice on 2026-11-10
// (10:39 and 10:40Z), each right after 17-36 s stalls, for messages typed into the window.
// waitForFocus gives a focus event already on its way a moment to land; the check itself is unchanged.
//
// The moment is counted in time main was free to deliver that event, not in wall time: a stall
// during the wait made a single 2 s timer overdue, and it could run before the focus event queued
// behind the stall, so sends were still refused right after the 0.8.110 relaunch (07:19:36Z and
// 07:19:38Z on 2026-11-11, with 15 main stalls logged and AO still starting). The wait re-arms in
// short slices and counts only those that fired on time; a slice that came back late saw main held.

const FOCUS_SETTLE_MS = 2_000;
const FOCUS_SLICE_MS = 100;
/** A slice firing this much later than asked means main was held, and that slice does not count. */
const FOCUS_LATE_MS = 250;
/** However held main is, a refused send is answered within this long. */
const FOCUS_WAIT_MAX_MS = 30_000;

/**
 * Resolves true as soon as `focused()` holds (checked again on each "focus" event of `emitters` and
 * after each slice), or with `focused()`'s answer once main has been free for `ms` (or after
 * FOCUS_WAIT_MAX_MS in all).
 */
function waitForFocus({ focused, emitters, ms = FOCUS_SETTLE_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  if (focused()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    let done = false;
    let free = 0;
    const started = now();
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      for (const emitter of emitters) emitter.removeListener("focus", check);
      resolve(value);
    };
    const check = () => { if (focused()) finish(true); };
    const slice = () => {
      const armed = now();
      timer = setTimer(() => {
        if (now() - armed - FOCUS_SLICE_MS <= FOCUS_LATE_MS) free += FOCUS_SLICE_MS;
        if (focused()) finish(true);
        else if (free >= ms || now() - started >= FOCUS_WAIT_MAX_MS) finish(false);
        else slice();
      }, FOCUS_SLICE_MS);
      timer?.unref?.();
    };
    for (const emitter of emitters) emitter.on("focus", check);
    slice();
  });
}

module.exports = { FOCUS_LATE_MS, FOCUS_SETTLE_MS, FOCUS_SLICE_MS, FOCUS_WAIT_MAX_MS, waitForFocus };
