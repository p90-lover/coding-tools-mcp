"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const HEADER_TIMEOUT_MS = 180_000;
const BLOCKED_PATH = /^\/(?:internal|shutdown)(?:\/|$)|^\/api\/v1\/(?:mobile|cloud|remotes|dev)(?:\/|$)|\/preview\/server\/?$/;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("Request exceeds 64 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function createAgentOrchestratorGateway({ rendererRoot, daemonPort, getStatus, desktopRequest }) {
  const bootstrap = crypto.randomBytes(32).toString("hex");
  const sessionKey = crypto.randomBytes(32).toString("hex");
  const cookieName = `ao_${crypto.randomBytes(8).toString("hex")}`;
  const sockets = new Set();
  const pendingRequests = new Set();
  let origin = "";
  let bootstrapAvailable = true;

  function authorized(request) {
    return request.headers.host === new URL(origin).host
      && (!request.headers.origin || request.headers.origin === origin)
      && String(request.headers.cookie || "").split(/;\s*/).includes(`${cookieName}=${sessionKey}`)
      && !["cross-site", "same-site"].includes(request.headers["sec-fetch-site"]);
  }

  function json(response, status, value) {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  }

  function proxy(request, response, body) {
    const headers = { ...request.headers, host: `127.0.0.1:${daemonPort}`, origin, cookie: "" };
    if (body) { delete headers["transfer-encoding"]; headers["content-length"] = String(body.length); }
    const upstream = http.request({
      hostname: "127.0.0.1", port: daemonPort, path: request.url, method: request.method,
      headers,
    }, (result) => {
      clearTimeout(headerDeadline);
      if (result.statusCode >= 300 && result.statusCode < 400) {
        result.resume();
        json(response, 502, { error: "Upstream redirects are not permitted" });
        return;
      }
      const headers = { ...result.headers };
      delete headers["set-cookie"];
      delete headers["access-control-allow-origin"];
      response.writeHead(result.statusCode, headers);
      response.flushHeaders();
      result.pipe(response);
      response.on("close", () => result.destroy());
    });
    // AO import validation and git inspection can take well over 20 s on large checkouts.
    let timedOut = false;
    const headerDeadline = setTimeout(() => { timedOut = true; upstream.destroy(new Error("AO response headers timed out")); }, HEADER_TIMEOUT_MS);
    pendingRequests.add(upstream);
    upstream.once("close", () => { clearTimeout(headerDeadline); pendingRequests.delete(upstream); });
    response.once("close", () => upstream.destroy());
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else if (timedOut) json(response, 504, { error: { message: "AO took too long to answer; try again" } });
      else json(response, 502, { error: { message: "AO daemon unavailable" } });
    });
    request.on("aborted", () => upstream.destroy());
    if (body) upstream.end(body); else request.pipe(upstream);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const target = new URL(request.url, origin);
      if (bootstrapAvailable && request.method === "GET" && target.pathname === `/open/${bootstrap}`
        && request.headers.host === new URL(origin).host && !request.headers.origin) {
        bootstrapAvailable = false;
        response.writeHead(303, { location: "/", "set-cookie": `${cookieName}=${sessionKey}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        response.end();
        return;
      }
      if (!authorized(request)) { json(response, 403, { error: "Untrusted AO client" }); return; }
      const decodedPath = decodeURIComponent(target.pathname);
      if (BLOCKED_PATH.test(decodedPath)) { json(response, 403, { error: "Remote access is disabled in the local-only integration" }); return; }
      if (target.pathname === "/integration/status" && request.method === "GET") {
        json(response, 200, { ...getStatus(), port: server.address().port });
        return;
      }
      if (target.pathname === "/integration/desktop" && request.method === "POST") {
        const input = await readJson(request);
        json(response, 200, { ok: true, value: await desktopRequest(input.operation, input.args || {}) });
        return;
      }
      if (target.pathname.startsWith("/api/")) {
        let body;
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
          const input = await readJson(request);
          body = Buffer.from(JSON.stringify(input));
        }
        proxy(request, response, body);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { json(response, 405, { error: "Method not allowed" }); return; }
      const root = fs.realpathSync(rendererRoot);
      let filePath = path.resolve(root, `.${decodedPath}`);
      if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) throw new Error("Invalid asset path");
      if (!path.extname(filePath)) filePath = path.join(root, "index.html");
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { json(response, 404, { error: "Asset not found" }); return; }
      const realFile = fs.realpathSync(filePath);
      if (!realFile.startsWith(`${root}${path.sep}`)) throw new Error("Asset escaped renderer root");
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(realFile)] || "application/octet-stream",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache",
        "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; frame-src 'none'; object-src 'none'; base-uri 'self'",
      });
      if (request.method === "HEAD") response.end(); else fs.createReadStream(realFile).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, 400, { ok: false, error: error.message }); else response.destroy();
    }
  });

  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, client, head) => {
    if (!authorized(request) || !/^\/mux(?:[/?]|$)/.test(request.url)) { client.destroy(); return; }
    const upstream = http.request({ hostname: "127.0.0.1", port: daemonPort, path: request.url, headers: { ...request.headers, host: `127.0.0.1:${daemonPort}`, origin, cookie: "" } });
    const headerDeadline = setTimeout(() => upstream.destroy(), 20000);
    pendingRequests.add(upstream);
    upstream.once("close", () => { clearTimeout(headerDeadline); pendingRequests.delete(upstream); });
    client.once("close", () => upstream.destroy());
    upstream.on("upgrade", (result, backend, backendHead) => {
      clearTimeout(headerDeadline);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (backendHead.length) client.write(backendHead);
      if (head.length) backend.write(head);
      backend.pipe(client); client.pipe(backend);
      client.on("error", () => backend.destroy()); backend.on("error", () => client.destroy());
      client.on("close", () => backend.destroy()); backend.on("close", () => client.destroy());
    });
    upstream.on("error", () => client.destroy());
    upstream.on("response", (response) => { response.destroy(); client.destroy(); });
    upstream.end();
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return { origin, openUrl: `${origin}/open/${bootstrap}` };
    },
    async close() {
      for (const request of pendingRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createAgentOrchestratorGateway, BLOCKED_PATH, readJson };
