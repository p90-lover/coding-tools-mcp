"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");

const MODULE = require.resolve("../electron/off-thread-run.cjs");

/** A fresh copy of the module (its own probe worker), counting connects made on this thread. */
function load() {
  const calls = [];
  const realConnect = net.connect;
  net.connect = (...args) => { calls.push(args[0]); return realConnect(...args); };
  delete require.cache[MODULE];
  return { module: require(MODULE), calls, restore: () => { net.connect = realConnect; } };
}

async function listening() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function closedPort() {
  const { port, close } = await listening();
  await close();
  return port;
}

/** A worker that takes requests and never answers, as one held in an earlier probe's close. */
function heldWorker() {
  const worker = new EventEmitter();
  worker.posted = [];
  worker.postMessage = (message) => worker.posted.push(message);
  worker.unref = () => worker;
  return worker;
}

test("a probe connects from a worker thread, never on the calling thread", async () => {
  const { module, calls, restore } = load();
  const server = await listening();
  try {
    const reply = await module.probeTcpOffThread({ host: "127.0.0.1", port: server.port, timeoutMs: 5_000 });
    assert.equal(reply.ok, true);
    assert.ok(Number.isFinite(reply.latencyMs), `latency ${reply.latencyMs}`);
    // Closing a connect that a network filter holds held main up to 122 s: no socket here.
    assert.deepEqual(calls, []);
  } finally { restore(); await server.close(); }
});

test("a refused port answers with the refusal and its text", async () => {
  const { module, restore } = load();
  try {
    const reply = await module.probeTcpOffThread({ host: "127.0.0.1", port: await closedPort(), timeoutMs: 5_000 });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "ECONNREFUSED");
    assert.match(reply.message, /ECONNREFUSED/);
  } finally { restore(); }
});

test("a held worker is answered at the deadline, and its late request is not connected", async () => {
  const { module, restore } = load();
  const worker = heldWorker();
  try {
    const began = Date.now();
    const reply = await module.probeTcpOffThread({ host: "127.0.0.1", port: 9, timeoutMs: 100 }, { createWorker: () => worker });
    const waited = Date.now() - began;
    assert.deepEqual(reply, { ok: false, code: "ETIMEDOUT", message: "Connection timed out" });
    assert.ok(waited >= 1_000 && waited < 3_000, `answered after the deadline and grace (${waited} ms)`);
    // The worker skips what it reaches after the deadline, so a held close does not queue connects.
    assert.equal(worker.posted.length, 1);
    assert.ok(worker.posted[0].request.deadline <= Date.now());
    // An answer that arrives after the deadline is dropped.
    worker.emit("message", { id: worker.posted[0].id, reply: { ok: true, latencyMs: 1 } });
  } finally { restore(); }
});

test("it still probes when no worker thread can be started", async () => {
  const { module, calls, restore } = load();
  const server = await listening();
  try {
    const unavailable = () => { throw new Error("no workers here"); };
    const reply = await module.probeTcpOffThread({ host: "127.0.0.1", port: server.port, timeoutMs: 5_000 }, { createWorker: unavailable });
    assert.equal(reply.ok, true);
    assert.equal(calls.length, 1);
  } finally { restore(); await server.close(); }
});

test("a probe the worker never answered because it stopped is made here", async () => {
  const { module, calls, restore } = load();
  const server = await listening();
  const worker = heldWorker();
  try {
    const pending = module.probeTcpOffThread({ host: "127.0.0.1", port: server.port, timeoutMs: 5_000 }, { createWorker: () => worker });
    worker.emit("exit", 1);
    const reply = await pending;
    assert.equal(reply.ok, true);
    assert.equal(calls.length, 1);
  } finally { restore(); await server.close(); }
});
