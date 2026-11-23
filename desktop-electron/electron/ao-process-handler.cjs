"use strict";

function createAoProcessHandler({ readyOwner, isWorking, startDaemon, stopDaemon }) {
  let writes = 0;
  let admission = 0;
  let explicitStop = 0;
  let changing = false;

  function beginMutation() {
    admission += 1;
    writes += 1;
    return () => { writes -= 1; };
  }

  function stop() {
    explicitStop += 1;
    return stopDaemon();
  }

  async function restartWhenIdle(owner, onRestart) {
    if (changing || writes || !owner || readyOwner() !== owner) return false;
    const before = admission;
    const stopAt = explicitStop;
    try {
      if (await isWorking() !== false) return false;
    } catch {
      return false;
    }
    // A write that both started and finished during the probe invalidates its idle answer too.
    if (changing || writes || admission !== before || explicitStop !== stopAt || readyOwner() !== owner) return false;
    changing = true;
    try {
      onRestart();
      await stopDaemon();
      if (explicitStop !== stopAt) return false;
      await startDaemon();
      return explicitStop === stopAt;
    } finally {
      changing = false;
    }
  }

  return Object.freeze({ beginMutation, stop, restartWhenIdle });
}

const childExited = (child) => child.exitCode !== null || child.signalCode !== null;

function waitForChildExit(child, ms) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), ms);
    child.once("exit", onExit);
  });
}

async function stopOwnedAoChild(child, requestShutdown, { gracefulMs = 5000, killMs = 5000 } = {}) {
  if (!Number.isInteger(child?.pid) || childExited(child)) return;
  const requested = await requestShutdown().catch(() => false);
  if (requested && await waitForChildExit(child, gracefulMs)) return;
  if (!childExited(child)) child.kill();
  if (!await waitForChildExit(child, killMs)) {
    throw Object.assign(new Error("The previous AO daemon has not exited; no replacement was started"), { code: "AO_STOP_UNCONFIRMED" });
  }
}

module.exports = { createAoProcessHandler, stopOwnedAoChild };
