"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { validateRegisterIds } = require("./register-host.cjs");

const MAX_BODY_BYTES = 8192;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ROUTES = new Map([["/v1/status", "GET"], ["/v1/start", "POST"], ["/v1/accounts", "GET"], ["/v1/export", "POST"], ["/v1/refresh", "POST"]]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0, settled = false; const chunks = [];
    const finish = (failure, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      request.off("data", data); request.off("end", end); request.off("error", aborted); request.off("aborted", aborted);
      if (failure) { request.resume(); reject(failure); } else resolve(value);
    };
    const invalid = (statusCode = 400) => Object.assign(new Error("Invalid Register API body"), { statusCode });
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { finish(invalid(413)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        finish(null, value);
      } catch { finish(invalid()); }
    };
    const aborted = () => finish(invalid());
    const timer = setTimeout(() => finish(invalid(408)), 10000);
    request.on("data", data); request.once("end", end); request.once("error", aborted); request.once("aborted", aborted);
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) finish(invalid(413));
  });
}

async function abortable(promise, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error("Register request cancelled"), { code: "register_unavailable" }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

function createRegisterApi({ host, descriptorPath, sourceIdPath = path.join(path.dirname(descriptorPath || ""), "register-source.json") } = {}) {
  if (!host || !["status", "start", "request"].every(name => typeof host[name] === "function")) throw new Error("Register host is unavailable");
  if (!descriptorPath || !path.isAbsolute(descriptorPath) || !path.isAbsolute(sourceIdPath)
    || path.resolve(descriptorPath) === path.resolve(sourceIdPath)) throw new Error("Register API storage must use separate absolute files");
  let sourceId, server = null, origin = "", token = "", generation = 0, startPending = null, closePending = null;
  const sockets = new Set(), requests = new Set();
  const publicDescriptor = () => ({ source_id: sourceId, url: origin });

  function loadSourceId() {
    if (sourceId) return;
    if (fs.existsSync(sourceIdPath)) {
      try {
        const stat = fs.lstatSync(sourceIdPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error();
        const saved = JSON.parse(fs.readFileSync(sourceIdPath, "utf8"));
        if (saved.schema_version !== 1 || !UUID.test(saved.source_id)) throw new Error();
        sourceId = saved.source_id;
      } catch { throw new Error("Register source identity could not be read"); }
    } else {
      const created = crypto.randomUUID();
      writePrivateFileAtomic(sourceIdPath, JSON.stringify({ schema_version: 1, source_id: created }) + "\n");
      sourceId = created;
    }
  }
  function removeDescriptor(ownedToken) {
    if (!ownedToken) return;
    try {
      const stat = fs.lstatSync(descriptorPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
      const saved = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
      if (saved.token === ownedToken && saved.source_id === sourceId) fs.unlinkSync(descriptorPath);
    } catch { /* A descriptor already removed or replaced is no longer ours. */ }
  }
  function json(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    let payload = Buffer.from(JSON.stringify({ ...value, source_id: sourceId }) + "\n");
    if (payload.length > MAX_RESPONSE_BYTES) {
      status = 502; payload = Buffer.from(JSON.stringify({ error: "register_response_too_large", source_id: sourceId }) + "\n");
    }
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" });
    response.end(payload);
  }
  const publicStatus = value => ({ ready: value?.ready === true, owned: value?.owned === true, starting: value?.starting === true,
    error: value?.error ? "register_unavailable" : null });

  async function handle(request, response, expectedToken, expectedOrigin, expectedGeneration) {
    const controller = new AbortController(); requests.add(controller);
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const authorization = request.headers.authorization;
      const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ") ? Buffer.from(authorization.slice(7)) : Buffer.alloc(0);
      const expected = Buffer.from(expectedToken);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { json(response, 401, { error: "unauthorized" }); return; }
      if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== new URL(expectedOrigin).host
        || Object.hasOwn(request.headers, "origin") || Object.keys(request.headers).some(name => name.startsWith("sec-fetch-"))) {
        json(response, 403, { error: "untrusted_client" }); return;
      }
      if (expectedGeneration !== generation) { json(response, 503, { error: "register_unavailable" }); return; }
      if (ROUTES.get(request.url) !== request.method) { json(response, 404, { error: "not_found" }); return; }
      let body;
      if (request.method === "POST") {
        if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          json(response, 415, { error: "json_required" }); return;
        }
        body = await readBody(request);
        if (request.url === "/v1/start") {
          if (Object.keys(body).length) { json(response, 400, { error: "invalid_body" }); return; }
        } else {
          try { validateRegisterIds(body); } catch { json(response, 400, { error: "invalid_ids" }); return; }
        }
      } else if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] || 0) !== 0) {
        json(response, 400, { error: "unexpected_body" }); return;
      }
      controller.signal.throwIfAborted();
      if (request.url === "/v1/status" || request.url === "/v1/start") {
        const value = await abortable(request.url === "/v1/status" ? host.status() : host.start(), controller.signal);
        const status = publicStatus(value);
        json(response, request.url === "/v1/start" && !status.ready ? 503 : 200, status);
        return;
      }
      const route = "/api/coding-tools/" + request.url.slice("/v1/".length);
      const value = await abortable(host.request(request.method, route, body, { signal: controller.signal }), controller.signal);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Register response");
      json(response, 200, value);
    } catch (failure) {
      const status = [400, 408, 413].includes(failure?.statusCode) ? failure.statusCode : failure?.code === "register_unavailable" ? 503 : 502;
      json(response, status, { error: status < 500 ? "invalid_body" : status === 503 ? "register_unavailable" : "register_request_failed" });
    } finally { requests.delete(controller); }
  }

  async function closeServer(instance) {
    if (!instance) return;
    instance.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    if (instance.listening) await new Promise(resolve => instance.close(resolve));
  }
  function start() {
    if (closePending) return closePending.then(start);
    if (startPending) return startPending;
    if (server?.listening) return Promise.resolve(publicDescriptor());
    const run = ++generation, privateToken = crypto.randomBytes(32).toString("base64url");
    let instance, instanceOrigin = "";
    const pending = (async () => {
      loadSourceId();
      instance = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 1000 },
        (request, response) => { void handle(request, response, privateToken, instanceOrigin, run); });
      server = instance; instance.maxRequestsPerSocket = 1;
      instance.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      instance.on("upgrade", (_request, socket) => socket.destroy());
      instance.on("clientError", (_failure, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
      instance.on("error", () => {});
      await new Promise((resolve, reject) => {
        instance.once("error", reject);
        instance.listen(0, "127.0.0.1", () => { instance.off("error", reject); resolve(); });
      });
      if (run !== generation) throw new Error("Register API start cancelled");
      instanceOrigin = `http://127.0.0.1:${instance.address().port}`;
      writePrivateFileAtomic(descriptorPath, JSON.stringify({ schema_version: 1, url: instanceOrigin, token: privateToken, source_id: sourceId }) + "\n");
      origin = instanceOrigin; token = privateToken;
      return publicDescriptor();
    })().catch(async failure => {
      await closeServer(instance); removeDescriptor(privateToken);
      if (server === instance) server = null;
      throw failure;
    }).finally(() => { if (startPending === pending) startPending = null; });
    startPending = pending;
    return pending;
  }
  function close() {
    if (closePending) return closePending;
    ++generation;
    for (const controller of requests) controller.abort();
    const pending = (async () => {
      await startPending?.catch(() => {});
      await closeServer(server); server = null;
      removeDescriptor(token); token = ""; origin = "";
    })().finally(() => { if (closePending === pending) closePending = null; });
    closePending = pending;
    return pending;
  }
  return { start, close, recoverAfterCancelledQuit: start };
}

module.exports = { createRegisterApi };
