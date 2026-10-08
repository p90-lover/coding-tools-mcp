"use strict";
// Live AO session changes from the daemon's CDC feed (GET /api/v1/events, server-sent events).
// AO's own renderer refreshes a chat from this feed instead of polling; Coding Tools uses it the
// same way, to wake the mission loop and the chat as soon as a role's turn moves.
const http = require("node:http");

// A cursor past the head makes the daemon start at the head, so a new connection does not
// replay the whole change log (tens of thousands of events on a long-lived install).
const FROM_HEAD = "9007199254740991";
const MAX_FRAME = 64 * 1024;

/** Splits buffered SSE text into complete frames; returns the frames and the unfinished rest. */
function parseSseFrames(buffer) {
  const frames = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  for (let end = rest.indexOf("\n\n"); end !== -1; end = rest.indexOf("\n\n")) {
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const frame = { id: "", event: "", data: "" };
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") frame.data = frame.data ? `${frame.data}\n${value}` : value;
      else if (field === "id" || field === "event") frame[field] = value;
    }
    if (frame.data || frame.event) frames.push(frame);
  }
  // A frame that never ends is not SSE; drop it rather than grow without bound.
  return { frames, rest: rest.length > MAX_FRAME ? "" : rest };
}

/** The session change a CDC frame describes, or null when it names no session. */
function sessionChange(frame) {
  let decoded;
  try { decoded = JSON.parse(frame.data); } catch { return null; }
  const sessionId = decoded?.sessionId;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return null;
  const payload = decoded.payload && typeof decoded.payload === "object" ? decoded.payload : {};
  return {
    sessionId,
    type: String(decoded.type || frame.event || "").slice(0, 64),
    // Conversation rows (messages, reasoning, tool calls) carry their conversation id; a bare
    // session_updated is an activity-state change such as working -> idle.
    conversation: typeof payload.conversationId === "string" && payload.conversationId !== "",
  };
}

function createAoSessionEvents({ port, logger = console, get = http.get, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const listeners = new Set();
  let request = null;
  let retryTimer = null;
  let cursor = FROM_HEAD;
  let failures = 0;
  let connecting = false;

  function emit(change) {
    for (const listener of [...listeners]) {
      try { listener(change); } catch (error) { logger.warn?.(`AO session listener failed: ${error?.message || error}`); }
    }
  }

  function retry() {
    request = null;
    if (!listeners.size || retryTimer) return;
    failures += 1;
    retryTimer = setTimer(() => { retryTimer = null; void connect(); }, Math.min(10_000, 500 * 2 ** Math.min(failures, 5)));
  }

  async function connect() {
    if (request || connecting || !listeners.size) return;
    let daemonPort;
    connecting = true;
    try { daemonPort = await port(); } catch { connecting = false; retry(); return; }
    connecting = false;
    if (request || !listeners.size) return;
    if (!Number.isInteger(daemonPort) || daemonPort < 1 || daemonPort > 65535) { retry(); return; }
    const current = get({
      host: "127.0.0.1", port: daemonPort, path: `/api/v1/events?after=${cursor}`,
      headers: { accept: "text/event-stream" },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); current.destroy(); return; }
      failures = 0;
      response.setEncoding("utf8");
      let buffer = "";
      response.on("data", chunk => {
        const parsed = parseSseFrames(buffer + chunk);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          if (/^\d{1,16}$/.test(frame.id)) cursor = frame.id;
          const change = sessionChange(frame);
          if (change) emit(change);
        }
      });
      response.on("end", () => current.destroy());
    });
    request = current;
    current.on("error", () => {});
    current.on("close", () => { if (request === current) retry(); });
  }

  return {
    /** Calls listener({ sessionId, type, conversation }) for each live change; returns unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      void connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
        const current = request; request = null; current?.destroy();
        // The next subscriber starts at the head again; nobody was listening in between.
        cursor = FROM_HEAD;
      };
    },
  };
}

/**
 * Batches session and run changes into one renderer notification per window. The first change
 * after a quiet window goes out at once; a burst (a streaming answer revises its message many
 * times a second) is folded into one trailing notification, as AO's renderer does.
 */
function createChangePulse(publish, { windowMs = 150, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const sessions = new Set();
  const runs = new Set();
  let timer = null;
  let lastAt = -Infinity;
  function flush() {
    timer = null; lastAt = now();
    if (!sessions.size && !runs.size) return;
    const payload = { sessions: [...sessions], runs: [...runs] };
    sessions.clear(); runs.clear();
    try { publish(payload); } catch { /* the window may be closing */ }
  }
  function schedule() {
    if (timer) return;
    const wait = windowMs - (now() - lastAt);
    if (wait <= 0) flush();
    else timer = setTimer(flush, wait);
  }
  return {
    session(sessionId) { if (typeof sessionId === "string") { sessions.add(sessionId); schedule(); } },
    run(workspaceId, runId) { if (typeof runId === "string") { runs.add(`${workspaceId}:${runId}`); schedule(); } },
    stop() { if (timer) clearTimer(timer); timer = null; sessions.clear(); runs.clear(); },
  };
}

module.exports = { createAoSessionEvents, createChangePulse, parseSseFrames, sessionChange };
