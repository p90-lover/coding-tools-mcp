"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  DEFAULT_GATEWAY_PORT,
  createProxyGateway,
  fetchGatewayTrace,
  isLoopbackHost,
  readConfigLine,
  validateGatewayPort,
  validateUpstream,
} = require("../electron/proxy-gateway-relay.cjs");
const {
  GATEWAY_PROFILE_ID,
  compareVersionNames,
  createProxyGatewayController,
} = require("../electron/proxy-gateway.cjs");
const { createProviderNetworkController, createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { proxyRouteFromEnvironment } = require("../electron/chatgpt-desktop.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const TRACE_BODY = "fl=1\nh=chatgpt.com\nip=203.0.113.7\nts=1\nloc=NL\ncolo=AMS\n";
const TOKEN = "a".repeat(64);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
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

const auth = (token, separator = ":") => (token
  ? `Proxy-Authorization${separator} Basic ${Buffer.from(`ct:${token}`).toString("base64")}\r\n`
  : "");

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
    const head = await readHead(socket).catch(() => null);
    if (!head) return;
    const lines = head.split("\r\n").filter(Boolean);
    const authLine = lines.find((line) => /^proxy-authorization\s*:/i.test(line));
    const value = authLine ? authLine.slice(authLine.indexOf(":") + 1).trim() : null;
    requests.push({ requestLine: lines[0], headers: lines.slice(1), auth: value });
    if (value !== expected) {
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
async function fakeSocksUpstream({ username, password, replyAddressType = 0x01 }) {
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
          socket.write(Buffer.from([0x05, 0x00, 0x00, replyAddressType, 0, 0, 0, 0, 0, 0]));
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
  const gateway = createProxyGateway({ port: 0, tokenlessPort: 0, proxyToken: TOKEN, getUpstream: () => upstream, ...overrides });
  const address = await gateway.start();
  return { gateway, port: address.port, tokenlessPort: address.tokenlessPort };
}

async function connectTunnel(port, target, token = TOKEN, separator = ":") {
  const socket = await connect(port);
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth(token, separator)}\r\n`);
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
  plain.write(`GET http://example.test/cdn-cgi/trace?x=1 HTTP/1.1\r\nHost: example.test\r\nProxy-Connection : keep-alive\r\n${auth(TOKEN, " :")}\r\n`);
  const response = await readAll(plain);
  assert.match(response, /^HTTP\/1\.1 200 OK/);
  assert.match(response, /seen=http:\/\/example\.test\/cdn-cgi\/trace\?x=1/);
  const forwarded = upstream.requests[1];
  assert.equal(forwarded.requestLine, "GET http://example.test/cdn-cgi/trace?x=1 HTTP/1.1");
  assert.ok(forwarded.headers.includes("Connection: close"));
  assert.ok(!forwarded.headers.some((line) => /^proxy-connection\s*:/i.test(line)),
    "a hop-by-hop header with space before the colon is still stripped");
  assert.equal(forwarded.headers.filter((line) => /^proxy-authorization\s*:/i.test(line)).length, 1);
  assert.doesNotMatch(forwarded.headers.join("\n"), new RegExp(Buffer.from(`ct:${TOKEN}`).toString("base64")));

  const trace = await fetchGatewayTrace({ port, proxyToken: TOKEN, url: "http://chatgpt.test/cdn-cgi/trace" });
  assert.equal(trace.ok, true);
  assert.equal(trace.ip, "203.0.113.7");
  assert.equal(trace.loc, "NL");

  const stats = gateway.stats();
  assert.equal(stats.tunnels, 1);
  assert.equal(stats.httpRequests, 2);
  assert.ok(stats.bytesReceived > 0 && stats.bytesSent > 0);
});

test("the data port answers 407 without the local token; the token-free port serves without one", async (t) => {
  const upstream = await fakeHttpUpstream({ username: "user-1", password: "secret-1" });
  t.after(() => close(upstream.server));
  const { gateway, port, tokenlessPort } = await startGateway({
    protocol: "http", host: "127.0.0.1", port: upstream.port, username: "user-1", password: "secret-1",
  });
  t.after(() => gateway.stop());

  for (const token of [null, "b".repeat(64)]) {
    const denied = await connectTunnel(port, "chatgpt.com:443", token);
    assert.match(denied.head, /^HTTP\/1\.1 407 /);
    assert.match(denied.head, /Proxy-Authenticate: Basic/);
    denied.socket.destroy();
  }
  assert.equal(upstream.requests.length, 0, "an unauthenticated client never reaches the paid upstream");
  assert.equal(gateway.stats().authFailures, 2);

  const open = await connectTunnel(tokenlessPort, "chatgpt.com:443", null);
  assert.match(open.head, /^HTTP\/1\.1 200 /);
  open.socket.write("desktop");
  assert.equal(await readSome(open.socket, 12), "echo:desktop");
  open.socket.destroy();

  // The token-free listener can be closed and reopened without touching the data port.
  await gateway.closeTokenless();
  assert.equal(gateway.address().tokenlessPort, null);
  await assert.rejects(connect(tokenlessPort), /ECONNREFUSED/);
  const reopened = await gateway.openTokenless();
  const again = await connectTunnel(reopened.tokenlessPort, "chatgpt.com:443", null);
  assert.match(again.head, /^HTTP\/1\.1 200 /);
  again.socket.destroy();

  // ChatGPT Desktop never puts credentials on its command line: the env route with a key is refused.
  assert.equal(proxyRouteFromEnvironment({ HTTPS_PROXY: `http://ct:${TOKEN}@127.0.0.1:17894` }), null);
});

test("the helper's config line survives a multibyte character split across chunks", async () => {
  const { PassThrough } = require("node:stream");
  const stream = new PassThrough();
  const pending = readConfigLine(stream);
  const bytes = Buffer.from(`${JSON.stringify({ password: "密碼-pässwörd" })}\n`, "utf8");
  const split = bytes.indexOf(Buffer.from("密", "utf8")) + 1;
  stream.write(bytes.subarray(0, split));
  stream.write(bytes.subarray(split));
  assert.deepEqual(await pending, { password: "密碼-pässwörd" });
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

  const trace = await fetchGatewayTrace({ port, proxyToken: TOKEN, url: "http://chatgpt.test/cdn-cgi/trace" });
  assert.equal(trace.ip, "203.0.113.7");
  assert.equal(trace.loc, "NL");
  assert.deepEqual(upstream.connects, ["chatgpt.com:443", "chatgpt.test:80"]);

  const plain = await connect(port);
  plain.write(`GET http://chatgpt.test/path HTTP/1.1\r\nHost: chatgpt.test\r\n${auth(TOKEN)}\r\n`);
  assert.match(await readAll(plain), /seen=\/path/, "SOCKS5 requests use the origin-form path");
});

test("a SOCKS5 reply with an unknown address type is refused", async (t) => {
  const upstream = await fakeSocksUpstream({ username: "u", password: "p", replyAddressType: 0x05 });
  t.after(() => close(upstream.server));
  const { gateway, port } = await startGateway({ protocol: "socks5", host: "127.0.0.1", port: upstream.port, username: "u", password: "p" });
  t.after(() => gateway.stop());
  const tunnel = await connectTunnel(port, "chatgpt.com:443");
  assert.match(tunnel.head, /^HTTP\/1\.1 502 /);
  assert.match(await readAll(tunnel.socket), /unknown address type 5/);
});

test("the gateway rejects wrong SOCKS5 credentials, non-loopback clients and every loopback target spelling", async (t) => {
  const upstream = await fakeSocksUpstream({ username: "socks-user", password: "socks-pass" });
  t.after(() => close(upstream.server));
  const { gateway, port } = await startGateway({
    protocol: "socks5", host: "127.0.0.1", port: upstream.port, username: "socks-user", password: "nope",
  });
  t.after(() => gateway.stop());

  const denied = await connectTunnel(port, "chatgpt.com:443");
  assert.match(denied.head, /^HTTP\/1\.1 502 /);
  assert.match(await readAll(denied.socket), /rejected the saved credentials/);

  for (const target of ["127.0.0.1:17894", "2130706433:443", "0177.0.0.1:443", "[::ffff:7f00:1]:443", "localhost.:443", "[::1]:443", "0x7f.1:443"]) {
    const loop = await connectTunnel(port, target);
    assert.match(loop.head, /^HTTP\/1\.1 403 /, target);
    loop.socket.destroy();
  }
  const local = await connect(port);
  local.write(`GET http://localhost.:8080/ HTTP/1.1\r\nHost: localhost:8080\r\n${auth(TOKEN)}\r\n`);
  assert.match(await readAll(local), /^HTTP\/1\.1 403 /);

  const remote = new net.Socket();
  Object.defineProperty(remote, "remoteAddress", { value: "192.0.2.10" });
  const before = gateway.stats().rejectedConnections;
  await gateway.handleConnection(remote);
  assert.equal(remote.destroyed, true);
  assert.equal(gateway.stats().rejectedConnections, before + 1);
  assert.throws(() => createProxyGateway({ host: "0.0.0.0", proxyToken: TOKEN, getUpstream: () => null }), /only listens on loopback/);
});

test("bare LF and NUL inside the request head are refused before anything is relayed", async (t) => {
  const upstream = await fakeHttpUpstream({ username: "u", password: "p" });
  t.after(() => close(upstream.server));
  const { gateway, port } = await startGateway({ protocol: "http", host: "127.0.0.1", port: upstream.port, username: "u", password: "p" });
  t.after(() => gateway.stop());
  for (const head of [
    `GET http://example.test/ HTTP/1.1\r\nHost: example.test\nProxy-Authorization: Basic eDp5\r\n${auth(TOKEN)}\r\n`,
    `GET http://example.test/ HTTP/1.1\r\nHost: exa\0mple.test\r\n${auth(TOKEN)}\r\n`,
    `GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n folded: value\r\n${auth(TOKEN)}\r\n`,
  ]) {
    const socket = await connect(port);
    socket.write(head);
    assert.match(await readAll(socket), /^HTTP\/1\.1 400 /);
  }
  assert.equal(upstream.requests.length, 0);
});

test("a slow client cannot hold a slot past the fixed header deadline", async (t) => {
  const { gateway, port } = await startGateway({ protocol: "http", host: "proxy.test", port: 8080 }, { headerTimeoutMs: 200 });
  t.after(() => gateway.stop());
  const socket = await connect(port);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const trickle = setInterval(() => socket.write("X"), 50);
  socket.on("error", () => {});
  const started = Date.now();
  await closed;
  clearInterval(trickle);
  assert.ok(Date.now() - started < 1_500, "trickled bytes do not extend the deadline");
});

test("concurrent starts share one listener attempt", async (t) => {
  const port = await freePort();
  const gateway = createProxyGateway({ port, tokenlessPort: null, proxyToken: TOKEN, getUpstream: () => null });
  t.after(() => gateway.stop());
  const [first, second] = await Promise.all([gateway.start(), gateway.start()]);
  assert.deepEqual(first, second);
  assert.equal(first.port, port);
});

test("upstreams that loop back into ProxyBridge or the gateway are refused in every spelling", () => {
  for (const port of [17891, 17892, 17893, 17894, 17895]) {
    for (const host of ["127.0.0.1", "localhost", "localhost.", "2130706433", "0177.0.0.1", "::ffff:7f00:1", "[::1]"]) {
      assert.throws(() => validateUpstream({ protocol: "http", host, port }), /points back/, `${host}:${port}`);
    }
  }
  assert.throws(() => validateUpstream({ protocol: "http", host: "[::1]", port: 18000 }, { gatewayPorts: [18000] }), /points back/);
  assert.throws(() => validateUpstream({ protocol: "socks4", host: "proxy.test", port: 1080 }), /HTTP, HTTPS or SOCKS5/);
  assert.deepEqual(
    validateUpstream({ protocol: "HTTP", host: "ISP.example.test", port: 10000, username: "u", password: "p" }),
    { protocol: "http", host: "isp.example.test", port: 10000, username: "u", password: "p" },
  );
  assert.equal(validateUpstream({ protocol: "http", host: "127.0.0.1", port: 7890 }).port, 7890,
    "other local proxies remain valid upstreams");
  for (const port of [17891, 17892, 17893, 80, 70000]) assert.throws(() => validateGatewayPort(port));
  assert.equal(validateGatewayPort(17894), DEFAULT_GATEWAY_PORT);
  assert.equal(isLoopbackHost("::ffff:10.0.0.1"), false);
  assert.equal(isLoopbackHost("example.com"), false);
});

// ---- The detached helper and its controller ------------------------------------------------

function tempSetup(t) {
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
  store.setGlobalRouting({ enabled: true, profileId: "proxybridge-local-17891" });
  const applied = [];
  let environmentRoute = null;
  const network = {
    store,
    applyGlobalRouting: async () => {
      applied.push(store.snapshot().routing.globalProfileId);
      return store.snapshot();
    },
    setEnvironmentRoute: (resolver) => {
      environmentRoute = resolver;
    },
  };
  return { directory, store, network, applied, environmentRoute: () => environmentRoute };
}

const pids = new Set();

function trackHelpers(t) {
  t.after(async () => {
    for (const pid of pids) {
      if (processAlive(pid)) {
        try {
          process.kill(pid);
        } catch {}
      }
    }
    await waitFor(() => [...pids].every((pid) => !processAlive(pid)));
    pids.clear();
  });
}

function controllerFor(setup, spawns, options = {}) {
  return createProxyGatewayController({
    userData: setup.directory,
    network: setup.network,
    resolveRuntime: () => ({ executable: process.execPath, args: [], env: {}, kind: "node" }),
    spawnProcess: (executable, args, spawnOptions) => {
      const child = spawn(executable, args, spawnOptions);
      spawns.push({ executable, args, env: spawnOptions.env, pid: child.pid });
      pids.add(child.pid);
      return child;
    },
    watchdogMs: 0,
    ...options,
  });
}

async function addUpstream(setup, t, { username = "isp-user", password = "isp-password-value" } = {}) {
  const upstream = await fakeHttpUpstream({ username, password });
  t.after(() => close(upstream.server));
  setup.store.saveProxyProfile({
    id: "isp-upstream",
    name: "ISP upstream",
    endpoint: { protocol: "http", host: "127.0.0.1", port: upstream.port },
    username,
    password,
  });
  return upstream;
}

function gatewayToken(store) {
  return store.proxySecret(GATEWAY_PROFILE_ID)?.password;
}

test("Use for this app runs a detached helper, routes through it with a local token and restores the previous route", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  const upstream = await addUpstream(setup, t);
  const spawns = [];
  const controller = controllerFor(setup, spawns);
  const [port, tokenlessPort] = [await freePort(), await freePort()];

  await assert.rejects(controller.configure({ upstreamProfileId: "proxybridge-local-17891" }), /points back/);
  await assert.rejects(controller.configure({ upstreamProfileId: GATEWAY_PROFILE_ID }), /own profile/);
  let status = await controller.configure({ upstreamProfileId: "isp-upstream", port, tokenlessPort });
  assert.equal(status.upstream.name, "ISP upstream");
  assert.equal(status.running, false);

  status = await controller.setUseForApp(true);
  assert.equal(status.running, true);
  assert.equal(status.useForApp, true);
  assert.equal(spawns.length, 1);
  const pid = status.helper.pid;
  assert.notEqual(pid, process.pid, "the relay runs in its own process");

  const gatewayProfile = setup.store.snapshot().proxyProfiles.find((profile) => profile.id === GATEWAY_PROFILE_ID);
  assert.deepEqual(gatewayProfile.endpoint, { protocol: "http", host: "127.0.0.1", port });
  assert.equal(gatewayProfile.hasAuthentication, true, "Chromium and CPA get the local token from the store");
  const token = gatewayToken(setup.store);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(setup.store.snapshot().routing.globalProfileId, GATEWAY_PROFILE_ID);
  assert.deepEqual(setup.applied, [GATEWAY_PROFILE_ID]);
  const envRoute = setup.environmentRoute()(gatewayProfile);
  assert.deepEqual(envRoute, { url: `http://ct:${token}@127.0.0.1:${port}` },
    "children get the key in their env route; no token-free URL reaches every child");

  const denied = await connectTunnel(port, "chatgpt.com:443", null);
  assert.match(denied.head, /^HTTP\/1\.1 407 /);
  denied.socket.destroy();
  const tunnel = await connectTunnel(port, "chatgpt.com:443", token);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /);
  tunnel.socket.write("ping");
  assert.equal(await readSome(tunnel.socket, 9), "echo:ping");
  tunnel.socket.destroy();
  assert.equal(status.tokenlessOpen, false, "the token-free port is closed by default");
  await assert.rejects(connect(tokenlessPort), /ECONNREFUSED/);
  assert.equal(upstream.requests.at(-1).auth, `Basic ${Buffer.from("isp-user:isp-password-value").toString("base64")}`);

  // Upstream credentials never reach argv, the helper env, the settings, state or log files, and
  // the access key's only stored copy is the encrypted profile secret.
  const providers = path.join(setup.directory, "providers");
  const state = JSON.parse(fs.readFileSync(path.join(providers, "proxy-gateway.state.json"), "utf8"));
  assert.equal(state.pid, pid);
  assert.equal(state.dataPort, port);
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(state, "proxyToken"), false);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(token));
  await waitFor(() => fs.existsSync(path.join(providers, "proxy-gateway.log")) && fs.readFileSync(path.join(providers, "proxy-gateway.log"), "utf8").includes("helper_ready"));
  for (const [label, text] of [
    ["argv", JSON.stringify(spawns.map((entry) => [entry.executable, ...entry.args]))],
    ["env", JSON.stringify(spawns.map((entry) => entry.env))],
    ["settings", fs.readFileSync(path.join(providers, "proxy-gateway.json"), "utf8")],
    ["state", fs.readFileSync(path.join(providers, "proxy-gateway.state.json"), "utf8")],
    ["log", fs.readFileSync(path.join(providers, "proxy-gateway.log"), "utf8")],
  ]) {
    assert.doesNotMatch(text, /isp-password-value/, label);
    assert.doesNotMatch(text, /isp-user/, label);
  }

  status = await controller.setUseForApp(false);
  assert.equal(status.useForApp, false);
  assert.equal(status.running, true, "turning the switch off leaves the gateway itself running");
  assert.equal(setup.store.snapshot().routing.globalProfileId, "proxybridge-local-17891");
  assert.equal(setup.store.snapshot().routing.globalEnabled, true);

  await controller.setUseForApp(true);
  setup.applied.length = 0;
  status = await controller.setRunning(false);
  assert.equal(status.running, false);
  assert.equal(status.useForApp, false, "stopping the gateway never leaves the app on a closed port");
  assert.deepEqual(setup.applied, ["proxybridge-local-17891"], "the route moves back before the helper stops");
  assert.ok(await waitFor(() => !processAlive(pid)), "a user stop ends the helper");
  assert.equal(fs.existsSync(path.join(providers, "proxy-gateway.state.json")), false);
});

