"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const TOOL_IDS = Object.freeze(["cpa", "codex-router"]);
const CPA_LOOPBACK = Object.freeze({
  id: "cpa",
  host: "127.0.0.1",
  port: 8317,
  origin: "http://127.0.0.1:8317",
  endpoint: "http://127.0.0.1:8317/",
  healthPath: "/v1/models",
  healthUrl: "http://127.0.0.1:8317/v1/models",
  openaiBasePath: "/v1",
  openaiBaseUrl: "http://127.0.0.1:8317/v1",
  modelsPath: "/v1/models",
  chatCompletionsPath: "/v1/chat/completions",
  controlPath: "/management.html",
  controlUrl: "http://127.0.0.1:8317/management.html",
  urlEnv: "CODING_TOOLS_CPA_URL",
  openaiBaseUrlEnv: "CODING_TOOLS_CPA_OPENAI_BASE_URL",
  proxyApiKeyEnv: "CODING_TOOLS_CPA_PROXY_API_KEY",
});
const ROUTER_LOOPBACK = Object.freeze({
  id: "codex-router",
  host: "127.0.0.1",
  port: 4202,
  origin: "http://127.0.0.1:4202",
  endpoint: "http://127.0.0.1:4202/",
  healthPathTemplate: "/_codex-router/{callerKey}/v1/models",
  openaiBasePathTemplate: "/_codex-router/{callerKey}/v1",
  chatCompletionsPathTemplate: "/_codex-router/{callerKey}/v1/chat/completions",
  urlEnv: "CODING_TOOLS_CODEX_ROUTER_URL",
  openaiBaseUrlEnv: "CODING_TOOLS_CODEX_ROUTER_OPENAI_BASE_URL",
  callerKeyEnv: "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY",
});
const PROVIDER_BACKEND_CONSUMERS = Object.freeze(["desktop", "mcp", "paseo"]);
const PROVIDER_BACKEND_LAUNCH_IDS = Object.freeze(["codex-router", "paseo", "anneal"]);
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

function startPeerIds(toolId) {
  return String(toolId || "").trim() === "codex-router" ? ["cpa"] : [];
}

function routerHealthUrl(callerKey) {
  const key = String(callerKey || "").trim();
  if (!key) throw new Error("Codex Router caller key is required for loopback health");
  return `${ROUTER_LOOPBACK.origin}/_codex-router/${encodeURIComponent(key)}/v1/models`;
}

function managedLoopbackHealthTargets({ cpaProxyApiKey, routerCallerKey } = {}) {
  return Object.freeze({
    cpa: Object.freeze({
      url: CPA_LOOPBACK.healthUrl,
      headers: cpaProxyApiKey
        ? Object.freeze({ Authorization: `Bearer ${String(cpaProxyApiKey)}` })
        : Object.freeze({}),
    }),
    "codex-router": Object.freeze({
      url: routerCallerKey ? routerHealthUrl(routerCallerKey) : null,
      headers: Object.freeze({}),
    }),
  });
}

function desktopCrossUseEnvironment({ cpaProxyApiKey, routerCallerKey } = {}) {
  const proxyApiKey = String(cpaProxyApiKey || "").trim();
  const callerKey = String(routerCallerKey || "").trim();
  return {
    [CPA_LOOPBACK.urlEnv]: CPA_LOOPBACK.origin,
    [CPA_LOOPBACK.openaiBaseUrlEnv]: CPA_LOOPBACK.openaiBaseUrl,
    [ROUTER_LOOPBACK.urlEnv]: ROUTER_LOOPBACK.origin,
    ...(proxyApiKey ? { [CPA_LOOPBACK.proxyApiKeyEnv]: proxyApiKey } : {}),
    ...(callerKey ? {
      [ROUTER_LOOPBACK.callerKeyEnv]: callerKey,
      [ROUTER_LOOPBACK.openaiBaseUrlEnv]: `${ROUTER_LOOPBACK.origin}/_codex-router/${callerKey}/v1`,
    } : {}),
  };
}

function launchConsumesProviderBackends(id) {
  return PROVIDER_BACKEND_LAUNCH_IDS.includes(String(id || "").trim());
}

