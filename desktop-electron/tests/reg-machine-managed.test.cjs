const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const Module = require("node:module");
const { createRegMachineService, routePath, matchesRoute, UI_ORIGIN } = require("../electron/reg-machine-managed.cjs");
const moduleRoot = path.resolve(__dirname, "../../app-handler/reg-machine");
const handler = require(path.join(moduleRoot, "handler.cjs"));
const routes = require(path.join(moduleRoot, "routes.json"));

test("Register source provenance and complete operation catalog exclude private state", () => {
  const manifest = require(path.join(moduleRoot, "SOURCE_SNAPSHOT.json"));
  assert.equal(manifest.files.length, 312);
  for (const file of manifest.files) {
    assert.doesNotMatch(file.path, /(^|\/)(data|exports|runtime|aiTemp|Trash|node_modules|\.venv|\.env[^/]*|tokens|cookies)(\/|$)|\.(db|har)$/i);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(moduleRoot, "source", file.path))).digest("hex"),
      file.sha256, file.path);
  }
  assert.equal(new Set(routes.map((route) => route.name)).size, routes.length);
  assert.ok(routes.length >= 144);
  for (const route of routes) {
    assert.ok(handler.operations.includes(route.name), route.name);
    if (route.method !== "GET" || /\/authenticator\//.test(route.path)) assert.equal(handler.isReadOnly(route.name), false);
    assert.ok(matchesRoute(route, routePath(route, Object.fromEntries([...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1], "fixture"]))), route.method));
  }
  for (const bad of ["..", ".", "a/b", "%2f", "a?query", "a#fragment"]) {
    assert.throws(() => routePath({ path: "/api/accounts/{id}" }, { id: bad }), /Invalid Register path/);
  }
  assert.equal(routePath({ path: "/api/accounts/{id}" }, { id: "fixture.name" }), "/api/accounts/fixture.name");
});

