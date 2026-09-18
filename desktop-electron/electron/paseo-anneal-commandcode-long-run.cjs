"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const TOOL_IDS = Object.freeze(["commandcode-proxy", "paseo", "anneal"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HEALTH_POLL_MS = 45_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const MAX_JOURNAL_EVENTS = 80;
const MAX_JOURNAL_BYTES = 32_768;
const SCHEMA_VERSION = 1;

function emptyToolState() {
  return {
    desiredRunning: false,
    consecutiveCrashes: 0,
    backoffMs: 0,
    reconnectGeneration: 0,
    lastEvent: null,
    lastError: null,
    keptAliveAt: null,
    lastStartedAt: null,
    firstFailureAt: null,
  };
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    tools: {
      "commandcode-proxy": emptyToolState(),
      paseo: emptyToolState(),
      anneal: emptyToolState(),
    },
    events: [],
  };
}

function requiredToolId(value) {
  const id = String(value || "").trim();
  if (!TOOL_IDS.includes(id)) throw new Error(`Unknown long-run tool: ${id || "missing"}`);
  return id;
}

function nextBackoffMs(attempt, { random = Math.random } = {}) {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const exponential = BACKOFF_BASE_MS * (2 ** Math.min(index, 16));
  const capped = Math.min(BACKOFF_CAP_MS, exponential);
  const jitter = Math.floor(capped * 0.1 * Math.min(1, Math.max(0, random())));
  return Math.min(BACKOFF_CAP_MS, capped + jitter);
}

function shouldAbandonLongRun() {
  return false;
}

function trimJournal(events, { maxEvents = MAX_JOURNAL_EVENTS, maxBytes = MAX_JOURNAL_BYTES } = {}) {
  const source = Array.isArray(events) ? events.filter((entry) => entry && typeof entry === "object") : [];
  let next = source.slice(-Math.max(1, maxEvents));
  while (next.length > 8 && Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) {
    next = next.slice(1);
  }
  return next;
}

function readState(filePath) {
  if (!filePath) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return emptyState();
    const next = emptyState();
    for (const id of TOOL_IDS) {
      next.tools[id] = { ...emptyToolState(), ...(parsed.tools?.[id] || {}) };
    }
    next.events = trimJournal(parsed.events);
    return next;
  } catch {
    return emptyState();
  }
}