test("an app restart adopts the running helper and its open tunnels keep flowing", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const firstSpawns = [];
  const first = controllerFor(setup, firstSpawns);
  await first.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await first.setUseForApp(true);
  const token = gatewayToken(setup.store);
  const tunnel = await connectTunnel(started.listen.port, "chatgpt.com:443", token);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /);

  await first.close();
  assert.ok(processAlive(started.helper.pid), "a normal quit leaves the helper running");

  const secondSpawns = [];
  const second = controllerFor(setup, secondSpawns);
  const adopted = await second.startup();
  assert.equal(secondSpawns.length, 0, "nothing new is spawned");
  assert.equal(adopted.running, true);
  assert.equal(adopted.helper.pid, started.helper.pid);
  assert.equal(adopted.helper.adopted, true);
  assert.equal(adopted.useForApp, true);
  assert.equal(gatewayToken(setup.store), token, "an adopted helper keeps its token, so children keep working");

  tunnel.socket.write("still-here");
  assert.equal(await readSome(tunnel.socket, 15), "echo:still-here");
  tunnel.socket.destroy();
  const fresh = await connectTunnel(adopted.listen.port, "chatgpt.com:443", token);
  assert.match(fresh.head, /^HTTP\/1\.1 200 /);
  fresh.socket.destroy();
  await second.setRunning(false);
});

