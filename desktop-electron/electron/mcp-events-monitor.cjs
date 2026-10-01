"use strict";

// Detects Coding Tools incidents in the desktop process and reports them to the headless
// service, whose MCP event hub delivers them as signed webhooks to ChatGPT subscriptions.
// Each incident is reported once; the same condition re-arms only after it recovered.

const net = require("node:net");

const EVENTS = Object.freeze({
  webTurnFailed: "coding_tools.web_turn.failed",
  runStalled: "coding_tools.run.stalled",
  missionNeedsAttention: "coding_tools.mission.needs_attention",
  bridgeDown: "coding_tools.bridge.down",
});
const DEFAULT_STALL_MINUTES = 5;
const TICK_MS = 30_000;
const PROBE_FAILURES_BEFORE_DOWN = 2;
const MAX_REPORTS_PER_WINDOW = 20;
const REPORT_WINDOW_MS = 10 * 60_000;
const MAX_PENDING = 50;
const PROXY_NET_ERRORS = new Set([
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_AUTH_UNSUPPORTED",
  "ERR_PROXY_CERTIFICATE_INVALID",
  "ERR_NO_SUPPORTED_PROXIES",
]);

function stallMinutesFrom(env = process.env) {
  const value = Number(env.CODING_TOOLS_EVENT_STALL_MINUTES);
  return Number.isFinite(value) && value >= 1 && value <= 24 * 60 ? value : DEFAULT_STALL_MINUTES;
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function redact(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[redacted]@")
    .slice(0, 500);
}

/** host:port of a proxy URL without credentials, or null. */
function proxyTarget(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port, label: `${url.hostname}:${port}` };
  } catch {
    return null;
  }
}

function tcpProbe({ host, port }, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, code) => { socket.destroy(); resolve({ ok, code }); };
    socket.setTimeout(timeoutMs, () => done(false, "ETIMEDOUT"));
    socket.once("connect", () => done(true, null));
    socket.once("error", (error) => done(false, error?.code || "ECONNREFUSED"));
  });
}

