"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const { getOffThread } = require("../electron/off-thread-run.cjs");

// getOffThread is https.get from a worker: the update check's Node fallback closing a pending
// connect on the main process held every window 72.9 s (2026-11-09). These run it for real against
// a loopback server; `workers` sees each worker it starts, to show the request's worker ends.
function tracked() {
  const workers = [];
  const createWorker = (source, options) => {
    const worker = new Worker(source, options);
    worker.exited = new Promise((resolve) => worker.once("exit", resolve));
    workers.push(worker);
    return worker;
  };
  return { workers, createWorker };
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function get(url, options, deps) {
  return new Promise((resolve, reject) => {
    const request = getOffThread(url, options, resolve, deps);
    request.once("error", reject);
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("a response streams from the worker whole, with its status and headers, and the worker ends", async (t) => {
  const body = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 31) % 251;
  let seenHeader = null;
  const base = await serve(t, (request, response) => {
    seenHeader = request.headers["user-agent"];
    response.writeHead(200, { "content-type": "application/octet-stream", "x-check": "yes" });
    response.end(body);
  });
  const { workers, createWorker } = tracked();
  const response = await get(`${base}/pack`, { headers: { "User-Agent": "coding-tools-test" } }, { createWorker });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-check"], "yes");
  const received = await readAll(response);
  assert.equal(received.length, body.length);
  assert.ok(received.equals(body), "every byte arrives in order");
  assert.equal(seenHeader, "coding-tools-test", "the headers reach the server");
  assert.equal(workers.length, 1);
  await workers[0].exited;
});

test("the worker reads on only as the reader takes the body", async (t) => {
  let written = 0;
  let finished = false;
  const base = await serve(t, (_request, response) => {
    response.writeHead(200);
    const chunk = Buffer.alloc(64 * 1024, 1);
    const more = () => {
      while (written < 64 * 1024 * 1024) {
        written += chunk.length;
        if (!response.write(chunk)) { response.once("drain", more); return; }
      }
      finished = true;
      response.end();
    };
    more();
  });
  const response = await get(`${base}/big`, {}, tracked());
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(finished, false, "an unread 64 MB body is not pulled through the worker into memory");
  assert.ok(written < 32 * 1024 * 1024, `the server could write only what the pipes hold (${written} bytes)`);
  response.destroy();
});

test("a timeout is reported here, and destroying the request ends its worker", async (t) => {
  const base = await serve(t, () => { /* never answers */ });
  const { workers, createWorker } = tracked();
  const failure = await new Promise((resolve) => {
    const request = getOffThread(`${base}/silent`, {}, () => resolve(new Error("answered")), { createWorker });
    request.setTimeout(200, () => request.destroy(new Error("Update request timed out")));
    request.once("error", resolve);
  });
  assert.match(failure.message, /timed out/);
  await workers[0].exited;
});

test("a refused connection rejects with its code, as https.get's error does", async () => {
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(get(`http://127.0.0.1:${port}/`, {}, tracked()), (error) => error.code === "ECONNREFUSED");
});

test("a reader that stops early ends the request's worker", async (t) => {
  const base = await serve(t, (_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write(Buffer.alloc(1024, 2)), 5);
    response.once("close", () => clearInterval(timer));
  });
  const { workers, createWorker } = tracked();
  const response = await get(`${base}/endless`, {}, { createWorker });
  for await (const _chunk of response) break; // destroys the stream
  await workers[0].exited;
});
