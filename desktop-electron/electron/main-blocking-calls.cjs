"use strict";

// Names what held the main process when it stalls. launcher.main_stalled says that every window
// froze, and for how long, but not why: most stalls on the user's machine (60 since 10-27, up to
// 144 s) used almost no CPU, so main sat in a synchronous call, and two probes (2026-10-30) never
// caught one live. Every call that can hold the main thread that way passes through here: starting
// a process (Windows runs CreateProcess on the caller, and an antivirus scan of the program makes
// that seconds) and the synchronous file calls (the app's drive is a busy, nearly full HDD). One
// that holds main for SLOW_MS or more is reported with what it touched and who called it.
//
// Socket calls too. libuv makes sockets non-blocking, yet on 2026-11-03, after Bitdefender's
// service restarted, main sat 70 s and 21 s in a native stream write and 76-122 s in closes of
// pending connects, with 0.2 s of CPU each: a network filter held the call in the kernel. The
// stall probe saw only Node's frames, never the endpoint. Every write (TCP, TLS and pipes) passes
// through Socket#_writeGeneric, and every connect and close through the native handle methods.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { ChildProcess } = require("node:child_process");

const SLOW_MS = 250;
const FS_CALLS = [
  "readFileSync", "writeFileSync", "appendFileSync", "statSync", "lstatSync", "readdirSync", "existsSync",
  "openSync", "readSync", "writeSync", "fsyncSync", "closeSync", "renameSync", "copyFileSync", "mkdirSync",
  "rmSync", "unlinkSync", "realpathSync",
];
// Reports kept until the logger exists (the watch starts before main.cjs creates it).
const MAX_EARLY = 50;
// One report per operation and calling site in this window; the stall event still carries the latest.
const REPEAT_MS = 10_000;

const here = __filename;
function callerOf(stack) {
  return String(stack || "").split("\n").slice(1)
    .map((line) => line.trim().replace(/^at /u, ""))
    .filter((line) => !line.includes(here) && !line.includes("node:"))
    // Six frames: with three, a 26 s statSync of config.json ended at a helper 13 paths share
    // (RuntimeHost.runtimeConfigSnapshot, 2026-10-31), and which one froze the app stayed unknown.
    .slice(0, 6)
    .map((line) => line.replace(/\(?(?:[A-Za-z]:)?[^():]*[\\/]([^\\/():]+:\d+):\d+\)?/u, "$1"))
    .join(" < ");
}
const targetOf = (value) => (typeof value === "string" ? path.basename(value)
  : value instanceof URL ? path.basename(value.pathname) : typeof value === "number" ? `fd ${value}` : "");