test("a changed upstream identity makes the next app restart replace the helper with the same access key", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const first = controllerFor(setup, []);
  await first.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await first.setUseForApp(true);
  const oldToken = gatewayToken(setup.store);
  await first.close();

  const replacement = await fakeHttpUpstream({ username: "other-user", password: "other-pass" });
  t.after(() => close(replacement.server));
  setup.store.saveProxyProfile({
    id: "isp-upstream",
    name: "ISP upstream",
    endpoint: { protocol: "http", host: "127.0.0.1", port: replacement.port },
    username: "other-user",
    password: "other-pass",
  });
  const spawns = [];
  const second = controllerFor(setup, spawns);
  const status = await second.startup();
  assert.equal(spawns.length, 1);
  assert.notEqual(status.helper.pid, started.helper.pid);
  assert.ok(await waitFor(() => !processAlive(started.helper.pid)), "the old helper was stopped");
  assert.equal(gatewayToken(setup.store), oldToken, "kept background services never meet a 407");
  const tunnel = await connectTunnel(status.listen.port, "chatgpt.com:443", oldToken);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /);
  tunnel.socket.destroy();
  assert.equal(replacement.requests.length, 1);

  // A credential save and a port change replace the helper too, still with the same key.
  const portChanged = await second.configure({ port: await freePort() });
  assert.notEqual(portChanged.helper.pid, status.helper.pid);
  assert.equal(gatewayToken(setup.store), oldToken);
  const restarted = await second.refreshUpstream({ credentialsChanged: true });
  assert.notEqual(restarted.helper.pid, portChanged.helper.pid);
  assert.equal(gatewayToken(setup.store), oldToken);
  const denied = await connectTunnel(restarted.listen.port, "chatgpt.com:443", "f".repeat(64));
  assert.match(denied.head, /^HTTP\/1\.1 407 /);
  denied.socket.destroy();
  const probe = await connectTunnel(restarted.listen.port, "chatgpt.com:443", oldToken);
  assert.doesNotMatch(probe.head, /^HTTP\/1\.1 407 /, "the replacement helper accepts the kept key");
  probe.socket.destroy();
  await second.setRunning(false);
});

