"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { HeadlessHost } = require("../electron/headless-host.cjs");

test("native Codex local confirmation header stays in the main-to-sidecar request", async () => {
  const headers = [];
  const server = http.createServer((request, response) => {
    headers.push(request.headers["x-coding-tools-local-ui"] ?? null);
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const host = new HeadlessHost({ app: null, logger: null, sourceRoot: "." });
  host.ensureStarted = async () => ({ endpoint, token: "control-token", uiToken: "main-only-token" });
  try {
    assert.deepEqual(await host.request("/native", {}), { ok: true });
    assert.deepEqual(await host.request("/native", {}, { localConfirmation: true }), { ok: true });
    assert.deepEqual(headers, [null, "main-only-token"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
