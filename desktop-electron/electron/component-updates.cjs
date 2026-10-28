"use strict";
// Keeps managed components (CPA) on their newest release. Every few hours the newest release is
// downloaded, verified and installed into its own version folder beside the running one, which
// disturbs nothing. Switching to it restarts the component and drops the requests it is serving,
// so that waits for a quiet moment; until then the next app start runs the new version anyway.

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 2 * 60_000;
const SWAP_POLL_MS = 60_000;
// CPA must have finished no request for this long before it is restarted under its clients.
const QUIET_MS = 5 * 60_000;
// An update that has waited this long (a machine that is never quiet for 5 minutes) takes 1 minute.
const PATIENCE_MS = 24 * 60 * 60_000;
const SHORT_QUIET_MS = 60_000;

/**
 * Whether a staged update may replace the running component now. Every input is a plain number
 * or boolean; waiting is always safe, because the next app start runs the newest installed version.
 *
 * @param {object} moment
 * @param {boolean} moment.busy          a chat turn, browser task or bridge connect is running (or that check failed)
 * @param {number} moment.systemIdleSeconds  seconds since the user last touched keyboard or mouse
 * @param {number} moment.componentIdleMs    ms since the component last finished a request (Infinity if never)
 * @param {number} moment.stagedForMs        ms since the update was installed and began waiting
 * @returns {boolean}
 */
function readyToSwap({ busy, systemIdleSeconds, componentIdleMs, stagedForMs }) {
  // Never over running work: the next app start switches anyway, so a busy machine only waits.
  if (busy) return false;
  // CPA's own quiet is what matters; agents and other apps use it while the user is away.
  if (componentIdleMs >= QUIET_MS) return true;
  // After a day of waiting, a shorter gap will do, provided the user is away too.
  return stagedForMs >= PATIENCE_MS && componentIdleMs >= SHORT_QUIET_MS && systemIdleSeconds >= SHORT_QUIET_MS / 1000;
}

function createComponentUpdater({
  componentId,
  stage,
  swap,
  enabled = () => true,
  isBusy = async () => false,
  idleSeconds = () => 0,
  lastActivityAt = () => null,
  logger = null,
  now = Date.now,
  checkIntervalMs = CHECK_INTERVAL_MS,
  firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
  swapPollMs = SWAP_POLL_MS,
}) {
  let checkTimer = null;
  let swapTimer = null;
  let stagedAt = null;
  let working = false;

  async function check() {
    if (working || !enabled()) return null;
    working = true;
    try {
      const result = await stage(componentId);
      if (result?.staged) {
        stagedAt ??= now();
        logger?.info?.("managed-component.update_staged", { componentId, from: result.current, to: result.latest });
      }
      return result;
    } catch (error) {
      logger?.warn?.("managed-component.update_check_failed", { componentId, message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      working = false;
    }
  }

  async function trySwap() {
    if (working || stagedAt === null || !enabled()) return null;
    // A busy check that cannot answer counts as busy: never restart over work it could not see.
    const busy = await Promise.resolve().then(isBusy).catch(() => true);
    const last = lastActivityAt();
    const moment = {
      busy: Boolean(busy),
      systemIdleSeconds: Number(idleSeconds()) || 0,
      componentIdleMs: Number.isFinite(last) ? Math.max(0, now() - last) : Infinity,
      stagedForMs: now() - stagedAt,
    };
    if (!readyToSwap(moment)) return null;
    working = true;
    try {
      const result = await swap(componentId);
      stagedAt = null;
      logger?.info?.("managed-component.update_swapped", { componentId, ...result });
      return result;
    } catch (error) {
      logger?.warn?.("managed-component.update_swap_failed", { componentId, message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      working = false;
    }
  }

  function stop() {
    if (checkTimer) clearTimeout(checkTimer);
    if (swapTimer) clearInterval(swapTimer);
    checkTimer = null;
    swapTimer = null;
  }

  function start() {
    stop();
    const schedule = (delay) => {
      checkTimer = setTimeout(async () => {
        await check();
        schedule(checkIntervalMs);
      }, delay);
      checkTimer.unref?.();
    };
    schedule(firstCheckDelayMs);
    swapTimer = setInterval(() => { void trySwap(); }, swapPollMs);
    swapTimer.unref?.();
  }

  return { check, trySwap, start, stop, stagedAt: () => stagedAt };
}

module.exports = { CHECK_INTERVAL_MS, createComponentUpdater, readyToSwap };
