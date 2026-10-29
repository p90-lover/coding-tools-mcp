"use strict";

const { execFile, spawn } = require("node:child_process");
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

module.exports = { runOffThread };
