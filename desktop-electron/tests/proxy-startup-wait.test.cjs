const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// waitForProxyRoute lives in main.cjs (which needs Electron); load just that function.
const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const start = source.indexOf("async function waitForProxyRoute(");
const close = /\r?\n\}\r?\n/.exec(source.slice(start));
const end = close ? start + close.index + close[0].length : -1;
assert.ok(start > 0 && end > start, "waitForProxyRoute is defined in main.cjs");
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitForProxyRoute = new Function("net", "delay", "process", `${source.slice(start, end)}\nreturn waitForProxyRoute;`)(net, delay, process);

function withProxy(value, run) {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
  delete process.env.HTTP_PROXY;
  if (value === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = value;
  return run().finally(() => {
    for (const [key, previous] of Object.entries(saved)) if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  });
}

test("the first chatgpt.com load waits for a local proxy that is still starting", async () => {
  // Reserve a free port, then open it only after the wait has begun.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  await withProxy(`http://127.0.0.1:${port}`, async () => {
    const began = Date.now();
    const server = net.createServer((socket) => socket.destroy());
    setTimeout(() => server.listen(port, "127.0.0.1"), 1200);
    try {
      await waitForProxyRoute(8000);
      const waited = Date.now() - began;
      assert.ok(waited >= 1000 && waited < 6000, `resolved once the proxy accepted, after ${waited} ms`);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test("no proxy, or a proxy that never opens, does not hold the load beyond the limit", async () => {
  await withProxy(undefined, async () => {
    const began = Date.now();
    await waitForProxyRoute(5000);
    assert.ok(Date.now() - began < 50, "no proxy: at once");
  });
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  await withProxy(`127.0.0.1:${port}`, async () => {
    const began = Date.now();
    await waitForProxyRoute(1500);
    const waited = Date.now() - began;
    assert.ok(waited >= 1400 && waited < 4000, `gave up after the limit (${waited} ms)`);
  });
});
