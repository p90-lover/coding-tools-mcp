"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_GATEWAY_PORT,
  GATEWAY_PROFILE_ID,
  createProxyGateway,
  createProxyGatewayController,
  fetchGatewayTrace,
  validateGatewayPort,
  validateUpstream,
} = require("../electron/proxy-gateway.cjs");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const TRACE_BODY = "fl=1\nh=chatgpt.com\nip=203.0.113.7\nts=1\nloc=NL\ncolo=AMS\n";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      socket.pause();
      const rest = buffer.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(buffer.subarray(0, end + 4).toString("latin1"));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function readAll(socket) {
  return new Promise((resolve) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.resume();
  });
}

function readSome(socket, size) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < size) return;
      socket.off("data", onData);
      resolve(buffer.toString("utf8"));
    };
    socket.on("data", onData);
    socket.resume();
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function respondTrace(socket, seen) {
  const body = `${TRACE_BODY}seen=${seen}\n`;
  socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

// A fake upstream HTTP proxy that insists on Basic proxy authentication, echoes CONNECT tunnels and
// answers absolute-URI requests itself.
async function fakeHttpUpstream({ username, password }) {
  const requests = [];
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = net.createServer(async (socket) => {
    socket.on("error", () => {});
    const head = await readHead(socket);
    const lines = head.split("\r\n").filter(Boolean);
    const auth = lines.find((line) => /^proxy-authorization:/i.test(line))?.split(/:\s*/, 2)[1] ?? null;
    requests.push({ requestLine: lines[0], headers: lines.slice(1), auth });
    if (auth !== expected) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (/^CONNECT /.test(lines[0])) {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
      socket.resume();
      return;
    }
    respondTrace(socket, lines[0].split(" ")[1]);
  });
  const port = await listen(server);
  return { server, port, requests };
}

// A fake SOCKS5 proxy with RFC 1929 username/password authentication.
async function fakeSocksUpstream({ username, password }) {
  const connects = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let target = null;
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          const methods = [...buffer.subarray(2, 2 + buffer[1])];
          buffer = buffer.subarray(2 + buffer[1]);
          if (!methods.includes(0x02)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, 0x02]));
          stage = "auth";
        } else if (stage === "auth") {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 3 + userLength) return;
          const passLength = buffer[2 + userLength];
          if (buffer.length < 3 + userLength + passLength) return;
          const user = buffer.subarray(2, 2 + userLength).toString("utf8");
          const pass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString("utf8");
          buffer = buffer.subarray(3 + userLength + passLength);
          if (user !== username || pass !== password) {
            socket.end(Buffer.from([0x01, 0x01]));
            return;
          }
          socket.write(Buffer.from([0x01, 0x00]));
          stage = "request";
        } else if (stage === "request") {
          if (buffer.length < 5 || buffer[3] !== 0x03) return;
          const length = buffer[4];
          if (buffer.length < 7 + length) return;
          const host = buffer.subarray(5, 5 + length).toString("utf8");
          const port = buffer.readUInt16BE(5 + length);
          buffer = buffer.subarray(7 + length);
          target = `${host}:${port}`;
          connects.push(target);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = "relay";
        } else {
          if (!buffer.length) return;
          const text = buffer.toString("latin1");
          buffer = Buffer.alloc(0);
          if (target.endsWith(":80")) {
            if (text.includes("\r\n\r\n")) respondTrace(socket, text.split("\r\n", 1)[0].split(" ")[1]);
          } else {
            socket.write(`echo:${text}`);
          }
          return;
        }
      }
    };
    socket.on("data", onData);
  });
  const port = await listen(server);
  return { server, port, connects };
}

async function startGateway(upstream, overrides = {}) {
  const gateway = createProxyGateway({ port: 0, getUpstream: () => upstream, ...overrides });
  const address = await gateway.start();
  return { gateway, port: address.port };
}

