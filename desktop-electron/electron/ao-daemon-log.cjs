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

module.exports = { createDaemonLogFilter, keepsDaemonLogLine, goDurationMs, daemonLogEvent, SLOW_STAGE_MS };
