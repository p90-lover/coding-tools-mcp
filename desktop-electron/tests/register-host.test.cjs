"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { createRegisterHost } = require("../electron/register-host.cjs");

const fixtureRoot = path.resolve(__dirname, "../../aiTemp/register-runtime-20261020/host-tests");
const identity = { ok: true, service: "account-manager-v2" };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(fixtureRoot, "case-"));
  const project = path.join(base, "project");
  const python = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.mkdirSync(path.join(project, "static"));
  for (const name of ["main.py", "static/index.html", path.relative(project, python)]) fs.writeFileSync(path.join(project, name), "fixture");
  const servers = [], hosts = [], views = [], attaches = [], detaches = [], external = [];
  t.after(async () => {
    for (const host of hosts) await host.shutdown();
    for (const server of servers) if (server.listening) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    assert.ok(base.startsWith(fixtureRoot + path.sep));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const serve = async (handler = (_request, response) => response.end(JSON.stringify(identity)), port = 0) => {
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
    const instance = createRegisterHost({ projectRoot: project, createView: makeView,
      attachView: view => attaches.push(view), detachView: view => detaches.push(view), openExternal: url => external.push(url),
      healthTimeoutMs: 500, startupTimeoutMs: 1200, pollIntervalMs: 5,
      spawnProcess: () => { throw Error("Unexpected spawn"); }, ...options });
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
  return { base, project, python, serve, freeOrigin, host, child, views, attaches, detaches, external, until };
}

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

test("project configuration canonicalizes and persists only the project path", async t => {
  const f = await fixture(t), alias = path.join(f.base, "alias");
  fs.symlinkSync(f.project, alias, process.platform === "win32" ? "junction" : "dir");
  const configPath = path.join(f.base, "settings/runtime-register.json");
  const host = f.host({ origin: await f.freeOrigin(), configPath });
  const value = await host.configure(alias);
  assert.equal(value.projectRoot, fs.realpathSync.native(f.project));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { projectRoot: value.projectRoot });
  const restored = f.host({ origin: await f.freeOrigin(), projectRoot: "ignored", configPath });
  assert.equal((await restored.status()).projectRoot, value.projectRoot);
  await assert.rejects(host.configure(path.join(f.base, "missing")), /does not exist/);
});

test("start validates source, static build and Python without importing source", async t => {
  const f = await fixture(t), host = f.host({ origin: await f.freeOrigin() });
  for (const [file, message] of [["main.py", /main.py/], ["static/index.html", /static UI/], [path.relative(f.project, f.python), /Python/]]) {
    const target = path.join(f.project, file); fs.unlinkSync(target);
    const result = await host.start(); assert.equal(result.owned, false); assert.match(result.error, message);
    fs.writeFileSync(target, "fixture");
  }
});

test("concurrent starts share one child, fixed argv and unmodified auth/proxy environment", async t => {
  const f = await fixture(t), origin = await f.freeOrigin();
  let spawned, calls = 0, service, child;
  const host = f.host({ origin, spawnProcess: (program, args, options) => {
    calls++; spawned = { program, args, options };
    child = f.child(() => { service?.server.closeAllConnections(); service?.server.close(); });
    void f.serve(undefined, Number(new URL(origin).port)).then(value => { service = value; }); return child;
  } });
  const first = host.start(); assert.equal(host.start(), first);
  await assert.rejects(host.configure(f.project), /Stop Register/);
  const value = await first;
  assert.equal(value.ready, true); assert.equal(value.owned, true); assert.equal(value.starting, false); assert.equal(calls, 1);
  assert.equal(spawned.program, f.python);
  assert.deepEqual(spawned.args, ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", new URL(origin).port]);
  assert.ok(Object.keys(spawned.options.env).length === Object.keys(process.env).length
    && Object.entries(process.env).every(([key, value]) => spawned.options.env[key] === value), "Child environment is unchanged");
  assert.equal(spawned.options.cwd, f.project);
  assert.equal(spawned.options.windowsHide, true); assert.deepEqual(spawned.options.stdio, ["ignore", "ignore", "ignore"]);
  await assert.rejects(host.configure(f.project), /Stop Register/);
  assert.equal((await host.stop()).owned, false); assert.equal(child.kills, 1);
});

test("startup timeout and spawn errors expose actionable messages without raw secrets", async t => {
  const f = await fixture(t), child = f.child(), origin = await f.freeOrigin();
  const timeout = f.host({ origin, startupTimeoutMs: 35, spawnProcess: () => child });
  const value = await timeout.start(); assert.match(value.error, /did not become ready/); assert.equal(child.kills, 1);
  assert.equal(value.starting, false); assert.equal(value.owned, false);
  const failed = f.host({ origin, spawnProcess: () => { throw Error("Bearer PRIVATE_FIXTURE_SECRET"); } });
  const error = (await failed.start()).error;
  assert.match(error, /Python.*start/i); assert.doesNotMatch(error, /PRIVATE_FIXTURE_SECRET/);
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
  await host.configure(f.project);
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
  await assert.rejects(host.configure(f.project), /closed|Stop Register/); await host.start(); assert.equal(spawns, 1);
  assert.equal((await host.stop()).owned, false); await host.configure(f.project);
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