// The native socket handles. process.binding is the only way to their shared prototypes; where it
// is gone, socket calls are simply not watched.
function socketHandles() {
  try {
    const TCP = process.binding("tcp_wrap").TCP.prototype;
    const Pipe = process.binding("pipe_wrap").Pipe.prototype;
    return { TCP, Pipe, HandleWrap: Object.getPrototypeOf(Object.getPrototypeOf(TCP)) };
  } catch {
    return null;
  }
}
// Where a socket goes, from what is already known: asking the kernel (getpeername) right after it
// held a call could be held the same way. An HTTP request names its method and path, never its query.
function socketTarget(socket, connected) {
  try {
    // A TLS socket's handle wraps the TCP handle that connected.
    const peer = connected.get(socket._handle) ?? connected.get(socket._handle?._parent)
      ?? (socket._peername?.address ? `${socket._peername.address}:${socket._peername.port}` : "");
    const host = socket.servername || socket._host;
    const request = socket._httpMessage;
    return [host && !peer.startsWith(`${host}:`) ? host : "", peer || (socket.server ? "accepted" : ""),
      request?.method && typeof request.path === "string" ? `${request.method} ${request.path.split("?")[0]}` : ""]
      .filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

function installBlockingCallWatch({ slowMs = SLOW_MS, now = () => performance.now(), clock = () => Date.now() } = {}) {
  let report = null;
  let reporting = false;
  let latest = null;
  const early = [];
  const lastSent = new Map();
  const restore = [];

  const record = (op, target, ms, stack) => {
    const entry = { op, target, ms: Math.round(ms), caller: callerOf(stack), at: clock() };
    latest = entry;
    // The blocking site itself (first frame), wherever it was called from. A socket call made from
    // Node's own code alone (fetch, an HTTP request's flush) has no caller: its endpoint is the site.
    const key = `${op} ${entry.caller.split(" < ")[0] || target}`;
    if (clock() - (lastSent.get(key) ?? -Infinity) < REPEAT_MS) return;
    lastSent.set(key, clock());
    if (!report) { if (early.length < MAX_EARLY) early.push(entry); return; }
    // The report itself may write synchronously (the logger's exit flush): never measure that.
    reporting = true;
    try { report(entry); } catch {} finally { reporting = false; }
  };
  const wrap = (owner, name, op, targetFromArgs, before = null) => {
    const original = owner[name];
    if (typeof original !== "function") return null;
    const wrapped = function (...args) {
      // A diagnostic never fails the call it watches.
      if (before) try { before.call(this, args); } catch {}
      if (reporting) return original.apply(this, args);
      const started = now();
      try { return original.apply(this, args); }
      finally {
        const ms = now() - started;
        if (ms >= slowMs) record(op, targetFromArgs.call(this, args), ms, new Error().stack);
      }
    };
    Object.assign(wrapped, original);
    owner[name] = wrapped;
    restore.push(() => { owner[name] = original; });
    return wrapped;
  };

  wrap(ChildProcess.prototype, "spawn", "spawn", (args) => targetOf(args[0]?.file));
  for (const name of FS_CALLS) {
    const native = fs[name]?.native;
    const wrapped = wrap(fs, name, name, (args) => targetOf(args[0]));
    if (wrapped && typeof native === "function") {
      wrapped.native = function (...args) {
        if (reporting) return native.apply(this, args);
        const started = now();
        try { return native.apply(this, args); }
        finally {
          const ms = now() - started;
          if (ms >= slowMs) record("realpathSync.native", targetOf(args[0]), ms, new Error().stack);
        }
      };
    }
  }

  // Each native handle's endpoint, kept from its connect for its writes and its close.
  const connected = new WeakMap();
  wrap(net.Socket.prototype, "_writeGeneric", "socket.write", function () { return socketTarget(this, connected); });
  const handles = socketHandles();
  if (handles) {
    const tcpTarget = (args) => `${args[1]}:${args[2]}`;
    const remember = (targetFromArgs) => function (args) { connected.set(this, targetFromArgs(args)); };
    for (const name of ["connect", "connect6"]) {
      wrap(handles.TCP, name, "socket.connect", tcpTarget, remember(tcpTarget));
    }
    const pipeTarget = (args) => `pipe ${path.basename(String(args[1]))}`;
    wrap(handles.Pipe, "connect", "socket.connect", pipeTarget, remember(pipeTarget));
    // Every handle closes here (file watchers' and processes' too); a socket is named by its connect.
    wrap(handles.HandleWrap, "close", "handle.close", function () { return connected.get(this) ?? this?.constructor?.name ?? ""; });
  }

  return {
    /** Starts reporting (and sends what was held back) through `send(entry)`. */
    attach(send) {
      report = send;
      for (const entry of early.splice(0)) { reporting = true; try { send(entry); } catch {} finally { reporting = false; } }
    },
    /** The latest slow call, if it ended at or after `since` (epoch ms), else null. */
    latestSince(since) { return latest && latest.at >= since ? latest : null; },
    uninstall() { for (const undo of restore.splice(0).reverse()) undo(); },
  };
}

module.exports = { installBlockingCallWatch, callerOf, SLOW_MS };