function providerBackendContract() {
  return Object.freeze({
    schemaVersion: 1,
    kind: "coding-tools-provider-backends",
    role: "provider-backend",
    bundled: true,
    consumers: PROVIDER_BACKEND_CONSUMERS,
    orchestrators: Object.freeze({
      paseo: Object.freeze({
        role: "orchestrator",
        uses: Object.freeze(["cpa", "codex-router"]),
        implements: "other-owner",
      }),
      anneal: Object.freeze({
        role: "task-preview",
        uses: Object.freeze(["cpa", "codex-router"]),
        implements: "other-owner",
      }),
    }),
    backends: Object.freeze({
      cpa: Object.freeze({
        id: "cpa",
        name: "CPA / CLIProxyAPI",
        role: "main-provider",
        protocol: "openai_chat",
        workloadHints: Object.freeze(["paseo", "anneal"]),
        origin: CPA_LOOPBACK.origin,
        openaiBaseUrl: CPA_LOOPBACK.openaiBaseUrl,
        health: Object.freeze({
          method: "GET",
          url: CPA_LOOPBACK.healthUrl,
          authorization: "Bearer {secret:proxyApiKey}",
          acceptStatus: Object.freeze([200]),
        }),
        api: Object.freeze({
          models: Object.freeze({ method: "GET", path: CPA_LOOPBACK.modelsPath }),
          chatCompletions: Object.freeze({ method: "POST", path: CPA_LOOPBACK.chatCompletionsPath }),
        }),
        control: Object.freeze({
          kind: "management.html",
          url: CPA_LOOPBACK.controlUrl,
          auth: "managementKey",
        }),
        env: Object.freeze({
          url: CPA_LOOPBACK.urlEnv,
          openaiBaseUrl: CPA_LOOPBACK.openaiBaseUrlEnv,
          proxyApiKey: CPA_LOOPBACK.proxyApiKeyEnv,
        }),
      }),
      "codex-router": Object.freeze({
        id: "codex-router",
        name: "Codex Router",
        role: "subagent-provider",
        protocol: "openai_chat",
        workloadHints: Object.freeze(["subagent", "paseo"]),
        origin: ROUTER_LOOPBACK.origin,
        openaiBaseUrl: `${ROUTER_LOOPBACK.origin}${ROUTER_LOOPBACK.openaiBasePathTemplate}`,
        health: Object.freeze({
          method: "GET",
          url: `${ROUTER_LOOPBACK.origin}${ROUTER_LOOPBACK.healthPathTemplate}`,
          acceptStatus: Object.freeze([200]),
        }),
        api: Object.freeze({
          models: Object.freeze({ method: "GET", path: ROUTER_LOOPBACK.healthPathTemplate }),
          chatCompletions: Object.freeze({ method: "POST", path: ROUTER_LOOPBACK.chatCompletionsPathTemplate }),
        }),
        control: Object.freeze({
          kind: "control-center",
          url: ROUTER_LOOPBACK.origin,
        }),
        env: Object.freeze({
          url: ROUTER_LOOPBACK.urlEnv,
          openaiBaseUrl: ROUTER_LOOPBACK.openaiBaseUrlEnv,
          callerKey: ROUTER_LOOPBACK.callerKeyEnv,
        }),
      }),
    }),
  });
}

