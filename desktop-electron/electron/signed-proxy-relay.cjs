"use strict";
// The app's own route to a signed-in proxy, for its Chromium sessions (the windows, the Browser
// tab's accounts, and main-process fetches such as the update download).
//
// Chromium sends a proxy sign-in only after the proxy asks for one with a 407. Decodo stops asking:
// on 2026-11-15 it answered requests carrying a sign-in with 200 and closed the others without a
// reply, so every Chromium request failed with ERR_EMPTY_RESPONSE, then ERR_TOO_MANY_RETRIES, and
// the app worked only behind an outside proxy app (ProxyBridge), which signs in up front. Programs
// the app starts were fine: their proxy URL carries the sign-in, sent with the first request.
//
// This relay listens on loopback and adds the saved sign-in to every request and CONNECT it
// forwards. It runs in a worker thread, so a busy main thread never holds the app's traffic, and
// gets the sign-in in memory only (workerData), never on disk or on a command line.
const { Worker } = require("node:worker_threads");

// Evaluated as a string in the worker (no asar path to resolve): keep it self-contained.
function relayWorkerMain() {
  const http = require("node:http");
  const https = require("node:https");
  const { parentPort, workerData } = require("node:worker_threads");
  const { endpoint, credentials, tunnelIdleMs, requestIdleMs } = workerData;
  const transport = endpoint.protocol === "https" ? https : http;
  const authorization = "Basic " + Buffer.from(`${credentials.username || ""}:${credentials.password || ""}`).toString("base64");
  const upstreamOptions = { hostname: endpoint.host.replace(/^\[|\]$/g, ""), port: endpoint.port, agent: false };
  const sockets = new Set();
  let authenticated = false;
  const post = (message) => { try { parentPort.postMessage(message); } catch { /* main is gone */ } };
  const signedIn = () => { if (!authenticated) { authenticated = true; post({ type: "authenticated" }); } };
  const track = (socket, idleMs) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setKeepAlive?.(true, 30_000);
    if (idleMs) socket.setTimeout(idleMs, () => socket.destroy());
  };

  const server = http.createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
    let target;
    try { target = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      response.writeHead(400).end(); return;
    }
    const headers = { ...request.headers, host: target.host, "proxy-authorization": authorization };
    delete headers["proxy-connection"];
    const upstream = transport.request({ ...upstreamOptions, method: request.method, path: target.href, headers }, (incoming) => {
      if (incoming.statusCode === 407) {
        incoming.resume();
        post({ type: "rejected" });
        response.writeHead(502, { "content-type": "text/plain" }).end("The proxy rejected the saved sign-in");
        return;
      }
      signedIn();
      const outgoing = { ...incoming.headers };
      delete outgoing["proxy-authenticate"];
      delete outgoing["proxy-authorization"];
      response.writeHead(incoming.statusCode, outgoing);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    upstream.setTimeout(requestIdleMs, () => upstream.destroy(new Error("The proxy did not respond")));
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("The proxy connection failed");
    });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", (socket) => track(socket, 0));
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, client, head) => {
    if (tunnelIdleMs) client.setTimeout(tunnelIdleMs, () => client.destroy());
    const target = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(request.url || "");
    if (!target || Number(target[2]) < 1 || Number(target[2]) > 65535) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return;
    }
    const upstream = transport.request({ ...upstreamOptions, method: "CONNECT", path: request.url,
      headers: { host: request.url, "proxy-connection": "keep-alive", "proxy-authorization": authorization } });
    const fail = () => { if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); };
    upstream.setTimeout(requestIdleMs, () => upstream.destroy(new Error("The proxy did not respond")));
    upstream.on("error", fail);
    // Node hands every CONNECT answer to "connect"; "response" is kept for any other.
    upstream.once("response", (response) => { response.resume(); if (response.statusCode === 407) post({ type: "rejected" }); fail(); });
    upstream.once("connect", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      if (response.statusCode !== 200 || client.destroyed) {
        remote.destroy();
        if (response.statusCode === 407) post({ type: "rejected" });
        fail();
        return;
      }
      signedIn();
      track(remote, tunnelIdleMs);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      client.pipe(remote);
      remote.pipe(client);
    });
    client.once("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("error", (error) => post({ type: "error", message: error.message }));
  parentPort.on("message", (message) => {
    if (message?.type !== "close") return;
    server.close();
    for (const socket of sockets) socket.destroy();
    parentPort.close();
  });
  server.listen(0, "127.0.0.1", () => post({ type: "ready", port: server.address().port }));
}

const RELAY_WORKER_SOURCE = `(${relayWorkerMain.toString()})()`;

/**
 * Starts a relay for one proxy and resolves with its loopback route once it listens:
 * `{ port, proxyRules, close() }`. Events after that reach `onEvent`: `authenticated` (the first
 * signed-in answer), `rejected` (the proxy refused the sign-in) and `stopped` (the worker ended
 * without close()).
 */
function startSignedProxyRelay({
  endpoint, credentials, onEvent = () => {},
  createWorker = (source, options) => new Worker(source, options),
  readyTimeoutMs = 10_000, tunnelIdleMs = 15 * 60_000, requestIdleMs = 120_000,
} = {}) {
  if (!["http", "https"].includes(endpoint?.protocol)) {
    return Promise.reject(new Error("The app's proxy relay forwards to HTTP or HTTPS proxies only"));
  }
  return new Promise((resolve, reject) => {
    const worker = createWorker(RELAY_WORKER_SOURCE, {
      eval: true,
      workerData: {
        endpoint: { protocol: endpoint.protocol, host: String(endpoint.host), port: Number(endpoint.port) },
        credentials: { username: String(credentials?.username || ""), password: String(credentials?.password || "") },
        tunnelIdleMs, requestIdleMs,
      },
    });
    let settled = false;
    let closed = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void Promise.resolve(worker.terminate?.()).catch(() => {});
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("The app's proxy relay did not start")), readyTimeoutMs);
    timer.unref?.();
    const close = () => {
      if (closed) return Promise.resolve();
      closed = true;
      try { worker.postMessage({ type: "close" }); } catch { /* already gone */ }
      return Promise.resolve(worker.terminate?.()).then(() => {}, () => {});
    };
    worker.on("message", (message) => {
      if (!settled) {
        if (message?.type === "ready" && Number.isInteger(message.port)) {
          settled = true;
          clearTimeout(timer);
          resolve({ port: message.port, proxyRules: `http://127.0.0.1:${message.port}`, close });
        } else if (message?.type === "error") {
          fail(new Error(message.message || "The app's proxy relay failed"));
        }
        return;
      }
      try { onEvent(message); } catch { /* a listener's fault is not the relay's */ }
    });
    worker.on("error", (error) => {
      if (!settled) fail(error);
      else if (!closed) { try { onEvent({ type: "stopped", message: error?.message }); } catch { /* ignore */ } }
    });
    worker.on("exit", (code) => {
      if (!settled) fail(new Error(`The app's proxy relay exited (${code})`));
      else if (!closed) { closed = true; try { onEvent({ type: "stopped", code }); } catch { /* ignore */ } }
    });
    // The relay never keeps a quitting app alive.
    worker.unref?.();
  });
}

module.exports = { startSignedProxyRelay, RELAY_WORKER_SOURCE };
