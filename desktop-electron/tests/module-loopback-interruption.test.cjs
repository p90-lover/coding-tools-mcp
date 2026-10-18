"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { requestJson } = require("../../app-handler/lib/loopback.cjs");

async function endpoint(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const partial of [false, true]) {
  test(`a service disconnect ${partial ? "during the body" : "after headers"} rejects instead of hanging`, async t => {
    const origin = await endpoint(t, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 100 });
      res.flushHeaders();
      if (partial) res.write('{"ok":');
      setTimeout(() => res.destroy(), 10);
    });
    let timer;
    try {
      await assert.rejects(Promise.race([
        requestJson(origin),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Request stayed pending")), 1000); }),
      ]), /Module response interrupted|aborted|ECONNRESET/);
    } finally { clearTimeout(timer); }
  });
}

test("a complete loopback response still parses normally", async t => {
  const origin = await endpoint(t, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); });
  const result = await requestJson(origin);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true });
});
