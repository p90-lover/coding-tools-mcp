"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");

const UI_ORIGIN = "coding-tools-register://app";
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function routePath(route, parameters = {}) {
  return route.path.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = parameters[key];
    if (!["string", "number"].includes(typeof value) || !String(value)
      || [".", ".."].includes(String(value)) || /[\\/%?#]/.test(String(value))) throw new Error(`Invalid Register path parameter: ${key}`);
    return encodeURIComponent(String(value));
  });
}

function matchesRoute(route, pathname, method) {
  const escaped = route.path.split(/(\{[^}]+\})/).map((part) => (
    part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")
  )).join("");
  return route.method === method && new RegExp(`^${escaped}$`).test(pathname);
}

function createRegMachineService({
  moduleRoot, runtimeRoot, dataRoot, pythonExecutable = null,
  spawnProcess = spawn, fetchImpl = fetch, terminate = terminateOwnedProcessTree,
  startupTimeoutMs = 45_000,
} = {}) {
  for (const value of [moduleRoot, runtimeRoot, dataRoot]) {
    if (!value || !path.isAbsolute(value)) throw new Error("Register roots must be absolute");
  }
  const routes = require(path.join(moduleRoot, "routes.json"));
  let child = null;
  let starting = null;
  let state = "offline";
  let error = "";
  let origin = "";
  let instance = "";
  let secret = null;
  const portalSessions = new Map();

  function status() {
    const executable = path.join(runtimeRoot, "backend", process.platform === "win32" ? "register-backend.exe" : "register-backend");
    const missing = [
      !pythonExecutable && !fs.existsSync(executable) ? "bundled backend executable" : null,
      !fs.existsSync(path.join(runtimeRoot, "module", "source", "static", "index.html")) ? "bundled Register frontend" : null,
    ].filter(Boolean);
    return { ok: !error, status: state, pid: child?.pid || null, error: error || null,
      available: missing.length === 0, missing, url: state === "ready" ? UI_ORIGIN + "/" : null };
  }

  function secrets() {
    if (secret) return secret;
    const file = path.join(dataRoot, "desktop-auth.json");
    let candidate;
    try {
      candidate = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!["password", "portalPassword", "portalJwt"].every((key) => typeof candidate?.[key] === "string" && candidate[key].length >= 32)) {
        throw new Error("invalid");
      }
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw new Error("Register private authentication file is invalid");
      candidate = Object.fromEntries(["password", "portalPassword", "portalJwt"].map((key) => [key, crypto.randomBytes(32).toString("hex")]));
      writePrivateFileAtomic(file, JSON.stringify(candidate));
    }
    secret = candidate;
    return secret;
  }

  function token() {
    return crypto.createHash("sha256").update("reg-machine-auth\0" + secrets().password).digest("hex");
  }

  async function stop() {
    const owned = child;
    if (owned) {
      terminate(owned, "SIGTERM");
      if (owned.exitCode === null && owned.signalCode === null) {
        await Promise.race([new Promise((resolve) => owned.once("exit", resolve)), delay(2_000)]);
        if (owned.exitCode === null && owned.signalCode === null) terminate(owned, "SIGKILL");
      }
      if (child === owned) child = null;
    }
    origin = "";
    portalSessions.clear();
    state = "offline";
    return status();
  }

  async function start() {
    if (state === "ready" && child?.exitCode === null && child?.signalCode === null) return status();
    if (starting) return starting;
    starting = (async () => {
      const snapshot = status();
      if (!snapshot.available) throw new Error("Register is not bundled: " + snapshot.missing.join(", "));
      const credentials = secrets();
      fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      const port = await new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          const selected = listener.address().port;
          listener.close((cause) => cause ? reject(cause) : resolve(selected));
        });
      });
      instance = crypto.randomBytes(32).toString("hex");
      origin = `http://127.0.0.1:${port}`;
      state = "starting";
      error = "";
      const bundledModule = path.join(runtimeRoot, "module");
      const executable = pythonExecutable || path.join(runtimeRoot, "backend",
        process.platform === "win32" ? "register-backend.exe" : "register-backend");
      const args = pythonExecutable ? [path.join(bundledModule, "desktop_entry.py"), "--port", String(port)] : ["--port", String(port)];
      const owned = spawnProcess(executable, args, {
        cwd: dataRoot, windowsHide: true, detached: DETACH_OWNED_CHILD,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1",
          APP_PASSWORD: credentials.password, CODING_TOOLS_REGISTER_INSTANCE: instance,
          ACCOUNT_MANAGER_DATABASE_URL: "sqlite:///" + path.join(dataRoot, "accounts.db").replaceAll("\\", "/"),
          PORTAL_DATABASE_URL: "sqlite:///" + path.join(dataRoot, "portal.db").replaceAll("\\", "/"),
          PORTAL_JWT_SECRET: credentials.portalJwt, PORTAL_ADMIN_USERNAME: "coding-tools",
          PORTAL_ADMIN_PASSWORD: credentials.portalPassword, PORTAL_CORS_ORIGINS: UI_ORIGIN,
          ANY_AUTO_DISABLE_SOLVER: "1", REG_FACTORY_ENV_FILE: path.join(dataRoot, "authenticator.env"),
          AUTH_DATA_DIR: path.join(dataRoot, "authenticator"),
          PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeRoot, "browsers"),
          CAMOUFOX_CACHE_DIR: path.join(runtimeRoot, "camoufox"),
          REG_MACHINE_NODE_EXECUTABLE: process.execPath,
          NO_PROXY: [process.env.NO_PROXY || process.env.no_proxy || "", "localhost", "127.0.0.1", "::1"].filter(Boolean).join(","),
          no_proxy: [process.env.NO_PROXY || process.env.no_proxy || "", "localhost", "127.0.0.1", "::1"].filter(Boolean).join(","),
        },
      });
      child = owned;
      let spawnError = null;
      owned.once("error", (cause) => { spawnError = cause; });
      owned.once("exit", () => {
        if (child === owned) { child = null; state = "offline"; origin = ""; portalSessions.clear(); }
      });
      // Consume stderr without retaining provider messages or credentials.
      owned.stderr?.on("data", () => {});
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError || owned.exitCode !== null || owned.signalCode !== null) {
          throw new Error("Register backend exited before becoming ready");
        }
        try {
          const response = await fetchImpl(origin + "/api/desktop/health", { signal: AbortSignal.timeout(1_000), redirect: "error" });
          if (response.ok && (await response.json()).instance === instance
            && child === owned && owned.exitCode === null && owned.signalCode === null) {
            state = "ready";
            return status();
          }
        } catch {}
        await delay(150);
      }
      throw new Error("Register backend startup timed out");
    })().catch(async (cause) => {
      try { await stop(); } catch {}
      error = cause.message || "Register backend failed to start";
      state = "error";
      throw new Error(error);
    }).finally(() => { starting = null; });
    return starting;
  }

  function rememberPortalSession(data, sessionId = crypto.randomUUID()) {
    if (state !== "ready") throw new Error("Register stopped before portal sign-in completed");
    if (typeof data?.access_token !== "string" || typeof data?.refresh_token !== "string") {
      throw new Error("Register portal returned no session");
    }
    portalSessions.set(sessionId, { accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: Date.now() + Math.max(0, (Number(data.expires_in) || 7200) - 60) * 1000 });
    return { sessionId, user: data.user, expiresIn: data.expires_in };
  }

  async function refreshPortalSession(sessionId) {
    const saved = portalSessions.get(sessionId);
    if (!saved) throw new Error("Unknown Register portal session");
    if (!saved.refreshing) {
      saved.refreshing = (async () => {
        const response = await fetchImpl(origin + "/portal/api/auth/refresh", { method: "POST",
          headers: { "Content-Type": "application/json" }, redirect: "error",
          body: JSON.stringify({ refresh_token: saved.refreshToken }), signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
          if (portalSessions.get(sessionId) === saved) portalSessions.delete(sessionId);
          throw new Error("Register portal session expired");
        }
        const data = await response.json();
        if (portalSessions.get(sessionId) !== saved || state !== "ready") throw new Error("Register portal session closed");
        return { ok: true, status: response.status, contentType: "application/json",
          data: rememberPortalSession(data, sessionId) };
      })().finally(() => { saved.refreshing = null; });
    }
    return saved.refreshing;
  }

  async function request(pathname, { method = "GET", body, headers = {}, signal, portalSession } = {}) {
    if (state !== "ready" || !origin) throw new Error("Start Register before using its APIs");
    const target = new URL(pathname, origin);
    if (target.origin !== origin || target.username || target.password) throw new Error("Invalid Register API target");
    const trustedHeaders = { ...headers, Authorization: "Bearer " + token() };
    if (target.pathname.startsWith("/portal/api/")) {
      delete trustedHeaders.Authorization;
      if (portalSession) {
        let saved = portalSessions.get(portalSession);
        if (!saved) throw new Error("Unknown Register portal session");
        if (Date.now() >= saved.expiresAt && !target.pathname.startsWith("/portal/api/auth/")) {
          await refreshPortalSession(portalSession);
          saved = portalSessions.get(portalSession);
        }
        trustedHeaders.Authorization = "Bearer " + saved.accessToken;
      }
    }
    return fetchImpl(target, { method, headers: trustedHeaders, body, redirect: "error", signal,
      ...(body && typeof body.pipeTo === "function" ? { duplex: "half" } : {}) });
  }

  async function call(operation, args = {}) {
    if (operation === "status") return status();
    if (operation === "start") return start();
    if (operation === "stop") { if (starting) await starting.catch(() => {}); return stop(); }
    if (operation === "restart") { if (starting) await starting.catch(() => {}); await stop(); return start(); }
    if (operation === "ui-open") { await start(); return { ok: true, url: UI_ORIGIN + "/" }; }
    if (operation === "portal-owner-session") {
      await start();
      const response = await request("/portal/api/auth/login", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: "coding-tools", password: secrets().portalPassword }),
        signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Register portal owner sign-in failed");
      return { ok: true, ...rememberPortalSession(await response.json()) };
    }
    if (operation === "portal_auth_refresh") return refreshPortalSession(args.portalSession);
    const route = routes.find((entry) => entry.name === operation);
    if (!route) throw new Error("Unknown Register API operation");
    const url = new URL(routePath(route, args.parameters), UI_ORIGIN);
    for (const [key, value] of Object.entries(args.query || {})) {
      if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Register query values must be scalar");
      url.searchParams.set(key, String(value));
    }
    if (route.stream) {
      if (route.path.startsWith("/portal/")) {
        if (!portalSessions.has(args.portalSession)) throw new Error("Sign into the customer portal before opening its events");
        url.searchParams.set("_desktop_session", args.portalSession);
      }
      return { ok: true, stream: true, url: UI_ORIGIN + url.pathname + url.search };
    }
    let payload = args.body;
    if (operation === "portal_auth_logout") {
      const saved = portalSessions.get(args.portalSession);
      if (!saved) throw new Error("Unknown Register portal session");
      payload = { refresh_token: saved.refreshToken };
    }
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("Register request is too large");
    const response = await request(url.pathname + url.search, { method: route.method, body,
      headers: { "Content-Type": "application/json", ...(route.path === "/api/authenticator/entries"
        ? { "X-Requested-With": "reg-machine-authenticator" } : {}) },
      signal: AbortSignal.timeout(45_000), portalSession: args.portalSession });
    if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("Register response is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new Error("Register response is too large");
    const contentType = response.headers.get("content-type") || "";
    let data = contentType.includes("application/json") && bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
    if (response.ok && operation === "portal_auth_login") data = rememberPortalSession(data);
    if (response.ok && operation === "portal_auth_logout") portalSessions.delete(args.portalSession);
    return { ok: response.ok && data?.ok !== false, status: response.status, contentType,
      ...(contentType.includes("application/json") ? { data }
        : { dataBase64: bytes.toString("base64"), disposition: response.headers.get("content-disposition") }) };
  }

  async function handleRequest(incoming) {
    const url = new URL(incoming.url);
    if (url.protocol !== "coding-tools-register:" || url.host !== "app" || url.username || url.password) return new Response("Forbidden", { status: 403 });
    const portalSession = incoming.headers.get("x-register-portal-session") || url.searchParams.get("_desktop_session");
    url.searchParams.delete("_desktop_session");
    if (url.pathname.startsWith("/portal/api/") && portalSession && !portalSessions.has(portalSession)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const isApi = url.pathname.startsWith("/api") || url.pathname.startsWith("/portal/api");
    const originHeader = incoming.headers.get("origin");
    if (isApi && ((originHeader && originHeader !== UI_ORIGIN)
      || incoming.headers.get("sec-fetch-site") === "cross-site")) return new Response("Forbidden", { status: 403 });
    const route = routes.find((entry) => matchesRoute(entry, url.pathname, incoming.method));
    const staticPath = incoming.method === "GET" && !isApi
      && (/^\/(?:assets\/[^/]+|favicon.svg|icons.svg)$/.test(url.pathname)
        || /^\/(?:register|history|tasks|authenticator|proxies|settings|accounts(?:\/[^/]+)?)?$/.test(url.pathname));
    if (!route && !staticPath) return new Response("Not found", { status: 404 });
    try {
      const raw = ["GET", "HEAD"].includes(incoming.method) ? undefined : await incoming.arrayBuffer();
      if (raw && raw.byteLength > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });
      if (["portal_auth_login", "portal_auth_refresh", "portal_auth_logout"].includes(route?.name)) {
        if (route.name !== "portal_auth_login" && !portalSessions.has(portalSession)) return new Response("Unauthorized", { status: 401 });
        let body = {};
        try { if (raw?.byteLength) body = JSON.parse(Buffer.from(raw).toString("utf8")); }
        catch { return new Response("Invalid JSON", { status: 400 }); }
        const result = await call(route.name, { body, portalSession });
        return Response.json(result.data, { status: result.status });
      }
      const response = await request(url.pathname + url.search, { method: incoming.method, body: raw,
        headers: { "Content-Type": incoming.headers.get("content-type") || "application/json",
          ...(route?.path === "/api/authenticator/entries" ? { "X-Requested-With": "reg-machine-authenticator" } : {}) },
        signal: incoming.signal, portalSession });
      const headers = new Headers(response.headers);
      for (const name of ["set-cookie", "content-encoding", "content-length", "transfer-encoding"]) headers.delete(name);
      if (!isApi) headers.set("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'");
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response("Register backend is unavailable", { status: 503 }); }
  }

  return Object.freeze({ call, status, start, stop: () => call("stop"), handleRequest });
}

module.exports = { createRegMachineService, routePath, matchesRoute, UI_ORIGIN };
