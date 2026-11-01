"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRegisterCpaSync } = require("../electron/register-host.cjs");

const origin = "http://127.0.0.1:8000";
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const cookies = new EventEmitter(), calls = [], errors = [];
  let connection = { baseUrl: "http://127.0.0.1:8317", managementKey: "fixture-management-key" };
  let config = options.config || {}, authorized = options.authorized !== false;
  const sync = createRegisterCpaSync({
    origin, browserSession: { cookies, fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (options.fetch) return options.fetch(url, init);
      if (!authorized) return { status: 401, ok: false };
      if (init.method === "PUT") { config = { ...config, ...JSON.parse(init.body).data }; return { ok: true }; }
      return { ok: true, json: async () => config };
    } },
    getConnection: () => connection,
    onError: message => errors.push(message),
  });
  t.after(() => sync.dispose());
  return { sync, cookies, calls, errors, config: () => config,
    connection: value => { connection = value; }, authorize: () => { authorized = true; } };
}

test("managed CPA settings are handed to Register using its authenticated local session", async t => {
  const f = fixture(t, { config: { unrelated: "keep" } });
  await f.sync.sync();
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.url, origin + "/api/config");
    assert.equal(call.credentials, "include");
    assert.equal(call.redirect, "error");
    assert.equal(call.cache, "no-store");
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.deepEqual(JSON.parse(f.calls[1].body), { data: {
    cpa_api_url: "http://127.0.0.1:8317", cpa_api_key: "fixture-management-key",
  } });
  assert.equal(f.config().unrelated, "keep");
  await f.sync.sync();
  assert.equal(f.calls.length, 2, "status polling does not reread or rewrite saved settings");
  assert.deepEqual(f.errors, []);
});

test("matching settings are not rewritten; an explicitly configured remote CPA is preserved", async t => {
  for (const config of [
    { cpa_api_url: "http://127.0.0.1:8317/", cpa_api_key: "fixture-management-key" },
    { cpa_api_url: "https://user-cpa.invalid", cpa_api_key: "custom-key" },
  ]) {
    const f = fixture(t, { config });
    await f.sync.sync(); await f.sync.sync();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.config(), config);
  }
});

test("only the managed loopback CPA connection is accepted", async t => {
  for (const connection of [null, {},
    { baseUrl: "https://untrusted.invalid", managementKey: "secret" },
    { baseUrl: "http://127.0.0.1:8317", managementKey: "" },
    { baseUrl: "http://user:pass@127.0.0.1:8317", managementKey: "secret" },
  ]) {
    const f = fixture(t); f.connection(connection); await f.sync.sync();
    assert.equal(f.calls.length, 0);
  }
});

test("login protection is respected and the auth cookie triggers setup after sign-in", async t => {
  const f = fixture(t, { authorized: false });
  await f.sync.sync(); assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []);
  f.authorize();
  for (const [cookie, removed] of [
    [{ name: "other", domain: "127.0.0.1" }, false],
    [{ name: "_auth", domain: "elsewhere.invalid" }, false],
    [{ name: "_auth", domain: "127.0.0.1" }, true],
  ]) f.cookies.emit("changed", {}, cookie, "explicit", removed);
  await tick(); assert.equal(f.calls.length, 1);
  f.cookies.emit("changed", {}, { name: "_auth", domain: "127.0.0.1" }, "explicit", false);
  await tick();
  assert.equal(f.config().cpa_api_url, "http://127.0.0.1:8317");
  assert.equal(f.calls.length, 3);
});

test("a CPA that becomes ready later or rotates its key is resynchronized", async t => {
  const f = fixture(t); f.connection(null);
  await f.sync.sync(); assert.equal(f.calls.length, 0);
  f.connection({ baseUrl: "http://127.0.0.1:8317", managementKey: "first" });
  await f.sync.sync(); assert.equal(f.config().cpa_api_key, "first");
  f.connection({ baseUrl: "http://127.0.0.1:8317", managementKey: "rotated" });
  await f.sync.sync(); assert.equal(f.config().cpa_api_key, "rotated");
  assert.equal(f.calls.length, 4);
});

