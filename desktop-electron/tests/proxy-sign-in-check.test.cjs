"use strict";

// Seen live 2026-11-15: Global Routing named a proxy whose saved sign-in the proxy refused (HTTP 407).
// Its Test said "64 ms" (a TCP connect only), the app's update check failed every few minutes with
// "Update download failed with HTTP 407", and nothing said the sign-in was the problem.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { Readable } = require("node:stream");

const { probeTcpOffThread } = require("../electron/off-thread-run.cjs");
const providerNetwork = require("../electron/provider-network.cjs");

const USER = "probe-user";
const PASSWORD = "probe-pass";

/** An HTTP proxy that answers CONNECT: 200 for the one sign-in, 407 for any other or none. */
async function httpProxy() {
  const heads = [];
  const server = net.createServer((socket) => {
    let text = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (!text.includes("\r\n\r\n")) return;
      heads.push(text);
      const expected = `Proxy-Authorization: Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
      socket.end(text.includes(expected)
        ? "HTTP/1.1 200 Connection established\r\n\r\n"
        : 'HTTP/1.1 407 Unauthorized\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, heads, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A SOCKS5 proxy (RFC 1928/1929) that wants the one username and password. */
async function socksProxy() {
  const server = net.createServer((socket) => {
    let stage = "greeting";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (stage === "greeting") {
        const offered = [...chunk.subarray(2, 2 + chunk[1])];
        if (!offered.includes(2)) { socket.end(Buffer.from([5, 0xff])); return; }
        stage = "sign-in";
        socket.write(Buffer.from([5, 2]));
        return;
      }
      const userLength = chunk[1];
      const user = chunk.subarray(2, 2 + userLength).toString("utf8");
      const pass = chunk.subarray(3 + userLength, 3 + userLength + chunk[2 + userLength]).toString("utf8");
      socket.end(Buffer.from([1, user === USER && pass === PASSWORD ? 0 : 1]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function scratch(t) {
  const base = path.resolve(__dirname, "../../aiTemp/tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "proxy-sign-in-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a proxy probe with a sign-in asks the proxy to connect and reads its answer", async () => {
  const proxy = await httpProxy();
  const probe = (signIn) => probeTcpOffThread({ host: "127.0.0.1", port: proxy.port, timeoutMs: 5_000,
    ...(signIn ? { proxy: { protocol: "http", target: "github.com:443", ...signIn } } : {}) });
  try {
    const accepted = await probe({ username: USER, password: PASSWORD });
    assert.equal(accepted.ok, true);
    assert.ok(Number.isFinite(accepted.latencyMs), `latency ${accepted.latencyMs}`);
    assert.match(proxy.heads[0], /^CONNECT github\.com:443 HTTP\/1\.1\r\nHost: github\.com:443\r\n/);

    const refused = await probe({ username: USER, password: "an-old-password" });
    assert.deepEqual([refused.ok, refused.code], [false, "PROXY_SIGN_IN_REFUSED"]);
    assert.equal(refused.message, "The proxy refused the saved sign-in (HTTP 407)");
    assert.ok(!refused.message.includes("an-old-password"), "the answer never carries the sign-in");

    const missing = await probe({ username: "", password: "" });
    assert.deepEqual([missing.ok, missing.code], [false, "PROXY_SIGN_IN_REFUSED"]);
    assert.equal(missing.message, "The proxy asks for a sign-in and none is saved (HTTP 407)");
    assert.doesNotMatch(proxy.heads[2], /Proxy-Authorization/i, "no sign-in header without a sign-in");

    // Without the sign-in check a probe is the TCP connect it always was: the port's other callers.
    const before = proxy.heads.length;
    assert.equal((await probe(null)).ok, true);
    assert.equal(proxy.heads.length, before, "a plain probe sends nothing");
  } finally { await proxy.close(); }
});

test("a SOCKS5 proxy's username and password are checked the same way", async () => {
  const proxy = await socksProxy();
  const probe = (signIn) => probeTcpOffThread({ host: "127.0.0.1", port: proxy.port, timeoutMs: 5_000,
    proxy: { protocol: "socks5", target: "github.com:443", ...signIn } });
  try {
    assert.equal((await probe({ username: USER, password: PASSWORD })).ok, true);
    const refused = await probe({ username: USER, password: "an-old-password" });
    assert.deepEqual([refused.ok, refused.code, refused.message], [false, "PROXY_SIGN_IN_REFUSED", "The proxy refused the saved sign-in"]);
    const missing = await probe({ username: "", password: "" });
    assert.deepEqual([missing.ok, missing.code, missing.message],
      [false, "PROXY_SIGN_IN_REFUSED", "The proxy asks for a sign-in and none is saved"]);
  } finally { await proxy.close(); }
});

test("the Proxy page's Test reports a refused sign-in, and the profile keeps it until the sign-in changes", async (t) => {
  const proxy = await httpProxy();
  const root = scratch(t);
  const store = providerNetwork.createProviderNetworkStore({ filePath: path.join(root, "provider-network.json"),
    keyPath: path.join(root, "provider-network.key"), safeStorage: null });
  const endpoint = { protocol: "http", host: "127.0.0.1", port: proxy.port };
  try {
    store.saveProxyProfile({ id: "p1", name: "Proxy", endpoint, username: USER, password: "an-old-password" });
    const shown = () => store.snapshot().proxyProfiles.find((item) => item.id === "p1");

    const refused = await providerNetwork.testProxyEndpoint(store.activeProxy("p1"), store.proxySecret("p1"));
    assert.deepEqual(refused, { reachable: false, signInRefused: true, error: "The proxy refused the saved sign-in (HTTP 407)" });
    store.recordProxyHealth("p1", refused);
    assert.deepEqual([shown().signInRefused, shown().lastError, shown().latencyMs],
      [true, "The proxy refused the saved sign-in (HTTP 407)", undefined]);

    // Renaming the proxy keeps what the last check found; a new sign-in is not what was refused.
    store.saveProxyProfile({ id: "p1", name: "Renamed", endpoint });
    assert.equal(shown().signInRefused, true);
    store.saveProxyProfile({ id: "p1", name: "Renamed", endpoint, password: PASSWORD });
    assert.deepEqual([shown().signInRefused, shown().lastError], [undefined, undefined]);

    const accepted = await providerNetwork.testProxyEndpoint(store.activeProxy("p1"), store.proxySecret("p1"));
    assert.equal(accepted.reachable, true);
    store.recordProxyHealth("p1", { reachable: false, signInRefused: true, error: "The proxy refused the saved sign-in (HTTP 407)" });
    store.recordProxyHealth("p1", accepted);
    assert.deepEqual([shown().signInRefused, shown().lastError, typeof shown().latencyMs], [undefined, undefined, "number"]);

    // A proxy that cannot be reached is still that, not a sign-in problem.
    await proxy.close();
    const down = await providerNetwork.testProxyEndpoint(store.activeProxy("p1"), store.proxySecret("p1"));
    assert.deepEqual([down.reachable, down.signInRefused], [false, undefined]);
  } finally {
    await proxy.close().catch(() => {});
    // The saves land before the scratch folder goes.
    await store.saved().catch(() => {});
  }
});

test("a request reports a sign-in the proxy refused, or took, once; with none offered it reports nothing", async () => {
  const { fetchNativeWithProxyAuth } = require("../electron/control-server.cjs");
  const authInfo = { isProxy: true, scheme: "basic", host: "proxy.invalid", port: 8080, realm: "test" };
  // Chromium asks again when the proxy answers 407 to the credentials it was given; with nothing
  // offered the second time it gives up and delivers the 407.
  const electronNet = (asks) => ({ request: () => {
    const request = Object.assign(new EventEmitter(), { abort() {}, end() {
      let asked = 0;
      const ask = () => request.emit("login", authInfo, (username) => {
        asked += 1;
        if (username && asked < asks) { queueMicrotask(ask); return; }
        request.emit("response", Object.assign(Readable.from([]), { statusCode: username ? 200 : 407, headers: {} }));
      });
      queueMicrotask(ask);
    } });
    return request;
  } });
  const call = async (asks, credentials) => {
    const heard = [];
    const response = await fetchNativeWithProxyAuth({ electronNet: electronNet(asks), browserSession: {}, url: "https://api.github.com/x",
      options: { method: "GET", headers: {} }, getProxyCredentials: () => credentials,
      onProxySignInRefused: (info) => heard.push(`refused ${info.host}:${info.port}`),
      onProxySignInAccepted: () => heard.push("accepted") });
    return [response.status, heard];
  };
  const saved = { username: USER, password: PASSWORD };
  assert.deepEqual(await call(1, saved), [200, ["accepted"]], "a sign-in the proxy took is reported as accepted");
  assert.deepEqual(await call(2, saved), [407, ["refused proxy.invalid:8080"]], "a refused one is reported once, and not as accepted");
  assert.deepEqual(await call(2, null), [407, []], "no saved sign-in: nothing was refused");
});

test("a refusal seen on the app's own request shows on the proxy and clears when the proxy takes the sign-in again", async (t) => {
  const root = scratch(t);
  const logged = [], published = [];
  const controller = providerNetwork.createProviderNetworkController({ app: {}, browserPartition: "fixture",
    getBrowserHost: () => null, logger: { info: (event) => logged.push(event), warn: (event) => logged.push(event) },
    onChanged: (snapshot) => published.push(snapshot.proxyProfiles.find((item) => item.id === "global")),
    safeStorage: null, session: {}, shell: {}, userData: root });
  controller.store.saveProxyProfile({ id: "global", name: "Global", endpoint: { protocol: "http", host: "proxy.example.test", port: 10000 },
    username: USER, password: PASSWORD });
  const shown = () => controller.store.snapshot().proxyProfiles.find((item) => item.id === "global");

  assert.equal(controller.noteProxySignInAccepted("global"), false, "nothing to clear on a proxy never refused");
  assert.equal(controller.noteProxySignInRefused("global"), true);
  assert.deepEqual([shown().signInRefused, shown().lastError], [true, "The proxy refused the saved sign-in (HTTP 407)"]);
  // Every later request refused the same way changes nothing: one write, one line in the log.
  assert.equal(controller.noteProxySignInRefused("global"), false);
  assert.equal(controller.noteProxySignInRefused("global"), false);
  assert.deepEqual(logged, ["proxy.sign_in_refused"]);
  assert.deepEqual(published.map((item) => item.signInRefused), [true]);

  assert.equal(controller.noteProxySignInAccepted("global"), true);
  assert.deepEqual([shown().signInRefused, shown().lastError, shown().latencyMs], [undefined, undefined, undefined]);
  assert.deepEqual(logged, ["proxy.sign_in_refused", "proxy.sign_in_accepted"]);
  assert.deepEqual(published.map((item) => item.signInRefused), [true, undefined]);
  // Refused again after that is news again.
  assert.equal(controller.noteProxySignInRefused("global"), true);
  assert.deepEqual(logged.at(-1), "proxy.sign_in_refused");
  assert.equal(controller.noteProxySignInRefused("unknown"), false, "a proxy that is gone is ignored");
  // The saves land before the scratch folder goes.
  await controller.store.saved();
});

test("the app's egress router signs every request, so its word on the sign-in is what the proxy shows", async (t) => {
  const root = scratch(t);
  const logged = [], published = [];
  let routerEvent = null;
  const proxied = { proxy: null, async setProxy(config) { this.proxy = config; }, async closeAllConnections() {} };
  const controller = providerNetwork.createProviderNetworkController({ app: {}, browserPartition: "fixture",
    getBrowserHost: () => ({ partition: "fixture" }), logger: { info: (event) => logged.push(event), warn: (event) => logged.push(event), error: (event) => logged.push(event) },
    onChanged: (snapshot) => published.push(snapshot.proxyProfiles.find((item) => item.id === "global").signInRefused),
    safeStorage: null, session: { defaultSession: proxied, fromPartition: () => proxied }, shell: {}, userData: root,
    startRouter: async ({ port, onEvent }) => { routerEvent = onEvent; return { port, running: true, setRoutes() {}, reconnect: async () => ({ closed: 0 }), stats: async () => ({}), close: async () => {} }; } });
  controller.store.saveProxyProfile({ id: "global", name: "Global", endpoint: { protocol: "http", host: "proxy.example.test", port: 10000 },
    username: USER, password: PASSWORD });
  controller.store.setGlobalRouting({ enabled: true, profileId: "global" });
  await controller.applyGlobalRouting();
  assert.match(proxied.proxy.proxyRules, /^http:\/\/127\.0\.0\.1:\d+$/, "the window goes through the router");
  const shown = () => controller.store.snapshot().proxyProfiles.find((item) => item.id === "global");

  routerEvent({ type: "signin", profileId: "global", ok: false });
  routerEvent({ type: "signin", profileId: "global", ok: false });
  assert.deepEqual([shown().signInRefused, shown().lastError], [true, "The proxy refused the saved sign-in (HTTP 407)"]);
  assert.deepEqual(logged.filter((event) => /sign/.test(event)), ["proxy.sign_in_refused"], "logged once");
  routerEvent({ type: "signin", profileId: "global", ok: true });
  assert.deepEqual([shown().signInRefused, shown().lastError], [undefined, undefined]);
  assert.deepEqual(published, [true, undefined]);
  await controller.store.saved();
});

test("an update the proxy answers 407 says the proxy's sign-in is the problem", async (testContext) => {
  const https = require("node:https");
  const update = require("../electron/update.cjs");
  testContext.mock.method(https, "get", () => assert.fail("a refused sign-in must not send the update around the proxy"));
  update.useNativeUpdateTransport(async () => new Response(null, { status: 407 }));
  try {
    await assert.rejects(update.downloadText("https://api.github.com/x"), (error) => {
      assert.equal(error.message, "The proxy refused its sign-in (HTTP 407). Check the proxy's sign-in on the Proxy page.");
      return true;
    });
    assert.equal(https.get.mock.callCount(), 0);
  } finally { update.useNativeUpdateTransport(null); }
});