function writeState(filePath, state) {
  if (!filePath || !path.isAbsolute(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function projectLongRun(toolState) {
  return Object.freeze({
    desiredRunning: toolState.desiredRunning === true,
    keptAliveAt: toolState.keptAliveAt,
    lastStartedAt: toolState.lastStartedAt,
    reconnectGeneration: toolState.reconnectGeneration || 0,
    windowMs: WEEK_MS,
  });
}

function attachLane193LongRun(inner, {
  statePath = null,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  powerSaveBlocker = null,
  logger = null,
  resumeOnCreate = true,
  random = Math.random,
} = {}) {
  if (!inner) throw new Error("External services controller is required");
  const state = readState(statePath);
  const timers = new Map();
  let powerSaveId = null;
  let disposed = false;

  function persist() {
    writeState(statePath, state);
  }

  function record(toolId, event, extra = {}) {
    const entry = {
      at: new Date(now()).toISOString(),
      toolId,
      event,
      ...extra,
    };
    state.events = trimJournal([...state.events, entry]);
    state.tools[toolId].lastEvent = event;
    persist();
    if (event !== "keepalive") logger?.info?.("paseo-anneal-commandcode-long-run.event", entry);
  }

  function clearTimer(toolId) {
    const timer = timers.get(toolId);
    if (timer) clearTimeoutFn(timer);
    timers.delete(toolId);
  }

  function schedule(toolId, delayMs, fn) {
    clearTimer(toolId);
    const timer = setTimeoutFn(() => {
      timers.delete(toolId);
      if (disposed) return undefined;
      return Promise.resolve().then(fn).catch((error) => {
        logger?.warn?.("paseo-anneal-commandcode-long-run.tick-failed", {
          toolId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(0, delayMs));
    timer?.unref?.();
    timers.set(toolId, timer);
  }

  function syncPowerSave() {
    const needed = TOOL_IDS.some((id) => state.tools[id].desiredRunning);
    if (!powerSaveBlocker?.start) return;
    const active = powerSaveId !== null && powerSaveBlocker.isStarted?.(powerSaveId);
    if (needed && !active) {
      powerSaveId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!needed && active) {
      try { powerSaveBlocker.stop(powerSaveId); } catch {}
      powerSaveId = null;
    }
  }

  async function recover(toolId, reason) {
    const current = state.tools[toolId];
    if (!current.desiredRunning || shouldAbandonLongRun()) return inner.inspect(toolId);
    current.consecutiveCrashes += 1;
    current.backoffMs = nextBackoffMs(current.consecutiveCrashes - 1, { random });
    current.reconnectGeneration += 1;
    if (!current.firstFailureAt) current.firstFailureAt = new Date(now()).toISOString();
    record(toolId, "crash-recover", { reason, backoffMs: current.backoffMs });
    persist();
    schedule(toolId, current.backoffMs, async () => {
      try {
        await inner.start(toolId);
        current.lastStartedAt = new Date(now()).toISOString();
        persist();
        watchDesired(toolId);
      } catch (error) {
        current.lastError = error instanceof Error ? error.message : String(error);
        record(toolId, "restart-failed", { message: current.lastError });
        await recover(toolId, "restart-failed");
      }
    });
    return inner.inspect(toolId);
  }

  async function tick(toolId) {
    if (disposed || !state.tools[toolId].desiredRunning) return;
    let observed;
    try {
      observed = await inner.inspect(toolId);
    } catch (error) {
      observed = { id: toolId, status: "offline", error: error instanceof Error ? error.message : String(error) };
    }
    const status = String(observed?.status || "");
    if (status === "ready") {
      state.tools[toolId].consecutiveCrashes = 0;
      state.tools[toolId].backoffMs = 0;
      state.tools[toolId].keptAliveAt = new Date(now()).toISOString();
      state.tools[toolId].lastError = null;
      persist();
      record(toolId, "keepalive");
      schedule(toolId, HEALTH_POLL_MS, () => tick(toolId));
      return;
    }
    await recover(toolId, status || "offline");
  }

  function watchDesired(toolId) {
    if (!state.tools[toolId].desiredRunning) return;
    schedule(toolId, HEALTH_POLL_MS, () => tick(toolId));
  }

  async function start(toolId) {
    const id = requiredToolId(toolId);
    state.tools[id].desiredRunning = true;
    state.tools[id].lastStartedAt = new Date(now()).toISOString();
    record(id, "desired-start");
    persist();
    syncPowerSave();
    const started = await inner.start(id);
    watchDesired(id);
    return started;
  }

  async function stop(toolId) {
    const id = requiredToolId(toolId);
    state.tools[id].desiredRunning = false;
    record(id, "desired-stop");
    persist();
    clearTimer(id);
    syncPowerSave();
    return inner.stop(id);
  }

  async function restart(toolId) {
    const id = requiredToolId(toolId);
    state.tools[id].desiredRunning = true;
    state.tools[id].reconnectGeneration += 1;
    record(id, "desired-restart");
    persist();
    syncPowerSave();
    const restarted = await inner.restart(id);
    watchDesired(id);
    return restarted;
  }

  function resume() {
    for (const id of TOOL_IDS) {
      if (state.tools[id].desiredRunning) {
        record(id, "session-revive");
        watchDesired(id);
      }
    }
    syncPowerSave();
  }

  function dispose() {
    disposed = true;
    for (const id of TOOL_IDS) clearTimer(id);
    if (powerSaveId !== null && powerSaveBlocker?.stop) {
      try { powerSaveBlocker.stop(powerSaveId); } catch {}
      powerSaveId = null;
    }
    inner.dispose?.();
  }

  if (resumeOnCreate) resume();

  const wrapped = {
    start,
    stop,
    restart,
    dispose,
    lane193LongRun: () => ({
      schemaVersion: SCHEMA_VERSION,
      windowMs: WEEK_MS,
      tools: {
        "commandcode-proxy": projectLongRun(state.tools["commandcode-proxy"]),
        paseo: projectLongRun(state.tools.paseo),
        anneal: projectLongRun(state.tools.anneal),
      },
    }),
  };
  for (const key of Object.keys(inner)) {
    if (wrapped[key] === undefined) {
      const value = inner[key];
      wrapped[key] = typeof value === "function" ? value.bind(inner) : value;
    }
  }
  return wrapped;
}

module.exports = {
  TOOL_IDS,
  WEEK_MS,
  HEALTH_POLL_MS,
  attachLane193LongRun,
  shouldAbandonLongRun,
};
