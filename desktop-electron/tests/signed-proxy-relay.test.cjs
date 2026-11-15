"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const { startSignedProxyRelay } = require(path.join(root, "electron/signed-proxy-relay.cjs"));
const network = require(path.join(root, "electron/provider-network.cjs"));

const USER = "user-sp1-session-1";
const PASS = "pa@ss:word";
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

// A proxy that behaves as Decodo did on 2026-11-15: a request carrying the right sign-in is served,
// a wrong one gets 407, and one with no sign-in is closed without any reply (no 407 to answer).
async function decodoLikeProxy(t) {
  const target = http.createServer((request, response) => response.end(`TARGET ${request.url}`));
  const targetPort = await listen(target);
  const seen = [];
  const verdict = (header) => (!header ? "drop" : header === EXPECTED ? "ok" : "reject");
  const proxy = http.createServer((request, response) => {
    const result = verdict(request.headers["proxy-authorization"]);
    seen.push({ kind: "request", result, url: request.url });
    if (result === "drop") { request.socket.destroy(); return; }
    if (result === "reject") { response.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' }).end(); return; }
    response.end("PROXY_OK");
  });
  proxy.on("connect", (request, client) => {
    const result = verdict(request.headers["proxy-authorization"]);
    seen.push({ kind: "connect", result, url: request.url });
    if (result === "drop") { client.destroy(); return; }
    if (result === "reject") { client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
    const remote = net.connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(remote); remote.pipe(client);
    });
    remote.on("error", () => client.destroy());
    client.on("error", () => remote.destroy());
  });
  const port = await listen(proxy);
  t.after(async () => { proxy.closeAllConnections?.(); target.closeAllConnections?.(); await close(proxy); await close(target); });
  return { port, targetPort, seen };
}

// An absolute-form GET through an HTTP proxy, as Chromium sends for http:// pages.
function getThrough(proxyPort, url, headers = {}) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: new URL(url).host, ...headers }, agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", (error) => resolve({ error: error.code || error.message }));
    request.end();
  });
}

// A CONNECT tunnel through an HTTP proxy, then one request inside it, as Chromium does for https://.
function tunnelThrough(proxyPort, targetPort) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `127.0.0.1:${targetPort}`, agent: false });
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); resolve({ status: response.statusCode }); return; }
      let raw = "";
      socket.on("data", (chunk) => { raw += chunk; if (raw.includes("TARGET")) { socket.destroy(); resolve({ status: 200, body: raw.slice(raw.indexOf("TARGET")) }); } });
      socket.write(`GET /inside HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
    });
    request.on("error", (error) => resolve({ error: error.code || error.message }));
    request.end();
  });
}

test("a proxy that drops unsigned requests fails them with an empty reply, as Chromium saw", async (t) => {
  const upstream = await decodoLikeProxy(t);
  const result = await getThrough(upstream.port, "http://example.test/page");
  assert.ok(result.error, "no reply at all, so no 407 for Chromium to answer");
  assert.equal(upstream.seen[0].result, "drop");
});

test("the relay signs every request and tunnel in, so that proxy serves them", async (t) => {
  const upstream = await decodoLikeProxy(t);
  const events = [];
  const relay = await startSignedProxyRelay({
    endpoint: { protocol: "http", host: "127.0.0.1", port: upstream.port },
    credentials: { username: USER, password: PASS },
    onEvent: (event) => events.push(event.type),
  });
  t.after(() => relay.close());
  assert.match(relay.proxyRules, /^http:\/\/127\.0\.0\.1:\d+$/);

  assert.deepEqual(await getThrough(relay.port, "http://example.test/page"), { status: 200, body: "PROXY_OK" });
  assert.deepEqual(await tunnelThrough(relay.port, upstream.targetPort), { status: 200, body: "TARGET /inside" });
  assert.deepEqual(upstream.seen.map((entry) => [entry.kind, entry.result]), [["request", "ok"], ["connect", "ok"]]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["authenticated"], "the first signed-in answer is reported once");
});

test("a sign-in the proxy refuses comes back as 502 and is reported, never as a 407 to the page", async (t) => {
  const upstream = await decodoLikeProxy(t);
  const events = [];
  const relay = await startSignedProxyRelay({
    endpoint: { protocol: "http", host: "127.0.0.1", port: upstream.port },
    credentials: { username: USER, password: "wrong" },
    onEvent: (event) => events.push(event.type),
  });
  t.after(() => relay.close());
  assert.equal((await getThrough(relay.port, "http://example.test/page")).status, 502);
  assert.equal((await tunnelThrough(relay.port, upstream.targetPort)).status, 502);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["rejected", "rejected"]);
});

test("a closed relay stops listening, and only HTTP(S) proxies get one", async (t) => {
  const upstream = await decodoLikeProxy(t);
  const relay = await startSignedProxyRelay({ endpoint: { protocol: "http", host: "127.0.0.1", port: upstream.port }, credentials: { username: USER, password: PASS } });
  await relay.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await getThrough(relay.port, "http://example.test/page");
  assert.ok(after.error, "nothing answers on a closed relay");
  await assert.rejects(startSignedProxyRelay({ endpoint: { protocol: "socks5", host: "127.0.0.1", port: 1 }, credentials: {} }), /HTTP or HTTPS/);
});

// Provider network: which rule each Chromium session takes.
function world(t, { startSignedRelay } = {}) {
  const directory = path.join(root, "aiTemp/signed-proxy-relay", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessions = new Map();
  const sessionFor = (name) => {
    if (!sessions.has(name)) sessions.set(name, { name, proxy: null, async setProxy(config) { this.proxy = config; }, async closeAllConnections() {} });
    return sessions.get(name);
  };
  const warnings = [];
  const controller = network.createProviderNetworkController({
    app: {}, browserPartition: "persist:coding-tools-chatgpt",
    getBrowserHost: () => ({ partition: "persist:coding-tools-chatgpt" }),
    logger: { info() {}, warn(event, detail) { warnings.push([event, detail]); } },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: sessionFor("default"), fromPartition: sessionFor },
    shell: {}, userData: directory,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "[]" }),
    ...(startSignedRelay ? { startSignedRelay } : {}),
  });
  return { controller, sessionFor, warnings };
}

function fakeRelays() {
  const started = [];
  let nextPort = 51000;
  return {
    started,
    start: async ({ endpoint, credentials, onEvent }) => {
      const relay = { port: nextPort++, endpoint, credentials, onEvent, closed: false };
      relay.proxyRules = `http://127.0.0.1:${relay.port}`;
      relay.close = async () => { relay.closed = true; };
      started.push(relay);
      return relay;
    },
  };
}

