"use strict";

/**
 * Honest loopback health for managed stacks.
 * Ready means the health HTTP probe succeeded (CPA GET /v1/models,
 * Codex Router GET /_codex-router/{callerKey}/v1/models, CommandCode
 * GET /v1/models, Paseo/Anneal GET /). A live pid without a successful
 * listen is never ready.
 */

const READY_WAIT_MS = Object.freeze({
  cpa: 45_000,
  "codex-router": 90_000,
  "commandcode-proxy": 30_000,
  paseo: 60_000,
  anneal: 45_000,
});
const DEFAULT_READY_WAIT_MS = 20_000;
const READY_POLL_MS = 250;

function timeoutFor(id, override) {
  if (Number.isFinite(override) && override >= 0) return override;
  return READY_WAIT_MS[id] || DEFAULT_READY_WAIT_MS;
}

async function waitUntilHealthy({
  inspect,
  id,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs,
  pollMs = READY_POLL_MS,
} = {}) {
  if (typeof inspect !== "function") throw new Error("Health inspect callback is required");
  if (!id) throw new Error("Health inspect id is required");
  const started = now();
  const limit = timeoutFor(id, timeoutMs);
  const poll = Number.isFinite(pollMs) && pollMs >= 0 ? pollMs : READY_POLL_MS;
  let last = { id, status: "starting", error: null };

  while (true) {
    try {
      last = await inspect(id);
    } catch (error) {
      last = {
        id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (last?.status === "ready") return last;
    if (now() - started >= limit) return last || { id, status: "offline", error: null };
    await sleep(poll);
  }
}

module.exports = {
  DEFAULT_READY_WAIT_MS,
  READY_POLL_MS,
  READY_WAIT_MS,
  waitUntilHealthy,
};