test("New access key is the one action that rotates the key, and the old key stops working", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const controller = controllerFor(setup, []);
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await controller.setUseForApp(true);
  const oldToken = gatewayToken(setup.store);
  setup.applied.length = 0;

  const rotated = await controller.rotateAccessKey();
  const newToken = gatewayToken(setup.store);
  assert.match(newToken, /^[0-9a-f]{64}$/);
  assert.notEqual(newToken, oldToken);
  assert.notEqual(rotated.helper.pid, started.helper.pid);
  assert.equal(rotated.useForApp, true);
  assert.deepEqual(setup.applied, [GATEWAY_PROFILE_ID], "the env route is re-applied with the new key");
  assert.equal(setup.environmentRoute()(setup.store.snapshot().proxyProfiles.find((profile) => profile.id === GATEWAY_PROFILE_ID)).url,
    `http://ct:${newToken}@127.0.0.1:${rotated.listen.port}`);
  const stale = await connectTunnel(rotated.listen.port, "chatgpt.com:443", oldToken);
  assert.match(stale.head, /^HTTP\/1\.1 407 /);
  stale.socket.destroy();
  const fresh = await connectTunnel(rotated.listen.port, "chatgpt.com:443", newToken);
  assert.match(fresh.head, /^HTTP\/1\.1 200 /);
  fresh.socket.destroy();

  await controller.close();
  const relaunched = controllerFor(setup, []);
  const adopted = await relaunched.startup();
  assert.equal(adopted.helper.pid, rotated.helper.pid, "the rotated helper is adopted as usual");
  assert.equal(gatewayToken(setup.store), newToken);
  await relaunched.setRunning(false);
});

function staleState(pid, dataPort, controlPort) {
  return {
    version: 2,
    pid,
    ownerPid: 1,
    dataPort,
    tokenlessPort: 17895,
    controlPort,
    controlToken: "c".repeat(64),
    upstreamProfileId: "isp-upstream",
    fingerprint: "e".repeat(64),
    runtime: "node",
    startedAt: new Date().toISOString(),
  };
}

test("a stale state file is discarded without signalling a pid it cannot verify", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const seed = controllerFor(setup, []);
  await seed.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  await seed.setRunning(true);
  await seed.setRunning(false);

  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => dead.once("exit", resolve));
  const statePath = path.join(setup.directory, "providers", "proxy-gateway.state.json");
  for (const pid of [dead.pid, process.pid]) {
    // A dead pid, or a live pid that does not hold the data port (a reused pid).
    fs.writeFileSync(statePath, JSON.stringify(staleState(pid, await freePort(), await freePort())));
    const spawns = [];
    const controller = controllerFor(setup, spawns);
    const status = await controller.setRunning(true);
    assert.equal(spawns.length, 1, `a fresh helper replaces the stale state for pid ${pid}`);
    assert.equal(status.running, true);
    assert.ok(processAlive(process.pid), "the unrelated live pid was not signalled");
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).pid, status.helper.pid);
    await controller.setRunning(false);
  }
});