async function httpProbe(url, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, code: response.ok ? null : `HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, code: error?.name === "AbortError" ? "ETIMEDOUT" : (error?.cause?.code || "ECONNREFUSED") };
  } finally {
    clearTimeout(timer);
  }
}

function createMcpEventMonitor({
  report,
  configure = null,
  logger = null,
  now = Date.now,
  stallMinutes = stallMinutesFrom(),
  bridgeHealthUrl = () => null,
  proxyUrl = () => process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
  probeHttp = httpProbe,
  probeTcp = tcpProbe,
} = {}) {
  if (typeof report !== "function") throw new Error("MCP event monitor needs a report sink");
  const stallMs = Math.round(stallMinutes * 60_000);
  const turns = new Map();
  const endedTurns = new Set();
  const runs = new Map();
  const open = new Map();
  const probes = { bridge: { failures: 0, since: null }, proxy: { failures: 0, since: null } };
  const pending = [];
  const sentAt = [];
  let timer = null;
  let ticking = false;

  async function deliver(entry) {
    try {
      await report(entry);
      return true;
    } catch (error) {
      logger?.debug?.("mcp_events.report_deferred", { event: entry.event, message: String(error?.message || error).slice(0, 200) });
      return false;
    }
  }

  function enqueue(entry) {
    if (!entry.resolve) {
      const cutoff = now() - REPORT_WINDOW_MS;
      while (sentAt.length && sentAt[0] < cutoff) sentAt.shift();
      if (sentAt.length >= MAX_REPORTS_PER_WINDOW) {
        logger?.warn?.("mcp_events.rate_limited", { event: entry.event });
        return;
      }
      sentAt.push(now());
    }
    pending.push(entry);
    while (pending.length > MAX_PENDING) pending.shift();
    void flush();
  }

  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (pending.length) {
        if (!await deliver(pending[0])) break;
        pending.shift();
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /** Report `key` once while it stays open. Returns true when a new incident started. */
  function openIncident(key, event, workspaceId, data, fixedId = null) {
    if (open.has(key)) return false;
    const at = now();
    const incidentId = fixedId ?? `${key}@${at}`;
    open.set(key, { event, incidentId });
    enqueue({
      event,
      workspace_id: workspaceId ?? null,
      data: { incident_id: incidentId, occurred_at: iso(at), ...data },
    });
    return true;
  }

  function closeIncident(key) {
    const incident = open.get(key);
    if (!incident) return;
    open.delete(key);
    enqueue({ event: incident.event, resolve: true, data: { incident_id: incident.incidentId } });
  }

  function closePrefix(prefix) {
    for (const key of [...open.keys()]) if (key.startsWith(prefix)) closeIncident(key);
  }

  // --- web chat turns (browser control server) ------------------------------------------

  function turnEvent(event = {}) {
    const traceId = typeof event.traceId === "string" ? event.traceId : null;
    if (!traceId) return;
    const mode = event.manual ? "manual" : "automatic";
    if (event.type === "start") {
      turns.set(traceId, { traceId, mode, conversationKey: event.conversationKey ?? null, lastProgress: now() });
      return;
    }
    if (event.type === "heartbeat") {
      const turn = turns.get(traceId);
      if (turn) turn.lastProgress = now();
      closeIncident(`web_turn_stall:${traceId}`);
      return;
    }
    if (event.type !== "end") return;
    const turn = turns.get(traceId);
    turns.delete(traceId);
    closeIncident(`web_turn_stall:${traceId}`);
    if (event.status !== "failed" && event.status !== "aborted") return;
    // A turn ends once; a repeated end report for the same trace is the same incident.
    if (endedTurns.has(traceId)) return;
    endedTurns.add(traceId);
    if (endedTurns.size > 500) endedTurns.delete(endedTurns.values().next().value);
    const conversationKey = event.conversationKey ?? turn?.conversationKey ?? null;
    openIncident(`web_turn:${traceId}`, EVENTS.webTurnFailed, null, {
      reason_code: event.status,
      reason: redact(event.message || `The web chat turn ended as ${event.status}`),
      next_step: event.status === "aborted"
        ? "The turn was cancelled before it finished. If the task is still wanted, send the request again; call server_info to see whether related incidents are still open."
        : "The Coding Tools web chat turn failed. Check the Coding Tools window for a login, captcha or error banner, then send the request again to continue the task.",
      recovery_tools: ["server_info"],
      status: event.status,
      turn_mode: event.manual ? "manual" : (turn?.mode ?? mode),
      trace_id: traceId,
      conversation_key: conversationKey,
    }, `web_turn:${traceId}`);
    // A failed turn is terminal and never "recovers", so no open entry is kept.
    open.delete(`web_turn:${traceId}`);
  }

  // Proxy outages are seen two ways: failed ChatGPT requests (closed only by a later
  // successful request, since a reachable proxy port can still fail upstream) and failed
  // TCP probes of the proxy port. Either one open means the outage is already reported.
  function nativeFetchFailed({ netError } = {}) {
    if (!PROXY_NET_ERRORS.has(netError) || open.has("bridge:proxy_route")) return;
    const target = proxyTarget(proxyUrl());
    openIncident("bridge:proxy_fetch", EVENTS.bridgeDown, null, {
      reason_code: netError,
      reason: `A ChatGPT request through the configured proxy failed (${netError}).`,
      next_step: "Start the local proxy app or choose a working proxy in Coding Tools > Network Proxy; ChatGPT requests fail until the proxy route works.",
      recovery_tools: ["server_info"],
      component: "proxy_route",
      target: target?.label ?? "unknown",
      down_since: iso(now()),
      net_error: netError,
    });
  }

  function nativeFetchSucceeded() {
    closeIncident("bridge:proxy_fetch");
    closeIncident("bridge:proxy_route");
    probes.proxy = { failures: 0, since: null };
  }

  // --- Agent Orchestrator background runs -----------------------------------------------

  function runState(update = {}) {
    const { workspaceId, runId } = update;
    if (typeof workspaceId !== "string" || typeof runId !== "string") return;
    const key = `${workspaceId}:${runId}`;
    const current = runs.get(key) ?? { workspaceId, runId, fingerprint: null, lastChange: now() };
    if (update.status === "finished" || update.stopped === true) {
      runs.delete(key);
      closePrefix(`mission:${key}:`);
      closeIncident(`run_stall:${key}`);
      return;
    }
    if (update.fingerprint !== undefined && update.fingerprint !== current.fingerprint) {
      current.fingerprint = update.fingerprint;
      current.lastChange = now();
      closeIncident(`run_stall:${key}`);
    }
    current.status = update.status;
    runs.set(key, current);
    const attention = update.attention ?? null;
    if (update.status === "running") {
      // A running run clears earlier held/error incidents and any satisfied wait.
      for (const kind of ["error", "stopped", "pending_approval", "needs_input"]) {
        if (kind !== attention) closeIncident(`mission:${key}:${kind}`);
      }
    }
    if (!attention) return;
    const hints = {
      pending_approval: "A mission worker is waiting for a tool approval. Only the local user can approve it in Coding Tools (Mission tab); ask them to review it.",
      needs_input: "A mission worker needs input. Ask the user to answer it on the Coding Tools Board or Mission tab.",
      error: "The mission stopped with an error. Call workflow_list to inspect the saved cards, then ask the user to resume the mission from Coding Tools once the cause is fixed.",
      stopped: "The mission was held with unresolved cards. Call workflow_list to inspect them; resuming requires the local Coding Tools controls.",
    };
    if (!hints[attention]) return;
    openIncident(`mission:${key}:${attention}`, EVENTS.missionNeedsAttention, workspaceId, {
      reason_code: attention,
      reason: redact(update.detail || attention.replace("_", " ")),
      next_step: hints[attention],
      recovery_tools: ["workflow_list", "server_info"],
      workspace_id: workspaceId,
      run_id: runId,
      status: ["held", "paused", "running", "idle"].includes(update.status) ? update.status : "held",
      attention,
    });
  }

  // --- periodic checks --------------------------------------------------------------------

  function checkStalls() {
    const at = now();
    for (const turn of turns.values()) {
      if (turn.mode !== "automatic" || at - turn.lastProgress < stallMs) continue;
      openIncident(`web_turn_stall:${turn.traceId}`, EVENTS.runStalled, null, {
        reason_code: "no_heartbeat",
        reason: `The web chat turn sent no heartbeat for ${Math.round((at - turn.lastProgress) / 60_000)} minutes.`,
        next_step: "The Coding Tools browser turn looks stuck. Check the ChatGPT tab in Coding Tools (login, captcha or a frozen response); if it does not recover, cancel it and send the request again.",
        recovery_tools: ["server_info"],
        run_kind: "web_turn",
        stalled_for_seconds: Math.round((at - turn.lastProgress) / 1000),
        stall_threshold_seconds: Math.round(stallMs / 1000),
        last_progress_at: iso(turn.lastProgress),
        trace_id: turn.traceId,
        conversation_key: turn.conversationKey,
      });
    }
    for (const [key, run] of runs) {
      if (run.status !== "running" || at - run.lastChange < stallMs) continue;
      // Waiting on the local user is not a stall; that incident is already open.
      if (open.has(`mission:${key}:pending_approval`) || open.has(`mission:${key}:needs_input`)) continue;
      openIncident(`run_stall:${key}`, EVENTS.runStalled, run.workspaceId, {
        reason_code: "no_progress",
        reason: `No mission card changed state for ${Math.round((at - run.lastChange) / 60_000)} minutes.`,
        next_step: "The orchestrator run is still marked running but made no progress. Call workflow_list to inspect it; if a worker is stuck, ask the user to stop and resume the mission in Coding Tools.",
        recovery_tools: ["workflow_list", "server_info"],
        run_kind: "orchestrator_run",
        stalled_for_seconds: Math.round((at - run.lastChange) / 1000),
        stall_threshold_seconds: Math.round(stallMs / 1000),
        last_progress_at: iso(run.lastChange),
        workspace_id: run.workspaceId,
        run_id: run.runId,
      });
    }
  }

  async function checkComponent(name, url, probe, label, hint) {
    const state = probes[name];
    if (!url) {
      state.failures = 0;
      state.since = null;
      closeIncident(`bridge:${name === "bridge" ? "codex_bridge" : "proxy_route"}`);
      if (name === "proxy") closeIncident("bridge:proxy_fetch");
      return;
    }
    const result = await probe();
    const key = `bridge:${name === "bridge" ? "codex_bridge" : "proxy_route"}`;
    if (result.ok) {
      state.failures = 0;
      state.since = null;
      closeIncident(key);
      return;
    }
    state.failures += 1;
    state.since ??= now();
    if (state.failures < PROBE_FAILURES_BEFORE_DOWN || (name === "proxy" && open.has("bridge:proxy_fetch"))) return;
    openIncident(key, EVENTS.bridgeDown, null, {
      reason_code: result.code || "unreachable",
      reason: `${label} did not answer ${state.failures} consecutive health checks.`,
      next_step: hint,
      recovery_tools: ["server_info"],
      component: name === "bridge" ? "codex_bridge" : "proxy_route",
      target: url,
      down_since: iso(state.since),
      net_error: result.code || null,
    });
  }

  // The webhook sender lives in the headless service, which does not see later changes
  // to this process's proxy route. The sink deduplicates unchanged values.
  async function syncProxy() {
    if (!configure) return;
    try {
      await configure(proxyTarget(proxyUrl()) ? proxyUrl() : null);
    } catch {
      // Retried on the next tick (for example once the headless service is up).
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      checkStalls();
      const health = bridgeHealthUrl();
      let bridgeLabel = null;
      try { bridgeLabel = health ? new URL(health).host : null; } catch { bridgeLabel = null; }
      await checkComponent("bridge", bridgeLabel, () => probeHttp(health), "The Codex bridge",
        "Restart the Codex bridge from Coding Tools (Runtime > Restart). Web chat turns cannot run until it is back.");
      const proxy = proxyTarget(proxyUrl());
      await checkComponent("proxy", proxy?.label ?? null, () => probeTcp(proxy), "The network proxy",
        "Start the local proxy app or choose a working proxy in Coding Tools > Network Proxy; ChatGPT requests fail until the proxy route works.");
      await syncProxy();
      await flush();
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, TICK_MS);
    timer.unref?.();
    void tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({
    turnEvent, nativeFetchFailed, nativeFetchSucceeded, runState, tick, start, stop, flush,
    snapshot: () => ({ openIncidents: [...open.keys()], trackedTurns: turns.size, trackedRuns: runs.size, pending: pending.length }),
  });
}

module.exports = { createMcpEventMonitor, EVENTS, proxyTarget, stallMinutesFrom, redact };
