"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const TOOL_IDS = Object.freeze(["cpa", "codex-router"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EXECUTION_TIMEOUT_MS = 8 * 24 * 60 * 60 * 1000;
const HEALTH_POLL_MS = 45_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const BLIP_RESTART_THRESHOLD = 3;
const MAX_JOURNAL_EVENTS = 80;
const MAX_JOURNAL_BYTES = 32_768;
const GROK_STREAM_STALL_MS = 2 * 60 * 60_000;
const GATEWAY_RESTARTS = 32;
const GATEWAY_RESTART_WINDOW_MS = 10 * 60_000;
const LITELLM_REQUEST_TIMEOUT_SECONDS = Math.ceil(EXECUTION_TIMEOUT_MS / 1000);
const CPA_LOGS_MAX_TOTAL_SIZE_MB = 256;
const SCHEMA_VERSION = 1;

function emptyToolState() {
  return {
    desiredRunning: false,
    consecutiveBlips: 0,
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
      cpa: emptyToolState(),
      "codex-router": emptyToolState(),
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

function classifyObservation({ desiredRunning, pid, status }) {
  if (!desiredRunning) return "idle";
  if (status === "ready") return "healthy";
  if (pid) return "blip";
  return "crash";
}

function trimJournal(events, { maxEvents = MAX_JOURNAL_EVENTS, maxBytes = MAX_JOURNAL_BYTES } = {}) {
  const source = Array.isArray(events) ? events.filter((entry) => entry && typeof entry === "object") : [];
  let next = source.slice(-Math.max(1, maxEvents));
  while (next.length > 8 && Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) {
    next = next.slice(1);
  }
  return next;
}

function routerLongRunEnvironment() {
  return {
    MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: String(EXECUTION_TIMEOUT_MS),
    CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: String(EXECUTION_TIMEOUT_MS),
    MODEL_ROUTER_ACTIVITY_RECORD_RETENTION_MS: String(EXECUTION_TIMEOUT_MS),
    CODEX_ROUTER_ACTIVITY_RECORD_RETENTION_MS: String(EXECUTION_TIMEOUT_MS),
    CODEX_ROUTER_GROK_STREAM_STALL_MS: String(GROK_STREAM_STALL_MS),
    CODEX_ROUTER_GATEWAY_RESTARTS: String(GATEWAY_RESTARTS),
    CODEX_ROUTER_GATEWAY_RESTART_WINDOW_MS: String(GATEWAY_RESTART_WINDOW_MS),
    CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS: String(BACKOFF_BASE_MS),
    LITELLM_REQUEST_TIMEOUT: String(LITELLM_REQUEST_TIMEOUT_SECONDS),
  };
}

function applyLongRunLiteLlmTimeout(home) {
  const filePath = path.join(home, "src", "litellm-config.mjs");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const source = fs.readFileSync(filePath, "utf8");
  const next = source.replace(
    /request_timeout:\s*600\b/g,
    `request_timeout: ${LITELLM_REQUEST_TIMEOUT_SECONDS}`,
  );
  if (next === source) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

function cpaLongRunYamlLines() {
  return [
    "request-retry: 5",
    "max-retry-interval: 300",
    "save-cooldown-status: true",
    "error-logs-max-files: 20",
    `logs-max-total-size-mb: ${CPA_LOGS_MAX_TOTAL_SIZE_MB}`,
    "nonstream-keepalive-interval: 30",
    "streaming:",
    "  keepalive-seconds: 15",
    "  bootstrap-retries: 2",
  ];
}

function rotateFileIfNeeded(filePath, { maxBytes = 2 * 1024 * 1024, keep = 2 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < maxBytes) return false;
  for (let index = keep; index >= 1; index -= 1) {
    const from = index === 1 ? filePath : `${filePath}.${index}`;
    const to = `${filePath}.${index}`;
    if (fs.existsSync(from)) {
      try { fs.renameSync(from, to); } catch {}
    }
  }
  return true;
}

function readState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !parsed.tools) return emptyState();
    const state = emptyState();
    for (const id of TOOL_IDS) {
      state.tools[id] = { ...emptyToolState(), ...(parsed.tools[id] || {}) };
    }
    state.events = trimJournal(parsed.events);
    return state;
  } catch {
    return emptyState();
  }
}

