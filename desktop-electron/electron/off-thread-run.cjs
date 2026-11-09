"use strict";

const { execFile, spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const { PassThrough, Readable, Writable } = require("node:stream");
const { Worker } = require("node:worker_threads");

/**
 * Starting a process on Windows holds the thread that starts it until the program is loaded, and an
 * antivirus scan of the program makes that seconds: the tunnel CLI's status probe, started once a
 * second while the tunnel came up, held the main process (every window) for 5.5 s of a 7 s stall
 * (profiled live 2026-10-29, Bitdefender reading 37 MB/s after an install). runOffThread starts the
 * program from a worker thread instead, as agent-orchestrator-workspace.cjs does for git, and runs
 * it directly when no worker can be started.
 */

/**
 * The one implementation, run in the worker (as its source) or here as the fallback. Calls `done`
 * once with { code, stdout, stderr }, { timedOut: true } or { error }; each stream keeps at most
 * `maxBytes`. A timeout ends the whole process tree.
 */
function runChild({ file, args, cwd, env, timeoutMs, maxBytes }, spawn, execFile, done) {
  const windows = process.platform === "win32";
  let child;
  try {
    child = spawn(file, args, { cwd, env, detached: !windows, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    done({ error: String((error && error.message) || error) });
    return;
  }
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const capture = (name) => (chunk) => {
    const room = maxBytes - sizes[name];
    if (room <= 0) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    chunks[name].push(part);
    sizes[name] += part.length;
  };
  child.stdout.on("data", capture("stdout"));
  child.stderr.on("data", capture("stderr"));
  let settled = false;
  let timedOut = false;
  let grace = null;
  const finish = (reply) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(grace);
    done(reply);
  };
  // A timeout ends the tree and is reported once the program has closed (or 5 s on), as the main
  // process's own control commands wait for theirs: until then it still holds its folder.
  const timer = setTimeout(() => {
    timedOut = true;
    if (windows) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    grace = setTimeout(() => finish({ timedOut: true }), 5_000);
  }, timeoutMs);
  child.once("error", (error) => finish(timedOut ? { timedOut: true } : { error: String((error && error.message) || error) }));
  child.once("close", (code) => finish(timedOut ? { timedOut: true } : {
    code: code ?? 1,
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
  }));
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { spawn, execFile } = require("node:child_process");
const runChild = ${runChild.toString()};
parentPort.on("message", ({ id, request }) => runChild(request, spawn, execFile, (reply) => parentPort.postMessage({ id, reply })));`;

let worker = null;
let workerBroken = false;
let calls = 0;
const pending = new Map();

function runHere(request) {
  return new Promise((resolve) => runChild(request, spawn, execFile, resolve));
}

function startWorker() {
  const started = new Worker(WORKER_SOURCE, { eval: true });
  started.unref();
  started.on("message", ({ id, reply }) => {
    const call = pending.get(id);
    pending.delete(id);
    // Held only while a program runs, so an idle worker never keeps the process from exiting.
    if (!pending.size) started.unref();
    call?.resolve(reply);
  });
  const stopped = () => {
    if (worker !== started) return;
    worker = null;
    workerBroken = true;
    // Whatever it had not answered runs here.
    const unanswered = [...pending.values()];
    pending.clear();
    for (const call of unanswered) runHere(call.request).then(call.resolve);
  };
  started.on("error", stopped);
  started.on("exit", stopped);
  return started;
}

/**
 * Runs `file` with `args` and resolves { code, stdout, stderr }, { timedOut: true } or { error };
 * it never rejects. `env`, when given, replaces the program's environment.
 */
function runOffThread({ file, args = [], cwd, env, timeoutMs, maxBytes = 1024 * 1024 }) {
  const request = { file, args, cwd, env, timeoutMs, maxBytes };
  if (workerBroken) return runHere(request);
  try {
    worker ??= startWorker();
  } catch {
    workerBroken = true;
    return runHere(request);
  }
  return new Promise((resolve) => {
    const id = ++calls;
    pending.set(id, { request, resolve });
    worker.ref();
    worker.postMessage({ id, request });
  });
}

/**
 * Starts `file` once from the worker with harmless `args` (e.g. --help) and waits for it to exit, so
 * that a long-lived child this thread must start itself (it owns its pipes and exit) finds the
 * program already loaded and scanned. Windows' load and the antivirus scan of a fresh program are
 * what hold the starting thread. Resolves whether or not the program ran; never rejects.
 */
async function warmProgram(file, args = [], timeoutMs = 30_000, run = runOffThread) {
  await run({ file, args, timeoutMs, maxBytes: 4096 });
}

/*
 * Long-lived children. warmProgram only loads the program first, and the start that follows on this
 * thread still waits for Windows to create the process: 13-48 s each on the busy hard disk while the
 * antivirus scanned bun.exe and ao-daemon.exe (launcher.main_blocked on 0.8.40, 2026-11-01: the
 * runtime's setup after a Browser sign-in held every window 47.8 s). spawnOffThread starts the
 * program in a worker that keeps it, and hands back a child that looks like one started here: its
 * pid, exitCode and signalCode, stdout and stderr as streams, stdin, kill() and the error, exit and
 * close events. Where no worker can start it falls back to spawn() on this thread.
 *
 * Output is relayed with a window: at most OUTPUT_WINDOW_BYTES of a stream wait for this thread to
 * take them, then the worker stops reading and the program waits on its full pipe, as it does for a
 * parent started here that is busy. Without it the worker read on while main was held: 0.8.49's main
 * process grew to 11.3 GB during a 408 s stall (2026-11-02 08:24, 7 s of CPU), then spent 63 s of
 * CPU on the backlog. This thread tells the worker what it took once per turn of its loop.
 */
const OUTPUT_WINDOW_BYTES = 1024 * 1024;
const SPAWN_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const children = new Map();
const flows = new Map();
const post = (message) => parentPort.postMessage(message);
const describe = (error) => ({ message: String((error && error.message) || error), code: error && error.code });
parentPort.on("message", (message) => {
  const { id } = message;
  if (message.type === "spawn") {
    let child;
    try {
      child = spawn(message.file, message.args, message.options);
    } catch (error) {
      post({ type: "spawned", id, pid: null });
      post({ type: "error", id, error: describe(error) });
      return;
    }
    children.set(id, child);
    post({ type: "spawned", id, pid: Number.isInteger(child.pid) ? child.pid : null });
    for (const stream of ["stdout", "stderr"]) {
      const source = child[stream];
      if (!source) continue;
      let untaken = 0;
      flows.set(id + ":" + stream, (bytes) => {
        untaken -= bytes;
        if (untaken <= ${OUTPUT_WINDOW_BYTES / 2} && source.isPaused()) source.resume();
      });
      source.on("data", (chunk) => {
        untaken += chunk.length;
        post({ type: "data", id, stream, chunk });
        if (untaken >= ${OUTPUT_WINDOW_BYTES}) source.pause();
      });
      source.on("end", () => post({ type: "end", id, stream }));
      source.on("error", (error) => post({ type: "stream-error", id, stream, error: describe(error) }));
    }
    child.stdin?.on("error", (error) => post({ type: "stream-error", id, stream: "stdin", error: describe(error) }));
    child.on("error", (error) => post({ type: "error", id, error: describe(error) }));
    child.on("exit", (code, signal) => post({ type: "exit", id, code, signal }));
    child.on("close", (code, signal) => {
      children.delete(id);
      flows.delete(id + ":stdout");
      flows.delete(id + ":stderr");
      post({ type: "close", id, code, signal });
    });
    if (message.unref) child.unref();
  } else if (message.type === "taken") {
    flows.get(id + ":" + message.stream)?.(message.bytes);
  } else if (message.type === "kill") {
    let sent = false;
    try { sent = children.get(id)?.kill(message.signal) ?? false; } catch {}
    post({ type: "killed", id, sent });
  } else if (message.type === "write") {
    const stdin = children.get(id)?.stdin;
    if (!stdin) { post({ type: "written", id, seq: message.seq, error: { message: "stdin is closed" } }); return; }
    stdin.write(Buffer.from(message.chunk), (error) => post({ type: "written", id, seq: message.seq, error: error ? describe(error) : null }));
  } else if (message.type === "end") {
    children.get(id)?.stdin?.end();
  }
});`;

const asError = ({ message, code }) => Object.assign(new Error(message), code ? { code } : {});

/** A child started in the spawn worker, as this thread sees it. */
class OffThreadChild extends EventEmitter {
  constructor(id, send, stdio) {
    super();
    this.id = id;
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.send = send;
    const piped = (index) => stdio[index] === "pipe";
    this.stdout = piped(1) ? new PassThrough() : null;
    this.stderr = piped(2) ? new PassThrough() : null;
    this.writes = new Map();
    let seq = 0;
    this.stdin = piped(0) ? new Writable({
      write: (chunk, _encoding, done) => {
        const at = ++seq;
        this.writes.set(at, done);
        send({ type: "write", id, seq: at, chunk });
      },
      final: (done) => { send({ type: "end", id }); done(); },
    }) : null;
    // Events wait for the caller that awaited the start to attach its listeners, and keep their
    // order: exit before close, output before both.
    this.queue = Promise.resolve();
    this.untold = { stdout: 0, stderr: 0 };
    this.telling = false;
  }

  /** Counts output this thread has taken and tells the worker once per turn (OUTPUT_WINDOW_BYTES). */
  taken(stream, bytes) {
    this.untold[stream] += bytes;
    if (this.telling) return;
    this.telling = true;
    setImmediate(() => {
      this.telling = false;
      for (const name of ["stdout", "stderr"]) {
        if (!this.untold[name]) continue;
        this.send({ type: "taken", id: this.id, stream: name, bytes: this.untold[name] });
        this.untold[name] = 0;
      }
    });
  }

  later(action) {
    this.queue = this.queue.then(() => new Promise((resolve) => setImmediate(() => { action(); resolve(); })));
  }

  receive(message) {
    switch (message.type) {
      case "data":
        this[message.stream]?.write(Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength));
        this.taken(message.stream, message.chunk.byteLength);
        break;
      case "end": this.later(() => this[message.stream]?.end()); break;
      case "stream-error": this.later(() => this[message.stream]?.destroy(asError(message.error))); break;
      case "written": { const done = this.writes.get(message.seq); this.writes.delete(message.seq); done?.(message.error ? asError(message.error) : null); break; }
      case "error": this.later(() => this.emit("error", asError(message.error))); break;
      case "exit": this.later(() => { this.exitCode = message.code; this.signalCode = message.signal; this.emit("exit", message.code, message.signal); }); break;
      case "close": this.later(() => {
        if (this.exitCode === null && this.signalCode === null) { this.exitCode = message.code; this.signalCode = message.signal; }
        this.stdin?.destroy();
        this.emit("close", message.code, message.signal);
      }); break;
      default: break;
    }
  }

  /** The worker stopped: its pipes to this child are gone, as when a parent loses its child's. */
  lost() {
    for (const done of this.writes.values()) done(new Error("The process start worker stopped"));
    this.writes.clear();
    this.later(() => {
      this.stdout?.end();
      this.stderr?.end();
      this.emit("error", new Error("The process start worker stopped; this program's output and exit are no longer seen"));
    });
  }

  kill(signal = "SIGTERM") {
    if (this.exitCode !== null || this.signalCode !== null || this.pid === undefined) return false;
    this.killed = true;
    this.send({ type: "kill", id: this.id, signal });
    return true;
  }

  // The worker never holds this process open (it is unref'ed), so these have nothing to change.
  ref() {}
  unref() {}
}

let spawnWorker = null;
let spawnWorkerBroken = false;
let spawnCalls = 0;
const spawned = new Map();

function startSpawnWorker(createWorker) {
  const started = createWorker(SPAWN_WORKER_SOURCE, { eval: true });
  started.on("message", (message) => {
    const entry = spawned.get(message.id);
    if (!entry) return;
    if (message.type === "spawned") {
      entry.child.pid = message.pid ?? undefined;
      entry.resolve(entry.child);
      return;
    }
    // A program that never started may send no close: its error ends it here.
    if (message.type === "close" || (message.type === "error" && entry.child.pid === undefined)) {
      spawned.delete(message.id);
      holdWhileRunning(started);
    }
    entry.child.receive(message);
  });
  const stopped = () => {
    if (spawnWorker !== started) return;
    spawnWorker = null;
    spawnWorkerBroken = true;
    const lost = [...spawned.values()];
    spawned.clear();
    for (const entry of lost) {
      // A start the worker never answered runs here; a running child is reported lost.
      if (entry.child.pid === undefined && !entry.started) entry.retry();
      else entry.child.lost();
    }
  };
  started.on("error", stopped);
  started.on("exit", stopped);
  // After the listeners: listening for messages refs the worker again, and then it would hold the
  // process open after its last child has gone.
  started.unref();
  return started;
}

/**
 * Like a child started here, a running child with pipes keeps this process alive; a persistent one
 * (detached, output discarded) does not, and neither does an idle worker.
 */
function holdWhileRunning(worker) {
  const piped = [...spawned.values()].some((entry) => !entry.persistent);
  if (piped) worker.ref();
  else worker.unref();
}

const WORKER_OPTION_KEYS = new Set(["cwd", "env", "detached", "windowsHide", "windowsVerbatimArguments", "shell", "argv0", "stdio"]);

/**
 * Options a worker can receive: plain data only (no streams or functions in stdio). Any other option
 * (a timeout, an AbortSignal, uid) starts the program here, where spawn() honours it.
 */
function workerOptions(options) {
  if (Object.keys(options).some((key) => options[key] !== undefined && !WORKER_OPTION_KEYS.has(key))) return null;
  const { cwd, env, detached, windowsHide, windowsVerbatimArguments, shell, argv0 } = options;
  const stdio = options.stdio ?? "pipe";
  const list = typeof stdio === "string" ? [stdio, stdio, stdio] : stdio;
  if (!Array.isArray(list) || list.some((entry) => !["pipe", "ignore", "inherit", null, undefined].includes(entry))) return null;
  if (shell !== undefined && typeof shell !== "boolean" && typeof shell !== "string") return null;
  const plain = { stdio: list.map((entry) => entry ?? "pipe") };
  for (const [key, value] of Object.entries({ cwd, env, detached, windowsHide, windowsVerbatimArguments, shell, argv0 })) {
    if (value !== undefined) plain[key] = value;
  }
  return plain;
}

/**
 * Starts `file` like child_process.spawn, from the spawn worker, and resolves the child once the
 * worker has started it (its pid known, or its error to follow). Never rejects: a start failure
 * arrives as the child's error event, as with spawn(). Options the worker cannot receive, or a
 * worker that cannot run, start it here instead.
 */
function spawnOffThread(file, args = [], options = {}, { createWorker = (source, workerOptions) => new Worker(source, workerOptions) } = {}) {
  const plain = workerOptions(options);
  const here = () => spawn(file, args, options);
  if (!plain || spawnWorkerBroken) return Promise.resolve(here());
  try {
    spawnWorker ??= startSpawnWorker(createWorker);
  } catch {
    spawnWorkerBroken = true;
    return Promise.resolve(here());
  }
  return new Promise((resolve) => {
    const id = ++spawnCalls;
    const send = (message) => spawnWorker?.postMessage(message);
    const child = new OffThreadChild(id, send, plain.stdio);
    // A persistent child (detached, its output discarded) need not keep either side's loop busy.
    const persistent = plain.detached === true && plain.stdio.every((entry) => entry !== "pipe");
    const entry = { child, persistent, started: false, resolve: (value) => { entry.started = true; resolve(value); }, retry: () => resolve(here()) };
    spawned.set(id, entry);
    holdWhileRunning(spawnWorker);
    spawnWorker.postMessage({ type: "spawn", id, file, args, options: plain, unref: persistent });
  });
}

/** For tests: forget the worker so the next start makes a new one. */
function resetSpawnWorker() {
  const worker = spawnWorker;
  spawnWorker = null;
  worker?.terminate?.();
  spawnWorkerBroken = false;
  spawned.clear();
}

/*
 * Folder watches. libuv answers each change Windows reports for a watched folder on the thread that
 * owns the watch, and for any change but a removal it first asks the disk for the file's long name
 * (GetLongPathNameW, one lookup per part of the path). The folders we watch hold the app's data on the
 * busy hard disk, so a change could hold the main process: 5.2 s with 16 ms of CPU on 2026-11-02, and
 * three of the day's six stall probes found main resuming in a watch callback. watchOffThread keeps
 * every watch in one worker and passes only the change on; where no worker can start, it watches here.
 */
const WATCH_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const watchers = new Map();
const describe = (error) => ({ message: String((error && error.message) || error), code: error && error.code });
parentPort.on("message", ({ type, id, directory }) => {
  if (type === "close") {
    const watcher = watchers.get(id);
    watchers.delete(id);
    try { if (watcher) watcher.close(); } catch {}
    return;
  }
  let watcher;
  try {
    watcher = fs.watch(directory, { persistent: false }, (event, name) => parentPort.postMessage({ id, event, name: name == null ? null : String(name) }));
  } catch (error) {
    parentPort.postMessage({ id, error: describe(error) });
    return;
  }
  watcher.on("error", (error) => { watchers.delete(id); parentPort.postMessage({ id, error: describe(error) }); });
  watchers.set(id, watcher);
  parentPort.postMessage({ id, armed: true });
});`;

let watchWorker = null;
let watchWorkerBroken = false;
let watchIds = 0;
const watches = new Map();

function startWatchWorker() {
  const started = new Worker(WATCH_WORKER_SOURCE, { eval: true });
  started.on("message", ({ id, event, name, armed, error }) => {
    const watch = watches.get(id);
    if (!watch) return;
    if (error) {
      watches.delete(id);
      watch.settle();
      if (watch.listenerCount("error")) watch.emit("error", Object.assign(new Error(error.message), { code: error.code }));
      return;
    }
    if (armed) {
      watch.settle();
      // A change made before the worker began watching was never reported: say something may have
      // changed, as a watch does when it cannot name the file.
      watch.listener("rename", null);
      return;
    }
    watch.listener(event, name);
  });
  const stopped = () => {
    if (watchWorker !== started) return;
    watchWorker = null;
    watchWorkerBroken = true;
    // Their owners close them on an error and watch again (here, from now on) or fall back to their
    // own slower checks, as for any watch that fails.
    const open = [...watches.values()];
    watches.clear();
    for (const watch of open) {
      watch.settle();
      if (watch.listenerCount("error")) watch.emit("error", new Error("The folder watch worker stopped"));
    }
  };
  started.on("error", stopped);
  started.on("exit", stopped);
  // After the listeners: adding a 'message' listener refs the worker again, and an earlier unref left
  // every process that watched a folder unable to exit (seen in tests: files hung until killed).
  started.unref();
  return started;
}

/**
 * Watches `directory` (not its subfolders) and calls `listener(eventType, fileName)` as fs.watch does;
 * fileName may be null. Returns a handle with close(), ref(), unref(), an 'error' event and `ready`, a
 * promise settled once the watch is in place or has failed. A folder that cannot be watched (missing)
 * reports 'error' rather than throwing. Unlike fs.watch it never keeps the process running.
 */
function watchOffThread(directory, listener, watchHere = fs.watch) {
  if (!watchWorkerBroken && !watchWorker) {
    try { watchWorker = startWatchWorker(); } catch { watchWorkerBroken = true; }
  }
  if (watchWorkerBroken) {
    const watcher = watchHere(directory, { persistent: false }, listener);
    watcher.ready = Promise.resolve();
    return watcher;
  }
  const id = ++watchIds;
  const handle = new EventEmitter();
  let settle;
  handle.ready = new Promise((resolve) => { settle = resolve; });
  handle.settle = () => settle();
  handle.listener = listener;
  handle.close = () => {
    handle.settle();
    if (watches.delete(id)) watchWorker?.postMessage({ type: "close", id });
  };
  handle.ref = () => handle;
  handle.unref = () => handle;
  watches.set(id, handle);
  watchWorker.postMessage({ type: "watch", id, directory });
  return handle;
}

/** For tests: forget the watch worker so the next watch starts a new one. */
function resetWatchWorker() {
  const worker = watchWorker;
  watchWorker = null;
  watches.clear();
  worker?.terminate?.();
  watchWorkerBroken = false;
}

/*
 * TCP reachability probes. libuv closes a socket on Windows with a synchronous closesocket(), and
 * closing one whose connect has not finished waits for whatever holds that connect. On 2026-11-03,
 * a minute after Bitdefender's Virus Shield service crashed and restarted (10:31-10:32), the MCP
 * events monitor's 30 s probe of the proxy port held the main process 76 s, 122 s and 89 s (0.2 s
 * of CPU each), every time inside such a close: twice in the one Node makes when the first of the
 * proxy's two addresses has not answered in 250 ms (happy eyeballs), once in the probe's own close
 * at its 3 s timeout. The same close takes 0.1 ms otherwise. probeTcpOffThread connects and closes
 * in a worker and answers here by its deadline even when the worker is held; where no worker can
 * start, it probes here.
 */
const PROBE_ANSWER_GRACE_MS = 1_000;

// A hostname with several addresses fails with an AggregateError whose message is empty; report the
// per-address codes (for example "EACCES 1.2.3.4") so a blocked or refused proxy is diagnosable from
// the Proxy page's test.
function connectErrorText(error) {
  if (!(error instanceof Error)) return String(error);
  const attempts = Array.isArray(error.errors)
    ? error.errors.map((item) => [item?.code, item?.address].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  if (attempts.length) return `Connection failed: ${attempts.join(", ")}`;
  return error.message || error.code || "Connection failed";
}

/**
 * The one implementation, run in the worker (as its source) or here as the fallback. Calls `done`
 * once with { ok: true, latencyMs } or { ok: false, code, message }.
 */
function probeTcp({ host, port, timeoutMs }, net, describe, done) {
  const started = Date.now();
  let settled = false;
  let socket = null;
  const finish = (reply) => {
    if (settled) return;
    settled = true;
    socket?.destroy();
    done(reply);
  };
  try {
    socket = net.connect({ host, port });
  } catch (error) {
    finish({ ok: false, code: error?.code || "EINVAL", message: describe(error) });
    return;
  }
  socket.setTimeout(timeoutMs, () => finish({ ok: false, code: "ETIMEDOUT", message: "Connection timed out" }));
  socket.once("connect", () => finish({ ok: true, latencyMs: Date.now() - started }));
  socket.once("error", (error) => finish({ ok: false, code: error?.code || error?.errors?.[0]?.code || "ECONNREFUSED", message: describe(error) }));
}

const PROBE_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const net = require("node:net");
const describe = ${connectErrorText.toString()};
const probeTcp = ${probeTcp.toString()};
parentPort.on("message", ({ id, request }) => {
  // A request that waited behind a held close was already answered by the caller: skip its connect.
  if (Date.now() >= request.deadline) return;
  probeTcp(request, net, describe, (reply) => parentPort.postMessage({ id, reply }));
});`;

let probeWorker = null;
let probeWorkerBroken = false;
let probeCalls = 0;
const probes = new Map();

function probeHere(request) {
  return new Promise((resolve) => probeTcp(request, net, connectErrorText, resolve));
}

function startProbeWorker(createWorker) {
  const started = createWorker(PROBE_WORKER_SOURCE, { eval: true });
  started.on("message", ({ id, reply }) => probes.get(id)?.settle(reply));
  const stopped = () => {
    if (probeWorker !== started) return;
    probeWorker = null;
    probeWorkerBroken = true;
    // Whatever it had not answered is probed here.
    for (const entry of probes.values()) probeHere(entry.request).then(entry.settle);
  };
  started.on("error", stopped);
  started.on("exit", stopped);
  // After the listeners, which ref it again: each probe's own deadline keeps the process up instead.
  started.unref();
  return started;
}

/**
 * Connects to `host`:`port` from the probe worker and resolves { ok: true, latencyMs } or
 * { ok: false, code, message } within `timeoutMs` and a second's grace; it never rejects.
 */
function probeTcpOffThread({ host, port, timeoutMs = 3_000 }, { createWorker = (source, options) => new Worker(source, options) } = {}) {
  const request = { host, port, timeoutMs, deadline: Date.now() + timeoutMs };
  if (probeWorkerBroken) return probeHere(request);
  try {
    probeWorker ??= startProbeWorker(createWorker);
  } catch {
    probeWorkerBroken = true;
    return probeHere(request);
  }
  return new Promise((resolve) => {
    const id = ++probeCalls;
    // The worker answers by the deadline unless it is held itself, in the close of an earlier probe.
    const timer = setTimeout(() => settle({ ok: false, code: "ETIMEDOUT", message: "Connection timed out" }), timeoutMs + PROBE_ANSWER_GRACE_MS);
    const settle = (reply) => {
      if (!probes.delete(id)) return;
      clearTimeout(timer);
      resolve(reply);
    };
    probes.set(id, { request, settle });
    probeWorker.postMessage({ id, request });
  });
}

/*
 * Loopback HTTP requests. The same day main also sat 70 s and 21 s inside a native socket write
 * (0.1 s of CPU each), and a count in the running app found it making about 1,700 writes a minute,
 * nearly all the chat's reads: of AO sessions and conversations from the AO daemon (17 a second
 * with two chats working) and of AO state through the headless service (11 a second). A filter that
 * holds any of those calls holds every window. fetchOffThread makes such a request from a worker
 * and answers here: by the caller's signal when the worker is held, as fetch itself would.
 */

/**
 * The one implementation, run in the worker (as its source) or here as the fallback. Resolves the
 * whole response as { status, statusText, headers, body } (body an ArrayBuffer), or { tooLarge: true }
 * once more than `maxBytes` arrived; rejects as fetch does.
 */
async function fetchWhole(fetch, { url, init, maxBytes }, signal) {
  const response = await fetch(url, { ...init, signal });
  const chunks = [];
  let size = 0;
  // Leaving the loop early cancels the rest of the body.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (maxBytes !== null && size > maxBytes) return { tooLarge: true };
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: response.status, statusText: response.statusText, headers: [...response.headers], body: body.buffer };
}

/** What crosses back from the worker of a failed fetch: names, messages and codes, with its cause. */
function plainError(error) {
  const plain = (value) => {
    const fields = { name: String((value && value.name) || "Error"), message: String((value && value.message) || value) };
    for (const key of ["code", "errno", "syscall", "address", "port"]) if (value && value[key] !== undefined) fields[key] = value[key];
    return fields;
  };
  return error && error.cause ? { ...plain(error), cause: plain(error.cause) } : plain(error);
}

const FETCH_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const fetchWhole = ${fetchWhole.toString()};
const plainError = ${plainError.toString()};
const requests = new Map();
parentPort.on("message", ({ id, request, cancel }) => {
  if (cancel) {
    const entry = requests.get(id);
    if (entry) { entry.cancelled = true; entry.controller.abort(); }
    return;
  }
  const entry = { cancelled: false, controller: new AbortController() };
  requests.set(id, entry);
  // Started after the messages already queued: one whose caller gave up while this thread was held
  // is followed by its cancel, and is dropped before it connects or sends.
  setImmediate(() => {
    if (entry.cancelled) { requests.delete(id); return; }
    fetchWhole(fetch, request, entry.controller.signal).then(
      (reply) => parentPort.postMessage({ id, reply }, reply.body ? [reply.body] : []),
      (error) => parentPort.postMessage({ id, error: plainError(error) }),
    ).finally(() => requests.delete(id));
  });
});`;

let fetchWorker = null;
let fetchWorkerBroken = false;
let fetchCalls = 0;
const fetches = new Map();

function rebuiltError({ name, message, cause, ...fields }) {
  const error = Object.assign(name === "TypeError" ? new TypeError(message) : new Error(message), fields);
  if (error.name !== name) error.name = name;
  if (cause) error.cause = rebuiltError(cause);
  return error;
}

function responseOf(reply, maxBytes) {
  if (reply.tooLarge) throw Object.assign(new RangeError(`The response exceeded ${maxBytes} bytes`), { code: "ERR_RESPONSE_TOO_LARGE" });
  // These statuses carry no body, and a Response refuses one for them.
  const empty = [204, 205, 304].includes(reply.status);
  return new Response(empty ? null : reply.body, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
}

function fetchHere(request, signal) {
  return fetchWhole(fetch, request, signal).then((reply) => responseOf(reply, request.maxBytes));
}

function startFetchWorker(createWorker) {
  const started = createWorker(FETCH_WORKER_SOURCE, { eval: true });
  let answered = false;
  started.on("message", ({ id, reply, error }) => {
    answered = true;
    const entry = fetches.get(id);
    if (error) entry?.fail(rebuiltError(error));
    else entry?.answer(reply);
  });
  const stopped = () => {
    if (fetchWorker !== started) return;
    fetchWorker = null;
    // One that never answered cannot run here: requests go to this thread's own fetch from now on.
    // Otherwise the next request starts a new worker.
    if (!answered) fetchWorkerBroken = true;
    const lost = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("The request worker stopped"), { code: "ECONNRESET" }) });
    for (const entry of fetches.values()) entry.fail(lost);
  };
  started.on("error", stopped);
  started.on("exit", stopped);
  // Only while it has requests to answer does it keep the process up, as their sockets would here.
  started.unref();
  return started;
}

/**
 * fetch(url, init) for a request whose response is read whole, made from a worker thread. It takes
 * method, headers (plain or Headers), a string or byte body, redirect and signal, plus `maxBytes`:
 * past it, it rejects with code ERR_RESPONSE_TOO_LARGE. It resolves a Response holding the body
 * (without url or redirected), rejects as fetch does (TypeError "fetch failed" with the socket
 * error as cause; the signal's reason once it aborts, even while the worker is held), and makes the
 * request here when no worker can start or the init cannot be copied to one.
 */
function fetchOffThread(url, { signal, maxBytes = null, ...init } = {}, { createWorker = (source, options) => new Worker(source, options) } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const headers = typeof Headers === "function" && init.headers instanceof Headers ? [...init.headers] : init.headers;
  const body = init.body;
  const request = { url: String(url), init: { ...init, headers }, maxBytes };
  const copyable = body === undefined || body === null || typeof body === "string" || ArrayBuffer.isView(body);
  if (fetchWorkerBroken || !copyable) return fetchHere(request, signal);
  try {
    fetchWorker ??= startFetchWorker(createWorker);
  } catch {
    fetchWorkerBroken = true;
    return fetchHere(request, signal);
  }
  const worker = fetchWorker;
  return new Promise((resolve, reject) => {
    const id = ++fetchCalls;
    const done = () => {
      if (!fetches.delete(id)) return false;
      signal?.removeEventListener("abort", onAbort);
      if (fetches.size === 0) fetchWorker?.unref?.();
      return true;
    };
    const fail = (error) => { if (done()) reject(error); };
    const answer = (reply) => {
      if (!done()) return;
      try { resolve(responseOf(reply, maxBytes)); } catch (refused) { reject(refused); }
    };
    const onAbort = () => {
      fail(signal.reason);
      worker.postMessage({ id, cancel: true });
    };
    fetches.set(id, { fail, answer });
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.ref?.();
    try {
      worker.postMessage({ id, request });
    } catch {
      // A header value or option that cannot be copied to the worker: this request is made here.
      done();
      fetchHere(request, signal).then(resolve, reject);
    }
  });
}

/** For tests: forget the request worker so the next request starts a new one. */
function resetFetchWorker() {
  const worker = fetchWorker;
  fetchWorker = null;
  fetches.clear();
  worker?.terminate?.();
  fetchWorkerBroken = false;
}

/**
 * Streamed GETs. Closing a socket whose connect is still pending runs closesocket() on the thread
 * that owns the socket, and with the antivirus holding it, the update check's Node fallback held the
 * main process (every window) for 72.9 s as it gave up on a GitHub connect (Activity, 2026-11-09
 * 05:56:01Z: handle.close 20.205.243.168:443 < update.cjs). fetchOffThread holds a whole body, and
 * an update pack is hundreds of MB, so this streams: http(s).get from a worker of its own, with the
 * shape of https.get(url, { headers }, onResponse). It returns a request with setTimeout(ms, onTimeout),
 * destroy(error) and an 'error' event; the response is a Readable with statusCode and headers, and
 * the worker reads the next chunk only once this thread has taken the last. The worker ends with the
 * request (its socket closes there). Where no worker can start, the request is made here.
 */
const GET_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const transport = require(workerData.protocol === "http:" ? "node:http" : "node:https");
const errorOf = (error) => ({ message: String((error && error.message) || error), code: error && error.code });
let response = null;
const request = transport.get(workerData.url, { headers: workerData.headers }, (res) => {
  response = res;
  res.pause();
  res.on("data", (chunk) => { res.pause(); parentPort.postMessage({ type: "data", chunk }); });
  res.on("end", () => parentPort.postMessage({ type: "end" }));
  res.on("error", (error) => parentPort.postMessage({ type: "response-error", error: errorOf(error) }));
  parentPort.postMessage({ type: "response", statusCode: res.statusCode, headers: res.headers });
});
request.on("error", (error) => parentPort.postMessage({ type: "error", error: errorOf(error) }));
parentPort.on("message", (message) => {
  if (message.type === "pull") { if (response) response.resume(); }
  else if (message.type === "timeout") request.setTimeout(message.ms, () => parentPort.postMessage({ type: "timeout" }));
});
`;

function getOffThread(url, { headers = {} } = {}, onResponse, { createWorker = (source, options) => new Worker(source, options) } = {}) {
  const parsed = new URL(url);
  let worker;
  try {
    worker = createWorker(GET_WORKER_SOURCE, { eval: true, workerData: { url: parsed.toString(), protocol: parsed.protocol, headers: { ...headers } } });
  } catch {
    return require(parsed.protocol === "http:" ? "node:http" : "node:https").get(parsed, { headers }, onResponse);
  }
  const request = new EventEmitter();
  const rebuilt = (error) => Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
  let response = null, onTimeout = null, ended = false;
  // Ends the worker once: its socket closes on its own thread, never this one.
  const end = () => {
    if (ended) return false;
    ended = true;
    Promise.resolve(worker.terminate?.()).catch(() => {});
    return true;
  };
  const fail = (error) => {
    if (!end()) return;
    if (response) response.destroy(error);
    else request.emit("error", error);
  };
  worker.on("message", (message) => {
    switch (message.type) {
      case "response":
        response = new Readable({ read: () => { if (!ended) worker.postMessage({ type: "pull" }); } });
        response.statusCode = message.statusCode;
        response.headers = message.headers;
        // A reader that stops early (a size limit, a write that failed) ends the request.
        response.once("close", end);
        onResponse?.(response);
        break;
      case "data": response?.push(Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength)); break;
      case "end": end(); response?.push(null); break;
      case "response-error": fail(rebuilt(message.error)); break;
      case "error": fail(rebuilt(message.error)); break;
      case "timeout": onTimeout?.(); break;
      default: break;
    }
  });
  worker.on("error", (error) => fail(error));
  worker.on("exit", () => fail(Object.assign(new Error("The request worker stopped"), { code: "ECONNRESET" })));
  request.setTimeout = (ms, callback) => {
    onTimeout = callback;
    if (!ended) worker.postMessage({ type: "timeout", ms });
    return request;
  };
  request.destroy = (error) => {
    if (error) fail(error);
    else end();
    return request;
  };
  return request;
}

module.exports = {
  runOffThread, warmProgram, spawnOffThread, resetSpawnWorker, watchOffThread, resetWatchWorker, probeTcpOffThread, connectErrorText,
  fetchOffThread, resetFetchWorker, getOffThread,
};