test("a lost upstream takes the app off the gateway instead of leaving every request 502", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const controller = controllerFor(setup, []);
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await controller.setUseForApp(true);
  setup.store.archiveProxyProfile("isp-upstream");
  setup.applied.length = 0;
  const status = await controller.refreshUpstream();
  assert.equal(status.useForApp, false);
  assert.equal(status.running, false);
  assert.match(status.lastError.message, /not found or is disabled/);
  assert.equal(setup.store.snapshot().routing.globalProfileId, "proxybridge-local-17891");
  assert.deepEqual(setup.applied, ["proxybridge-local-17891"]);
  assert.ok(await waitFor(() => !processAlive(started.helper.pid)));
});

test("launch falls back to the previous route when the helper can be neither adopted nor started", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const first = controllerFor(setup, []);
  await first.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await first.setUseForApp(true);
  await first.close();
  process.kill(started.helper.pid);
  assert.ok(await waitFor(() => !processAlive(started.helper.pid)));

  const blocked = controllerFor(setup, [], {
    resolveRuntime: () => {
      throw new Error("The bundled runtime is not installed yet");
    },
  });
  const status = await blocked.startup();
  assert.equal(status.running, false);
  assert.match(status.lastError.message, /not installed yet/);
  assert.equal(status.useForApp, false);
  assert.equal(setup.store.snapshot().routing.globalProfileId, "proxybridge-local-17891");
  assert.equal(setup.store.snapshot().routing.globalEnabled, true);
});

test("concurrent gateway starts spawn one helper", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const spawns = [];
  const controller = controllerFor(setup, spawns);
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const [first, second] = await Promise.all([controller.setRunning(true), controller.setRunning(true)]);
  assert.equal(spawns.length, 1);
  assert.equal(first.helper.pid, second.helper.pid);
  await controller.setRunning(false);
});

test("the token-free port is closed by default, open while ChatGPT Desktop runs and closed after", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const controller = controllerFor(setup, [], { tokenlessHoldMs: 150 });
  const tokenlessPort = await freePort();
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort });
  assert.equal(await controller.desktopRoute(), null, "no token-free route while the app does not use the gateway");
  const started = await controller.setUseForApp(true);
  assert.equal(started.tokenlessOpen, false);
  await assert.rejects(connect(tokenlessPort), /ECONNREFUSED/);

  const route = await controller.desktopRoute();
  assert.equal(route.url, `http://127.0.0.1:${tokenlessPort}`, "a ChatGPT Desktop launch gets the token-free port");
  assert.ok(route.bypass.includes("localhost"));
  const tunnel = await connectTunnel(tokenlessPort, "chatgpt.com:443", null);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /);
  tunnel.socket.destroy();
  await controller.setDesktopRunning(true);
  await sleep(250);
  assert.equal((await controller.status()).tokenlessOpen, true, "a tracked instance keeps it open past the launch hold");
  await controller.setDesktopRunning(false);
  assert.equal((await controller.status()).tokenlessOpen, false, "the last instance's exit closes it");
  await assert.rejects(connect(tokenlessPort), /ECONNREFUSED/);

  // The app quits or crashes with the port open: the next app closes it when it adopts the helper.
  await controller.desktopRoute();
  assert.equal((await controller.status()).tokenlessOpen, true);
  const relaunched = controllerFor(setup, [], { tokenlessHoldMs: 150 });
  const adopted = await relaunched.startup();
  assert.equal(adopted.helper.adopted, true);
  assert.equal(adopted.tokenlessOpen, false);
  await relaunched.setRunning(false);
});

test("a live helper that misses verification keeps its state and is never signalled", async (t) => {
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const sockets = new Set();
  const keep = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  };
  const holder = net.createServer(keep);
  const silent = net.createServer(keep);
  const dataPort = await listen(holder);
  const controlPort = await listen(silent);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(holder), close(silent)]);
  });
  const controller = controllerFor(setup, [], { controlTimeoutMs: 150, verifyRetryDelaysMs: [50, 100] });
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const statePath = path.join(setup.directory, "providers", "proxy-gateway.state.json");
  const state = staleState(process.pid, dataPort, controlPort);
  fs.writeFileSync(statePath, JSON.stringify(state));

  await assert.rejects(controller.setRunning(true), /unverified helper \(pid \d+\) holds the gateway port/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), state, "the state and its control token are kept");
  const status = await controller.status();
  assert.equal(status.helperState, "unverified");
  assert.equal(status.unverifiedHelper.pid, process.pid);
  assert.ok(processAlive(process.pid), "the pid was not signalled");
});

test("the proxy login answers only the challenger the global route names", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-login-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const network = createProviderNetworkController({
    app: {},
    browserPartition: "test",
    getBrowserHost: () => null,
    logger: { info() {}, warn() {} },
    safeStorage: null,
    session: {},
    shell: {},
    userData: directory,
  });
  const key = "k".repeat(64);
  network.store.saveProxyProfile({
    id: GATEWAY_PROFILE_ID,
    name: "Built-in proxy gateway",
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17894 },
    username: "ct",
    password: key,
  });
  network.store.setGlobalRouting({ enabled: true, profileId: GATEWAY_PROFILE_ID });
  const attempt = (authInfo) => {
    const answers = [];
    let prevented = false;
    const handled = network.handleProxyLogin({ preventDefault: () => { prevented = true; } }, authInfo, (...values) => answers.push(values));
    return { handled, prevented, answers };
  };
  for (const authInfo of [
    { isProxy: true, host: "127.0.0.1", port: 17895 },
    { isProxy: true, host: "127.0.0.2", port: 17894 },
    { isProxy: true, host: "squatter.test", port: 17894 },
    { isProxy: false, host: "127.0.0.1", port: 17894 },
  ]) {
    assert.deepEqual(attempt(authInfo), { handled: false, prevented: false, answers: [] }, JSON.stringify(authInfo));
  }
  assert.deepEqual(attempt({ isProxy: true, host: "127.0.0.1", port: 17894 }), { handled: true, prevented: true, answers: [["ct", key]] });
});

test("a helper that died while its port stayed free is restarted with the same key", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const rotations = [];
  const controller = controllerFor(setup, [], { restartBackoffBaseMs: 0, onAccessKeyRotated: (detail) => rotations.push(detail) });
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await controller.setUseForApp(true);
  const key = gatewayToken(setup.store);
  process.kill(started.helper.pid);
  assert.ok(await waitFor(() => !processAlive(started.helper.pid)));

  await controller.watchdogTick();
  const status = await controller.status();
  assert.equal(status.running, true);
  assert.notEqual(status.helper.pid, started.helper.pid);
  assert.equal(gatewayToken(setup.store), key, "no evidence of a squat: the key is kept");
  assert.deepEqual(rotations, []);
  assert.deepEqual(status.needsRestart, []);
  const tunnel = await connectTunnel(status.listen.port, "chatgpt.com:443", key);
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /, "kept services still work with the key they hold");
  tunnel.socket.destroy();
  await controller.setRunning(false);
});

