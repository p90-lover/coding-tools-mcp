const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { createProviderNetworkController } = require("../electron/provider-network.cjs");

async function fixture(t) {
  const sockets = new Set(), seen = [];
  const expected = "Basic " + Buffer.from("saved-user:saved-pass").toString("base64");
  const server = http.createServer((request, response) => {
    seen.push(request.headers["proxy-authorization"] === expected);
    response.writeHead(seen.at(-1) ? 200 : 407, seen.at(-1) ? {} : { "proxy-authenticate": 'Basic realm="fixture"' });
    response.end(seen.at(-1) ? "proxy accepted" : "proxy login required");
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (request, socket, head) => {
    seen.push(request.headers["proxy-authorization"] === expected);
    if (!seen.at(-1)) return socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"fixture\"\r\n\r\n");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", data => socket.write(data));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-login-proxy-"));
  const controller = createProviderNetworkController({ app: {}, browserPartition: "fixture-account",
    getBrowserHost: () => ({ partition: "fixture-account" }), getBrowserProxyBinding: () => "bound",
    logger: { info() {}, warn() {} }, safeStorage: null, session: {}, shell: {}, userData: root });
  for (const id of ["global", "bound"]) controller.store.saveProxyProfile({ id, name: id, enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: server.address().port },
    username: id === "bound" ? "saved-user" : "wrong-global-user", password: id === "bound" ? "saved-pass" : "wrong-global-pass" });
  controller.store.setGlobalRouting({ enabled: true, profileId: "global" });
  t.after(async () => {
    await controller.store.saved();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { controller, port: server.address().port, seen };
}

function get(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "http://fixture.invalid/", agent: false,
      headers: { "proxy-authorization": "must-be-replaced" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject); request.setTimeout(3000, () => request.destroy(new Error("fixture timeout")));
  });
}

test("Chrome proxy authenticates HTTP and CONNECT with the bound account secret and closes afterwards", async t => {
  const { controller, port, seen } = await fixture(t);
  assert.equal(await get(port), 407, "the upstream really requires proxy credentials");
  assert.equal(typeof controller.withBrowserLoginProxy, "function", "Chrome must receive the saved proxy authentication");
  let localPort;
  await controller.withBrowserLoginProxy("fixture-account", { proxyRules: `PROXY 127.0.0.1:${port}` }, async route => {
    localPort = Number(route.proxyRules.match(/^PROXY 127\.0\.0\.1:(\d+)$/)?.[1]);
    assert.ok(localPort && localPort !== port);
    assert.equal(JSON.stringify(route).includes("saved-"), false);
    assert.equal(await get(localPort), 200);
    await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: localPort, method: "CONNECT", path: "fixture.invalid:443", agent: false });
      request.once("error", reject);
      request.once("connect", (response, socket, head) => {
        assert.equal(response.statusCode, 200); assert.equal(head.length, 0);
        socket.once("error", reject); socket.setTimeout(3000, () => socket.destroy(new Error("fixture timeout")));
        socket.once("data", data => { try { assert.equal(data.toString(), "tunnel-data"); resolve(); } catch (error) { reject(error); } finally { socket.destroy(); } });
        socket.write("tunnel-data");
      });
      request.end();
    });
  });
  assert.deepEqual(seen, [false, true, true], "saved credentials reach the configured upstream, including CONNECT");
  await new Promise((resolve, reject) => {
    const socket = net.connect(localPort, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); reject(new Error("login proxy leaked after completion")); });
    socket.once("error", error => { try { assert.equal(error.code, "ECONNREFUSED"); resolve(); } catch (caught) { reject(caught); } });
  });
});

test("Chrome proxy refuses a different upstream before using saved credentials", async t => {
  const { controller, seen } = await fixture(t);
  assert.equal(typeof controller.withBrowserLoginProxy, "function");
  await assert.rejects(controller.withBrowserLoginProxy("fixture-account", { proxyRules: "PROXY different.invalid:1234" }, () => assert.fail("wrong proxy must not open")), /does not match/);
  assert.deepEqual(seen, []);
});

test("Chrome proxy preserves a direct route without a credential relay", async t => {
  const { controller, seen } = await fixture(t);
  assert.equal(typeof controller.withBrowserLoginProxy, "function");
  assert.equal(await controller.withBrowserLoginProxy("fixture-account", { proxyRules: "DIRECT" }, async route => {
    assert.deepEqual(route, { proxyRules: "DIRECT" }); return "direct";
  }), "direct");
  assert.deepEqual(seen, []);
});

test("Chrome proxy is also closed when opening Chrome fails", async t => {
  const { controller, port } = await fixture(t);
  let localPort;
  await assert.rejects(controller.withBrowserLoginProxy("fixture-account", { proxyRules: `PROXY 127.0.0.1:${port}` }, async route => {
    localPort = Number(route.proxyRules.split(":").at(-1));
    throw new Error("fixture Chrome startup failed");
  }), /Chrome startup failed/);
  await new Promise((resolve, reject) => {
    const socket = net.connect(localPort, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); reject(new Error("failed login left its proxy open")); });
    socket.once("error", error => { try { assert.equal(error.code, "ECONNREFUSED"); resolve(); } catch (caught) { reject(caught); } });
  });
});
