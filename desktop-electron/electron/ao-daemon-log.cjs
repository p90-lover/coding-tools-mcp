"use strict";

const { TextDecoder } = require("node:util");

/**
 * Which AO daemon output lines the launcher keeps (in memory; AO's output is never written to disk).
 * AO logs at debug level and writes an access line for every request, and the chat polls a working
 * conversation several times a second: 84% of its output is "GET … status=200" lines and 15% debug
 * lines. What is kept explains a failure or a lost turn: info and above, every write, every error
 * status and any slow read.
 */
const SLOW_REQUEST_MS = 1000;
// A line this long with no newline yet is passed on as it is rather than held without bound.
const MAX_PARTIAL_LINE = 64 * 1024;

const DURATION_UNIT_MS = { h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, "µs": 0.001, "μs": 0.001, ns: 0.000001 };

/** A Go time.Duration as printed by slog ("1.0482ms", "523.4µs", "2m3.5s"), in ms; NaN when not one. */
function goDurationMs(text) {
  const value = String(text || "");
  const parts = value.match(/(\d+(?:\.\d+)?)(ms|us|µs|μs|ns|h|m|s)/g);
  if (!parts || parts.join("") !== value) return Number.NaN;
  return parts.reduce((sum, part) => {
    const [, number, unit] = /^(\d+(?:\.\d+)?)(.+)$/.exec(part);
    return sum + Number(number) * DURATION_UNIT_MS[unit];
  }, 0);
}

/** Whether one daemon output line (no newline) is kept. */
function keepsDaemonLogLine(line) {
  if (/^time=\S+ level=DEBUG /.test(line)) return false;
  if (!line.includes(' msg="http request" ')) return true;
  const method = /\bmethod=(\S+)/.exec(line)?.[1];
  if (method !== "GET" && method !== "HEAD") return true;
  const status = Number(/\bstatus=(\d+)/.exec(line)?.[1]);
  if (!(status >= 200 && status < 400)) return true;
  // An unreadable duration is kept: the line is then not known to be a quick poll.
  const duration = goDurationMs(/\bduration=(\S+)/.exec(line)?.[1]);
  return !(duration < SLOW_REQUEST_MS);
}

/** slog's text form as fields: `key=value` pairs, a value with spaces quoted with `\"` escapes. */
function slogFields(line) {
  const fields = {};
  for (const [, key, raw] of String(line).trimEnd().matchAll(/(?:^|\s)([\w.]+)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
    fields[key] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
  }
  return fields;
}

// A start stage this long is reported. A healthy start's stages take milliseconds, except the
// agent handshake (controller_start), which takes a few seconds.
const SLOW_STAGE_MS = 5000;

/**
 * The launcher log event (memory only) an AO line makes, or null. A chat that read "waiting for
 * the agent to take the message" for four minutes (2026-11-09) could not be explained afterwards:
 * AO had said which store method held its one database writer, and how long each stage of the
 * agent's start took, but those lines stayed in the in-memory tail nothing reads. Two kinds go to
 * the launcher log, where a slow chat start is looked into: AO's writer report (at most one a
 * minute) and a start stage that took SLOW_STAGE_MS or more.
 */
function daemonLogEvent(line) {
  const writer = line.includes('msg="sqlite writer held while writes wait"');
  if (!writer && !line.includes('msg="spawn: asynchronous chat stage"')) return null;
  const fields = slogFields(line);
  if (writer) {
    return { level: "warn", event: "ao.writer_held", detail: { heldMs: Math.round(goDurationMs(fields.held)) || null,
      waiting: Number(fields.waiting) || 0, holder: String(fields.holder ?? "").slice(0, 400) } };
  }
  const ms = goDurationMs(fields.duration);
  if (!(ms >= SLOW_STAGE_MS)) return null;
  return { level: "info", event: "ao.start_stage_slow",
    detail: { session: String(fields.sessionID ?? "").slice(0, 128), stage: String(fields.stage ?? "").slice(0, 40), ms: Math.round(ms) } };
}

/**
 * Splits one output stream into lines and passes the kept ones to `write`. Chunks do not end on
 * line boundaries, so each stream needs its own filter.
 */
function createDaemonLogFilter(write) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let partial = "";
  const emit = (lines) => {
    const kept = lines.filter(keepsDaemonLogLine);
    if (kept.length) write(`${kept.join("\n")}\n`);
  };
  return {
    push(chunk) {
      if (chunk === "") return;
      const text = typeof chunk === "string" ? decoder.decode() + chunk : decoder.decode(chunk, { stream: true });
      const lines = (partial + text).split("\n");
      partial = lines.pop();
      if (partial.length > MAX_PARTIAL_LINE) { lines.push(partial); partial = ""; }
      emit(lines);
    },
    flush() {
      partial += decoder.decode();
      if (partial) emit([partial]);
      partial = "";
    },
  };
}