test("Register lifecycle owns one child and keeps credentials out of UI, streams and binary responses", async () => {
  const fixture = path.resolve(__dirname, "../../aiTemp/reg-machine-tests/" + crypto.randomUUID());
  const runtimeRoot = path.join(fixture, "runtime");
  fs.mkdirSync(path.join(runtimeRoot, "backend"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "module/source/static"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "backend", process.platform === "win32" ? "register-backend.exe" : "register-backend"), "");
  fs.writeFileSync(path.join(runtimeRoot, "module/source/static/index.html"), "<html>Register</html>");
  let spawned = 0;
  let stopped = 0;
  let environment;
  let portalLogins = 0;
  const privileged = routes.find((entry) => entry.name.startsWith("portal_admin_") && entry.path.endsWith("/users") && entry.method === "GET");
  assert.ok(privileged);
  const owned = new EventEmitter();
  Object.assign(owned, { pid: 987654, exitCode: null, signalCode: null, stderr: new EventEmitter() });
  const service = createRegMachineService({
    moduleRoot, runtimeRoot, dataRoot: path.join(fixture, "data"),
    spawnProcess(_executable, args, options) {
      spawned++;
      environment = options.env;
      assert.deepEqual(args.slice(0, 1), ["--port"]);
      assert.equal(options.cwd, path.join(fixture, "data"));
      assert.equal(options.windowsHide, true);
      return owned;
    },
    terminate(child) {
      assert.equal(child, owned);
      stopped++;
      owned.exitCode = 0;
      owned.emit("exit", 0);
    },
    async fetchImpl(input, options = {}) {
      const url = new URL(input);
      assert.equal(url.hostname, "127.0.0.1");
      if (url.pathname === "/api/desktop/health") return Response.json({ instance: environment.CODING_TOOLS_REGISTER_INSTANCE });
      if (url.pathname === "/portal/api/auth/login") {
        portalLogins++;
        const account = JSON.parse(options.body).account;
        return Response.json({ access_token: "portal-access-" + account, refresh_token: "portal-refresh-" + account,
          expires_in: 7200, user: { username: account, role: account === "coding-tools" ? "owner" : "customer" } });
      }
      if (url.pathname.startsWith("/portal/api/")) {
        const auth = options.headers.Authorization;
        if (!auth) return new Response("Unauthorized", { status: 401 });
        assert.ok(auth.startsWith("Bearer portal-access-"), "the host APP credential must never become a portal credential");
        const upstream = routes.find((entry) => matchesRoute(entry, url.pathname, options.method || "GET"));
        if ((url.pathname === privileged.path || (upstream?.stream && upstream.name.startsWith("portal_admin_")))
          && auth !== "Bearer portal-access-coding-tools") {
          return new Response("Forbidden", { status: 403 });
        }
        assert.equal(url.searchParams.has("_desktop_session"), false);
        if (url.pathname.endsWith("/events") || url.pathname.endsWith("/stream")) {
          return new Response("data: " + auth.slice("Bearer portal-access-".length) + "\n\n",
            { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ username: auth.slice("Bearer portal-access-".length) });
      }
      assert.ok(options.headers.Authorization.startsWith("Bearer "));
      if (url.pathname === "/api/auth/check") return Response.json({ required: true, authenticated: true });
      if (url.pathname.endsWith("/events")) return new Response("data: fixture\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.includes("/export")) return new Response("fixture-binary", { headers: { "content-type": "application/octet-stream", "set-cookie": "_auth=private" } });
      return Response.json({ platform: "fixture" });
    },
  });
  try {
    const [first, second] = await Promise.all([service.start(), service.start()]);
    assert.equal(spawned, 1);
    assert.equal(first.pid, second.pid);
    assert.equal(service.status().status, "ready");
    assert.equal(environment.ANY_AUTO_DISABLE_SOLVER, "1");
    assert.ok(environment.ACCOUNT_MANAGER_DATABASE_URL.includes("/data/accounts.db"));
    assert.ok(!JSON.stringify(service.status()).includes(environment.APP_PASSWORD));
    assert.deepEqual(await service.call("ui-open"), { ok: true, url: UI_ORIGIN + "/" });
    const response = await service.handleRequest(new Request(UI_ORIGIN + "/api/auth/check"));
    assert.deepEqual(await response.json(), { required: true, authenticated: true });
    const streaming = routes.find((route) => route.path.endsWith("/events"));
    const streamPath = routePath(streaming, { task_id: 1 });
    const events = await service.handleRequest(new Request(UI_ORIGIN + streamPath));
    assert.equal(await events.text(), "data: fixture\n\n");
    const binary = await service.handleRequest(new Request(UI_ORIGIN + "/api/accounts/export"));
    assert.equal(await binary.text(), "fixture-binary");
    assert.equal(binary.headers.get("set-cookie"), null);
    assert.equal((await service.handleRequest(new Request("https://attacker.invalid/api/accounts"))).status, 403);
    assert.equal((await service.handleRequest(new Request(UI_ORIGIN + "/api/accounts", { headers: { origin: "https://attacker.invalid" } }))).status, 403);
    assert.equal((await service.handleRequest(new Request(UI_ORIGIN + "/api/unknown"))).status, 404);
    await assert.rejects(service.call("unknown"), /Unknown Register/);

    const anonymous = await service.handleRequest(new Request(UI_ORIGIN + "/portal/api/auth/me"));
    assert.equal(anonymous.status, 401);
    assert.equal(portalLogins, 0, "portal reads must never implicitly sign in as owner");
    const signedIn = await service.call("portal_auth_login", { body: { account: "customer", password: "fixture" } });
    const customerSession = signedIn.data.sessionId;
    assert.equal(typeof customerSession, "string");
    assert.ok(!JSON.stringify(signedIn).includes("portal-access-"));
    const denied = await service.call(privileged.name, { portalSession: customerSession });
    assert.equal(denied.status, 403, "upstream customer permissions remain effective");
    const owner = await service.call("portal-owner-session");
    assert.equal((await service.call(privileged.name, { portalSession: owner.sessionId })).status, 200);
    const portalStreams = routes.filter((entry) => entry.stream && entry.path.startsWith("/portal/"));
    assert.equal(portalStreams.length, 4);
    let previousStream;
    for (const stream of portalStreams) {
      const opened = await service.call(stream.name, { parameters: { task_id: 1 }, portalSession: customerSession });
      assert.ok(opened.url.includes("_desktop_session="));
      const result = await service.handleRequest(new Request(opened.url));
      if (stream.name.startsWith("portal_admin_")) {
        assert.equal(result.status, 403);
        const ownerStream = await service.call(stream.name, { parameters: { task_id: 1 }, portalSession: owner.sessionId });
        const allowed = await service.handleRequest(new Request(ownerStream.url));
        assert.equal(allowed.status, 200);
        assert.equal(await allowed.text(), "data: coding-tools\n\n");
      } else {
        assert.equal(result.status, 200);
        assert.equal(await result.text(), "data: customer\n\n");
        previousStream = opened.url;
      }
    }
    await service.call("portal_auth_logout", { portalSession: customerSession });
    assert.equal((await service.handleRequest(new Request(previousStream))).status, 401);

    await service.stop();
    assert.equal(stopped, 1);
    assert.equal(service.status().pid, null);
  } finally {
    await service.stop();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Register reports missing release artifacts without starting a process", async () => {
  let spawned = false;
  const missing = path.resolve(__dirname, "../../aiTemp/reg-machine-missing-release");
  const service = createRegMachineService({ moduleRoot, runtimeRoot: missing, dataRoot: missing,
    spawnProcess() { spawned = true; throw new Error("unexpected spawn"); } });
  assert.equal(service.status().available, false);
  await assert.rejects(service.start(), /Register is not bundled/);
  assert.equal(spawned, false);
});

function loadServiceWithMocks(overrides, globals = {}) {
  const file = path.resolve(__dirname, "../electron/reg-machine-managed.cjs");
  const originalRequire = Module.createRequire(file);
  const context = { module: { exports: {} }, process, Buffer, URL, AbortSignal, Response, fetch, ...globals,
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : originalRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.module.exports.createRegMachineService;
}

test("Register never caches invalid or unpersisted authentication across retries", async () => {
  for (const scenario of ["invalid", "disk-full"]) {
    let writes = 0;
    let spawns = 0;
    const mockedFs = { existsSync: () => true, mkdirSync: () => {},
      readFileSync: () => {
        if (scenario === "invalid") return JSON.stringify({ password: "bad", portalPassword: "bad", portalJwt: "bad" });
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      } };
    const create = loadServiceWithMocks({ "node:fs": mockedFs, "./atomic-file.cjs": {
      writePrivateFileAtomic() { writes++; throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    } });
    const service = create({ moduleRoot, runtimeRoot: path.resolve("aiTemp/mock-runtime"), dataRoot: path.resolve("aiTemp/mock-data"),
      spawnProcess() { spawns++; throw new Error("unexpected spawn"); } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(service.start(), scenario === "invalid" ? /authentication file is invalid/ : /disk full/);
    }
    assert.equal(spawns, 0, scenario);
    assert.equal(writes, scenario === "disk-full" ? 2 : 0);
  }
});

test("Register stop waits for an in-flight start and leaves no owned backend", async () => {
  let releasePort;
  let environment;
  let alive = false;
  const mockedFs = { existsSync: () => true, mkdirSync: () => {},
    readFileSync: () => JSON.stringify({ password: "a".repeat(64), portalPassword: "b".repeat(64), portalJwt: "c".repeat(64) }) };
  const create = loadServiceWithMocks({ "node:fs": mockedFs, "node:net": { createServer: () => ({
    once() {}, listen(_port, _host, callback) { releasePort = callback; },
    address: () => ({ port: 18765 }), close(callback) { callback(); },
  }) } });
  const owned = new EventEmitter();
  Object.assign(owned, { pid: 987654, exitCode: null, signalCode: null, stderr: new EventEmitter() });
  const service = create({ moduleRoot, runtimeRoot: path.resolve("aiTemp/mock-runtime"), dataRoot: path.resolve("aiTemp/mock-data"),
    spawnProcess(_file, _args, options) { environment = options.env; alive = true; return owned; },
    terminate() { alive = false; owned.exitCode = 0; owned.emit("exit", 0); },
    fetchImpl: async () => Response.json({ instance: environment.CODING_TOOLS_REGISTER_INSTANCE }) });
  const starting = service.start();
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  releasePort();
  await Promise.all([starting, stopping]);
  assert.equal(alive, false);
  assert.equal(service.status().pid, null);
});

test("Register protocol auth stays opaque and concurrent expired portal reads refresh once", { timeout: 5_000 }, async () => {
  let clock = 1;
  let environment;
  let refreshes = 0;
  let finishRefresh;
  const mockedFs = { existsSync: () => true, mkdirSync: () => {},
    readFileSync: () => JSON.stringify({ password: "a".repeat(64), portalPassword: "b".repeat(64), portalJwt: "c".repeat(64) }) };
  const create = loadServiceWithMocks({ "node:fs": mockedFs, "node:net": { createServer: () => ({
    once() {}, listen(_port, _host, callback) { callback(); },
    address: () => ({ port: 18765 }), close(callback) { callback(); },
  }) } }, { Date: { now: () => clock } });
  const owned = new EventEmitter();
  Object.assign(owned, { pid: 987654, exitCode: null, signalCode: null, stderr: new EventEmitter() });
  const service = create({ moduleRoot, runtimeRoot: path.resolve("aiTemp/mock-runtime"), dataRoot: path.resolve("aiTemp/mock-data"),
    spawnProcess(_file, _args, options) { environment = options.env; return owned; },
    terminate() { owned.exitCode = 0; owned.emit("exit", 0); },
    async fetchImpl(input, options) {
      const url = new URL(input);
      if (url.pathname === "/api/desktop/health") return Response.json({ instance: environment.CODING_TOOLS_REGISTER_INSTANCE });
      if (url.pathname === "/portal/api/auth/login") return Response.json({
        access_token: "fixture-old-access", refresh_token: "fixture-old-refresh", expires_in: 120, user: { role: "customer" } });
      if (url.pathname === "/portal/api/auth/refresh") {
        refreshes++;
        await new Promise((resolve) => { finishRefresh = resolve; });
        return Response.json({ access_token: "fixture-fresh-access", refresh_token: "fixture-fresh-refresh",
          expires_in: 7200, user: { role: "customer" } });
      }
      if (url.pathname === "/portal/api/auth/logout") {
        assert.equal(JSON.parse(options.body).refresh_token, "fixture-fresh-refresh");
        return Response.json({ ok: true });
      }
      assert.equal(options.headers.Authorization, "Bearer fixture-fresh-access");
      return Response.json({ role: "customer" });
    } });
  try {
    await service.start();
    const signedIn = await service.handleRequest(new Request(UI_ORIGIN + "/portal/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", origin: UI_ORIGIN },
      body: JSON.stringify({ account: "fixture", password: "fixture" }) }));
    assert.equal(signedIn.status, 200);
    const opaque = await signedIn.json();
    assert.equal(typeof opaque.sessionId, "string");
    assert.equal(opaque.access_token, undefined);
    assert.equal(opaque.refresh_token, undefined);
    clock = 120_000;
    const one = service.call("portal_app_api_get_profile", { portalSession: opaque.sessionId });
    const two = service.call("portal_app_api_get_profile", { portalSession: opaque.sessionId });
    await Promise.resolve();
    assert.equal(refreshes, 1);
    finishRefresh();
    assert.deepEqual((await Promise.all([one, two])).map((result) => result.status), [200, 200]);
    const refreshed = service.handleRequest(new Request(UI_ORIGIN + "/portal/api/auth/refresh", {
      method: "POST", headers: { "x-register-portal-session": opaque.sessionId } }));
    for (let attempt = 0; attempt < 20 && refreshes < 2; attempt++) await new Promise(setImmediate);
    assert.equal(refreshes, 2);
    finishRefresh();
    const renewed = await (await refreshed).json();
    assert.equal(renewed.sessionId, opaque.sessionId);
    assert.equal(renewed.access_token, undefined);
    const loggedOut = await service.handleRequest(new Request(UI_ORIGIN + "/portal/api/auth/logout", {
      method: "POST", headers: { "x-register-portal-session": opaque.sessionId } }));
    assert.equal(loggedOut.status, 200);
    const stream = routes.find((entry) => entry.stream && entry.path.startsWith("/portal/api/app"));
    await assert.rejects(service.call(stream.name, { parameters: { task_id: 1 }, portalSession: opaque.sessionId }), /Sign into/);
  } finally { await service.stop(); }
});
