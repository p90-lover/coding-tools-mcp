"use strict";

// The workspace listeners the person started themselves (Workspaces > Authentication > Start, confirmed
// in the focused window), kept in launcher state and started again when the app starts. Nothing did
// this before: every app restart, and so every automatic update, left each workspace's MCP listener
// stopped. ChatGPT's native Codex requests were then refused ("Start this workspace's authenticated MCP
// listener first") until the person started it again by hand. Seen 2026-11-20 after the 0.8.140 update:
// all four workspaces stopped, and ChatGPT said only that the native Codex connection was unavailable.
//
// Only a listener the person confirmed is remembered, and stopping it forgets it, so a restore never
// starts anything they did not choose. The headless service still requires `confirm` for the start.

const SERVICES = new Set(["mcp", "actions"]);
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LISTENERS = 64;

function listenerKey(workspaceId, service) {
  return typeof workspaceId === "string" && WORKSPACE_ID.test(workspaceId) && SERVICES.has(service)
    ? `${workspaceId}:${service}` : null;
}

/** The remembered listeners as unique "<workspaceId>:<service>" entries; anything else is dropped. */
function normalizeListeners(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const [workspaceId, service, extra] = entry.split(":");
    const key = extra === undefined ? listenerKey(workspaceId, service) : null;
    if (key) seen.add(key);
  }
  return [...seen].slice(-MAX_LISTENERS);
}

/**
 * The remembered listeners after the person's confirmed `operation` succeeded: a start or restart
 * remembers the listener, a stop forgets it, and a status read changes nothing.
 */
function rememberListener(list, workspaceId, service, operation) {
  const current = normalizeListeners(list);
  const key = listenerKey(workspaceId, service);
  if (!key || !["start", "restart", "stop"].includes(operation)) return current;
  const next = current.filter((entry) => entry !== key);
  if (operation !== "stop") next.push(key);
  return next.slice(-MAX_LISTENERS);
}

function listenerRunning(response) {
  const state = response?.status?.state;
  return typeof state === "string" && state !== "stopped" && state !== "error";
}

/**
 * Starts each remembered listener that is not running. A workspace that no longer exists is
 * forgotten; a listener that fails to start stays remembered for the next start. `request` is the
 * headless host's request(pathname, body). Returns the entries to keep and the ones started.
 */
async function restoreWorkspaceListeners({ entries, workspaceIds, request, logger = null }) {
  const known = new Set(Array.isArray(workspaceIds) ? workspaceIds : []);
  const kept = [];
  const restored = [];
  for (const key of normalizeListeners(entries)) {
    const [workspaceId, service] = key.split(":");
    if (!known.has(workspaceId)) {
      logger?.info?.("workspace.listener_forgotten", { service, reason: "workspace_removed" });
      continue;
    }
    kept.push(key);
    try {
      const status = await request("/api/v1/workspaces/service",
        { workspace_id: workspaceId, service, operation: "status", confirm: false });
      if (listenerRunning(status)) continue;
      const started = await request("/api/v1/workspaces/service",
        { workspace_id: workspaceId, service, operation: "start", confirm: true });
      restored.push(key);
      logger?.info?.("workspace.listener_restored", { service, state: started?.status?.state ?? null });
    } catch (error) {
      logger?.warn?.("workspace.listener_restore_failed", {
        service, message: String(error?.message || error).slice(0, 300),
      });
    }
  }
  return { kept, restored };
}

module.exports = { normalizeListeners, rememberListener, restoreWorkspaceListeners, listenerRunning };
