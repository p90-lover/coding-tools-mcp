"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const workerThreads = require("node:worker_threads");

const MODULE = require.resolve("../electron/off-thread-run.cjs");

/** A fresh copy of the module, loaded while `spawn` (and optionally `Worker`) are replaced. */
function load({ Worker } = {}) {
  const calls = [];
  const realSpawn = childProcess.spawn;
  const realWorker = workerThreads.Worker;
  childProcess.spawn = (...args) => { calls.push(args[0]); return realSpawn(...args); };
  if (Worker) workerThreads.Worker = Worker;
  delete require.cache[MODULE];
  try {
    const module = require(MODULE);
    return { module, calls, restore: () => { module.resetSpawnWorker(); childProcess.spawn = realSpawn; } };
  } finally {
    if (Worker) workerThreads.Worker = realWorker;
  }
}

const text = (stream) => new Promise((resolve) => {
  let all = "";
  stream.on("data", (chunk) => { all += chunk.toString("utf8"); });
  stream.on("end", () => resolve(all));
});
const closed = (child) => new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
const pipes = { stdio: ["ignore", "pipe", "pipe"], windowsHide: true };

test("a long-lived program starts from the worker and reports its output, exit and close like spawn()", async () => {
  const { module, calls, restore } = load();
  try {
    const child = await module.spawnOffThread(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); setTimeout(() => process.exit(3), 50)"], pipes);
    // Starting a process holds the thread that starts it while Windows loads and scans it: none here.
    assert.deepEqual(calls, []);
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, `pid ${child.pid}`);
    assert.equal(child.exitCode, null);
    const order = [];
    child.once("exit", (code) => order.push(`exit ${code}`));
    const [stdout, stderr, end] = await Promise.all([text(child.stdout), text(child.stderr), closed(child)]);
    order.push(`close ${end.code}`);
    assert.equal(stdout, "out");
    assert.equal(stderr, "err");
    assert.deepEqual(order, ["exit 3", "close 3"]);
    assert.equal(child.exitCode, 3);
    assert.equal(child.stdin, null);
  } finally { restore(); }
});

test("a program that exits at once still reaches listeners attached after the start resolves", async () => {
  const { module, restore } = load();
  try {
    const child = await module.spawnOffThread(process.execPath, ["-e", "process.exit(7)"], pipes);
    const exited = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exited, 7);
  } finally { restore(); }
});

test("stdin writes reach the program and their callbacks report back (the passkey Continue)", async () => {
  const { module, restore } = load();
  try {
    const child = await module.spawnOffThread(process.execPath, ["-e", "process.stdin.once('data', (d) => { process.stdout.write('got ' + d); process.exit(0); })"], { ...pipes, stdio: ["pipe", "pipe", "pipe"] });
    assert.equal(child.stdin.writable, true);
    const output = text(child.stdout);
    await new Promise((resolve, reject) => child.stdin.write("continue\n", (error) => (error ? reject(error) : resolve())));
    assert.equal((await output).trim(), "got continue");
    assert.equal((await closed(child)).code, 0);
  } finally { restore(); }
});

test("kill() ends a running program", async () => {
  const { module, restore } = load();
  try {
    const child = await module.spawnOffThread(process.execPath, ["-e", "setInterval(() => {}, 1000)"], pipes);
    const end = closed(child);
    assert.equal(child.kill(), true);
    assert.equal(child.killed, true);
    const { code, signal } = await end;
    assert.ok(code !== 0 || signal, `code ${code} signal ${signal}`);
    assert.equal(child.kill(), false, "an ended program cannot be killed again");
  } finally { restore(); }
});

test("a missing program arrives as the child's error event, as spawn() reports it", async () => {
  const { module, restore } = load();
  try {
    const child = await module.spawnOffThread("Z:\\no\\such\\program.exe", [], pipes);
    const error = await new Promise((resolve) => child.once("error", resolve));
    assert.equal(error.code, "ENOENT");
    assert.equal(child.pid, undefined);
  } finally { restore(); }
});

test("without a worker, or with an option a worker cannot take, the program starts here", async () => {
  const unavailable = load({ Worker: function Unavailable() { throw new Error("no workers here"); } });
  try {
    const child = await unavailable.module.spawnOffThread(process.execPath, ["-e", "process.exit(4)"], pipes);
    assert.equal((await closed(child)).code, 4);
    assert.deepEqual(unavailable.calls, [process.execPath]);
  } finally { unavailable.restore(); }
  const odd = load();
  try {
    const child = await odd.module.spawnOffThread(process.execPath, ["-e", "process.exit(5)"], { ...pipes, timeout: 10_000 });
    assert.equal((await closed(child)).code, 5);
    assert.deepEqual(odd.calls, [process.execPath], "spawn() honours the timeout only here");
  } finally { odd.restore(); }
});
