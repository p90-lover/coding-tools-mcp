"use strict";

const { fingerprintStatus } = require("./five-stack-loopbacks.cjs");

const HEALTHY_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 8_000;
const MAX_INTERVAL_MS = 5 * 60_000;

function createFiveStackLoopbackProbes({
  probeAll,
  onChange = null,
  logger = null,
  healthyIntervalMs = HEALTHY_INTERVAL_MS,
  minIntervalMs = MIN_INTERVAL_MS,
  maxIntervalMs = MAX_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof probeAll !== "function") throw new Error("probeAll is required");
  let timer = null;
  let stopped = true;
  let intervalMs = minIntervalMs;
  let lastFingerprint = "";
  let lastSnapshot = null;
  let consecutiveErrors = 0;
  let ticks = 0;
  let published = 0;

  function allListening(snapshot) {
    const stacks = snapshot?.stacks || [];
    return stacks.length > 0 && stacks.every((stack) => stack.listening === true);
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      tick().catch((error) => {
        consecutiveErrors += 1;
        intervalMs = Math.min(maxIntervalMs, Math.max(minIntervalMs, intervalMs * 2));
        if (consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
          logger?.warn?.("five-stack loopback probe recovered after crash", {
            consecutiveErrors,
          });
        }
        schedule();
        void error;
      });
    }, intervalMs);
    timer?.unref?.();
  }

  async function tick() {
    if (stopped) return;
    ticks += 1;
    try {
      const snapshot = await probeAll();
      consecutiveErrors = 0;
      lastSnapshot = snapshot;
      const fingerprint = fingerprintStatus(snapshot);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        published += 1;
        onChange?.(snapshot);
      }
      intervalMs = allListening(snapshot)
        ? healthyIntervalMs
        : Math.min(maxIntervalMs, Math.max(minIntervalMs, intervalMs * 2));
    } catch (error) {
      consecutiveErrors += 1;
      intervalMs = Math.min(maxIntervalMs, Math.max(minIntervalMs, intervalMs * 2));
      if (consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
        logger?.warn?.("five-stack loopback probe error", {
          consecutiveErrors,
          message: error instanceof Error ? error.message : "probe_failed",
        });
      }
    } finally {
      schedule();
    }
  }

  return {
    start() {
      stopped = false;
      intervalMs = minIntervalMs;
      schedule();
    },
    async refresh() {
      await tick();
      return lastSnapshot;
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    snapshot() {
      return lastSnapshot;
    },
    stats() {
      return Object.freeze({
        ticks,
        published,
        consecutiveErrors,
        intervalMs,
        fingerprint: lastFingerprint,
      });
    },
  };
}

module.exports = {
  HEALTHY_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  createFiveStackLoopbackProbes,
};
