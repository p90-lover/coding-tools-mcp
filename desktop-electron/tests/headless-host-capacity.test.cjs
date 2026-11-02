"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { HeadlessHost } = require("../electron/headless-host.cjs");

// A host whose control endpoint is a local server; nothing is spawned.
async function hostAgainst(handler, t) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = Object.create(HeadlessHost.prototype);
  host.ensureStarted = async () => ({ endpoint: `http://127.0.0.1:${server.address().port}`, token: "t".repeat(43) });
  return host;
}

const full = (response) => {
  response.writeHead(429, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: "HEADLESS_NOT_ACCEPTING", message: "HEADLESS_CAPACITY: request admission is full" } }));
};

test("a request the headless service turned away as full is sent again (seen on Activity in a poll burst)", async (t) => {
  let calls = 0;
  const host = await hostAgainst((request, response) => {
    calls += 1;
    if (calls <= 2) return full(response);
    response.end(JSON.stringify({ ok: true, calls }));
  }, t);
  const result = await host.request("/api/v1/ao/read", { workspace_id: "ws" });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test("it gives up after a few tries, and other errors are never retried", async (t) => {
  let calls = 0;
  const host = await hostAgainst((request, response) => { calls += 1; full(response); }, t);
  await assert.rejects(host.request("/api/v1/ao/read", {}), /HEADLESS_CAPACITY/);
  assert.equal(calls, 4, "the first try and three retries");

  let other = 0;
  const failing = await hostAgainst((request, response) => {
    other += 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "AO run not found in this workspace" } }));
  }, t);
  await assert.rejects(failing.request("/api/v1/ao/read", {}), /AO run not found/);
  assert.equal(other, 1);
});

// A service with `slots` request slots, as coding-tools-headless admits them; answers wait for `release`.
function slottedService(slots) {
  const service = { active: 0, peak: 0, refused: 0, served: 0, held: [] };
  service.handler = (request, response) => {
    if (service.active >= slots) { service.refused += 1; return full(response); }
    service.active += 1;
    service.peak = Math.max(service.peak, service.active);
    service.held.push(() => {
      service.active -= 1;
      service.served += 1;
      response.end(JSON.stringify({ ok: true }));
    });
  };
  service.release = () => { for (const answer of service.held.splice(0)) answer(); };
  return service;
}

test("a startup burst larger than the service's slots waits its turn instead of being refused", async (t) => {
  const service = slottedService(16);
  const host = await hostAgainst(service.handler, t);
  const burst = Array.from({ length: 35 }, (_, i) => host.request("/api/v1/ao/read", { run_id: `run-${i}` }));
  // Each slot is held for far longer than every capacity retry (a slow read on the HDD).
  while (service.served < 35) {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    service.release();
  }
  const results = await Promise.all(burst);
  assert.equal(results.every((result) => result.ok), true, "every request succeeded");
  assert.equal(service.refused, 0, "the service never turned one away");
  assert.equal(service.peak, 10, "ordinary reads leave two of the launcher's twelve slots for controls");
  assert.deepEqual(host.turns, { active: 0, waiting: [] });
});

test("a request whose turn does not come in time fails as the service would, and frees its place", async (t) => {
  const service = slottedService(16);
  const host = await hostAgainst(service.handler, t);
  host.maxInFlight = 1;
  host.queueWaitMs = 50;
  const first = host.request("/api/v1/ao/read", {});
  await assert.rejects(host.request("/api/v1/ao/read", { run_id: "other" }), /HEADLESS_CAPACITY: .*queue did not clear/);
  assert.equal(host.turns.waiting.length, 0);
  const answer = async (pending) => {
    while (!service.held.length) await new Promise((resolve) => setImmediate(resolve));
    service.release();
    return pending;
  };
  assert.equal((await answer(first)).ok, true);
  assert.equal((await answer(host.request("/api/v1/ao/read", {}))).ok, true, "the turn it gave up was not lost");
});

test("a failed request still passes its turn on", async (t) => {
  let calls = 0;
  const host = await hostAgainst((request, response) => {
    calls += 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "AO run not found in this workspace" } }));
  }, t);
  host.maxInFlight = 1;
  const results = await Promise.allSettled([1, 2, 3].map(i => host.request("/api/v1/ao/read", { run_id: `run-${i}` })));
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "rejected"]);
  assert.equal(calls, 3);
  assert.deepEqual(host.turns, { active: 0, waiting: [] });
});

for (const aborted of [true, false]) {
  test("a headless response " + (aborted ? "abort" : "error") + " releases its queued turn without replay", async (t) => {
    const requests = [];
    let escaped = null, waiting = null;
    const host = Object.create(HeadlessHost.prototype);
    host.ensureStarted = async () => ({ endpoint: "http://127.0.0.1:1", token: "synthetic-fixture" });
    host.maxInFlight = 1;
    t.mock.method(http, "request", (options) => {
      const request = new EventEmitter();
      requests.push(options);
      request.write = () => {};
      request.destroy = (error) => { if (error) request.emit("error", error); };
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        request.emit("response", response);
        if (options.path === "/first") {
          waiting = host.turns.waiting.length;
          response.emit("data", Buffer.from('{"partial":'));
          if (aborted) response.emit("aborted");
          const error = Object.assign(new Error(aborted ? "aborted" : "socket failed Bearer synthetic-fixture"), { code: "ECONNRESET" });
          try {
            response.emit("error", error);
          } catch (error) {
            escaped = error;
            // Bound the baseline failure and let its waiting request finish before asserting.
            request.emit("error", error);
          }
          response.emit("close");
        } else {
          response.emit("data", Buffer.from('{"ok":true}'));
          response.emit("end");
        }
      });
      return request;
    });

    const results = await Promise.allSettled([
      host.request("/first", { request_id: "first" }),
      host.request("/next", { request_id: "next" }),
    ]);
    assert.equal(escaped, null, "the response error must be handled by requestJson");
    assert.equal(waiting, 1, "the next request was waiting when the response failed");
    assert.equal(results[0].status, "rejected");
    assert.match(results[0].reason.message, aborted ? /^aborted$/ : /Bearer \[redacted\]/);
    assert.equal(results[1].status, "fulfilled");
    assert.deepEqual(results[1].value, { ok: true });
    assert.deepEqual(requests.map(({ path, method }) => ({ path, method })), [
      { path: "/first", method: "POST" },
      { path: "/next", method: "POST" },
    ]);
    assert.deepEqual(host.turns, { active: 0, waiting: [] });
  });
}