const SQUATTER_ANSWER = (() => {
  const body = JSON.stringify({ service: "someone-else", pid: 4242 });
  return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
})();

// Holds the port and answers every request with `answer` (a squatter answers the probe as another
// process with 200 JSON).
async function squat(t, port, answer = SQUATTER_ANSWER) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => socket.end(answer));
  });
  // A just-killed helper's socket can linger for a moment before the port is free to take.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      if (attempt >= 40) throw error;
      await sleep(100);
    }
  }
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await close(server);
  };
  t.after(stop);
  return stop;
}

function rotationLog() {
  const events = [];
  return {
    events,
    logger: {
      info: (event, detail) => events.push({ event, detail }),
      warn: (event, detail) => events.push({ event, detail }),
    },
    rotated: () => events.filter((entry) => entry.event === "proxy_gateway.access_key_rotated"),
  };
}

test("startup rotates once when the data port answers as another process after the helper died", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const port = await freePort();
  const first = controllerFor(setup, []);
  await first.configure({ upstreamProfileId: "isp-upstream", port, tokenlessPort: await freePort() });
  const started = await first.setUseForApp(true);
  const oldKey = gatewayToken(setup.store);
  await first.close();
  process.kill(started.helper.pid);
  assert.ok(await waitFor(() => !processAlive(started.helper.pid)));
  const release = await squat(t, port);

  const rotations = [];
  const pids = { bridge: process.pid, mcp: process.pid };
  const relaunched = controllerFor(setup, [], {
    onAccessKeyRotated: (detail) => rotations.push(detail),
    readServicePids: () => ({ ...pids }),
  });
  let status = await relaunched.startup();
  const newKey = gatewayToken(setup.store);
  assert.notEqual(newKey, oldKey, "the squatter may have collected the old key");
  assert.deepEqual(rotations, [], "CPA is not restarted while the gateway is down");
  assert.deepEqual(status.needsRestart, ["bridge", "mcp"], "the bridge and MCP are flagged, never restarted");
  assert.equal(status.running, false);
  assert.equal(setup.store.snapshot().routing.globalProfileId, "proxybridge-local-17891", "the app leaves the squatted port");

  // The next pass fails the bind on the same squat: the same incident, no second rotation.
  await assert.rejects(relaunched.setRunning(true), /already in use/);
  assert.equal(gatewayToken(setup.store), newKey);

  // The bridge restarts as a new process: its note clears; MCP's stays.
  pids.bridge = process.ppid;
  status = await relaunched.status();
  assert.deepEqual(status.needsRestart, ["mcp"]);

  // Once a helper serves the new key, CPA's restart hook runs once.
  await release();
  status = await relaunched.setRunning(true);
  assert.equal(status.running, true);
  assert.deepEqual(rotations, [{ reason: "port_held_after_exit" }]);
  assert.equal(gatewayToken(setup.store), newKey);
  await relaunched.setRunning(false);
});

test("a failed bind rotates the key; the hook runs once a helper serves it", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const rotations = [];
  const port = await freePort();
  const controller = controllerFor(setup, [], { onAccessKeyRotated: (detail) => rotations.push(detail) });
  await controller.configure({ upstreamProfileId: "isp-upstream", port, tokenlessPort: await freePort() });
  await controller.setUseForApp(true);
  await controller.setRunning(false);
  const oldKey = gatewayToken(setup.store);
  const release = await squat(t, port, "");

  await assert.rejects(controller.setRunning(true), /already in use/);
  assert.notEqual(gatewayToken(setup.store), oldKey);
  assert.deepEqual(rotations, [], "no CPA restart while the gateway is down");
  assert.deepEqual((await controller.status()).needsRestart, ["bridge", "mcp"], "pids unknown: both stay listed");
  await release();
  await controller.setRunning(true);
  assert.deepEqual(rotations, [{ reason: "bind_failed" }]);
  await controller.setRunning(false);
});

test("our busy helper (503) or an older helper (407) on the port is not taken for a squatter", async (t) => {
  for (const answer of [
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Coding Tools gateway\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
  ]) {
    const setup = tempSetup(t);
    await addUpstream(setup, t);
    const dataPort = await freePort();
    await squat(t, dataPort, answer);
    const sockets = new Set();
    const silent = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    const controlPort = await listen(silent);
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await close(silent);
    });
    const log = rotationLog();
    const rotations = [];
    const controller = controllerFor(setup, [], {
      logger: log.logger,
      controlTimeoutMs: 150,
      verifyRetryDelaysMs: [50],
      onAccessKeyRotated: (detail) => rotations.push(detail),
    });
    await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
    const statePath = path.join(setup.directory, "providers", "proxy-gateway.state.json");
    const state = staleState(process.pid, dataPort, controlPort);
    fs.writeFileSync(statePath, JSON.stringify(state));

    await assert.rejects(controller.setRunning(true), /unverified helper/, answer.slice(0, 12));
    assert.deepEqual(log.rotated(), [], "no rotation");
    assert.deepEqual(rotations, []);
    const status = await controller.status();
    assert.equal(status.helperState, "unverified", "retried through the unverified path");
    assert.deepEqual(status.needsRestart, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), state, "the live helper's state is kept");
  }
});

test("a replaced helper reopens the token-free port while ChatGPT Desktop still runs", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const controller = controllerFor(setup, [], { restartBackoffBaseMs: 0 });
  const tokenlessPort = await freePort();
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort });
  await controller.setUseForApp(true);
  await controller.setDesktopRunning(true);
  let status = await controller.status();
  assert.equal(status.tokenlessOpen, true);

  status = await controller.configure({ port: await freePort() });
  assert.equal(status.tokenlessOpen, true, "configure replaced the helper and the demand reopened the port");
  const first = await connectTunnel(tokenlessPort, "chatgpt.com:443", null);
  assert.match(first.head, /^HTTP\/1\.1 200 /);
  first.socket.destroy();

  process.kill(status.helper.pid);
  assert.ok(await waitFor(() => !processAlive(status.helper.pid)));
  await controller.watchdogTick();
  status = await controller.status();
  assert.equal(status.tokenlessOpen, true, "a watchdog restart reopens it too");
  await controller.setDesktopRunning(false);
  assert.equal((await controller.status()).tokenlessOpen, false);
  await controller.setRunning(false);
});

