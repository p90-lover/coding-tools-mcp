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

test("warming a program runs it once from a worker and never fails the caller", async () => {
  const { module, calls, restore } = load();
  try {
    const marker = require("node:path").join(require("node:os").tmpdir(), `ct-warm-${process.pid}-${Date.now()}`);
    await module.warmProgram(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`]);
    assert.equal(require("node:fs").readFileSync(marker, "utf8"), "ran");
    require("node:fs").rmSync(marker, { force: true });
    // The AO daemon's program is warmed so its own start (which must stay on this thread) is quick.
    assert.deepEqual(calls, []);
    // A missing program only ends the warm-up (a hung one times out as runOffThread's own test shows).
    await module.warmProgram("Z:\\no\\such\\program.exe");
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

// 2026-11-02: three of six stall probes found main resuming in a folder watch's callback after
// seconds held with almost no CPU (5.2 s, 16 ms): libuv looks up each changed file's long name on
// the thread that owns the watch.
test("a folder is watched from a worker thread, and says once it is watching that something may have changed", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { module, restore } = load();
  const realWatch = fs.watch;
  const here = [];
  fs.watch = (...args) => { here.push(args[0]); return realWatch(...args); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-watch-off-thread-"));
  const seen = [];
  const watch = module.watchOffThread(root, (event, name) => seen.push(name));
  try {
    await watch.ready;
    assert.deepEqual(seen, [null], "once in place, it reports a change it cannot name");
    fs.writeFileSync(path.join(root, "config.json"), "{}");
    for (let tries = 0; tries < 200 && !seen.includes("config.json"); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(seen.includes("config.json"), JSON.stringify(seen));
    assert.deepEqual(here, [], "nothing is watched on the calling thread");
    watch.close();
    const after = seen.length;
    fs.writeFileSync(path.join(root, "other.json"), "{}");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(seen.length, after, "a closed watch reports nothing more");
  } finally {
    fs.watch = realWatch;
    watch.close();
    module.resetWatchWorker();
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a folder that cannot be watched reports an error instead of throwing", async () => {
  const { module, restore } = load();
  try {
    const watch = module.watchOffThread("Z:\\no\\such\\folder", () => {});
    const error = await new Promise((resolve) => watch.on("error", resolve));
    assert.equal(error.code, "ENOENT");
    await watch.ready;
  } finally {
    module.resetWatchWorker();
    restore();
  }
});

test("without a worker thread a folder is still watched, here", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { module, restore } = load({ Worker: function Unavailable() { throw new Error("no workers here"); } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-watch-here-"));
  const seen = [];
  const watch = module.watchOffThread(root, (event, name) => seen.push(name));
  try {
    await watch.ready;
    fs.writeFileSync(path.join(root, "config.json"), "{}");
    for (let tries = 0; tries < 200 && !seen.includes("config.json"); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(seen.includes("config.json"), JSON.stringify(seen));
  } finally {
    watch.close();
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
