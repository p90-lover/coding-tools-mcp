"use strict";
// The egress router (electron/egress-router.cjs), against loopback fakes: an echo server and an HTTP
// site as destinations, an HTTP proxy that requires a sign-in, and a SOCKS5 proxy with
// username/password. Nothing leaves the machine.
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const { startEgressRouter, newRouterKey } = require("../electron/egress-router.cjs");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const auth = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** An echo destination that also counts the connections it got. */
async function echoServer() {
  const seen = { connections: 0 };
  const server = net.createServer((socket) => { seen.connections += 1; socket.on("data", (chunk) => socket.write(chunk)); socket.on("error", () => {}); });
  const port = await listen(server);
  return { server, port, seen };
}

/** An HTTP proxy that takes CONNECT and absolute-form requests, signed in as user:pass. */
async function httpProxy({ user = "u", pass = "p", refuse = false } = {}) {
  const seen = { authorizations: [], connects: 0 };
  const server = http.createServer((request, response) => {
    seen.authorizations.push(request.headers["proxy-authorization"] || "");
    if (refuse || request.headers["proxy-authorization"] !== auth(user, pass)) { response.writeHead(407).end(); return; }
    const url = new URL(request.url);
    const upstream = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: request.method, headers: request.headers }, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    request.pipe(upstream);
  });
  server.on("connect", (request, client) => {
    seen.connects += 1;
    seen.authorizations.push(request.headers["proxy-authorization"] || "");
    if (refuse || request.headers["proxy-authorization"] !== auth(user, pass)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return;
    }
    const [host, port] = request.url.split(":");
    const remote = net.connect(Number(port), host, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); client.pipe(remote); remote.pipe(client); });
    remote.on("error", () => client.destroy());
    client.on("error", () => remote.destroy());
  });
  const port = await listen(server);
  return { server, port, seen };
}

/** A SOCKS5 proxy with username/password (RFC 1929) that connects to domain or IPv4 targets. */
async function socks5Proxy({ user = "su", pass = "sp" } = {}) {
  const seen = { signIns: [] };
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (greeting) => {
      if (greeting[0] !== 5 || !greeting.subarray(2).includes(2)) { socket.end(Buffer.from([5, 0xff])); return; }
      socket.write(Buffer.from([5, 2]));
      socket.once("data", (login) => {
        const userLength = login[1];
        const givenUser = login.subarray(2, 2 + userLength).toString();
        const givenPass = login.subarray(3 + userLength, 3 + userLength + login[2 + userLength]).toString();
        seen.signIns.push(`${givenUser}:${givenPass}`);
        if (givenUser !== user || givenPass !== pass) { socket.end(Buffer.from([1, 1])); return; }
        socket.write(Buffer.from([1, 0]));
        socket.once("data", (request) => {
          let host, offset;
          if (request[3] === 3) { host = request.subarray(5, 5 + request[4]).toString(); offset = 5 + request[4]; }
          else { host = [...request.subarray(4, 8)].join("."); offset = 8; }
          const port = request.readUInt16BE(offset);
          const remote = net.connect(port, host, () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            socket.pipe(remote); remote.pipe(socket);
          });
          remote.on("error", () => socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        });
      });
    });
  });
  const port = await listen(server);
  return { server, port, seen };
}

