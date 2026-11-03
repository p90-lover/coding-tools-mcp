"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const net = require("node:net");

const MODULE = require.resolve("../electron/off-thread-run.cjs");

/** A fresh copy of the module (its own request worker), counting client connects made on this thread. */
function load(t) {
  const connects = [];
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { connects.push(args[0]); return realConnect.apply(this, args); };
  delete require.cache[MODULE];
  const module = require(MODULE);
  t.after(() => { net.Socket.prototype.connect = realConnect; module.resetFetchWorker(); });
  return { module, connects };
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A worker that takes requests and never answers, as one held in a socket call. */
function heldWorker() {
  const worker = new EventEmitter();
  worker.posted = [];
  worker.postMessage = (message) => worker.posted.push(message);
  worker.ref = () => worker;
  worker.unref = () => worker;
  return worker;
}

test("a request is made from a worker thread and answers with a whole Response", async (t) => {
  const { module, connects } = load(t);
  const origin = await serve(t, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("x-seen", `${request.method} ${request.url} ${request.headers["content-type"]}`);
      response.end(JSON.stringify({ echoed: body }));
    });
  });
  const response = await module.fetchOffThread(`${origin}/api/v1/sessions/s?limit=1`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}', redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response instanceof Response);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-seen"), "POST /api/v1/sessions/s?limit=1 application/json");
  assert.deepEqual(await response.json(), { echoed: '{"a":1}' });
  // A native write or connect that a network filter holds held main 21-122 s (2026-11-03): none here.
  assert.deepEqual(connects, []);
});

test("an error status and an empty answer come back as fetch gives them", async (t) => {
  const { module } = load(t);
  const origin = await serve(t, (request, response) => {
    response.statusCode = request.url === "/gone" ? 404 : 204;
    response.end(request.url === "/gone" ? "no such session" : undefined);
  });
  const missing = await module.fetchOffThread(`${origin}/gone`);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "no such session");
  const empty = await module.fetchOffThread(`${origin}/empty`, { method: "DELETE" });
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), "");
});

test("a refused connection rejects as fetch does, with the socket error as its cause", async (t) => {
  const { module } = load(t);
  const error = await module.fetchOffThread(`http://127.0.0.1:${await closedPort()}/readyz`).then(() => null, (failure) => failure);
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, "fetch failed");
  assert.equal(error.cause?.code, "ECONNREFUSED", "callers read cause.code to tell a stopped service");
});

test("a response past maxBytes is refused without being read whole", async (t) => {
  const { module } = load(t);
  const origin = await serve(t, (request, response) => response.end("x".repeat(64 * 1024)));
  const error = await module.fetchOffThread(origin, { maxBytes: 1024 }).then(() => null, (failure) => failure);
  assert.equal(error?.code, "ERR_RESPONSE_TOO_LARGE");
  assert.equal((await module.fetchOffThread(origin, { maxBytes: 64 * 1024 })).status, 200, "exactly the limit is kept");
});

test("a held worker is answered by the caller's signal, and its late request is dropped", async (t) => {
  const { module } = load(t);
  const worker = heldWorker();
  const began = Date.now();
  const error = await module.fetchOffThread("http://127.0.0.1:9/api/v1/ao/read", { method: "POST", body: "{}", signal: AbortSignal.timeout(100) },
    { createWorker: () => worker }).then(() => null, (failure) => failure);
  const waited = Date.now() - began;
  // The same TimeoutError fetch rejects with: a caller that tells a timeout by its name still can.
  assert.equal(error?.name, "TimeoutError");
  assert.ok(waited >= 90 && waited < 2_000, `answered at the signal (${waited} ms)`);
  // Its cancel follows the request, so a worker that comes back never sends the stale POST.
  assert.deepEqual(worker.posted.map((message) => (message.cancel ? "cancel" : message.request.init.method)), ["POST", "cancel"]);
  assert.equal(worker.posted[0].id, worker.posted[1].id);
  // An answer that arrives later is dropped.
  worker.emit("message", { id: worker.posted[0].id, reply: { status: 200, statusText: "OK", headers: [], body: new ArrayBuffer(0) } });
});

test("an already aborted signal rejects at once, without a request", async (t) => {
  const { module } = load(t);
  const worker = heldWorker();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(module.fetchOffThread("http://127.0.0.1:9/", { signal: controller.signal }, { createWorker: () => worker }), { name: "AbortError" });
  assert.equal(worker.posted.length, 0);
});

test("it still makes the request when no worker thread can be started", async (t) => {
  const { module, connects } = load(t);
  const origin = await serve(t, (request, response) => response.end("here"));
  const unavailable = () => { throw new Error("no workers here"); };
  const response = await module.fetchOffThread(origin, {}, { createWorker: unavailable });
  assert.equal(await response.text(), "here");
  assert.equal(connects.length, 1, "made on this thread instead");
});

test("requests a worker had not answered when it stopped fail as a lost connection, and the next starts a new worker", async (t) => {
  const { module } = load(t);
  const origin = await serve(t, (request, response) => response.end("again"));
  const workers = [];
  const createWorker = (source, options) => {
    const worker = workers.length === 0 ? heldWorker() : new (require("node:worker_threads").Worker)(source, options);
    workers.push(worker);
    return worker;
  };
  const pending = module.fetchOffThread(origin, {}, { createWorker });
  // It answered something before, so it was working: a crash, not a thread that cannot run.
  workers[0].emit("message", { id: -1, reply: null });
  workers[0].emit("exit", 1);
  const error = await pending.then(() => null, (failure) => failure);
  assert.equal(error?.message, "fetch failed");
  assert.equal(error?.cause?.code, "ECONNRESET");
  assert.equal(await (await module.fetchOffThread(origin, {}, { createWorker })).text(), "again");
  assert.equal(workers.length, 2);
});