test("the helper closes the token-free port by itself once the app's heartbeat stops", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const controller = controllerFor(setup, [], { tokenlessLeaseMs: 400, tokenlessHeartbeatMs: 100, tokenlessHoldMs: 50 });
  const tokenlessPort = await freePort();
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort });
  await controller.setUseForApp(true);
  await controller.setDesktopRunning(true);
  await sleep(900);
  assert.equal((await controller.status()).tokenlessOpen, true, "the heartbeat renews the lease");

  // An app that opened the port and then crashed: no heartbeat follows.
  const state = JSON.parse(fs.readFileSync(path.join(setup.directory, "providers", "proxy-gateway.state.json"), "utf8"));
  await controller.close();
  await new Promise((resolve, reject) => {
    const request = require("node:http").request({
      host: "127.0.0.1", port: state.controlPort, method: "POST", path: "/tokenless/open",
      headers: { Authorization: `Bearer ${state.controlToken}` },
    }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", reject);
    request.end();
  });
  const open = await connectTunnel(tokenlessPort, "chatgpt.com:443", null);
  assert.match(open.head, /^HTTP\/1\.1 200 /);
  open.socket.destroy();
  await sleep(900);
  await assert.rejects(connect(tokenlessPort), /ECONNREFUSED/, "the lapsed lease closed the port");
});

test("the watchdog backs off exponentially when the helper keeps dying", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const spawns = [];
  const controller = controllerFor(setup, spawns, { restartBackoffBaseMs: 400, restartBackoffCapMs: 5_000 });
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  await controller.setRunning(true);
  const kill = async () => {
    const { helper } = await controller.status();
    process.kill(helper.pid);
    assert.ok(await waitFor(() => !processAlive(helper.pid)));
  };

  await kill();
  await controller.watchdogTick();
  assert.equal(spawns.length, 2, "the first restart is immediate");
  let status = await controller.status();
  assert.equal(status.watchdog.restarts, 1);

  await kill();
  await controller.watchdogTick();
  assert.equal(spawns.length, 2, "a second crash waits out the backoff");
  status = await controller.status();
  assert.equal(status.helperState, "restarting");
  assert.ok(status.watchdog.nextRestartAt);

  await sleep(450);
  await controller.watchdogTick();
  assert.equal(spawns.length, 3);
  status = await controller.status();
  assert.equal(status.watchdog.restarts, 2);
  assert.ok(Date.parse(status.watchdog.nextRestartAt) - Date.now() > 500, "the next delay doubles");
  await controller.setRunning(false);
});

test("a helper from another app version is replaced instead of adopted", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  await addUpstream(setup, t);
  const first = controllerFor(setup, [], { appVersion: "1.0.0" });
  await first.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const started = await first.setRunning(true);
  await first.close();
  const spawns = [];
  const updated = controllerFor(setup, spawns, { appVersion: "1.0.1" });
  const status = await updated.startup();
  assert.equal(spawns.length, 1);
  assert.notEqual(status.helper.pid, started.helper.pid);
  assert.ok(await waitFor(() => !processAlive(started.helper.pid)), "the outdated helper was stopped");
  await updated.setRunning(false);

  const names = ["0.9.0-win32-x64", "0.10.0-rc.2-win32-x64", "0.10.0-win32-x64", "0.10.0-rc.10-win32-x64-abc123"];
  assert.deepEqual([...names].sort((left, right) => compareVersionNames(right, left)),
    ["0.10.0-win32-x64", "0.10.0-rc.10-win32-x64-abc123", "0.10.0-rc.2-win32-x64", "0.9.0-win32-x64"]);
});

test("a credential refresh that joins a start in flight still runs its own restart", async (t) => {
  trackHelpers(t);
  const setup = tempSetup(t);
  const upstream = await fakeHttpUpstream({ username: "isp-user", password: "new-pass" });
  t.after(() => close(upstream.server));
  const profile = (password) => setup.store.saveProxyProfile({
    id: "isp-upstream",
    name: "ISP upstream",
    endpoint: { protocol: "http", host: "127.0.0.1", port: upstream.port },
    username: "isp-user",
    password,
  });
  profile("old-pass");
  const spawns = [];
  const controller = controllerFor(setup, spawns);
  await controller.configure({ upstreamProfileId: "isp-upstream", port: await freePort(), tokenlessPort: await freePort() });
  const starting = controller.setUseForApp(true);
  await new Promise((resolve) => setImmediate(resolve));
  profile("new-pass");
  const refreshed = controller.refreshUpstream({ credentialsChanged: true });
  await Promise.all([starting, refreshed]);
  assert.equal(spawns.length, 2, "the refresh queued its own pass instead of joining the start");
  const status = await controller.status();
  assert.equal(status.helper.pid, spawns[1].pid);
  const tunnel = await connectTunnel(status.listen.port, "chatgpt.com:443", gatewayToken(setup.store));
  assert.match(tunnel.head, /^HTTP\/1\.1 200 /, "the running helper uses the new upstream password");
  tunnel.socket.destroy();
  await controller.setRunning(false);
});