test("Global Routing sends the app's sessions through a signed relay for a proxy with a sign-in", async (t) => {
  const relays = fakeRelays();
  const { controller, sessionFor } = world(t, { startSignedRelay: relays.start });
  const saved = controller.store.saveProxyProfile({ name: "Decodo", endpoint: { protocol: "http", host: "isp.decodo.test", port: 10000 }, username: USER, password: PASS });
  const profile = saved.proxyProfiles.find((item) => item.name === "Decodo");
  controller.store.setGlobalRouting({ enabled: true, profileId: profile.id });
  await controller.applyGlobalRouting();

  assert.equal(relays.started.length, 1);
  assert.deepEqual(relays.started[0].endpoint, profile.endpoint);
  assert.deepEqual(relays.started[0].credentials, { username: USER, password: PASS });
  for (const name of ["default", "persist:coding-tools-chatgpt"]) {
    assert.equal(sessionFor(name).proxy.proxyRules, relays.started[0].proxyRules, `${name} goes through the relay, not straight to the proxy`);
  }

  await controller.applyGlobalRouting();
  assert.equal(relays.started.length, 1, "the running relay is reused");

  controller.store.saveProxyProfile({ id: profile.id, name: "Decodo", endpoint: profile.endpoint, password: "new-pass" });
  await controller.applyGlobalRouting();
  assert.equal(relays.started.length, 2, "a changed password gets a new relay");
  assert.equal(relays.started[0].closed, true, "and the old one is closed");
  assert.deepEqual(relays.started[1].credentials, { username: USER, password: "new-pass" });

  controller.store.setGlobalRouting({ enabled: false, profileId: profile.id });
  await controller.applyGlobalRouting();
  assert.equal(relays.started[1].closed, true, "a relay no route uses is closed");
  assert.deepEqual(sessionFor("default").proxy, { mode: "direct" });
});

test("a proxy without a sign-in keeps its own rule, and a relay that cannot start falls back to it", async (t) => {
  const relays = fakeRelays();
  const plain = world(t, { startSignedRelay: relays.start });
  const open = plain.controller.store.saveProxyProfile({ name: "Open", endpoint: { protocol: "http", host: "proxy.test", port: 8080 } })
    .proxyProfiles.find((item) => item.name === "Open");
  plain.controller.store.setGlobalRouting({ enabled: true, profileId: open.id });
  await plain.controller.applyGlobalRouting();
  assert.equal(relays.started.length, 0);
  assert.equal(plain.sessionFor("default").proxy.proxyRules, "http://proxy.test:8080");

  const broken = world(t, { startSignedRelay: async () => { throw new Error("worker unavailable"); } });
  const signed = broken.controller.store.saveProxyProfile({ name: "Decodo", endpoint: { protocol: "http", host: "isp.decodo.test", port: 10000 }, username: USER, password: PASS })
    .proxyProfiles.find((item) => item.name === "Decodo");
  broken.controller.store.setGlobalRouting({ enabled: true, profileId: signed.id });
  await broken.controller.applyGlobalRouting();
  assert.equal(broken.sessionFor("default").proxy.proxyRules, "http://isp.decodo.test:10000", "the app keeps working as before");
  assert.ok(broken.warnings.some(([event]) => event === "proxy.relay_failed"));
});

test("a refused sign-in is logged at most once a minute, naming no secret", async (t) => {
  const relays = fakeRelays();
  const { controller, warnings } = world(t, { startSignedRelay: relays.start });
  const profile = controller.store.saveProxyProfile({ name: "Decodo", endpoint: { protocol: "http", host: "isp.decodo.test", port: 10000 }, username: USER, password: PASS })
    .proxyProfiles.find((item) => item.name === "Decodo");
  controller.store.setGlobalRouting({ enabled: true, profileId: profile.id });
  await controller.applyGlobalRouting();
  relays.started[0].onEvent({ type: "rejected" });
  relays.started[0].onEvent({ type: "rejected" });
  const rejected = warnings.filter(([event]) => event === "proxy.relay_signin_rejected");
  assert.equal(rejected.length, 1);
  assert.doesNotMatch(JSON.stringify(rejected), /pa@ss|user-sp1/);
});
