"use strict";

// A click into the app window reaches its page at once, but the window's own focus event is handled
// on Electron main. After a main-thread stall the person's Send could reach main before that event,
// and the focused-window check refused it: "Click into the Coding Tools window" twice on 2026-11-10
// (10:39 and 10:40Z), each right after 17-36 s stalls, for messages typed into the window.
// waitForFocus gives a focus event already on its way a moment to land; the check itself is unchanged.

const FOCUS_SETTLE_MS = 2_000;

/**
 * Resolves true as soon as `focused()` holds (checked again on each "focus" event of `emitters`),
 * or with `focused()`'s answer after `ms`.
 */
function waitForFocus({ focused, emitters, ms = FOCUS_SETTLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (focused()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      for (const emitter of emitters) emitter.removeListener("focus", check);
      resolve(value);
    };
    const check = () => { if (focused()) finish(true); };
    for (const emitter of emitters) emitter.on("focus", check);
    timer = setTimer(() => finish(focused()), ms);
    timer?.unref?.();
  });
}

module.exports = { FOCUS_SETTLE_MS, waitForFocus };
