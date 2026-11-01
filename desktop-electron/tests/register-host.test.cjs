"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { createRegisterHost } = require("../electron/register-host.cjs");

const fixtureRoot = path.resolve(__dirname, "../../aiTemp/register-cpa-20261023/host/host-tests");
const identity = { ok: true, service: "account-manager-v2" };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(fixtureRoot, "case-"));
  const runtime = path.join(base, "runtime"), data = path.join(base, "data");
  fs.mkdirSync(runtime); fs.mkdirSync(data);
  const executable = path.join(runtime, process.platform === "win32" ? "register-service.exe" : "register-service");
  fs.writeFileSync(executable, "fixture", { mode: 0o700 });
  let instanceId;
  const servers = [], hosts = [], views = [], attaches = [], detaches = [], external = [];
  t.after(async () => {
    for (const host of hosts) await host.shutdown();
    for (const server of servers) if (server.listening) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    assert.ok(base.startsWith(fixtureRoot + path.sep));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const serve = async (handler = (_request, response) => response.end(JSON.stringify({ ...identity, ...(instanceId ? { instance_id: instanceId } : {}) })), port = 0) => {
    const server = http.createServer(handler); servers.push(server);
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    return { server, origin: "http://127.0.0.1:" + server.address().port };
  };
  const freeOrigin = async () => { const found = await serve(); await new Promise(resolve => found.server.close(resolve)); return found.origin; };
  const makeView = partition => {
    const contents = new EventEmitter();
    Object.assign(contents, { session: new EventEmitter(), closed: false, loads: [], reloads: 0,
      isDestroyed() { return this.closed; }, close() { this.closed = true; }, reload() { this.reloads++; },
      async loadURL(url) { this.loads.push(url); }, setWindowOpenHandler(handler) { this.popup = handler; },
      focus() { throw Error("Passive hosting must not focus"); },
    });
    const view = { partition, webContents: contents, placements: [], setBounds(rect) { this.placements.push(rect); } };
    views.push(view); return view;
  };
  const host = options => {
    const spawnProcess = options?.spawnProcess || (() => { throw Error("Unexpected spawn"); });
    const instance = createRegisterHost({ runtimeRoot: runtime, dataRoot: data, createView: makeView,
      attachView: view => attaches.push(view), detachView: view => detaches.push(view), openExternal: url => external.push(url),
      healthTimeoutMs: 500, startupTimeoutMs: 1200, pollIntervalMs: 5,
      ...options, spawnProcess: (...args) => { instanceId = args[2]?.env.CT_REGISTER_INSTANCE_ID; return spawnProcess(...args); } });
    hosts.push(instance); return instance;
  };
  const child = onKill => {
    const value = new EventEmitter();
    Object.assign(value, { pid: undefined, exitCode: null, signalCode: null, kills: 0,
      kill() { this.kills++; onKill?.(); this.exitCode = 0; this.emit("exit", 0); return true; } });
    return value;
  };
  const until = async condition => {
    const deadline = Date.now() + 1000;
    while (!condition()) { assert.ok(Date.now() < deadline, "Fixture condition deadline"); await tick(); }
  };
  return { base, runtime, data, executable, serve, freeOrigin, host, child, views, attaches, detaches, external, until };
}

async function managedService(f, handler, options = {}) {
  const origin = await f.freeOrigin();
  let service, environment;
  const health = { valid: true }, calls = [];
  const host = f.host({ origin, ...options, spawnProcess: (_program, _args, settings) => {
    environment = settings.env;
    const child = f.child(() => { service?.server.closeAllConnections(); service?.server.close(); });
    void f.serve((request, response) => {
      if (request.url === "/api/health") {
        response.end(JSON.stringify({ ...identity, instance_id: health.valid ? environment.CT_REGISTER_INSTANCE_ID : "foreign-instance" }));
      } else {
        calls.push({ route: request.url, method: request.method, authorization: request.headers.authorization });
        handler(request, response);
      }
    }, Number(new URL(origin).port)).then(value => { service = value; });
    return child;
  } });
  const started = await host.start(); assert.equal(started.ready, true, started.error);
  return { host, calls, health, environment };
}

test("managed runtime starts without a project checkout or virtual environment and keeps its bearer native", async t => {
  const f = await fixture(t), origin = await f.freeOrigin();
  let spawned, service, privateToken;
  const host = f.host({ projectRoot: "", runtimeRoot: f.runtime, dataRoot: f.data, origin,
    prepareSession: (_session, _origin, token) => { privateToken = token; },
    spawnProcess: (program, args, options) => {
      spawned = { program, args, options };
      const child = f.child(() => { service?.server.closeAllConnections(); service?.server.close(); });
      void f.serve((_request, response) => response.end(JSON.stringify({ ...identity,
        instance_id: options.env.CT_REGISTER_INSTANCE_ID })), Number(new URL(origin).port)).then(value => { service = value; });
      return child;
    },
  });
  host.setSurfaceActive(true);
  const value = await host.start();
  assert.equal(value.ready, true, value.error); assert.equal(value.managed, true);
  assert.equal(spawned.program, f.executable);
  assert.deepEqual(spawned.args, ["--host", "127.0.0.1", "--port", new URL(origin).port]);
  assert.equal(spawned.options.cwd, f.data);
  assert.match(spawned.options.env.APP_PASSWORD, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(spawned.options.env.CT_REGISTER_DATA_DIR, f.data);
  assert.equal(spawned.options.env.ACCOUNT_MANAGER_DATA_DIR, f.data);
  assert.equal(spawned.options.env.ACCOUNT_MANAGER_DATABASE_URL, "sqlite:///" + path.join(f.data, "account_manager.db").replaceAll("\\", "/"));
  await f.until(() => privateToken);
  assert.equal(privateToken, spawned.options.env.APP_PASSWORD);
  assert.equal(JSON.stringify(value).includes(privateToken), false);
  assert.equal("projectRoot" in value, false);
});

test("managed child discards inherited external Python and browser runtime overrides", async t => {
  const f = await fixture(t);
  const names = ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "PLAYWRIGHT_NODEJS_PATH"];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "FIXTURE_EXTERNAL_RUNTIME_DO_NOT_USE";
    const managed = await managedService(f, (_request, response) => response.end("{}"));
    assert.ok(Object.keys(managed.environment).every(name => !names.includes(name.toUpperCase())));
    assert.equal(managed.environment.CT_REGISTER_DATA_DIR, f.data);
    assert.equal(managed.environment.ACCOUNT_MANAGER_DATA_DIR, f.data);
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("status only probes exact identity; attached services are never acquired or killed", async t => {
  const f = await fixture(t), service = await f.serve();
  let spawns = 0;
  const host = f.host({ origin: service.origin, spawnProcess: () => { spawns++; } });
  assert.equal((await host.status()).ready, true); assert.equal(f.views.length, 0);
  const started = await host.start();
  assert.equal(started.owned, false); assert.equal(started.starting, false); assert.equal(spawns, 0);
  assert.equal((await host.stop()).ready, true);
  await host.shutdown();
  assert.equal((await fetch(service.origin + "/api/health")).status, 200);
});

test("wrong service identity, malformed JSON and hanging responses never spawn", async t => {
  const f = await fixture(t);
  for (const responseBody of [{ ok: true, service: "another" }, { ok: false, service: identity.service }, "not json"]) {
    const service = await f.serve((_request, response) => response.end(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)));
    const host = f.host({ origin: service.origin });
    assert.equal((await host.status()).ready, false);
    assert.match((await host.start()).error, /port.*in use/i);
  }
  const hung = await f.serve((_request, response) => {
    response.write("{"); const timer = setInterval(() => response.write(" "), 5);
    response.on("close", () => clearInterval(timer));
  });
  const host = f.host({ origin: hung.origin, healthTimeoutMs: 30 });
  const startedAt = Date.now(); assert.equal((await host.status()).ready, false);
  assert.ok(Date.now() - startedAt < 500, "Health has a total deadline, even with continuing data");
});

test("managed Register ignores legacy checkout settings and has no project configuration entry point", async t => {
  const f = await fixture(t);
  const configPath = path.join(f.base, "settings/runtime-register.json");
  fs.mkdirSync(path.dirname(configPath)); fs.writeFileSync(configPath, '{"projectRoot":"unavailable-checkout"}');
  const host = f.host({ origin: await f.freeOrigin(), configPath, projectRoot: "unavailable-checkout" });
  const value = await host.status();
  assert.equal(value.managed, true); assert.equal(value.runtimeRoot, f.runtime); assert.equal(value.dataRoot, f.data);
  assert.equal("projectRoot" in value, false); assert.equal(host.configure, undefined);
  assert.equal(fs.readFileSync(configPath, "utf8"), '{"projectRoot":"unavailable-checkout"}');
});

test("start validates only the bundled executable and writable app storage", async t => {
  const f = await fixture(t), host = f.host({ origin: await f.freeOrigin() });
  fs.unlinkSync(f.executable);
  const result = await host.start(); assert.equal(result.owned, false); assert.match(result.error, /bundled.*missing/i);
  fs.writeFileSync(f.executable, "fixture", { mode: 0o700 });
  const unavailable = path.join(f.base, "file"); fs.writeFileSync(unavailable, "fixture");
  const brokenStorage = f.host({ origin: await f.freeOrigin(), dataRoot: unavailable });
  assert.match((await brokenStorage.start()).error, /writable storage/);
});

test("concurrent starts share one child, fixed argv and private managed auth/storage environment", async t => {
  const f = await fixture(t), origin = await f.freeOrigin();
  let spawned, calls = 0, service, child;
  const host = f.host({ origin, spawnProcess: (program, args, options) => {
    calls++; spawned = { program, args, options };
    child = f.child(() => { service?.server.closeAllConnections(); service?.server.close(); });
    void f.serve(undefined, Number(new URL(origin).port)).then(value => { service = value; }); return child;
  } });
  const first = host.start(); assert.equal(host.start(), first);
  const value = await first;
  assert.equal(value.ready, true); assert.equal(value.owned, true); assert.equal(value.starting, false); assert.equal(calls, 1);
  assert.equal(spawned.program, f.executable);
  assert.deepEqual(spawned.args, ["--host", "127.0.0.1", "--port", new URL(origin).port]);
  const managed = new Set(["APP_PASSWORD", "CT_REGISTER_INSTANCE_ID", "CT_REGISTER_DATA_DIR", "ACCOUNT_MANAGER_DATA_DIR", "ACCOUNT_MANAGER_DATABASE_URL"]);
  const external = new Set(["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "PLAYWRIGHT_NODEJS_PATH"]);
  assert.ok(Object.entries(process.env).every(([key, value]) => managed.has(key) || external.has(key.toUpperCase()) || spawned.options.env[key] === value), "Unrelated child environment remains unchanged");
  assert.match(spawned.options.env.APP_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(spawned.options.cwd, f.data);
  assert.equal(spawned.options.windowsHide, true); assert.deepEqual(spawned.options.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal((await host.stop()).owned, false); assert.equal(child.kills, 1);
});

test("startup timeout and spawn errors expose actionable messages without raw secrets", async t => {
  const f = await fixture(t), child = f.child(), origin = await f.freeOrigin();
  const timeout = f.host({ origin, startupTimeoutMs: 35, spawnProcess: () => child });
  const value = await timeout.start(); assert.match(value.error, /did not become ready/); assert.equal(child.kills, 1);
  assert.equal(value.starting, false); assert.equal(value.owned, false);
  const failed = f.host({ origin, spawnProcess: () => { throw Error("Bearer PRIVATE_FIXTURE_SECRET"); } });
  const error = (await failed.start()).error;
  assert.match(error, /bundled.*start/i); assert.doesNotMatch(error, /PRIVATE_FIXTURE_SECRET/);
});

test("stop during startup kills only its child and cannot create a late view", async t => {
  const f = await fixture(t), child = f.child();
  let spawned;
  const launched = new Promise(resolve => { spawned = resolve; });
  const host = f.host({ origin: await f.freeOrigin(), spawnProcess: () => { spawned(); return child; } });
  host.setBounds({ x: 0, y: 0, width: 500, height: 300 }); host.setSurfaceActive(true);
  const starting = host.start(); await launched; const stopped = await host.stop(); await starting;
  assert.equal(stopped.owned, false); assert.equal(child.kills, 1); assert.equal(f.views.length, 0);
  await host.shutdown(); assert.equal(child.kills, 1);
});

test("native placement detaches on hide/invalid geometry, retains the login view and never focuses", async t => {
  const f = await fixture(t), service = await f.serve(), host = f.host({ origin: service.origin });
  await host.status(); host.setSurfaceActive(true); await f.until(() => f.views.length === 1 && f.views[0].webContents.loads.length);
  const view = f.views[0]; assert.match(view.partition, /^persist:/); assert.equal(f.attaches.length, 0);
  assert.equal(host.setBounds({ x: -2.2, y: 10.4, width: 600.2, height: 300 }), true);
  assert.equal(f.attaches.length, 1); assert.deepEqual(view.placements.at(-1), { x: 0, y: 10, width: 600, height: 300 });
  host.setSurfaceActive(false); assert.equal(f.detaches.length, 1); assert.equal(view.webContents.closed, false);
  host.setSurfaceActive(true); assert.equal(f.attaches.length, 2);
  assert.equal(host.setBounds({ x: 0, y: 0, width: NaN, height: 2 }), false); assert.equal(f.detaches.length, 2);
  await host.reload(); assert.equal(view.webContents.reloads, 1);
});

test("navigation stays local; safe async popups survive repeated attach and blobs remain native downloads", async t => {
  const f = await fixture(t), service = await f.serve(), host = f.host({ origin: service.origin });
  await host.status(); host.setSurfaceActive(true); await f.until(() => f.views[0]?.webContents.loads.length);
  const contents = f.views[0].webContents;
  let prevented = 0;
  contents.emit("will-navigate", { preventDefault() { prevented++; } }, service.origin + "/accounts");
  assert.equal(prevented, 0);
  for (const url of ["https://example.invalid/", "javascript:alert(1)", "file:///fixture", "blob:" + service.origin + "/owned"]) {
    contents.emit("will-redirect", { preventDefault() { prevented++; } }, url);
    assert.deepEqual(contents.popup({ url }), { action: "deny" });
  }
  await tick(); assert.deepEqual(f.external, ["https://example.invalid/"]); assert.equal(prevented, 4);
  await host.start(); contents.popup({ url: "https://example.invalid/payment" }); await tick();
  assert.equal(f.external.at(-1), "https://example.invalid/payment");
  assert.equal(contents.listenerCount("will-download"), 0, "Normal own-session blob export is not intercepted");
});

test("shutdown fences late session preparation, cleans its lease and closes the owned view", async t => {
  const f = await fixture(t), service = await f.serve();
  let release, cleaned = 0;
  const prepared = new Promise(resolve => { release = resolve; });
  const host = f.host({ origin: service.origin, prepareSession: () => prepared });
  await host.status(); host.setSurfaceActive(true); await f.until(() => f.views.length === 1);
  const closing = host.shutdown(); release(() => { cleaned++; }); await closing; await tick();
  assert.equal(cleaned, 1); assert.equal(f.views[0].webContents.closed, true); assert.equal(f.attaches.length, 0);
  host.setSurfaceActive(true); await host.reload(); assert.equal(f.views.length, 1);
});

test("failed shutdown can retry while permanently fencing starts and late views", async t => {
  const f = await fixture(t), origin = await f.freeOrigin();
  let service, kills = 0, spawns = 0;
  const child = f.child();
  child.kill = () => {
    kills++;
    if (kills === 1) return false;
    service?.server.closeAllConnections(); service?.server.close();
    child.exitCode = 0; child.emit("exit", 0); return true;
  };
  const host = f.host({ origin, spawnProcess: () => {
    spawns++; void f.serve(undefined, Number(new URL(origin).port)).then(value => { service = value; }); return child;
  } });
  assert.equal((await host.start()).owned, true);
  await assert.rejects(host.shutdown(), /refused termination/);
  assert.equal((await host.status()).owned, true);
  host.setSurfaceActive(true); await host.start();
  assert.equal(spawns, 1); assert.equal(f.views.length, 0);
  await Promise.all([host.shutdown(), host.shutdown()]);
  assert.equal(kills, 2); assert.equal((await host.status()).owned, false);
  await host.shutdown(); assert.equal(kills, 2);
});


test("cancelled quit restores attached view intent without starting a backend", async t => {
  const f = await fixture(t), service = await f.serve(); let quitting = false, spawns = 0;
  const host = f.host({ origin: service.origin, isQuitting: () => quitting, spawnProcess: () => { spawns++; } });
  await host.status(); host.setBounds({ x: 40, y: 80, width: 500, height: 300 }); host.setSurfaceActive(true);
  await f.until(() => f.views[0]?.webContents.loads.length);
  quitting = true; await host.shutdown(); assert.equal(f.views[0].webContents.closed, true);
  quitting = false; assert.equal((await host.recoverAfterCancelledQuit()).ready, true);
  await f.until(() => f.views.length === 2 && f.attaches.includes(f.views[1]));
  assert.deepEqual(f.views[1].placements.at(-1), { x: 40, y: 80, width: 500, height: 300 });
  assert.equal(f.views[1].partition, f.views[0].partition); assert.equal(spawns, 0);
  assert.equal((await host.start()).ready, true);
  quitting = true; await host.shutdown(); host.setSurfaceActive(false);
  quitting = false; await host.recoverAfterCancelledQuit(); await tick();
  assert.equal(f.views.length, 2, "Hidden/overlay intent remains hidden after recovery");
});

test("uncertain quit keeps ownership until Stop succeeds, then permits explicit start only", async t => {
  const f = await fixture(t), origin = await f.freeOrigin(); let quitting = false, spawns = 0, kills = 0, service;
  const host = f.host({ origin, isQuitting: () => quitting, spawnProcess: () => {
    spawns++; const child = f.child();
    child.kill = () => { if (++kills === 1) return false; service?.server.closeAllConnections(); service?.server.close(); child.exitCode = 0; child.emit("exit", 0); return true; };
    void f.serve(undefined, Number(new URL(origin).port)).then(value => { service = value; }); return child;
  } });
  assert.equal((await host.start()).owned, true); quitting = true;
  await assert.rejects(host.shutdown(), /refused termination/); quitting = false;
  assert.equal((await host.recoverAfterCancelledQuit()).owned, true);
  await host.start(); assert.equal(spawns, 1);
  assert.equal((await host.stop()).owned, false);
  assert.equal(spawns, 1, "Recovery never restarts the backend");
  assert.equal((await host.start()).owned, true); assert.equal(spawns, 2);
});

test("a new real quit fences a pending cancelled-quit recovery", async t => {
  const f = await fixture(t); let quitting = false, hold = false, held;
  const service = await f.serve((_request, response) => { if (hold) held = response; else response.end(JSON.stringify(identity)); });
  const host = f.host({ origin: service.origin, isQuitting: () => quitting });
  await host.status(); host.setSurfaceActive(true); await f.until(() => f.views.length === 1);
  quitting = true; await host.shutdown(); quitting = false; hold = true;
  const recovering = host.recoverAfterCancelledQuit(); await f.until(() => held);
  quitting = true; await host.shutdown(); held.end(JSON.stringify(identity)); await recovering; await tick();
  assert.equal(f.views.length, 1); assert.equal(f.views[0].webContents.closed, true);
  await host.start(); assert.equal(f.views.length, 1);
});

test("an early cancelled quit replaces a view fenced before shutdown ran", async t => {
  const f = await fixture(t), service = await f.serve(); let quitting = false, release, count = 0, recovery;
  const preparing = new Promise(resolve => { release = resolve; });
  const host = f.host({ origin: service.origin, isQuitting: () => quitting, prepareSession: () => ++count === 1 ? preparing : undefined });
  await host.status(); host.setSurfaceActive(true); await f.until(() => f.views.length === 1);
  quitting = true; release();
  await new Promise(resolve => queueMicrotask(() => { quitting = false; recovery = host.recoverAfterCancelledQuit(); resolve(); }));
  await recovery; await tick(); await tick();
  assert.equal(f.views[0].webContents.closed, true); assert.equal(f.views.length, 2);
});

test("loopback origin is constructor-only and rejects credentials or nonlocal hosts", async () => {
  for (const origin of ["https://127.0.0.1:8000", "http://localhost:8000", "http://example.invalid", "http://u:p@127.0.0.1:8000", "http://127.0.0.1:8000/path"]) {
    assert.throws(() => createRegisterHost({ origin }), /loopback/);
  }
});

test("native API uses only the managed bearer and fixed routes with explicit account IDs", async t => {
  const f = await fixture(t), selected = [];
  const managed = await managedService(f, (request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (body) selected.push(JSON.parse(body));
      response.end(JSON.stringify(request.url.endsWith("accounts") ? { accounts: [{ id: 7, email: "fixture@example.invalid" }] }
        : request.url.endsWith("export") ? { files: [{ account_id: 7, json: { refresh_token: "FIXTURE_PRIVATE" } }] } : { results: [{ id: 7, ok: true }] }));
    });
  });
  assert.equal((await managed.host.request("GET", "/api/coding-tools/accounts")).accounts[0].id, 7);
  assert.equal((await managed.host.request("POST", "/api/coding-tools/export", { ids: [7] })).files[0].json.refresh_token, "FIXTURE_PRIVATE");
  assert.equal((await managed.host.request("POST", "/api/coding-tools/refresh", { ids: [7] })).results[0].ok, true);
  assert.deepEqual(selected, [{ ids: [7] }, { ids: [7] }]);
  assert.ok(managed.calls.every(call => call.authorization === "Bearer " + managed.environment.APP_PASSWORD));
  for (const [method, route, body] of [["POST", "/api/coding-tools/accounts", {}], ["GET", "/api/accounts"],
    ["GET", "https://example.invalid/api/coding-tools/accounts"], ["GET", "/api/coding-tools/accounts", {}],
    ["POST", "/api/coding-tools/export", { ids: [] }], ["POST", "/api/coding-tools/refresh", { ids: [7, 7] }]]) {
    await assert.rejects(managed.host.request(method, route, body));
  }
  assert.equal(managed.calls.length, 3);
});

test("pre-existing services and a mismatched managed health identity never receive the private service bearer", async t => {
  const f = await fixture(t); let externalRequests = 0;
  const service = await f.serve((request, response) => {
    if (request.url !== "/api/health") externalRequests++;
    assert.equal(request.headers.authorization, undefined); response.end(JSON.stringify(identity));
  });
  const attached = f.host({ origin: service.origin }); assert.equal((await attached.start()).owned, false);
  await assert.rejects(attached.request("GET", "/api/coding-tools/accounts"), { code: "register_unavailable" });
  assert.equal(externalRequests, 0);
  const managed = await managedService(f, (_request, response) => response.end("{}"));
  managed.health.valid = false;
  await assert.rejects(managed.host.request("GET", "/api/coding-tools/accounts"), { code: "register_unavailable" });
  assert.equal(managed.calls.length, 0);
});

test("native API rejects redirects, malformed and oversized responses without returning upstream secrets", async t => {
  const f = await fixture(t); let mode = "redirect";
  const managed = await managedService(f, (_request, response) => {
    if (mode === "redirect") response.writeHead(302, { location: "https://example.invalid/" }).end("PRIVATE_FIXTURE_ERROR");
    else if (mode === "malformed") response.end("PRIVATE_FIXTURE_ERROR");
    else response.end(JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }));
  });
  for (mode of ["redirect", "malformed", "oversized"]) {
    await assert.rejects(managed.host.request("GET", "/api/coding-tools/accounts"), failure => {
      assert.equal(failure.code, "register_request_failed"); assert.doesNotMatch(failure.message, /PRIVATE_FIXTURE/); return true;
    });
  }
  assert.equal(managed.calls.length, 3);
});

test("native API requests have total deadlines and are cancelled by abort or owned shutdown", async t => {
  const f = await fixture(t);
  const managed = await managedService(f, (_request, response) => response.write("{"), { requestTimeoutMs: 80 });
  let started = Date.now();
  await assert.rejects(managed.host.request("POST", "/api/coding-tools/refresh", { ids: [7] }), { code: "register_request_failed" });
  assert.ok(Date.now() - started < 1000);
  const controller = new AbortController();
  const cancelled = managed.host.request("POST", "/api/coding-tools/refresh", { ids: [7] }, { signal: controller.signal }); cancelled.catch(() => {});
  await f.until(() => managed.calls.length === 2); controller.abort();
  await assert.rejects(cancelled, { code: "register_unavailable" });
  const pending = managed.host.request("POST", "/api/coding-tools/refresh", { ids: [7] }); pending.catch(() => {});
  await f.until(() => managed.calls.length === 3); started = Date.now();
  await managed.host.shutdown(); await assert.rejects(pending, { code: "register_unavailable" });
  assert.ok(Date.now() - started < 1000);
});