async function connectTunnel(port, target) {
  const socket = await connect(port);
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic Y2xpZW50OnNlY3JldA==\r\n\r\n`);
  const head = await readHead(socket);
  return { socket, head };
}

test("the gateway relays CONNECT tunnels and plain HTTP through an authenticated HTTP upstream", async (t) => {
  const upstream = await fakeHttpUpstream({ username: "user-1", password: "p@ss:word" });
  t.after(() => close(upstream.server));
  const { gateway, port } = await startGateway({
    protocol: "http", host: "127.0.0.1", port: upstream.port, username: "user-1", password: "p@ss:word",
  });
  t.after(() => gateway.stop());

  const tunnel = await connectTunnel(port, "chatgpt.com:443");
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /);
  tunnel.socket.write("ping");
  assert.equal(await readSome(tunnel.socket, 9), "echo:ping");
  tunnel.socket.destroy();
  assert.equal(upstream.requests[0].requestLine, "CONNECT chatgpt.com:443 HTTP/1.1");
  assert.equal(upstream.requests[0].auth, `Basic ${Buffer.from("user-1:p@ss:word").toString("base64")}`,
    "the gateway sends the upstream's own credentials, never the client's");

  const plain = await connect(port);
  plain.write("GET http://example.test/cdn-cgi/trace?x=1 HTTP/1.1\r\nHost: example.test\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic Y2xpZW50OnNlY3JldA==\r\n\r\n");
  const response = await readAll(plain);
  assert.match(response, /^HTTP\/1\.1 200 OK/);
  assert.match(response, /seen=http:\/\/example\.test\/cdn-cgi\/trace\?x=1/);
  const forwarded = upstream.requests[1];
  assert.equal(forwarded.requestLine, "GET http://example.test/cdn-cgi/trace?x=1 HTTP/1.1");
  assert.ok(forwarded.headers.includes("Connection: close"));
  assert.ok(!forwarded.headers.some((line) => /^proxy-connection:/i.test(line)));
  assert.equal(forwarded.headers.filter((line) => /^proxy-authorization:/i.test(line)).length, 1);

  const trace = await fetchGatewayTrace({ port, url: "http://chatgpt.test/cdn-cgi/trace" });
  assert.equal(trace.ok, true);
  assert.equal(trace.ip, "203.0.113.7");
  assert.equal(trace.loc, "NL");

  const stats = gateway.stats();
  assert.equal(stats.tunnels, 1);
  assert.equal(stats.httpRequests, 2);
  assert.ok(stats.bytesReceived > 0 && stats.bytesSent > 0);
});

test("the gateway reports a rejected upstream login without leaking the credentials", async (t) => {
  const upstream = await fakeHttpUpstream({ username: "user-1", password: "right" });
  t.after(() => close(upstream.server));
  const warnings = [];
  const { gateway, port } = await startGateway(
    { protocol: "http", host: "127.0.0.1", port: upstream.port, username: "user-1", password: "wrong-secret" },
    { logger: { info() {}, warn: (event, detail) => warnings.push(JSON.stringify({ event, detail })) } },
  );
  t.after(() => gateway.stop());

  const tunnel = await connectTunnel(port, "chatgpt.com:443");
  assert.match(tunnel.head, /^HTTP\/1\.1 502 /);
  assert.match(await readAll(tunnel.socket), /rejected the saved credentials \(407\)/);
  assert.match(gateway.lastError().message, /407/);
  assert.equal(gateway.stats().failures, 1);
  assert.ok(warnings.length > 0);
  for (const line of [...warnings, JSON.stringify(gateway.stats()), gateway.lastError().message]) {
    assert.doesNotMatch(line, /wrong-secret/);
    assert.doesNotMatch(line, new RegExp(Buffer.from("user-1:wrong-secret").toString("base64")));
  }
});

test("the gateway relays CONNECT and plain HTTP through an authenticated SOCKS5 upstream", async (t) => {
  const upstream = await fakeSocksUpstream({ username: "socks-user", password: "socks-pass" });
  t.after(() => close(upstream.server));
  const { gateway, port } = await startGateway({
    protocol: "socks5", host: "127.0.0.1", port: upstream.port, username: "socks-user", password: "socks-pass",
  });
  t.after(() => gateway.stop());

  const tunnel = await connectTunnel(port, "chatgpt.com:443");
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /);
  tunnel.socket.write("hello");
  assert.equal(await readSome(tunnel.socket, 10), "echo:hello");
  tunnel.socket.destroy();

  const trace = await fetchGatewayTrace({ port, url: "http://chatgpt.test/cdn-cgi/trace" });
  assert.equal(trace.ip, "203.0.113.7");
  assert.equal(trace.loc, "NL");
  assert.deepEqual(upstream.connects, ["chatgpt.com:443", "chatgpt.test:80"]);

  const plain = await connect(port);
  plain.write("GET http://chatgpt.test/path HTTP/1.1\r\nHost: chatgpt.test\r\n\r\n");
  assert.match(await readAll(plain), /seen=\/path/, "SOCKS5 requests use the origin-form path");
});

test("the gateway rejects wrong SOCKS5 credentials, non-loopback clients and loopback targets", async (t) => {
  const upstream = await fakeSocksUpstream({ username: "socks-user", password: "socks-pass" });
  t.after(() => close(upstream.server));
  const { gateway, port } = await startGateway({
    protocol: "socks5", host: "127.0.0.1", port: upstream.port, username: "socks-user", password: "nope",
  });
  t.after(() => gateway.stop());

  const denied = await connectTunnel(port, "chatgpt.com:443");
  assert.match(denied.head, /^HTTP\/1\.1 502 /);
  assert.match(await readAll(denied.socket), /rejected the saved credentials/);

  const loop = await connectTunnel(port, "127.0.0.1:17894");
  assert.match(loop.head, /^HTTP\/1\.1 403 /);
  loop.socket.destroy();
  const local = await connect(port);
  local.write("GET http://localhost:8080/ HTTP/1.1\r\nHost: localhost:8080\r\n\r\n");
  assert.match(await readAll(local), /^HTTP\/1\.1 403 /);

  const remote = new net.Socket();
  Object.defineProperty(remote, "remoteAddress", { value: "192.0.2.10" });
  const before = gateway.stats().rejectedConnections;
  await gateway.handleConnection(remote);
  assert.equal(remote.destroyed, true);
  assert.equal(gateway.stats().rejectedConnections, before + 1);
  assert.throws(() => createProxyGateway({ host: "0.0.0.0", getUpstream: () => null }), /only listens on loopback/);
});

test("upstreams that loop back into ProxyBridge or the gateway are refused", () => {
  for (const port of [17891, 17892, 17893, 17894]) {
    assert.throws(() => validateUpstream({ protocol: "http", host: "127.0.0.1", port }), /points back/);
    assert.throws(() => validateUpstream({ protocol: "http", host: "localhost", port }), /points back/);
  }
  assert.throws(() => validateUpstream({ protocol: "http", host: "[::1]", port: 18000 }, { gatewayPort: 18000 }), /points back/);
  assert.throws(() => validateUpstream({ protocol: "socks4", host: "proxy.test", port: 1080 }), /HTTP, HTTPS or SOCKS5/);
  assert.deepEqual(
    validateUpstream({ protocol: "HTTP", host: "isp.example.test", port: 10000, username: "u", password: "p" }),
    { protocol: "http", host: "isp.example.test", port: 10000, username: "u", password: "p" },
  );
  assert.equal(validateUpstream({ protocol: "http", host: "127.0.0.1", port: 7890 }).port, 7890,
    "other local proxies remain valid upstreams");
  for (const port of [17891, 17892, 17893, 80, 70000]) assert.throws(() => validateGatewayPort(port));
  assert.equal(validateGatewayPort(17894), DEFAULT_GATEWAY_PORT);
});

function tempStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-gateway-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createProviderNetworkStore({
    filePath: path.join(directory, "providers", "provider-network.json"),
    keyPath: path.join(directory, "providers", "provider-network.key"),
    safeStorage: null,
  });
  store.saveProxyProfile({
    id: "proxybridge-local-17891",
    name: "ProxyBridge local HTTP :17891",
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17891 },
  });
  store.saveProxyProfile({
    id: "isp-upstream",
    name: "ISP upstream",
    endpoint: { protocol: "http", host: "isp.example.test", port: 10000 },
    username: "isp-user",
    password: "isp-password-value",
  });
  store.setGlobalRouting({ enabled: true, profileId: "proxybridge-local-17891" });
  return { directory, store };
}

function fakeGatewayFactory(calls, { failStart = false } = {}) {
  return (options) => {
    let running = false;
    calls.push({ port: options.port, upstream: () => options.getUpstream() });
    return {
      async start() {
        if (failStart) throw new Error(`Port ${options.port} is already in use; choose another gateway port`);
        running = true;
        return { host: options.host, port: options.port };
      },
      async stop() { running = false; },
      running: () => running,
      address: () => (running ? { host: options.host, port: options.port } : null),
      stats: () => ({ activeConnections: 0 }),
      lastError: () => null,
    };
  };
}

test("Use for this app routes the app through the gateway profile and restores the previous route", async (t) => {
  const { directory, store } = tempStore(t);
  const applied = [];
  const network = {
    store,
    applyGlobalRouting: async () => {
      applied.push(store.snapshot().routing.globalProfileId);
      return store.snapshot();
    },
  };
  const calls = [];
  const controller = createProxyGatewayController({
    userData: directory, network, createGateway: fakeGatewayFactory(calls),
  });

  await assert.rejects(controller.configure({ upstreamProfileId: "proxybridge-local-17891" }), /points back/);
  await assert.rejects(controller.configure({ upstreamProfileId: GATEWAY_PROFILE_ID }), /not found|own profile/);
  let status = await controller.configure({ upstreamProfileId: "isp-upstream" });
  assert.equal(status.upstream.name, "ISP upstream");
  assert.equal(status.running, false);

  status = await controller.setUseForApp(true);
  assert.equal(status.running, true);
  assert.equal(status.useForApp, true);
  assert.equal(calls[0].upstream().password, "isp-password-value", "credentials come from the encrypted store");
  const gatewayProfile = store.snapshot().proxyProfiles.find((profile) => profile.id === GATEWAY_PROFILE_ID);
  assert.deepEqual(gatewayProfile.endpoint, { protocol: "http", host: "127.0.0.1", port: 17894 });
  assert.equal(gatewayProfile.hasAuthentication, false);
  assert.ok(gatewayProfile.scopes.includes("all"));
  assert.deepEqual(store.snapshot().routing, {
    ...store.snapshot().routing, globalEnabled: true, globalProfileId: GATEWAY_PROFILE_ID,
  });
  assert.deepEqual(applied, [GATEWAY_PROFILE_ID]);
  assert.deepEqual(status.previousGlobal, { enabled: true, profileId: "proxybridge-local-17891" });

  const saved = fs.readFileSync(path.join(directory, "providers", "proxy-gateway.json"), "utf8");
  assert.deepEqual(JSON.parse(saved), {
    version: 1,
    enabled: true,
    port: 17894,
    upstreamProfileId: "isp-upstream",
    useForApp: true,
    previousGlobal: { enabled: true, profileId: "proxybridge-local-17891" },
  });
  assert.doesNotMatch(saved, /isp-password-value|isp-user/);

  status = await controller.setUseForApp(false);
  assert.equal(status.useForApp, false);
  assert.equal(status.running, true, "turning the switch off leaves the gateway itself running");
  assert.equal(store.snapshot().routing.globalProfileId, "proxybridge-local-17891");
  assert.equal(store.snapshot().routing.globalEnabled, true);
  assert.deepEqual(applied, [GATEWAY_PROFILE_ID, "proxybridge-local-17891"]);

  await controller.setUseForApp(true);
  status = await controller.setRunning(false);
  assert.equal(status.running, false);
  assert.equal(status.useForApp, false, "stopping the gateway never leaves the app on a closed port");
  assert.equal(store.snapshot().routing.globalProfileId, "proxybridge-local-17891");
});

test("launch starts an enabled gateway first and falls back to the previous route if it cannot", async (t) => {
  const { directory, store } = tempStore(t);
  const network = { store, applyGlobalRouting: async () => store.snapshot() };
  const first = createProxyGatewayController({ userData: directory, network, createGateway: fakeGatewayFactory([]) });
  await first.configure({ upstreamProfileId: "isp-upstream" });
  await first.setUseForApp(true);
  await first.close();
  assert.equal(store.snapshot().routing.globalProfileId, GATEWAY_PROFILE_ID, "quitting keeps the saved route");

  const relaunched = createProxyGatewayController({ userData: directory, network, createGateway: fakeGatewayFactory([]) });
  let status = await relaunched.startup();
  assert.equal(status.running, true);
  assert.equal(status.useForApp, true);
  await relaunched.close();

  const blocked = createProxyGatewayController({
    userData: directory, network, createGateway: fakeGatewayFactory([], { failStart: true }),
  });
  status = await blocked.startup();
  assert.equal(status.running, false);
  assert.match(status.lastError.message, /already in use/);
  assert.equal(status.useForApp, false);
  assert.equal(store.snapshot().routing.globalProfileId, "proxybridge-local-17891");
  assert.equal(store.snapshot().routing.globalEnabled, true);
});

test("Proxy Gateway is a More tab wired through guarded IPC", () => {
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const preload = read("electron/preload.cjs");
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const main = read("electron/main.cjs");
  const i18n = read("src/i18n.ts");
  const zhTW = read("src/i18n/locales/zh-TW.ts");
  const surface = read("src/features/ProxyGatewaySurface.tsx");

  assert.match(types, /export type Surface = [^;]*"proxy-gateway"/);
  const moreStart = app.indexOf('<details className="sidebar-more"');
  const more = app.slice(moreStart, app.indexOf("</details>", moreStart));
  assert.match(more, /navigateSurface\("proxy-gateway"\)/);
  assert.match(more, /copy\.proxyGateway/);
  assert.match(app, /extraSurfaceActive = [^;]*surface === "proxy-gateway"/);
  assert.match(app, /keepAlive\("proxy-gateway"/);
  assert.match(app, /<ProxyGatewaySurface/);
  assert.equal((i18n.match(/proxyGateway: "/g) || []).length, 3, "en, zh-CN and ja carry the tab label");
  assert.match(zhTW, /proxyGateway: "/);

  for (const api of ["proxyGatewayStatus", "configureProxyGateway", "setProxyGatewayRunning", "setProxyGatewayForApp", "testProxyGateway", "onProxyGatewayChanged"]) {
    assert.match(preload, new RegExp(`${api}:`), `preload exposes ${api}`);
    assert.match(types, new RegExp(`${api}\\(`), `types declare ${api}`);
  }
  for (const api of ["proxyGatewayStatus", "configureProxyGateway", "setProxyGatewayRunning", "setProxyGatewayForApp", "testProxyGateway"]) {
    assert.match(surface, new RegExp(`\\.${api}\\(`), `surface calls ${api}`);
  }
  assert.match(surface, /17891/);
  assert.match(surface, /cdn-cgi\/trace/);
  assert.match(bootstrap, /handleGateway\("launcher:proxy-gateway-status", [^\n]*\{ write: false \}/);
  for (const channel of ["configure", "running", "use-for-app", "test"]) {
    assert.match(bootstrap, new RegExp(`handleGateway\\("launcher:proxy-gateway-${channel}"`));
  }
  assert.match(bootstrap, /if \(write\) providerWriteGuard\(event\)/);
  assert.match(main, /setProviderWriteGuard\(\(event\) => assertFocusedMainWindow\(event, true\)\)/);
  // The gateway listens before the saved global route is applied at launch.
  assert.ok(bootstrap.indexOf("await gateway.startup()") < bootstrap.indexOf("controller.applyGlobalRouting()"));
});
