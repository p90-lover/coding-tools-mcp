"use strict";
// One shutdown step with a deadline. A quit awaited each step with no limit, so one that never
// settled (seen after the Codex bridge was detached) left the app running forever with nothing
// logged. A step that overruns is logged by name and the quit moves on; a step that fails still
// throws, so a quit that should be cancelled is cancelled as before.

async function boundedQuitStep(name, work, { ms = 15_000, onTimeout = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimer(() => { onTimeout(name, ms); resolve("timeout"); }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    clearTimer(timer);
  }
}

module.exports = { boundedQuitStep };