function writeState(filePath, state) {
  if (!filePath) return;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    tools: {
      cpa: { ...emptyToolState(), ...(state.tools?.cpa || {}) },
      "codex-router": { ...emptyToolState(), ...(state.tools?.["codex-router"] || {}) },
    },
    events: trimJournal(state.events),
  };
  writePrivateFileAtomic(filePath, `${JSON.stringify(payload)}\n`);
}

function projectLongRun(toolState) {
  const current = { ...emptyToolState(), ...(toolState || {}) };
  return {
    desiredRunning: current.desiredRunning === true,
    reconnectGeneration: Number.isInteger(current.reconnectGeneration) ? current.reconnectGeneration : 0,
    lastEvent: current.lastEvent || null,
    lastError: current.lastError || null,
    backoffMs: Number.isInteger(current.backoffMs) ? current.backoffMs : 0,
    keptAliveAt: current.keptAliveAt || null,
  };
}

function attachCpaCodexLongRun(inner, {
  statePath = null,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  powerSaveBlocker = null,
  logger = null,
  resumeOnCreate = true,
  random = Math.random,
} = {}) {
  if (!inner) throw new Error("Original UI controller is required");
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
    if (event !== "keepalive") logger?.info?.("cpa-codex-long-run.event", entry);
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
        logger?.warn?.("cpa-codex-long-run.tick-failed", {
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

  function decorate(tool) {
    if (!tool || !TOOL_IDS.includes(tool.id)) return tool;
    return { ...tool, longRun: projectLongRun(state.tools[tool.id]) };
  }

  function snapshot() {
    const current = inner.snapshot();
    return {
      ...current,
      tools: current.tools.map(decorate),
    };
  }

  async function inspect(toolId) {
    return decorate(await inner.inspect(toolId));
  }

  async function recover(toolId, reason) {
    const current = state.tools[toolId];
    if (!current.desiredRunning || shouldAbandonLongRun()) return inspect(toolId);
    current.consecutiveCrashes += 1;
    current.backoffMs = nextBackoffMs(current.consecutiveCrashes - 1, { random });
    if (!current.firstFailureAt) current.firstFailureAt = new Date(now()).toISOString();
    record(toolId, "crash-recover", { reason, backoffMs: current.backoffMs });
    persist();
    schedule(toolId, current.backoffMs, async () => {
      try {
        await inner.start(toolId);
        current.lastStartedAt = new Date(now()).toISOString();
        persist();
        if (toolId === "codex-router") {
          try { await inner.openEmbedded(toolId); } catch {}
        }
        watchDesired(toolId);
      } catch (error) {
        current.lastError = error instanceof Error ? error.message : String(error);
        record(toolId, "restart-failed", { message: current.lastError });
        await recover(toolId, "restart-failed");
      }
    });
    return inspect(toolId);
  }

  async function tick(toolId) {
    if (disposed || !state.tools[toolId].desiredRunning) return;
    let observed;
    try {
      observed = await inner.inspect(toolId);
    } catch (error) {
      observed = {
        id: toolId,
        status: "offline",
        pid: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const kind = classifyObservation({
      desiredRunning: true,
      pid: observed.pid,
      status: observed.status,
    });
    const current = state.tools[toolId];
    if (kind === "healthy") {
      const recovered = current.consecutiveBlips > 0 || current.consecutiveCrashes > 0 || current.lastEvent === "crash-recover";
      current.consecutiveBlips = 0;
      current.consecutiveCrashes = 0;
      current.backoffMs = 0;
      current.firstFailureAt = null;
      current.lastError = null;
      current.keptAliveAt = new Date(now()).toISOString();
      if (recovered) {
        current.reconnectGeneration += 1;
        record(toolId, "reconnect", { generation: current.reconnectGeneration });
      }
      persist();
      schedule(toolId, HEALTH_POLL_MS, () => tick(toolId));
      return;
    }
    if (kind === "blip") {
      current.consecutiveBlips += 1;
      current.lastError = observed.error || "health blip";
      if (current.consecutiveBlips === 1) record(toolId, "blip", { pid: observed.pid });
      persist();
      if (current.consecutiveBlips >= BLIP_RESTART_THRESHOLD) {
        current.consecutiveBlips = 0;
        await recover(toolId, "repeated-blips");
        return;
      }
      schedule(toolId, HEALTH_POLL_MS, () => tick(toolId));
      return;
    }
    await recover(toolId, observed.error || "process-exit");
  }

  function watchDesired(toolId) {
    if (!state.tools[toolId].desiredRunning) {
      clearTimer(toolId);
      return;
    }
    schedule(toolId, 0, () => tick(toolId));
  }

  function isLongRunTool(toolId) {
    return TOOL_IDS.includes(String(toolId || "").trim());
  }

  async function start(toolId) {
    if (!isLongRunTool(toolId)) return inner.start(toolId);
    const id = requiredToolId(toolId);
    state.tools[id].desiredRunning = true;
    state.tools[id].lastStartedAt = new Date(now()).toISOString();
    record(id, "desired-start");
    syncPowerSave();
    const started = decorate(await inner.start(id));
    watchDesired(id);
    return started;
  }

  async function stop(toolId) {
    if (!isLongRunTool(toolId)) return inner.stop(toolId);
    const id = requiredToolId(toolId);
    state.tools[id].desiredRunning = false;
    state.tools[id].consecutiveBlips = 0;
    state.tools[id].consecutiveCrashes = 0;
    state.tools[id].backoffMs = 0;
    clearTimer(id);
    record(id, "desired-stop");
    syncPowerSave();
    return decorate(await inner.stop(id));
  }

  async function restart(toolId) {
    if (!isLongRunTool(toolId)) return inner.restart(toolId);
    const id = requiredToolId(toolId);
    state.tools[id].desiredRunning = true;
    record(id, "desired-restart");
    syncPowerSave();
    const restarted = decorate(await inner.restart(id));
    watchDesired(id);
    return restarted;
  }

  async function openEmbedded(toolId, section) {
    if (!isLongRunTool(toolId)) return inner.openEmbedded(toolId, section);
    const id = requiredToolId(toolId);
    const opened = await inner.openEmbedded(id, section);
    if (id === "cpa") {
      return {
        ...opened,
        tool: decorate(opened.tool),
      };
    }
    if (!state.tools[id].desiredRunning) {
      state.tools[id].desiredRunning = true;
      record(id, "desired-open");
      syncPowerSave();
    }
    watchDesired(id);
    return {
      ...opened,
      tool: decorate(opened.tool),
    };
  }

  async function openExternalTool(toolId, section) {
    if (!isLongRunTool(toolId)) return inner.openExternalTool(toolId, section);
    const id = requiredToolId(toolId);
    const opened = await inner.openExternalTool(id, section);
    if (id === "cpa") {
      return { ...opened, tool: decorate(opened.tool) };
    }
    if (!state.tools[id].desiredRunning) {
      state.tools[id].desiredRunning = true;
      record(id, "desired-open");
      syncPowerSave();
    }
    watchDesired(id);
    return { ...opened, tool: decorate(opened.tool) };
  }

  function resume() {
    for (const id of TOOL_IDS) {
      if (state.tools[id].desiredRunning) {
        record(id, "resume");
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

  return Object.freeze({
    snapshot,
    inspect,
    start,
    stop,
    restart,
    openEmbedded,
    openExternalTool,
    cpaManagementKey: (...args) => inner.cpaManagementKey?.(...args),
    copyCpaManagementKey: (...args) => inner.copyCpaManagementKey(...args),
    resume,
    dispose,
    longRunState: () => ({
      schemaVersion: SCHEMA_VERSION,
      tools: {
        cpa: projectLongRun(state.tools.cpa),
        "codex-router": projectLongRun(state.tools["codex-router"]),
      },
    }),
  });
}

module.exports = {
  TOOL_IDS,
  WEEK_MS,
  EXECUTION_TIMEOUT_MS,
  HEALTH_POLL_MS,
  BACKOFF_CAP_MS,
  CPA_LOGS_MAX_TOTAL_SIZE_MB,
  LITELLM_REQUEST_TIMEOUT_SECONDS,
  applyLongRunLiteLlmTimeout,
  attachCpaCodexLongRun,
  cpaLongRunYamlLines,
  classifyObservation,
  nextBackoffMs,
  projectLongRun,
  readState,
  rotateFileIfNeeded,
  routerLongRunEnvironment,
  shouldAbandonLongRun,
  trimJournal,
  writeState,
};
