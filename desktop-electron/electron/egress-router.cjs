"use strict";
// The app's egress router: the one way the app and every program it starts reach the network
// (docs/specs/rewrite-the-proxy). It listens on loopback and takes HTTP proxy requests (CONNECT and
// absolute-form). A consumer signs in with a route token that names who it is (the App, CPA, a model
// provider, a CPA credential, a Browser-tab account) and the router key; the router looks up that
// target's route for every new connection and forwards through it: a proxy profile, signed in on the
// first request (HTTP, HTTPS, SOCKS4a or SOCKS5), or direct. A routed target never falls back to
// direct: a broken route, an unreachable proxy or a refused sign-in fails the connection.
//
// Route changes are a new table from main (setRoutes): no consumer restarts and none ever holds a
// proxy's address or password. It runs in a worker thread, as the signed relay before it did, so a
// busy main thread never holds the app's traffic.
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");

// Evaluated as a string in the worker (no asar path to resolve): keep it self-contained.
function routerWorkerMain() {
  const http = require("node:http");
  const net = require("node:net");
  const { timingSafeEqual } = require("node:crypto");
  const tls = require("node:tls");
  const { parentPort, workerData } = require("node:worker_threads");
  const { key, tunnelIdleMs, connectTimeoutMs, requestIdleMs } = workerData;
  let table = workerData.table || { tokens: {}, targets: {} };
  const post = (message) => { try { parentPort.postMessage(message); } catch { /* main is gone */ } };

  // ---- per-target bookkeeping -------------------------------------------------------------
  const stats = new Map(); // target -> { open, total, lastOkAt, lastError, lastErrorAt, via }
  const sockets = new Map(); // target -> Set<socket> (client side of open tunnels and requests)
  const allSockets = new Set();
  const signInSeen = new Map(); // profileId -> { ok, at }
  const statOf = (target) => {
    let entry = stats.get(target);
    if (!entry) { entry = { open: 0, total: 0, lastOkAt: 0, lastError: "", lastErrorAt: 0, via: "" }; stats.set(target, entry); }
    return entry;
  };
  const opened = (target, socket) => {
    const entry = statOf(target);
    entry.open += 1;
    entry.total += 1;
    let set = sockets.get(target);
    if (!set) { set = new Set(); sockets.set(target, set); }
    set.add(socket);
    let done = false;
    socket.once("close", () => {
      if (done) return;
      done = true;
      entry.open = Math.max(0, entry.open - 1);
      set.delete(socket);
    });
  };
  const tracked = new WeakSet();
  const openedRequest = (target, socket, response) => {
    const entry = statOf(target);
    entry.open += 1;
    entry.total += 1;
    response.once("close", () => { entry.open = Math.max(0, entry.open - 1); });
    if (tracked.has(socket)) return;
    tracked.add(socket);
    let set = sockets.get(target);
    if (!set) { set = new Set(); sockets.set(target, set); }
    set.add(socket);
    socket.once("close", () => set.delete(socket));
  };
  const succeeded = (target, route) => {
    const entry = statOf(target);
    entry.lastOkAt = Date.now();
    entry.via = route.mode === "proxy" ? route.profileId : route.mode;
    if (route.mode === "proxy" && route.credentials) noteSignIn(route.profileId, true);
  };
  const failed = (target, route, code, message) => {
    const entry = statOf(target);
    entry.lastError = message;
    entry.lastErrorAt = Date.now();
    entry.via = route?.mode === "proxy" ? route.profileId : route?.mode || "";
    if (code === "signin_refused" && route?.profileId) noteSignIn(route.profileId, false);
    post({ type: "route-error", target, code, message, profileId: route?.profileId || null });
  };
  // Sign-in outcomes reach main once a minute per proxy at most, and at once when they flip.
  function noteSignIn(profileId, ok) {
    const now = Date.now();
    const last = signInSeen.get(profileId);
    if (last && last.ok === ok && now - last.at < 60_000) return;
    signInSeen.set(profileId, { ok, at: now });
    post({ type: "signin", profileId, ok });
  }

  // ---- who is asking ----------------------------------------------------------------------
  function targetOf(request, fixedTarget) {
    if (fixedTarget) return fixedTarget;
    const header = String(request.headers["proxy-authorization"] || "");
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
    if (!match) return null;
    let decoded = "";
    try { decoded = Buffer.from(match[1], "base64").toString("utf8"); } catch { return null; }
    const colon = decoded.indexOf(":");
    if (colon < 1) return null;
    const token = decoded.slice(0, colon);
    const secret = decoded.slice(colon + 1);
    const given = Buffer.from(secret);
    const expected = Buffer.from(key);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (Object.prototype.hasOwnProperty.call(table.tokens, token)) return table.tokens[token];
    // A model provider or CPA credential the table doesn't list yet (a type or a sign-in added since):
    // it follows All model providers, which is what an unset route means for it.
    return /^[pc]-[0-9a-f]{20}$/.test(token) && table.modelFallback ? table.modelFallback : null;
  }
  const routeOf = (target) => table.targets[target] || { mode: "broken", reason: "This route is not set up" };

  // A host in the route's bypass list goes direct (the profile's own bypass, loopback first).
  function bypassed(route, host) {
    const bare = String(host).replace(/^\[|\]$/g, "").toLowerCase();
    for (const raw of route.bypass || []) {
      const rule = String(raw).trim().toLowerCase().replace(/^\[|\]$/g, "");
      if (!rule) continue;
      if (rule === bare) return true;
      if (rule.startsWith("*.") && (bare.endsWith(rule.slice(1)) || bare === rule.slice(2))) return true;
      if (rule.startsWith(".") && bare.endsWith(rule)) return true;
    }
    return false;
  }

  // ---- opening a tunnel to host:port through a route --------------------------------------
  function routeError(code, message) { return Object.assign(new Error(message), { code }); }

  function connectSocket(host, port, secure) {
    return new Promise((resolve, reject) => {
      const options = { host: String(host).replace(/^\[|\]$/g, ""), port: Number(port) };
      const socket = secure ? tls.connect({ ...options, servername: net.isIP(options.host) ? undefined : options.host }) : net.connect(options);
      const timer = setTimeout(() => { socket.destroy(); reject(routeError("unreachable", `Couldn't reach ${host}:${port} (timed out)`)); }, connectTimeoutMs);
      socket.once(secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(socket); });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(routeError("unreachable", `Couldn't reach ${host}:${port} (${error.code || error.message})`));
      });
    });
  }

  // Reads bytes until `done(buffer)` says how many it needs, then hands back the rest.
  function readUntil(socket, done, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => { cleanup(); reject(routeError("timeout", "The proxy did not answer")); }, connectTimeoutMs);
      const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const used = done(buffer);
        if (used > 0) {
          cleanup();
          const rest = buffer.subarray(used);
          if (rest.length) socket.unshift(rest);
          resolve(buffer.subarray(0, used));
        } else if (buffer.length > limit) {
          cleanup();
          reject(routeError("protocol", "The proxy's answer was too long"));
        }
      };
      const onError = (error) => { cleanup(); reject(routeError("unreachable", `The proxy connection failed (${error.code || error.message})`)); };
      const onClose = () => { cleanup(); reject(routeError("closed", "The proxy closed the connection without an answer")); };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  async function httpProxyTunnel(route, host, port) {
    const proxy = await connectSocket(route.endpoint.host, route.endpoint.port, route.endpoint.protocol === "https");
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: keep-alive"];
    if (route.credentials) {
      const token = Buffer.from(`${route.credentials.username || ""}:${route.credentials.password || ""}`).toString("base64");
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    proxy.write(lines.join("\r\n") + "\r\n\r\n");
    const head = await readUntil(proxy, (buffer) => { const at = buffer.indexOf("\r\n\r\n"); return at === -1 ? 0 : at + 4; })
      .catch((error) => { proxy.destroy(); throw error; });
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"))?.[1] || 0);
    if (status === 200) return proxy;
    proxy.destroy();
    if (status === 407) throw routeError("signin_refused", "The proxy refused the saved sign-in");
    throw routeError("upstream_status", `The proxy answered HTTP ${status || "?"}`);
  }

  async function socks5Tunnel(route, host, port) {
    const proxy = await connectSocket(route.endpoint.host, route.endpoint.port, false);
    try {
      const withSignIn = Boolean(route.credentials && (route.credentials.username || route.credentials.password));
      proxy.write(Buffer.from(withSignIn ? [5, 2, 0, 2] : [5, 1, 0]));
      const choice = await readUntil(proxy, (buffer) => (buffer.length >= 2 ? 2 : 0));
      if (choice[0] !== 5) throw routeError("protocol", "The proxy is not a SOCKS5 proxy");
      if (choice[1] === 2) {
        if (!withSignIn) throw routeError("signin_refused", "The SOCKS5 proxy asks for a sign-in and none is saved");
        const user = Buffer.from(String(route.credentials.username || ""));
        const pass = Buffer.from(String(route.credentials.password || ""));
        if (user.length > 255 || pass.length > 255) throw routeError("protocol", "The saved sign-in is too long for SOCKS5");
        proxy.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        const answer = await readUntil(proxy, (buffer) => (buffer.length >= 2 ? 2 : 0));
        if (answer[1] !== 0) throw routeError("signin_refused", "The proxy refused the saved sign-in");
      } else if (choice[1] !== 0) {
        throw routeError("signin_refused", "The SOCKS5 proxy accepted none of the sign-in methods");
      }
      const bare = String(host).replace(/^\[|\]$/g, "");
      let address;
      if (net.isIPv4(bare)) address = Buffer.from([1, ...bare.split(".").map(Number)]);
      else if (net.isIPv6(bare)) {
        const full = bare.includes("::") ? expandIpv6(bare) : bare.split(":");
        address = Buffer.concat([Buffer.from([4]), Buffer.from(full.flatMap((group) => { const value = parseInt(group || "0", 16); return [value >> 8, value & 255]; }))]);
      } else {
        const name = Buffer.from(bare);
        if (name.length > 255) throw routeError("protocol", "The host name is too long for SOCKS5");
        address = Buffer.concat([Buffer.from([3, name.length]), name]);
      }
      proxy.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]));
      await readUntil(proxy, (buffer) => {
        if (buffer.length < 5) return 0;
        const kind = buffer[3];
        const length = kind === 1 ? 4 : kind === 4 ? 16 : kind === 3 ? 1 + buffer[4] : -1;
        if (length < 0) return buffer.length;
        return buffer.length >= 4 + length + 2 ? 4 + length + 2 : 0;
      }).then((reply) => {
        if (reply[1] !== 0) throw routeError(reply[1] === 2 ? "upstream_status" : "unreachable", `The SOCKS5 proxy could not connect (code ${reply[1]})`);
      });
      return proxy;
    } catch (error) { proxy.destroy(); throw error; }
  }
  function expandIpv6(text) {
    const [left, right] = text.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    return [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  }

  async function socks4Tunnel(route, host, port) {
    const proxy = await connectSocket(route.endpoint.host, route.endpoint.port, false);
    try {
      const user = Buffer.from(String(route.credentials?.username || ""));
      const bare = String(host).replace(/^\[|\]$/g, "");
      // SOCKS4a: 0.0.0.1 asks the proxy to resolve the name itself.
      const ip = net.isIPv4(bare) ? bare.split(".").map(Number) : [0, 0, 0, 1];
      const tail = net.isIPv4(bare) ? Buffer.alloc(0) : Buffer.concat([Buffer.from(bare), Buffer.from([0])]);
      proxy.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, ...ip]), user, Buffer.from([0]), tail]));
      const reply = await readUntil(proxy, (buffer) => (buffer.length >= 8 ? 8 : 0));
      if (reply[1] === 0x5a) return proxy;
      throw routeError(reply[1] === 0x5d || reply[1] === 0x5c ? "signin_refused" : "unreachable", `The SOCKS4 proxy refused the connection (code ${reply[1]})`);
    } catch (error) { proxy.destroy(); throw error; }
  }

  function openTunnel(route, host, port) {
    if (route.mode === "direct" || (route.mode === "proxy" && bypassed(route, host))) return connectSocket(host, port, false);
    if (route.mode !== "proxy") return Promise.reject(routeError("broken", route.reason || "This route is broken"));
    if (route.endpoint.protocol === "socks5") return socks5Tunnel(route, host, port);
    if (route.endpoint.protocol === "socks4") return socks4Tunnel(route, host, port);
    return httpProxyTunnel(route, host, port);
  }

  async function traceThrough(route) {
    const tunnel = await openTunnel(route, "www.cloudflare.com", 443);
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: tunnel, servername: "www.cloudflare.com" }, () => {
        secure.write(["GET /cdn-cgi/trace HTTP/1.1", "Host: www.cloudflare.com", "User-Agent: CodingTools-ProxyTest",
          "Connection: close", "", ""].join("\r\n"));
      });
      let text = "";
      const timer = setTimeout(() => { secure.destroy(); reject(routeError("timeout", "Cloudflare did not answer the exit check")); }, connectTimeoutMs);
      secure.on("data", (chunk) => { text += chunk.toString("utf8"); if (text.length > 16384) secure.destroy(); });
      secure.on("error", (error) => { clearTimeout(timer); reject(routeError("unreachable", "The exit check failed (" + (error.code || error.message) + ")")); });
      secure.on("close", () => {
        clearTimeout(timer);
        const ip = /^ip=([0-9a-f.:]{3,64})$/im.exec(text)?.[1] || "";
        const country = /^loc=([A-Z]{2})$/m.exec(text)?.[1] || "";
        if (!ip) reject(routeError("protocol", "The exit check got no answer"));
        else resolve({ ip, country });
      });
    });
  }

  // ---- the listeners ----------------------------------------------------------------------
  function deny(client, status, reason) {
    if (client.destroyed) return;
    const text = String(reason || "").replace(/[\r\n]+/g, " ").slice(0, 300);
    const extra = status === 407 ? "Proxy-Authenticate: Basic realm=\"Coding Tools\"\r\n" : "";
    client.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Bad Gateway"}\r\n${extra}`
      + `X-Coding-Tools-Route-Error: ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  }

  function createServer(fixedTarget) {
    const server = http.createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
      const target = targetOf(request, fixedTarget);
      if (!target) {
        response.writeHead(407, { "proxy-authenticate": "Basic realm=\"Coding Tools\"", "content-type": "text/plain" }).end("Sign in to the Coding Tools proxy");
        return;
      }
      let url;
      try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
      if (url.protocol !== "http:" || url.username || url.password) { response.writeHead(400).end(); return; }
      const route = routeOf(target);
      openedRequest(target, request.socket, response);
      const port = Number(url.port || 80);
      openTunnel(route, url.hostname, port).then((tunnel) => {
        succeeded(target, route);
        const headers = { ...request.headers, host: url.host };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const upstream = http.request({ method: request.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => tunnel }, (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.on("error", () => response.destroy());
          incoming.pipe(response);
        });
        upstream.setTimeout(requestIdleMs, () => upstream.destroy(new Error("The site did not answer")));
        upstream.on("error", () => { if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" }); response.end("The connection failed"); });
        response.once("close", () => { upstream.destroy(); tunnel.destroy(); });
        request.pipe(upstream);
      }, (error) => {
        failed(target, route, error.code, error.message);
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain", "x-coding-tools-route-error": String(error.message).slice(0, 300) });
        response.end(error.message);
      });
    });
    server.on("connection", (socket) => {
      allSockets.add(socket);
      socket.once("close", () => allSockets.delete(socket));
      socket.on("error", () => socket.destroy());
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("connect", (request, client, head) => {
      const target = targetOf(request, fixedTarget);
      if (!target) { deny(client, 407, "Sign in to the Coding Tools proxy"); return; }
      const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(request.url || "");
      const port = Number(match?.[2] || 0);
      if (!match || port < 1 || port > 65535) { deny(client, 400, "Bad CONNECT target"); return; }
      const route = routeOf(target);
      opened(target, client);
      openTunnel(route, match[1].replace(/^\[|\]$/g, ""), port).then((remote) => {
        if (client.destroyed) { remote.destroy(); return; }
        succeeded(target, route);
        if (tunnelIdleMs) { client.setTimeout(tunnelIdleMs, () => client.destroy()); remote.setTimeout(tunnelIdleMs, () => remote.destroy()); }
        remote.on("error", () => remote.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.once("close", () => remote.destroy());
        remote.once("close", () => client.destroy());
        client.pipe(remote);
        remote.pipe(client);
      }, (error) => {
        failed(target, route, error.code, error.message);
        deny(client, 502, error.message);
      });
    });
    return server;
  }

  const main = createServer(null);
  const openPorts = new Map(); // port -> server
  main.on("error", (error) => {
    if (error.code === "EADDRINUSE" && workerData.port && !main.listening) {
      main.listen(0, "127.0.0.1"); // the saved port is taken: any free one
      return;
    }
    post({ type: "error", message: error.message });
  });
  // The callback also fires when the retry on a free port (above) succeeds.
  main.listen(workerData.port || 0, "127.0.0.1", () => post({ type: "ready", port: main.address().port }));

  parentPort.on("message", (message) => {
    if (message?.type === "routes") {
      table = message.table || { tokens: {}, targets: {} };
    } else if (message?.type === "reconnect") {
      const targets = message.target ? [message.target] : [...sockets.keys()];
      let closed = 0;
      for (const target of targets) for (const socket of sockets.get(target) || []) { socket.destroy(); closed += 1; }
      post({ type: "reply", id: message.id, value: { closed } });
    } else if (message?.type === "trace") {
      // Where a route leaves the internet: Cloudflare's trace through it (the Proxy page's Test).
      traceThrough(message.route).then((value) => post({ type: "reply", id: message.id, value }),
        (error) => post({ type: "reply", id: message.id, error: error.message }));
    } else if (message?.type === "stats") {
      post({ type: "reply", id: message.id, value: Object.fromEntries(stats) });
    } else if (message?.type === "open-port") {
      const server = createServer(String(message.target));
      server.on("error", (error) => post({ type: "reply", id: message.id, error: error.message }));
      server.listen(0, "127.0.0.1", () => {
        openPorts.set(server.address().port, server);
        post({ type: "reply", id: message.id, value: { port: server.address().port } });
      });
    } else if (message?.type === "close-port") {
      openPorts.get(message.port)?.close();
      openPorts.delete(message.port);
      post({ type: "reply", id: message.id, value: { closed: true } });
    } else if (message?.type === "close") {
      main.close();
      for (const server of openPorts.values()) server.close();
      for (const socket of allSockets) socket.destroy();
      parentPort.close();
    }
  });
}

const ROUTER_WORKER_SOURCE = `(${routerWorkerMain.toString()})()`;

/** A new router key: 32 random bytes as hex, the password every route token is paired with. */
function newRouterKey() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Starts the egress router and resolves once it listens: `{ port, setRoutes(table), reconnect(target),
 * openPort(target), closePort(port), stats(), close() }`. `port` is tried first (a stopped router comes
 * back where the programs it serves expect it); taken, any free port is used and `port` says which.
 * A worker that stops on its own is started again on the same port with the last table, up to
 * `maxRestarts` times in ten minutes; `onEvent` hears `signin`, `route-error`, `restarted` and `stopped`.
 */
function startEgressRouter({
  port = 0, key, table = { tokens: {}, targets: {} }, onEvent = () => {},
  createWorker = (source, options) => new Worker(source, options),
  readyTimeoutMs = 10_000, tunnelIdleMs = 15 * 60_000, connectTimeoutMs = 30_000, requestIdleMs = 120_000,
  maxRestarts = 5,
} = {}) {
  if (typeof key !== "string" || key.length < 32) return Promise.reject(new Error("The egress router needs its key"));
  let current = table;
  let worker = null;
  let livePort = Number(port) || 0;
  let closed = false;
  let nextId = 1;
  const pending = new Map();
  const restarts = [];
  const emit = (event) => { try { onEvent(event); } catch { /* a listener's fault is not the router's */ } };

  function launch() {
    return new Promise((resolve, reject) => {
      const created = createWorker(ROUTER_WORKER_SOURCE, {
        eval: true,
        workerData: { port: livePort, key, table: current, tunnelIdleMs, connectTimeoutMs, requestIdleMs },
      });
      let settled = false;
      const timer = setTimeout(() => fail(new Error("The egress router did not start")), readyTimeoutMs);
      timer.unref?.();
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void Promise.resolve(created.terminate?.()).catch(() => {});
        reject(error);
      }
      created.on("message", (message) => {
        if (message?.type === "ready" && Number.isInteger(message.port)) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            livePort = message.port;
            worker = created;
            resolve(message.port);
          }
          return;
        }
        if (!settled) { if (message?.type === "error") fail(new Error(message.message || "The egress router failed")); return; }
        if (message?.type === "reply") {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value);
          return;
        }
        emit(message);
      });
      created.on("error", (error) => { if (!settled) fail(error); else emit({ type: "error", message: error?.message }); });
      created.on("exit", (code) => {
        if (!settled) { fail(new Error(`The egress router exited (${code})`)); return; }
        if (worker !== created) return;
        worker = null;
        for (const waiter of pending.values()) waiter.reject(new Error("The egress router stopped"));
        pending.clear();
        if (closed) return;
        const now = Date.now();
        while (restarts.length && now - restarts[0] > 10 * 60_000) restarts.shift();
        if (restarts.length >= maxRestarts) { emit({ type: "stopped", code }); return; }
        restarts.push(now);
        launch().then((restartedPort) => emit({ type: "restarted", port: restartedPort }),
          (error) => emit({ type: "stopped", code, message: error?.message }));
      });
      // The router never keeps a quitting app alive.
      created.unref?.();
    });
  }

  function ask(type, payload = {}) {
    if (!worker) return Promise.reject(new Error("The egress router is not running"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ type, id, ...payload }); } catch (error) { pending.delete(id); reject(error); }
    });
  }

  return launch().then(() => ({
    get port() { return livePort; },
    get running() { return Boolean(worker); },
    setRoutes(next) {
      current = next || { tokens: {}, targets: {} };
      try { worker?.postMessage({ type: "routes", table: current }); } catch { /* restarted with `current` */ }
    },
    reconnect: (target = null) => ask("reconnect", { target }),
    stats: () => ask("stats"),
    /** Where `route` leaves the internet: `{ ip, country }` from Cloudflare's trace. */
    trace: (route) => ask("trace", { route }),
    openPort: (target) => ask("open-port", { target }).then((value) => value.port),
    closePort: (openPort) => ask("close-port", { port: openPort }),
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      const ending = worker;
      worker = null;
      try { ending?.postMessage({ type: "close" }); } catch { /* already gone */ }
      return Promise.resolve(ending?.terminate?.()).then(() => {}, () => {});
    },
  }));
}

module.exports = { startEgressRouter, newRouterKey, ROUTER_WORKER_SOURCE };