/** Opens a CONNECT through the router; resolves { status, headers, socket } after its answer. */
function connectThrough(routerPort, authorization, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(routerPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`);
    });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] || 0), head: buffer.slice(0, end), socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}
const echo = (socket, text) => new Promise((resolve) => { socket.once("data", (chunk) => resolve(chunk.toString())); socket.write(text); });

function table(targets, tokens = { app: "app", cpa: "cpa" }) { return { tokens, targets }; }

test("only a consumer with a known route token and the router key gets through", async (t) => {
  const destination = await echoServer();
  const key = newRouterKey();
  const router = await startEgressRouter({ key, table: table({ app: { mode: "direct" } }) });
  t.after(async () => { await router.close(); destination.server.close(); });
  for (const authorization of [null, auth("app", "wrong-key".padEnd(64, "x")), auth("nobody", key)]) {
    const { status, head, socket } = await connectThrough(router.port, authorization, "127.0.0.1", destination.port);
    assert.equal(status, 407, `refused: ${authorization}`);
    assert.match(head, /Proxy-Authenticate: Basic/);
    socket.destroy();
  }
  assert.equal(destination.seen.connections, 0, "nothing was forwarded");
  const { status, socket } = await connectThrough(router.port, auth("app", key), "127.0.0.1", destination.port);
  assert.equal(status, 200);
  assert.equal(await echo(socket, "hello"), "hello");
  socket.destroy();
});

test("a proxy route signs in on the first request, and a refused or unreachable proxy fails instead of going direct", async (t) => {
  const destination = await echoServer();
  const proxy = await httpProxy();
  const refusing = await httpProxy({ refuse: true });
  const key = newRouterKey();
  const events = [];
  const route = (port) => ({ mode: "proxy", profileId: `p${port}`, endpoint: { protocol: "http", host: "127.0.0.1", port }, credentials: { username: "u", password: "p" } });
  const router = await startEgressRouter({ key, onEvent: (event) => events.push(event),
    table: table({ app: route(proxy.port), cpa: route(refusing.port), "provider:codex": route(1) }, { app: "app", cpa: "cpa", "p-codex": "provider:codex" }) });
  t.after(async () => { await router.close(); destination.server.close(); proxy.server.close(); refusing.server.close(); });

  const through = await connectThrough(router.port, auth("app", key), "127.0.0.1", destination.port);
  assert.equal(through.status, 200);
  assert.equal(await echo(through.socket, "via proxy"), "via proxy");
  assert.deepEqual(proxy.seen.authorizations, [auth("u", "p")], "signed in on the very first request, no 407 round trip");
  through.socket.destroy();

  const refused = await connectThrough(router.port, auth("cpa", key), "127.0.0.1", destination.port);
  assert.equal(refused.status, 502);
  assert.match(refused.head, /X-Coding-Tools-Route-Error: The proxy refused the saved sign-in/);
  const unreachable = await connectThrough(router.port, auth("p-codex", key), "127.0.0.1", destination.port);
  assert.equal(unreachable.status, 502);
  assert.match(unreachable.head, /Couldn't reach 127\.0\.0\.1:1/);
  assert.equal(destination.seen.connections, 1, "only the proxied connection reached the destination: no direct fallback");

  const stats = await router.stats();
  assert.equal(stats.app.total, 1);
  assert.ok(stats.app.lastOkAt > 0);
  assert.match(stats.cpa.lastError, /refused the saved sign-in/);
  assert.match(stats["provider:codex"].lastError, /Couldn't reach/);
  assert.ok(events.some((event) => event.type === "signin" && event.profileId === `p${proxy.port}` && event.ok === true));
  assert.ok(events.some((event) => event.type === "signin" && event.profileId === `p${refusing.port}` && event.ok === false));
  assert.ok(events.some((event) => event.type === "route-error" && event.target === "cpa" && event.code === "signin_refused"));
});

test("a broken route fails with its reason", async (t) => {
  const destination = await echoServer();
  const key = newRouterKey();
  const router = await startEgressRouter({ key, table: table({ app: { mode: "broken", reason: "The global proxy was removed" } }) });
  t.after(async () => { await router.close(); destination.server.close(); });
  const { status, head, socket } = await connectThrough(router.port, auth("app", key), "127.0.0.1", destination.port);
  assert.equal(status, 502);
  assert.match(head, /The global proxy was removed/);
  assert.equal(destination.seen.connections, 0);
  socket.destroy();
});

test("SOCKS5 upstreams sign in with username and password; a wrong one is refused", async (t) => {
  const destination = await echoServer();
  const socks = await socks5Proxy();
  const key = newRouterKey();
  const route = (password) => ({ mode: "proxy", profileId: "s", endpoint: { protocol: "socks5", host: "127.0.0.1", port: socks.port }, credentials: { username: "su", password } });
  const router = await startEgressRouter({ key, table: table({ app: route("sp"), cpa: route("bad") }) });
  t.after(async () => { await router.close(); destination.server.close(); socks.server.close(); });
  const ok = await connectThrough(router.port, auth("app", key), "localhost", destination.port);
  assert.equal(ok.status, 200);
  assert.equal(await echo(ok.socket, "socks"), "socks");
  ok.socket.destroy();
  const bad = await connectThrough(router.port, auth("cpa", key), "localhost", destination.port);
  assert.equal(bad.status, 502);
  assert.match(bad.head, /refused the saved sign-in/);
  assert.deepEqual(socks.seen.signIns, ["su:sp", "su:bad"]);
});

test("plain HTTP requests (absolute form) are forwarded through the route", async (t) => {
  const site = http.createServer((request, response) => response.end(`site saw ${request.url}`));
  const sitePort = await listen(site);
  const proxy = await httpProxy();
  const key = newRouterKey();
  const router = await startEgressRouter({ key, table: table({ app: { mode: "proxy", profileId: "p", endpoint: { protocol: "http", host: "127.0.0.1", port: proxy.port }, credentials: { username: "u", password: "p" } } }) });
  t.after(async () => { await router.close(); site.close(); proxy.server.close(); });
  const body = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: router.port, path: `http://127.0.0.1:${sitePort}/page?x=1`, headers: { "proxy-authorization": auth("app", key) } }, (response) => {
      let text = ""; response.on("data", (chunk) => { text += chunk; }); response.on("end", () => resolve(`${response.statusCode} ${text}`));
    }).on("error", reject);
  });
  assert.equal(body, "200 site saw /page?x=1");
  assert.equal(proxy.seen.connects, 1, "carried over a signed tunnel");
});

