"use strict";

const crypto = require("node:crypto");

const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const WATCH_TOOL_DEFS = Object.freeze([{
  name: "watch_command", title: "Continue when a command finishes",
  description: "Watch a command_id this chat started with exec_command. Returns a watch_id immediately; when the command finishes, fails, "
    + "or the watch expires, the app sends a real follow-up in this chat after your current turn ends. Use it for a build, test, CI watch "
    + "or deployment command you must check next. Start the command in the foreground, register this watch, check registration succeeded, "
    + "then end your turn instead of polling. A new call replaces an unfinished watch for that handle under the current turn. "
    + "It does not run, repeat, type into or stop the command. A watch deadline is not a command "
    + "timeout. Watches belong to this app runtime and are cancelled by Stop or a newer user turn. A promise in your reply alone schedules nothing.",
  inputSchema: { type: "object", additionalProperties: false, required: ["command_id", "reason"], properties: {
    command_id: { type: "string", maxLength: 128 },
    reason: { type: "string", minLength: 1, maxLength: 500, description: "What you will verify or do next when this command ends" },
    timeout_ms: { type: "integer", minimum: 1000, maximum: MAX_TIMEOUT_MS, default: 1_800_000 },
  } },
}, {
  name: "list_command_watches", title: "List this chat's command watches",
  description: "Read this chat's registered command watches and their observation/delivery states. No process is started or stopped. "
    + "Only a successful watch registration arranges a later follow-up; an empty list does not schedule one.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true },
}, {
  name: "cancel_command_watch", title: "Cancel a command watch",
  description: "Cancel this chat's watch_id and any follow-up it has not sent yet. The command keeps running; use kill_command separately to stop it.",
  inputSchema: { type: "object", additionalProperties: false, required: ["watch_id"], properties: { watch_id: { type: "string", maxLength: 128 } } },
}]);
const WATCH_TOOLS = new Set(WATCH_TOOL_DEFS.map(tool => tool.name));

