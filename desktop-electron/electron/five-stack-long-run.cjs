"use strict";

/**
 * Multi-day keep-alive for the five managed stacks (Codex Router, CPA,
 * CommandCode Proxy, Anneal, Paseo). Policy mirrors tunnel Recovery
 * (bounded backoff + healthy reset) and turn-suspension (sleep/wake is not a crash).
 *
 * Persist file holds desired running/stopped, selected section, and reconnect
 * budget. It never stores secrets or credentials.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { sweepGapIndicatesSuspension } = require("./turn-suspension.cjs");

const FIVE_STACK_IDS = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);

const DEFAULT_SECTIONS = Object.freeze({
  cpa: "dashboard",
  "codex-router": "dashboard",
  "commandcode-proxy": "banner",
  paseo: "agents",
  anneal: "tasks",
});

const TARGET_UPTIME_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const BACKOFF_SECONDS = Object.freeze([5, 15, 30, 60, 120, 300]);
const MAX_ATTEMPTS = 8;
const STABLE_RESET_MS = 120_000;
const PERSIST_IDLE_MS = 5 * 60 * 1000;
const PERSIST_NAME = "long-run.json";
const MAX_PERSIST_BYTES = 64 * 1024;

function emptyComponent(id) {
  return {
    desired: "stopped",
    selectedSection: DEFAULT_SECTIONS[id] || "",
    lastHealthyAt: 0,
    lastHeartbeatAt: 0,
    reconnectAttempts: 0,
    nextRetryAt: 0,
    blockedReason: null,
    stableSince: 0,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function due(component, nowMs) {
  return !component.blockedReason
    && component.reconnectAttempts < MAX_ATTEMPTS
    && (component.nextRetryAt === 0 || nowMs >= component.nextRetryAt);
}

function uiStatus(component, liveStatus) {
  if (component.desired !== "running") {
    return liveStatus === "ready" ? "ready" : "stopped";
  }
  if (liveStatus === "ready") return "ready";
  if (component.blockedReason || component.reconnectAttempts >= MAX_ATTEMPTS) return "blocked";
  if (component.reconnectAttempts > 0) return "reconnecting";
  if (liveStatus === "starting" || liveStatus === "unknown") return "starting";
  return "starting";
}

function summaryOf(id, component, nowMs, liveStatus = "offline") {
  const retryAfterSeconds = component.nextRetryAt > nowMs
    ? Math.ceil((component.nextRetryAt - nowMs) / 1000)
    : 0;
  return {
    desired: component.desired,
    selectedSection: component.selectedSection,
    uiStatus: uiStatus(component, liveStatus),
    reconnectAttempts: component.reconnectAttempts,
    maxAttempts: MAX_ATTEMPTS,
    retryAfterSeconds,
    lastHealthyAt: component.lastHealthyAt || null,
    blockedReason: component.blockedReason,
    targetUptimeMs: TARGET_UPTIME_MS,
    heartbeatMs: HEARTBEAT_MS,
  };
}

function createFiveStackLongRun({
  persistPath = null,
  now = () => Date.now(),
  readFile = null,
  writeFile = null,
  logger = null,
} = {}) {
  const components = new Map(FIVE_STACK_IDS.map((id) => [id, emptyComponent(id)]));
  let lastSweepAt = 0;
  let lastPersistAt = 0;
  let dirty = false;
  let suspended = false;

  function requireId(id) {
    if (!components.has(id)) throw new Error(`Unknown five-stack component: ${id}`);
    return components.get(id);
  }

  function markDirty() {
    dirty = true;
  }

  function persist(force = false) {
    const nowMs = now();
    if (!force && !dirty && nowMs - lastPersistAt < PERSIST_IDLE_MS) return;
    if (!persistPath && !writeFile) {
      dirty = false;
      lastPersistAt = nowMs;
      return;
    }
    const payload = JSON.stringify({
      version: 1,
      targetUptimeMs: TARGET_UPTIME_MS,
      heartbeatMs: HEARTBEAT_MS,
      updatedAt: nowMs,
      lastSweepAt,
      components: Object.fromEntries(
        FIVE_STACK_IDS.map((id) => [id, clone(components.get(id))]),
      ),
    }, null, 2);
    if (payload.length > MAX_PERSIST_BYTES) {
      logger?.warn?.("five-stack-long-run.persist-too-large", { bytes: payload.length });
      return;
    }
    try {
      if (writeFile) writeFile(payload);
      else {
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        writePrivateFileAtomic(persistPath, payload);
      }
      dirty = false;
      lastPersistAt = nowMs;
    } catch (error) {
      logger?.warn?.("five-stack-long-run.persist-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function load() {
    let raw = "";
    try {
      raw = readFile
        ? String(readFile() || "")
        : persistPath && fs.existsSync(persistPath)
          ? fs.readFileSync(persistPath, "utf8")
          : "";
    } catch (error) {
      logger?.warn?.("five-stack-long-run.load-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!raw.trim()) return;
    if (raw.length > MAX_PERSIST_BYTES) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.components !== "object") return;
    lastSweepAt = Number(parsed.lastSweepAt) || 0;
    for (const id of FIVE_STACK_IDS) {
      const incoming = parsed.components?.[id];
      if (!incoming || typeof incoming !== "object") continue;
      const current = components.get(id);
      current.desired = incoming.desired === "running" ? "running" : "stopped";
      if (typeof incoming.selectedSection === "string" && incoming.selectedSection) {
        current.selectedSection = incoming.selectedSection.slice(0, 64);
      }
      current.lastHealthyAt = Number(incoming.lastHealthyAt) || 0;
      current.lastHeartbeatAt = Number(incoming.lastHeartbeatAt) || 0;
      current.reconnectAttempts = Math.min(MAX_ATTEMPTS, Math.max(0, Number(incoming.reconnectAttempts) || 0));
      current.nextRetryAt = Number(incoming.nextRetryAt) || 0;
      current.blockedReason = typeof incoming.blockedReason === "string" ? incoming.blockedReason : null;
      current.stableSince = Number(incoming.stableSince) || 0;
    }
    dirty = false;
  }

  function setDesired(id, desired) {
    const component = requireId(id);
    const next = desired === "running" ? "running" : "stopped";
    component.desired = next;
    if (next === "running") {
      component.blockedReason = null;
      component.reconnectAttempts = 0;
      component.nextRetryAt = 0;
      component.stableSince = 0;
    } else {
      component.blockedReason = null;
      component.reconnectAttempts = 0;
      component.nextRetryAt = 0;
      component.stableSince = 0;
    }
    markDirty();
    persist(true);
    return summaryOf(id, component, now(), next === "running" ? "starting" : "offline");
  }

  function setSelectedSection(id, section) {
    const component = requireId(id);
    const value = String(section || "").trim().slice(0, 64);
    if (!value || value === component.selectedSection) {
      return summaryOf(id, component, now());
    }
    component.selectedSection = value;
    markDirty();
    persist(true);
    return summaryOf(id, component, now());
  }

  function noteHealthy(id) {
    const component = requireId(id);
    const nowMs = now();
    component.lastHealthyAt = nowMs;
    component.lastHeartbeatAt = nowMs;
    if (!component.stableSince) component.stableSince = nowMs;
    if (nowMs - component.stableSince >= STABLE_RESET_MS && component.reconnectAttempts > 0) {
      component.reconnectAttempts = 0;
      component.nextRetryAt = 0;
      component.blockedReason = null;
      component.stableSince = nowMs;
      markDirty();
    }
    if (nowMs - lastPersistAt >= PERSIST_IDLE_MS) markDirty();
    persist();
    return summaryOf(id, component, nowMs, "ready");
  }

  function noteAttempt(id) {
    const component = requireId(id);
    const nowMs = now();
    component.stableSince = 0;
    component.reconnectAttempts = Math.min(MAX_ATTEMPTS, component.reconnectAttempts + 1);
    const delay = BACKOFF_SECONDS[Math.min(component.reconnectAttempts - 1, BACKOFF_SECONDS.length - 1)];
    component.nextRetryAt = nowMs + delay * 1000;
    if (component.reconnectAttempts >= MAX_ATTEMPTS) {
      component.blockedReason = "reconnect_budget_exhausted";
    }
    markDirty();
    persist(true);
    return summaryOf(id, component, nowMs);
  }

  function hasPendingBackoff(nowMs, sweepAt) {
    for (const component of components.values()) {
      if (component.desired !== "running" || !component.nextRetryAt) continue;
      if (component.nextRetryAt <= sweepAt) continue;
      if (nowMs - component.nextRetryAt < HEARTBEAT_MS * 6) return true;
      if (nowMs < component.nextRetryAt) return true;
    }
    return false;
  }

  function markSuspended() {
    suspended = true;
  }

  function rebaselineAfterSuspension() {
    const nowMs = now();
    for (const component of components.values()) {
      if (component.desired !== "running") continue;
      component.lastHeartbeatAt = nowMs;
      if (component.lastHealthyAt) component.lastHealthyAt = nowMs;
    }
    markDirty();
  }

  function desired(id) {
    return requireId(id).desired;
  }

  function shouldAutoStart(id) {
    return requireId(id).desired !== "stopped";
  }

  function summary(id, liveStatus = "offline") {
    return summaryOf(id, requireId(id), now(), liveStatus);
  }

  function catalog(live = {}) {
    const nowMs = now();
    return {
      version: 1,
      targetUptimeMs: TARGET_UPTIME_MS,
      heartbeatMs: HEARTBEAT_MS,
      lastSweepAt,
      components: Object.fromEntries(
        FIVE_STACK_IDS.map((id) => [
          id,
          summaryOf(id, components.get(id), nowMs, live[id]?.status || "offline"),
        ]),
      ),
    };
  }

  function planTick(live = {}) {
    const nowMs = now();
        const slept = suspended
          || (
            sweepGapIndicatesSuspension(lastSweepAt || undefined, nowMs, HEARTBEAT_MS)
            && !hasPendingBackoff(nowMs, lastSweepAt)
          );
    suspended = false;
    lastSweepAt = nowMs;
    const actions = [];
    if (slept) {
      rebaselineAfterSuspension();
      persist();
      for (const id of FIVE_STACK_IDS) {
        if (components.get(id).desired === "running") {
          actions.push({ id, action: "suspend" });
        }
      }
      return actions;
    }
    for (const id of FIVE_STACK_IDS) {
      const component = components.get(id);
      if (component.desired !== "running") continue;
      if (live[id]?.installState === "not-installed") continue;
      const liveStatus = live[id]?.status || "offline";
      if (liveStatus === "ready") {
        noteHealthy(id);
        continue;
      }
      if (liveStatus === "starting") continue;
      if (!due(component, nowMs)) {
        if (component.blockedReason || component.reconnectAttempts >= MAX_ATTEMPTS) {
          actions.push({ id, action: "block" });
        }
        continue;
      }
      noteAttempt(id);
      actions.push({ id, action: "reconnect" });
    }
    persist();
    return actions;
  }

  load();

  return Object.freeze({
    load,
    persist,
    setDesired,
    setSelectedSection,
    noteHealthy,
    noteAttempt,
    markSuspended,
    desired,
    shouldAutoStart,
    summary,
    catalog,
    planTick,
    ids: FIVE_STACK_IDS,
  });
}

module.exports = {
  FIVE_STACK_IDS,
  DEFAULT_SECTIONS,
  TARGET_UPTIME_MS,
  HEARTBEAT_MS,
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  STABLE_RESET_MS,
  PERSIST_NAME,
  createFiveStackLongRun,
};