test("disposal cancels in-flight config reads, prevents late writes and removes the cookie listener", async t => {
  let release, signal;
  const f = fixture(t, { fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  } });
  const pending = f.sync.sync();
  assert.equal(f.cookies.listenerCount("changed"), 1);
  f.sync.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(f.cookies.listenerCount("changed"), 0);
  release({ ok: true, json: async () => ({}) });
  await pending; await f.sync.sync();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []);
});

test("failures are sanitized and retryable rather than cached as successful", async t => {
  let fail = true;
  const f = fixture(t, { fetch: async () => {
    if (fail) throw new Error("private-token-from-backend");
    return { ok: true, json: async () => ({}) };
  } });
  await f.sync.sync();
  assert.equal(f.errors.length, 1);
  assert.doesNotMatch(f.errors[0], /private-token|fixture-management-key/);
  fail = false; await f.sync.sync();
  assert.equal(f.calls.length, 3);
});

test("overlapping requests share a single setup and do not upload credentials twice", async t => {
  let release, reads = 0, writes = 0;
  const f = fixture(t, { fetch: async (_url, options) => {
    if (options.method === "PUT") { writes++; return { ok: true }; }
    reads++;
    return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({}) }); });
  } });
  const first = f.sync.sync(); assert.equal(f.sync.sync(), first);
  release(); await first;
  assert.equal(reads, 1); assert.equal(writes, 1);
});

test("failed config writes are retried and never treated as configured", async t => {
  let writes = 0;
  const f = fixture(t, { fetch: async (_url, options) => {
    if (options.method === "PUT") return { ok: ++writes > 1 };
    return { ok: true, json: async () => ({}) };
  } });
  await f.sync.sync(); assert.equal(f.errors.length, 1);
  await f.sync.sync(); assert.equal(writes, 2);
  await f.sync.sync(); assert.equal(f.calls.length, 4);
});

test("launcher wires native session setup, ready notifications and lease disposal to CPA sync", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getRegisterHost");
  let options, syncOptions, synced = 0, disposed = 0;
  const native = {}, events = [], proxy = [];
  const connection = { baseUrl: "http://127.0.0.1:8317", managementKey: "private-fixture" };
  const scope = {
    registerHost: null, path, app: { getPath: name => "G:/fixture/" + name }, quitting: false,
    createRegisterHost: value => { options = value; return native; },
    createRegisterCpaSync: value => { syncOptions = value; return { sync: async () => { synced++; }, dispose: () => { disposed++; } }; },
    externalServicesController: { cpaConnection: () => connection },
    send: (...args) => events.push(args),
  };
  vm.runInNewContext(fn.getText(ast), scope);
  assert.equal(scope.getRegisterHost({}), native);
  assert.equal(scope.getRegisterHost({}), native);
  const browserSession = { setProxy: async value => proxy.push(value.mode) };
  const cleanup = await options.prepareSession(browserSession, origin);
  assert.deepEqual(proxy, ["direct"]);
  assert.equal(syncOptions.browserSession, browserSession); assert.equal(syncOptions.origin, origin);
  assert.equal(syncOptions.getConnection(), connection); assert.equal(synced, 1);
  options.onChange({ ready: false }); assert.equal(synced, 1);
  options.onChange({ ready: true }); assert.equal(synced, 2);
  cleanup(); assert.equal(disposed, 1);
  options.onChange({ ready: true }); assert.equal(synced, 2);
  assert.equal(events.length, 3);
  assert.doesNotMatch(JSON.stringify(events), /private-fixture/);
});

test("invalid Register origins cannot receive managed credentials", () => {
  for (const origin of ["https://127.0.0.1:8000", "http://remote.invalid", "http://127.0.0.1:8000/path", "http://user:pass@127.0.0.1:8000"]) {
    assert.throws(() => createRegisterCpaSync({ origin }), /loopback/);
  }
});
