"use strict";

// monitor: Claude Code's Monitor tool for the app's chat agents. The user, 2026-11-14: "set up tools
// that exact the same as codex and claude code that can monitor task or anything that require
// attention". Its schema is Claude Code's MonitorInput (description, timeout_ms, command): the
// command runs in the background through the chat's own exec_command (reviewed, sandboxed and
// tracked like any other), each line it prints to stdout is an event, and the events reach the
// chat as follow-ups (agent-orchestrator-workflow.cjs registerCommandMonitor). Its exit, or the
// deadline, ends the watch. Unlike watch_command, which reports once when a command finishes.

const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_800_000;
const POLL_MS = 1000;
const MAX_LINE = 500;
const MAX_PER_CHAT = 8;
const MAX_TOTAL = 64;
// Like Claude Code's: a monitor whose events flood the chat is stopped (each delivery is a turn).
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_EVENTS = 200;

const MONITOR_TOOL_DEFS = Object.freeze([{
  name: "monitor", title: "Monitor a command's output",
  description: "Start a background monitor that streams events from a long-running command. Each line the command prints to stdout "
    + "is an event: events reach this chat as notifications (after your current turn ends, batched), so keep working or end your "
    + "turn instead of polling. The command's exit ends the watch; so does timeout_ms, which also stops the command. Use it for "
    + "\"tell me every time X happens\": a log tail filtered with grep or Select-String, a poll loop that prints one line per change, "
    + "a CI or deploy watcher that prints each step. Filter so each line is something you would act on, and cover failure "
    + "states as well as success: silence is not success. A monitor that prints too many lines is stopped. For a single "
    + "\"tell me when it is done\", use exec_command and watch_command instead. The command is reviewed like exec_command.",
  inputSchema: { type: "object", additionalProperties: false, required: ["description", "timeout_ms", "command"], properties: {
    description: { type: "string", minLength: 1, maxLength: 200, description: "Short human-readable description of what you are monitoring (shown in notifications)." },
    timeout_ms: { type: "integer", minimum: 1000, description: "Kill the monitor after this deadline. Default 300000ms. Deadlines above 1800000ms are capped to 1800000ms. You are notified at expiry and can re-arm." },
    command: { type: "string", minLength: 1, maxLength: 8000, description: "Shell command or script. Each stdout line is an event; exit ends the watch." },
  } },
}, {
  name: "list_monitors", title: "List this chat's monitors",
  description: "Read this chat's monitors: what each watches, its command_id, how many events it has sent, and whether it is still running. Read-only.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true },
}, {
  name: "stop_monitor", title: "Stop a monitor",
  description: "Stop this chat's monitor_id: no more events are sent, and its command is stopped.",
  inputSchema: { type: "object", additionalProperties: false, required: ["monitor_id"], properties: { monitor_id: { type: "string", maxLength: 128 } } },
}]);
const MONITOR_TOOLS = new Set(MONITOR_TOOL_DEFS.map(tool => tool.name));

/** Claude Code's rule: a missing deadline is 5 minutes, one above 30 minutes is capped to 30. */
function monitorTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1000) throw new Error("timeout_ms must be an integer of at least 1000");
  return Math.min(value, MAX_TIMEOUT_MS);
}

/**
 * The events one delivery sends, from the complete stdout lines printed since the last one.
 * Every line costs the agent a read, and a chat that is busy can collect hundreds before the
 * next delivery, so the batch is shaped here before it reaches the chat.
 *
 * In: `lines`, the new lines in the order printed: none blank, each at most MAX_LINE characters.
 * Out: the strings to deliver, in order (an empty array sends nothing). The flood guard counts
 * what this returns, so a batch shaped smaller here also keeps a chatty monitor alive longer.
 *
 * A run of the same line (a poll loop printing "waiting" each tick) becomes one event that says how
 * many times it repeated; every distinct line is kept, in order. Runs are not joined across
 * deliveries, so a later count never arrives after newer lines.
 */
function batchLines(lines) {
  const events = [];
  let last = null;
  let repeats = 0;
  const close = () => { if (last !== null) events.push(repeats > 1 ? `${last} (repeated ${repeats} times)` : last); };
  for (const line of lines) {
    if (line === last) { repeats += 1; continue; }
    close();
    last = line;
    repeats = 1;
  }
  close();
  return events;
}