// How often the same AO failure is put in the launcher log, and how many different ones are tracked.
const FAILURE_REPEAT_MS = 60_000;
const FAILURE_KINDS = 200;
const short = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * AO's own failures as launcher log events (memory only): `(line) => event | null`.
 *
 * AO hides a failure's cause from its answer ("Internal server error") and writes it only to its
 * output: the request line of a 5xx carries `error=`, and what AO could not do is a WARN or ERROR
 * line. The launcher kept those lines in a tail nothing reads, so `ao.idle_release_failed
 * {"code":"INTERNAL_ERROR"}` (2026-11-11) could not be explained afterwards. They are now events:
 * `ao.request_failed` for a 5xx request, `ao.daemon_warning` and `ao.daemon_error` for the rest.
 * The same failure (same message, or same method, route and status) is reported at most once a
 * minute, with how many repeats it stood for, so a loop cannot fill the log's 300 records.
 */
function createDaemonFailureEvents({ now = Date.now } = {}) {
  const seen = new Map(); // kind -> { at, repeats }
  const admit = (kind) => {
    const known = seen.get(kind), at = now();
    if (known && at - known.at < FAILURE_REPEAT_MS) { known.repeats += 1; return null; }
    const repeats = known?.repeats ?? 0;
    seen.delete(kind);
    seen.set(kind, { at, repeats: 0 });
    if (seen.size > FAILURE_KINDS) seen.delete(seen.keys().next().value);
    return repeats;
  };
  return (line) => {
    const level = /^time=\S+ level=(\w+) /.exec(line)?.[1] ?? /^level=(\w+) /.exec(line)?.[1];
    if (!level) return null;
    if (line.includes(' msg="http request" ')) {
      const fields = slogFields(line);
      const status = Number(fields.status);
      if (!(status >= 500)) return null;
      // One kind per route, not per session: ids in the path are folded.
      const route = short(fields.path, 200).replace(/\/[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/g, "/:id");
      const repeats = admit(`request ${fields.method} ${route} ${status}`);
      if (repeats === null) return null;
      return { level: "warn", event: "ao.request_failed", detail: { method: short(fields.method, 8), path: short(fields.path, 200), status,
        ms: Math.round(goDurationMs(fields.duration)) || null, error: short(fields.error, 400), ...(repeats ? { repeats } : {}) } };
    }
    if (level !== "WARN" && level !== "ERROR") return null;
    // The writer report has its own event (daemonLogEvent).
    if (line.includes('msg="sqlite writer held while writes wait"')) return null;
    const fields = slogFields(line);
    const message = short(fields.msg, 160);
    const repeats = admit(`${level} ${message}`);
    if (repeats === null) return null;
    const { time, level: ignored, msg, ...rest } = fields;
    const detail = { message };
    for (const [key, value] of Object.entries(rest).slice(0, 8)) detail[short(key, 40)] = short(value, key === "error" || key === "err" ? 400 : 160);
    return { level: "warn", event: level === "ERROR" ? "ao.daemon_error" : "ao.daemon_warning", detail: { ...detail, ...(repeats ? { repeats } : {}) } };
  };
}

module.exports = { createDaemonLogFilter, keepsDaemonLogLine, goDurationMs, daemonLogEvent, createDaemonFailureEvents, SLOW_STAGE_MS };