function createCommandWatches({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const records = new Map();
  let disposed = false;
  const publicRecord = record => ({ watch_id: record.id, command_id: record.commandId, reason: record.reason,
    status: record.status, delivery: record.delivery, created_at_ms: record.at, deadline_at_ms: record.deadline,
    ...(record.outcome ? { outcome: record.outcome } : {}), supervision_scope: "current app runtime; no command replay" });
  const clear = record => { clearTimer(record.timer); clearTimer(record.deadlineTimer); };
  function cancel(record) {
    if (!record || record.delivery === "delivered" || record.status === "cancelled") return false;
    clear(record);
    record.status = "cancelled";
    record.delivery = "cancelled";
    record.controller.abort();
    record.ticket?.cancel();
    return true;
  }
  const live = record => !disposed && record.status === "watching" && record.active();
  function finish(record, outcome) {
    if (record.status !== "watching") return;
    if (!live(record)) { cancel(record); return; }
    clear(record);
    record.status = outcome.kind;
    record.outcome = outcome;
    record.delivery = "pending";
    record.controller.abort();
    Promise.resolve().then(() => record.status === "cancelled" ? "cancelled" : record.ticket.complete(outcome))
      .then(delivery => { if (record.status !== "cancelled") record.delivery = ["delivered", "dropped", "failed", "unknown"].includes(delivery) ? delivery : "unknown"; },
        () => { if (record.status !== "cancelled") record.delivery = "unknown"; });
  }
  function arm(record, ms) {
    record.timer = setTimer(() => { record.timer = null; void inspect(record); }, ms);
    record.timer?.unref?.();
  }
  async function inspect(record) {
    if (record.status !== "watching") return;
    if (!live(record)) { cancel(record); return; }
    if (now() >= record.deadline) { finish(record, { kind: "expired", note: "The watch deadline passed; the command was not stopped and its outcome is not confirmed." }); return; }
    try {
      const result = await record.inspect(record.controller.signal);
      if (!live(record)) return;
      if (!result || result.ok === false || !["running", "terminating", "exited", "killed", "timed_out", "spawn_failed"].includes(result.status)) throw new Error("Command state unavailable");
      if (!["running", "terminating"].includes(result.status) && !result.finalization_pending) {
        finish(record, { kind: "completed", status: result.status, termination_reason: String(result.termination_reason ?? result.status).slice(0, 80),
          exit_code: Number.isInteger(result.exit_code) ? result.exit_code : null,
          command_ok: typeof result.command_ok === "boolean" ? result.command_ok : null,
          output_refs: { stdout: `command:${record.commandId}:stdout`, stderr: `command:${record.commandId}:stderr` } });
        return;
      }
      record.failures = 0;
    } catch {
      if (!live(record)) return;
      record.failures += 1;
      if (record.failures >= 3) { finish(record, { kind: "failed", note: "The command could not be observed after three tries. Its execution outcome is unknown; inspect it, never blindly relaunch it." }); return; }
    }
    arm(record, Math.min(5000, Math.max(1, record.deadline - now())));
  }
  async function watch({ owner, commandId, reason, timeoutMs = 1_800_000, active, inspect: read, prepare }) {
    if (disposed) throw new Error("Command watches are unavailable");
    if (typeof commandId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(commandId)) throw new Error("A valid command_id is required");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) throw new Error("reason must contain 1 to 500 characters");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeout_ms must be an integer from 1000 to 86400000");
    const previous = [...records.values()].find(record => record.owner === owner && record.commandId === commandId
      && (["registering", "watching", "completed"].includes(record.status) || record.delivery === "pending"));
    if (previous) {
      if (previous.registering) await previous.registering;
      if (!["registering", "watching"].includes(previous.status)) return publicRecord(previous);
      cancel(previous);
    }
    if ([...records.values()].filter(record => record.owner === owner && (["registering", "watching"].includes(record.status) || record.delivery === "pending")).length >= 16
      || [...records.values()].filter(record => ["registering", "watching"].includes(record.status) || record.delivery === "pending").length >= 128) throw new Error("Too many active command watches; cancel a watch first");
    while (records.size >= 256) {
      const oldest = [...records.values()].find(record => !["registering", "watching"].includes(record.status) && record.delivery !== "pending");
      if (!oldest) throw new Error("Command watch retention is full");
      records.delete(oldest.id);
    }
    const record = { id: `watch-${crypto.randomUUID()}`, owner, commandId, reason: reason.trim(), at: now(), deadline: now() + timeoutMs,
      status: "registering", delivery: "not_ready", active, inspect: read, failures: 0, controller: new AbortController() };
    records.set(record.id, record);
    let timer, removeAbort;
    const cancelled = new Promise((_, reject) => {
      const stop = () => reject(new Error("Watch registration was cancelled"));
      record.controller.signal.addEventListener("abort", stop, { once: true });
      removeAbort = () => record.controller.signal.removeEventListener("abort", stop);
    });
    const prepared = Promise.resolve().then(prepare).then(ticket => {
      if (record.status !== "registering" || disposed || !active()) { ticket?.cancel(); throw new Error("Watch registration was cancelled"); }
      if (typeof ticket?.complete !== "function" || typeof ticket?.cancel !== "function") throw new Error("Command continuation is unavailable");
      record.ticket = ticket;
    });
    record.registering = Promise.race([prepared, cancelled, new Promise((_, reject) => {
      timer = setTimer(() => { cancel(record); reject(new Error("Watch registration timed out; no follow-up was confirmed")); }, 15_000);
      timer?.unref?.();
    })]);
    try { await record.registering; }
    catch (error) { cancel(record); throw error; }
    finally { clearTimer(timer); removeAbort(); record.registering = null; }
    if (record.status !== "registering" || disposed || !active()) { cancel(record); throw new Error("Watch registration was cancelled"); }
    record.status = "watching";
    record.delivery = "armed";
    record.deadlineTimer = setTimer(() => finish(record, { kind: "expired", note: "The watch deadline passed; the command was not stopped and its outcome is not confirmed." }), Math.max(1, record.deadline - now()));
    record.deadlineTimer?.unref?.();
    arm(record, 1);
    return publicRecord(record);
  }
  return { watch,
    list: owner => [...records.values()].filter(record => record.owner === owner).map(publicRecord),
    cancel: (owner, id) => { const record = records.get(id); return record?.owner === owner ? cancel(record) : false; },
    cancelOwner: owner => { for (const record of records.values()) if (record.owner === owner) cancel(record); },
    close: () => { disposed = true; for (const record of records.values()) cancel(record); records.clear(); },
  };
}

module.exports = { createCommandWatches, WATCH_TOOL_DEFS, WATCH_TOOLS };