test("gateway channels use the provider IPC sender check; Network Proxy cannot overwrite the gateway profile", async () => {
  const { EventEmitter } = require("node:events");
  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve();
  app.getPath = () => "unused";
  app.getVersion = () => "0.0.0-test";
  const handlers = new Map();
  const saved = [];
  const calls = [];
  const loaded = { exports: {} };
  const gatewayStub = {
    startup: async () => ({}),
    upstreamProfileId: () => null,
    status: async () => ({ running: false }),
  };
  for (const name of ["configure", "setRunning", "setUseForApp", "rotateAccessKey", "test"]) {
    gatewayStub[name] = async (...args) => {
      calls.push(name, ...args);
      return { running: true };
    };
  }
  const dependencies = {
    "./provider-network.cjs": {
      createProviderNetworkController: () => ({
        store: {
          snapshot: () => ({ routing: { globalEnabled: true, globalProfileId: GATEWAY_PROFILE_ID } }),
          saveProxyProfile: (input) => saved.push(input),
          archiveProxyProfile: (input) => saved.push(input),
        },
        applyGlobalRouting: async () => ({}),
        handleProxyLogin() {},
      }),
    },
    "./provider-execution-router.cjs": {},
    "./profile.cjs": { resolveLauncherProfile: () => ({ browserPartition: "test", coreHome: "unused" }) },
    "./proxy-gateway.cjs": {
      GATEWAY_PROFILE_ID,
      createProxyGatewayController: () => gatewayStub,
      resolveHelperRuntime: () => null,
    },
  };
  require("node:vm").runInNewContext(read("electron/provider-bootstrap.cjs"), {
    module: loaded, require: (name) => dependencies[name], console,
  });
  let focused = true;
  const mainFrame = {};
  const page = { mainFrame, isFocused: () => focused, isDestroyed: () => false, send() {} };
  const window = { webContents: page, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => focused };
  const embedded = { mainFrame: {}, isFocused: () => true };
  loaded.exports.installProviderNetwork({
    app,
    BrowserWindow: {
      getAllWindows: () => [window],
      fromWebContents: (contents) => (contents === page || contents === embedded ? window : null),
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  await loaded.exports.providerNetworkReady();
  const own = { sender: page, senderFrame: mainFrame };
  const call = (channel, event, ...args) => handlers.get(channel)(event, ...args);

  await assert.rejects(
    call("launcher:proxy-profile-save", own, { id: GATEWAY_PROFILE_ID, name: "x", endpoint: { protocol: "http", host: "127.0.0.1", port: 1 }, enabled: false }),
    /managed in Proxy Gateway/,
  );
  await assert.rejects(call("launcher:proxy-profile-archive", own, GATEWAY_PROFILE_ID), /managed in Proxy Gateway/);
  assert.deepEqual(saved, []);

  const writes = [
    ["launcher:proxy-gateway-configure", "configure", { port: 18000 }],
    ["launcher:proxy-gateway-running", "setRunning", true],
    ["launcher:proxy-gateway-use-for-app", "setUseForApp", true],
    ["launcher:proxy-gateway-rotate-key", "rotateAccessKey"],
    ["launcher:proxy-gateway-test", "test"],
  ];
  for (const [channel, method, ...args] of writes) {
    calls.length = 0;
    await call(channel, own, ...args);
    assert.equal(calls[0], method, `${channel} reaches the gateway from the focused window`);
    calls.length = 0;
    await assert.rejects(call(channel, { sender: embedded, senderFrame: embedded.mainFrame }, ...args), /focused Coding Tools window/,
      `${channel} refuses web content embedded in the window`);
    await assert.rejects(call(channel, { sender: page, senderFrame: {} }, ...args), /focused Coding Tools window/,
      `${channel} refuses an iframe`);
    focused = false;
    await assert.rejects(call(channel, own, ...args), /focused Coding Tools window/, `${channel} is a "network" change`);
    focused = true;
    assert.deepEqual(calls, [], `${channel} never reached the gateway when refused`);
  }
  focused = false;
  assert.deepEqual(await call("launcher:proxy-gateway-status", own), { running: false }, "the status read needs only the window's own page");
  await assert.rejects(call("launcher:proxy-gateway-status", { sender: embedded, senderFrame: embedded.mainFrame }), /focused Coding Tools window/);
});

test("Proxy Gateway is a More tab wired through guarded IPC and packaged for the helper runtime", () => {
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const preload = read("electron/preload.cjs");
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const main = read("electron/main.cjs");
  const i18n = read("src/i18n.ts");
  const zhTW = read("src/i18n/locales/zh-TW.ts");
  const surface = read("src/features/ProxyGatewaySurface.tsx");
  const relaySource = read("electron/proxy-gateway-relay.cjs");
  const packageJson = JSON.parse(read("package.json"));

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

  for (const api of ["proxyGatewayStatus", "configureProxyGateway", "setProxyGatewayRunning", "setProxyGatewayForApp", "rotateProxyGatewayKey", "testProxyGateway", "onProxyGatewayChanged"]) {
    assert.match(preload, new RegExp(`${api}:`), `preload exposes ${api}`);
    assert.match(types, new RegExp(`${api}\\(`), `types declare ${api}`);
  }
  for (const api of ["proxyGatewayStatus", "configureProxyGateway", "setProxyGatewayRunning", "setProxyGatewayForApp", "rotateProxyGatewayKey", "testProxyGateway"]) {
    assert.match(surface,new RegExp(`\\.${api}\\(`), `surface calls ${api}`);
  }
  assert.match(surface, /17891/);
  assert.match(surface, /cdn-cgi\/trace/);
  // Gateway channels go through the provider handle() sender check: status with the default
  // access, every write with "network".
  assert.match(bootstrap, /handle\("launcher:proxy-gateway-status", \(\) => activeGateway\(\)\.status\(\)\);/);
  for (const channel of ["configure", "running", "use-for-app", "rotate-key", "test"]) {
    const start = bootstrap.indexOf(`handle("launcher:proxy-gateway-${channel}"`);
    assert.ok(start > 0, `${channel} is registered`);
    const registration = /^[\s\S]*?\);\r?\n/.exec(bootstrap.slice(start))[0];
    assert.match(registration, /, "network"\);\r?\n$/, `${channel} needs "network" access`);
  }
  assert.doesNotMatch(main + bootstrap, /setProviderWriteGuard|handleGateway/);
  // After an evidence rotation only CPA restarts; the Codex bridge and MCP tunnel are never killed.
  const hookStart = main.indexOf("setProxyGatewayKeyRotated(async");
  const hook = main.slice(hookStart, main.indexOf("\n  });", hookStart));
  assert.ok(hookStart > 0);
  assert.match(hook, /externalServicesController\.restart\("cpa"\)/);
  assert.doesNotMatch(hook, /runtimeSupervisor|runtimeHost|restartDaemon|tunnel|bridge/i);
  assert.match(surface, /The Codex bridge and MCP still use the old key/);
  // The helper is adopted or started before the saved global route is applied at launch.
  assert.ok(bootstrap.indexOf("await gateway.startup()") < bootstrap.indexOf("controller.applyGlobalRouting()"));
  // The bundled Bun runs the relay from app.asar.unpacked; it may require Node built-ins only.
  assert.ok(packageJson.build.asarUnpack.includes("electron/proxy-gateway-relay.cjs"));
  for (const [, name] of relaySource.matchAll(/require\("([^"]+)"\)/g)) assert.match(name, /^node:/);
  assert.match(relaySource, /token-free port[\s\S]*unauthenticated|WITHOUT authentication/);
});