function providerBackendOpenApi() {
  return Object.freeze({
    openapi: "3.0.3",
    info: Object.freeze({
      title: "Coding Tools CPA and Codex Router provider backends",
      version: "1.0.0",
      description: "Stable loopback OpenAI-compatible APIs for Desktop, MCP, and Paseo. Paseo/Anneal orchestration is owned elsewhere.",
    }),
    servers: Object.freeze([
      Object.freeze({ url: CPA_LOOPBACK.origin, description: "CPA main provider" }),
      Object.freeze({ url: ROUTER_LOOPBACK.origin, description: "Codex Router subagent provider" }),
    ]),
    paths: Object.freeze({
      "/v1/models": Object.freeze({
        get: Object.freeze({
          tags: Object.freeze(["cpa"]),
          operationId: "cpaListModels",
          security: Object.freeze([Object.freeze({ cpaProxyApiKey: Object.freeze([]) })]),
          responses: Object.freeze({ 200: Object.freeze({ description: "OpenAI-compatible model list" }) }),
        }),
      }),
      "/v1/chat/completions": Object.freeze({
        post: Object.freeze({
          tags: Object.freeze(["cpa"]),
          operationId: "cpaChatCompletions",
          security: Object.freeze([Object.freeze({ cpaProxyApiKey: Object.freeze([]) })]),
          responses: Object.freeze({ 200: Object.freeze({ description: "OpenAI-compatible chat completion" }) }),
        }),
      }),
      "/_codex-router/{callerKey}/v1/models": Object.freeze({
        get: Object.freeze({
          tags: Object.freeze(["codex-router"]),
          operationId: "routerListModels",
          parameters: Object.freeze([Object.freeze({
            name: "callerKey",
            in: "path",
            required: true,
            schema: Object.freeze({ type: "string", minLength: 32 }),
          })]),
          responses: Object.freeze({ 200: Object.freeze({ description: "OpenAI-compatible model list" }) }),
        }),
      }),
      "/_codex-router/{callerKey}/v1/chat/completions": Object.freeze({
        post: Object.freeze({
          tags: Object.freeze(["codex-router"]),
          operationId: "routerChatCompletions",
          parameters: Object.freeze([Object.freeze({
            name: "callerKey",
            in: "path",
            required: true,
            schema: Object.freeze({ type: "string", minLength: 32 }),
          })]),
          responses: Object.freeze({ 200: Object.freeze({ description: "OpenAI-compatible chat completion" }) }),
        }),
      }),
    }),
    components: Object.freeze({
      securitySchemes: Object.freeze({
        cpaProxyApiKey: Object.freeze({
          type: "http",
          scheme: "bearer",
          description: CPA_LOOPBACK.proxyApiKeyEnv,
        }),
      }),
    }),
  });
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
    desirePeer(toolId, "desired-recover-peer");
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
        for (const peerId of startPeerIds(toolId)) watchDesired(peerId);
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

  function desirePeer(toolId, event) {
    for (const peerId of startPeerIds(toolId)) {
      state.tools[peerId].desiredRunning = true;
      if (!state.tools[peerId].lastStartedAt) {
        state.tools[peerId].lastStartedAt = new Date(now()).toISOString();
      }
      record(peerId, event);
    }
  }

  async function start(toolId) {
    const id = requiredToolId(toolId);
    desirePeer(id, "desired-start-peer");
    state.tools[id].desiredRunning = true;
    state.tools[id].lastStartedAt = new Date(now()).toISOString();
    record(id, "desired-start");
    syncPowerSave();
    const started = decorate(await inner.start(id));
    for (const peerId of startPeerIds(id)) watchDesired(peerId);
    watchDesired(id);
    return started;
  }

  async function stop(toolId) {
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
    const id = requiredToolId(toolId);
    desirePeer(id, "desired-restart-peer");
    state.tools[id].desiredRunning = true;
    record(id, "desired-restart");
    syncPowerSave();
    const restarted = decorate(await inner.restart(id));
    for (const peerId of startPeerIds(id)) watchDesired(peerId);
    watchDesired(id);
    return restarted;
  }

  async function openEmbedded(toolId, section) {
    const id = requiredToolId(toolId);
    if (!state.tools[id].desiredRunning) {
      desirePeer(id, "desired-open-peer");
      state.tools[id].desiredRunning = true;
      record(id, "desired-open");
      syncPowerSave();
    }
    const opened = await inner.openEmbedded(id, section);
    watchDesired(id);
    return {
      ...opened,
      tool: decorate(opened.tool),
    };
  }

  async function openExternalTool(toolId, section) {
    const id = requiredToolId(toolId);
    if (!state.tools[id].desiredRunning) {
      desirePeer(id, "desired-open-peer");
      state.tools[id].desiredRunning = true;
      record(id, "desired-open");
      syncPowerSave();
    }
    const opened = await inner.openExternalTool(id, section);
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
  CPA_LOOPBACK,
  ROUTER_LOOPBACK,
  PROVIDER_BACKEND_CONSUMERS,
  PROVIDER_BACKEND_LAUNCH_IDS,
  WEEK_MS,
  EXECUTION_TIMEOUT_MS,
  HEALTH_POLL_MS,
  BACKOFF_CAP_MS,
  CPA_LOGS_MAX_TOTAL_SIZE_MB,
  LITELLM_REQUEST_TIMEOUT_SECONDS,
  applyLongRunLiteLlmTimeout,
  attachCpaCodexLongRun,
  cpaLongRunYamlLines,
  desktopCrossUseEnvironment,
  launchConsumesProviderBackends,
  managedLoopbackHealthTargets,
  providerBackendContract,
  providerBackendOpenApi,
  routerHealthUrl,
  startPeerIds,
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
