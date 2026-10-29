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
    return { module: require(MODULE), calls, restore: () => { childProcess.spawn = realSpawn; } };
  } finally {
    if (Worker) workerThreads.Worker = realWorker;
  }
}

const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";

test("a program starts from a worker thread, never on the calling thread", async () => {
  const { module, calls, restore } = load();
  try {
    const reply = await module.runOffThread({ file: process.execPath, args: ["-e", script], timeoutMs: 10_000 });
    assert.deepEqual(reply, { code: 3, stdout: "out", stderr: "err" });
    // Starting a process blocks the thread that starts it (seconds while it is scanned): none here.
    assert.deepEqual(calls, []);
  } finally { restore(); }
});

test("a given environment reaches the program (rtk's rewrite passes its own)", async () => {
  const { module, restore } = load();
  try {
    const env = { ...process.env, CT_OFF_THREAD_PROBE: "seen" };
    const reply = await module.runOffThread({ file: process.execPath, args: ["-e", "process.stdout.write(process.env.CT_OFF_THREAD_PROBE || 'none')"], env, timeoutMs: 10_000 });
    assert.equal(reply.stdout, "seen");
  } finally { restore(); }
});

test("it still runs when no worker thread can be started", async () => {
  const { module, calls, restore } = load({ Worker: function Unavailable() { throw new Error("no workers here"); } });
  try {
    const reply = await module.runOffThread({ file: process.execPath, args: ["-e", script], timeoutMs: 10_000 });
    assert.deepEqual(reply, { code: 3, stdout: "out", stderr: "err" });
    assert.deepEqual(calls, [process.execPath]);
  } finally { restore(); }
});

test("a program that outlives its timeout is ended and reported, and output is capped", async () => {
  const { module, restore } = load();
  try {
    const started = Date.now();
    const slow = await module.runOffThread({ file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 300 });
    assert.deepEqual(slow, { timedOut: true });
    assert.ok(Date.now() - started < 5_000);
    const big = await module.runOffThread({ file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(5000))"], timeoutMs: 10_000, maxBytes: 100 });
    assert.equal(big.stdout.length, 100);
    const missing = await module.runOffThread({ file: "Z:\\no\\such\\program.exe", args: [], timeoutMs: 10_000 });
    assert.ok(missing.error, JSON.stringify(missing));
  } finally { restore(); }
});