test("a new route table applies to the next connection, and reconnect closes the open ones", async (t) => {
  const destination = await echoServer();
  const proxy = await httpProxy();
  const key = newRouterKey();
  const viaProxy = { mode: "proxy", profileId: "p", endpoint: { protocol: "http", host: "127.0.0.1", port: proxy.port }, credentials: { username: "u", password: "p" } };
  const router = await startEgressRouter({ key, table: table({ app: viaProxy }) });
  t.after(async () => { await router.close(); destination.server.close(); proxy.server.close(); });
  const first = await connectThrough(router.port, auth("app", key), "127.0.0.1", destination.port);
  assert.equal(first.status, 200);
  router.setRoutes(table({ app: { mode: "direct" } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await connectThrough(router.port, auth("app", key), "127.0.0.1", destination.port);
  assert.equal(second.status, 200);
  assert.equal(proxy.seen.connects, 1, "the second connection went direct, as the new table says");
  const closed = new Promise((resolve) => first.socket.once("close", resolve));
  const result = await router.reconnect("app");
  assert.ok(result.closed >= 2);
  await closed;
  second.socket.destroy();
});

test("an open port serves one fixed target without a sign-in, until it is closed", async (t) => {
  const destination = await echoServer();
  const key = newRouterKey();
  const router = await startEgressRouter({ key, table: table({ app: { mode: "direct" } }) });
  t.after(async () => { await router.close(); destination.server.close(); });
  const port = await router.openPort("app");
  const open = await connectThrough(port, null, "127.0.0.1", destination.port);
  assert.equal(open.status, 200);
  open.socket.destroy();
  await router.closePort(port);
  await assert.rejects(connectThrough(port, null, "127.0.0.1", destination.port));
});

test("a router that stops on its own comes back on the same port with the last table", async (t) => {
  const destination = await echoServer();
  const key = newRouterKey();
  const workers = [];
  const { Worker } = require("node:worker_threads");
  const events = [];
  const router = await startEgressRouter({ key, table: table({ app: { mode: "broken", reason: "old" } }), onEvent: (event) => events.push(event),
    createWorker: (source, options) => { const worker = new Worker(source, options); workers.push(worker); return worker; } });
  t.after(async () => { await router.close(); destination.server.close(); });
  router.setRoutes(table({ app: { mode: "direct" } }));
  const port = router.port;
  await workers[0].terminate();
  for (let tries = 0; tries < 100 && !events.some((event) => event.type === "restarted"); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.find((event) => event.type === "restarted"), { type: "restarted", port });
  const again = await connectThrough(router.port, auth("app", key), "127.0.0.1", destination.port);
  assert.equal(again.status, 200, "the restarted router has the latest table, not the first one");
  again.socket.destroy();
});
