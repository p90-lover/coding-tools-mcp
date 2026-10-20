"use strict";

const assert = require("node:assert/strict");
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