function createCommandMonitors({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const records = new Map();
  let disposed = false;
  const running = record => record.status === "running";
  const publicRecord = record => ({ monitor_id: record.id, description: record.description, command_id: record.commandId,
    status: record.status, events_sent: record.sent, started_at_ms: record.at, deadline_at_ms: record.deadline,
    ...(record.outcome ? { outcome: record.outcome } : {}) });

  function stopTimers(record) { clearTimer(record.timer); clearTimer(record.deadlineTimer); record.timer = null; }
  function end(record, outcome) {
    if (!running(record)) return;
    stopTimers(record);
    flushLines(record, true);
    record.status = outcome.kind;
    record.outcome = outcome;
    record.controller.abort();
    Promise.resolve().then(() => record.ticket?.end(outcome)).catch(() => {});
  }
  function cancel(record) {
    if (!running(record)) return false;
    stopTimers(record);
    record.status = "stopped";
    record.outcome = { kind: "stopped" };
    record.controller.abort();
    record.ticket?.cancel();
    return true;
  }
  /** Sends the complete lines collected so far (at the end, the unfinished last line too); returns how many events. */
  function flushLines(record, final = false) {
    if (final && record.partial) { record.lines.push(record.partial); record.partial = ""; }
    if (!record.lines.length) return 0;
    const lines = record.lines.splice(0).map(line => line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    const events = batchLines(lines);
    if (!Array.isArray(events) || !events.length) return 0;
    record.sent += events.length;
    record.recent.push({ at: now(), count: events.length });
    Promise.resolve().then(() => record.ticket?.emit(events)).catch(() => {});
    return events.length;
  }
  /** Whether the last minute's events exceed the flood limit. */
  function flooded(record) {
    const since = now() - FLOOD_WINDOW_MS;
    record.recent = record.recent.filter(item => item.at >= since);
    return record.recent.reduce((sum, item) => sum + item.count, 0) > FLOOD_EVENTS;
  }
  function arm(record, ms = POLL_MS) {
    record.timer = setTimer(() => { record.timer = null; void poll(record); }, ms);
    record.timer?.unref?.();
  }
  async function poll(record) {
    if (!running(record)) return;
    if (disposed || !record.active()) { cancel(record); return; }
    try {
      const read = await record.read(record.offset, record.controller.signal);
      if (!running(record)) return;
      record.failures = 0;
      if (read.gap) record.lines.push("[earlier output expired before it was read]");
      if (read.content) {
        const text = record.partial + read.content;
        const parts = text.split(/\r?\n/);
        record.partial = parts.pop() ?? "";
        record.lines.push(...parts.filter(line => line.trim()));
      }
      if (Number.isSafeInteger(read.nextOffset) && read.nextOffset >= record.offset) record.offset = read.nextOffset;
      flushLines(record);
      if (flooded(record)) {
        end(record, { kind: "flooded", note: `More than ${FLOOD_EVENTS} events in a minute: the monitor and its command were stopped. Re-arm it with a tighter filter (grep for only the lines you would act on).` });
        return;
      }
      if (read.content) { arm(record, 1); return; } // more may be waiting: read again at once
      if (!["running", "terminating"].includes(read.status)) {
        end(record, { kind: "exited", status: read.status ?? "exited", exit_code: Number.isInteger(read.exitCode) ? read.exitCode : null });
        return;
      }
    } catch {
      if (!running(record)) return;
      if (++record.failures >= 3) { end(record, { kind: "failed", note: "The command's output could not be read after three tries; the monitor stopped. The command may still run: check it with list_commands." }); return; }
    }
    arm(record);
  }
  async function start({ owner, description, timeoutMs, commandId, active, read, prepare }) {
    if (disposed) throw new Error("Monitors are unavailable");
    if (typeof description !== "string" || !description.trim() || description.length > 200) throw new Error("description must contain 1 to 200 characters");
    const live = [...records.values()].filter(running);
    if (live.filter(record => record.owner === owner).length >= MAX_PER_CHAT || live.length >= MAX_TOTAL) throw new Error("Too many running monitors; stop one first");
    while (records.size >= 256) {
      const oldest = [...records.values()].find(record => !running(record));
      if (!oldest) throw new Error("Monitor retention is full");
      records.delete(oldest.id);
    }
    const record = { id: `monitor-${crypto.randomUUID()}`, owner, description: description.trim(), commandId, at: now(), deadline: now() + timeoutMs,
      status: "running", sent: 0, recent: [], offset: 0, partial: "", lines: [], failures: 0, active, read, controller: new AbortController() };
    record.ticket = await prepare(record);
    if (typeof record.ticket?.emit !== "function" || typeof record.ticket?.end !== "function" || typeof record.ticket?.cancel !== "function") throw new Error("Monitor delivery is unavailable");
    records.set(record.id, record);
    record.deadlineTimer = setTimer(() => end(record, { kind: "expired", note: `The monitor's ${Math.round(timeoutMs / 60_000)}-minute deadline passed and its command was stopped. Re-arm it with monitor if you still need the watch.` }), timeoutMs);
    record.deadlineTimer?.unref?.();
    arm(record, 1);
    return publicRecord(record);
  }
  return { start,
    list: owner => [...records.values()].filter(record => record.owner === owner).map(publicRecord),
    stop: (owner, id) => { const record = records.get(id); return record?.owner === owner ? cancel(record) : false; },
    commandOf: (owner, id) => { const record = records.get(id); return record?.owner === owner ? record.commandId : null; },
    cancelOwner: owner => { for (const record of records.values()) if (record.owner === owner) cancel(record); },
    close: () => { disposed = true; for (const record of records.values()) cancel(record); records.clear(); },
  };
}

module.exports = { createCommandMonitors, monitorTimeout, batchLines, MONITOR_TOOL_DEFS, MONITOR_TOOLS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
