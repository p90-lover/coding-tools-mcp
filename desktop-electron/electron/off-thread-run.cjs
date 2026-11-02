"use strict";

const { execFile, spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
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
 */
const SPAWN_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const children = new Map();
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
      if (!child[stream]) continue;
      child[stream].on("data", (chunk) => post({ type: "data", id, stream, chunk }));
      child[stream].on("end", () => post({ type: "end", id, stream }));
      child[stream].on("error", (error) => post({ type: "stream-error", id, stream, error: describe(error) }));
    }
    child.stdin?.on("error", (error) => post({ type: "stream-error", id, stream: "stdin", error: describe(error) }));
    child.on("error", (error) => post({ type: "error", id, error: describe(error) }));
    child.on("exit", (code, signal) => post({ type: "exit", id, code, signal }));
    child.on("close", (code, signal) => { children.delete(id); post({ type: "close", id, code, signal }); });
    if (message.unref) child.unref();
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
  }

  later(action) {
    this.queue = this.queue.then(() => new Promise((resolve) => setImmediate(() => { action(); resolve(); })));
  }

  receive(message) {
    switch (message.type) {
      case "data": this[message.stream]?.write(Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength)); break;
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

module.exports = { runOffThread, warmProgram, spawnOffThread, resetSpawnWorker };
