"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { createNovaManager, profileEntries, GATEWAY_PROFILE_ID } = require("../electron/proxybridge-nova.cjs");

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (buffer) => buffer.toString().replace(/^enc:/, ""),
};

const STATUS = {
  product: "ProxyBridge Nova", version: "1.1.0", managed: true, pid: 1, apiPort: 17894,
  gateway: { host: "127.0.0.1", port: 17891, running: true, error: null },
  routing: { state: "active", installed: true, runtimeReady: true, busy: false, services: {}, error: null },
  profile: { etag: "e1", proxyCount: 1, ruleCount: 2 },
  decodo: { configured: false, autoSync: false, lastSyncAt: null, nextSyncAt: null, lastError: null },
};

function socks(key, host, extra = {}) {
  return { key, protocol: "socks5", host, port: 1080, username: "user", password: "secret", linked: false, upstreamEligible: true, provider: null, ...extra };
}

/** A fake Nova API: a profile with an etag, PUT /v1/profile/proxies, and every request recorded. */
function fakeNova(proxies, { tokenOk = true } = {}) {
  const nova = { etag: "e1", proxies: structuredClone(proxies), calls: [], up: true };
  nova.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    nova.calls.push([init.method, pathname, init.headers?.authorization]);
    if (!nova.up) throw new TypeError("fetch failed");
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (!tokenOk) return reply(401, { error: "Unauthorized" });
    if (pathname === "/v1/shutdown" && init.method === "POST") { nova.up = false; return reply(200, { ok: true }); }
    if (pathname === "/v1/status") return reply(200, { ...STATUS, profile: { ...STATUS.profile, etag: nova.etag } });
    if (pathname === "/v1/profile") return reply(200, { etag: nova.etag, linkedProfilePath: null, proxies: nova.proxies, rules: [] });
    if (pathname === "/v1/profile/proxies" && init.method === "PUT") {
      const body = JSON.parse(init.body);
      if (body.etag !== nova.etag) return reply(409, { error: "Profile changed" });
      nova.proxies = body.proxies.map((proxy, index) => ({
        ...proxy, key: proxy.key || `local:new-${index}`,
        password: proxy.password ?? nova.proxies.find((old) => old.key === proxy.key)?.password ?? "",
      }));
      nova.etag = `e${Number(nova.etag.slice(1)) + 1}`;
      return reply(200, { etag: nova.etag, linkedProfilePath: null, proxies: nova.proxies, rules: [] });
    }
    return reply(404, { error: "Unknown API route" });
  };
  return nova;
}

function setup(t, nova, { seed } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-nova-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createProviderNetworkStore({
    filePath: path.join(root, "providers", "provider-network.json"),
    keyPath: path.join(root, "providers", "provider-network.key"), safeStorage,
  });
  seed?.(store);
  const applied = [];
  const published = [];
  const manager = createNovaManager({
    userData: root, safeStorage, store, env: {},
    applyGlobalRouting: async () => { applied.push(store.snapshot().routing.globalProfileId); },
    publish: (state, snapshot) => published.push({ state, snapshot }),
    fetchImpl: nova.fetch, sleep: async () => {},
    spawnImpl: () => { throw new Error("no spawn in this test"); },
  });
  return { root, store, manager, applied, published };
}

test("Nova's proxies and gateway become read-only Coding Tools profiles", () => {
  const entries = profileEntries({ proxies: [socks("local:a", "a.example"), { ...socks("x", "x"), protocol: "socks4" }] }, STATUS);
  assert.deepEqual(entries.map((entry) => entry.id), [GATEWAY_PROFILE_ID, "nova:local:a"], "the gateway first; protocols Nova can't route are left out");
  assert.deepEqual(entries[0].endpoint, { protocol: "http", host: "127.0.0.1", port: 17891 });
  assert.equal(entries[1].name, "SOCKS5 a.example:1080");
});

test("a sync mirrors Nova, keeps credentials in the store, and a removed proxy's routes move to the gateway", async (t) => {
  const nova = fakeNova([socks("local:a", "a.example")]);
  const { store, manager, applied } = setup(t, nova);
  await manager.start();
  manager.stopPolling();
  let snapshot = store.snapshot();
  assert.deepEqual(snapshot.proxyProfiles.map((profile) => profile.id), [GATEWAY_PROFILE_ID, "nova:local:a"]);
  assert.deepEqual(store.proxySecret("nova:local:a"), { username: "user", password: "secret" });
  assert.ok(nova.calls.every(([, , auth]) => /^Bearer [A-Za-z0-9_-]{32,}$/.test(auth)), "every call carries the managed token");

  store.setGlobalRouting({ enabled: true, profileId: "nova:local:a" });
  assert.throws(() => store.saveProxyProfile({ id: "nova:local:a", name: "x", endpoint: { protocol: "http", host: "h", port: 1 } }), /belongs to ProxyBridge Nova/);
  assert.throws(() => store.archiveProxyProfile("nova:local:a"), /belongs to ProxyBridge Nova/);

  nova.proxies = [];
  nova.etag = "e9";
  await manager.sync();
  snapshot = store.snapshot();
  assert.deepEqual(snapshot.proxyProfiles.map((profile) => profile.id), [GATEWAY_PROFILE_ID]);
  assert.equal(snapshot.routing.globalProfileId, GATEWAY_PROFILE_ID, "the app-wide route falls back to the gateway, not off");
  assert.equal(applied.at(-1), GATEWAY_PROFILE_ID, "and is applied again");
});

test("once, Coding Tools' own profiles move to Nova and their routes follow", async (t) => {
  const nova = fakeNova([socks("local:same", "same.example")]);
  const ids = {};
  const { store, manager } = setup(t, nova, {
    seed(store) {
      const add = (name, endpoint, credentials = {}) => {
        const next = store.saveProxyProfile({ name, endpoint, ...credentials });
        ids[name] = next.proxyProfiles.find((profile) => profile.name === name).id;
      };
      add("gateway", { protocol: "http", host: "localhost", port: 17891 });
      add("same", { protocol: "socks5", host: "same.example", port: 1080 });
      add("new", { protocol: "http", host: "new.example", port: 8080 }, { username: "u", password: "p" });
      add("old socks4", { protocol: "socks4", host: "four.example", port: 1080 });
      store.setGlobalRouting({ enabled: true, profileId: ids.gateway });
      store.setProviderPolicy({ providerId: "cpa", mode: "profile", profileId: ids.new });
      store.setProviderPolicy({ providerId: "other", mode: "profile", profileId: ids.same });
    },
  });
  await manager.start();
  manager.stopPolling();
  const snapshot = store.snapshot();
  const added = nova.proxies.find((proxy) => proxy.host === "new.example");
  assert.ok(added, "a profile Nova lacked is added to Nova");
  assert.equal(added.password, "p", "with its saved credentials");
  assert.equal(nova.proxies.find((proxy) => proxy.key === "local:same").password, "secret", "Nova's own proxies keep their passwords (sent as null)");
  assert.equal(snapshot.routing.globalProfileId, GATEWAY_PROFILE_ID);
  assert.equal(snapshot.routing.providers.find((policy) => policy.providerId === "cpa").profileId, `nova:${added.key}`);
  assert.equal(snapshot.routing.providers.find((policy) => policy.providerId === "other").profileId, "nova:local:same");
  const own = snapshot.proxyProfiles.filter((profile) => !profile.source);
  assert.deepEqual(own.filter((profile) => !profile.archivedAt).map((profile) => profile.name), ["old socks4"], "SOCKS4 has no Nova equivalent and stays");
  assert.ok(manager.state().migratedAt);

  const puts = nova.calls.filter(([method]) => method === "PUT").length;
  await manager.sync();
  assert.equal(nova.calls.filter(([method]) => method === "PUT").length, puts, "the migration runs once");
});

test("a Nova started by something else, or one that will not start, says why", async (t) => {
  const foreign = setup(t, fakeNova([], { tokenOk: false }));
  foreign.manager.stopPolling();
  await assert.rejects(foreign.manager.profile(), /API token does not match/);

  const down = fakeNova([]);
  down.up = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-nova-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, "ProxyBridgeRewrite.exe");
  fs.writeFileSync(exe, "");
  const spawned = [];
  const manager = createNovaManager({
    userData: root, safeStorage, store: { snapshot: () => ({ routing: {}, proxyProfiles: [] }) }, env: { CODING_TOOLS_NOVA_EXE: exe },
    applyGlobalRouting: async () => {}, fetchImpl: down.fetch, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    spawnImpl: (file, args, options) => {
      spawned.push({ file, args, env: options.env });
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit("exit", 3));
      return child;
    },
  });
  await manager.start();
  manager.stopPolling();
  assert.equal(spawned.length, 1, "app start launches Nova itself");
  assert.equal(manager.state().running, false);
  assert.match(manager.state().error, /Another ProxyBridge Nova is running and did not hand over/);
  assert.equal(spawned[0].file, exe);
  assert.deepEqual(spawned[0].args, ["--managed", "--takeover", "--api-port", "17894"]);
  assert.match(spawned[0].env.PROXYBRIDGE_NOVA_API_TOKEN, /^[A-Za-z0-9_-]{32,}$/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "providers", "proxybridge-nova.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(spawned[0].env.PROXYBRIDGE_NOVA_API_TOKEN), "the token is saved only encrypted");
});

/** A Nova manager whose launches start the fake Nova (or exit with `exitCode`), counting each one. */
function launching(t, nova, { exitCode = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-nova-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, "ProxyBridgeRewrite.exe");
  fs.writeFileSync(exe, "");
  const spawned = [];
  const store = createProviderNetworkStore({
    filePath: path.join(root, "providers", "provider-network.json"),
    keyPath: path.join(root, "providers", "provider-network.key"), safeStorage,
  });
  const options = {
    userData: root, safeStorage, store, env: { CODING_TOOLS_NOVA_EXE: exe },
    applyGlobalRouting: async () => {}, fetchImpl: nova.fetch, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    spawnImpl: () => {
      spawned.push(Date.now());
      const child = new EventEmitter();
      child.unref = () => {};
      if (exitCode === null) nova.up = true;
      else setImmediate(() => child.emit("exit", exitCode));
      return child;
    },
  };
  return { spawned, options, manager: createNovaManager(options) };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("Nova starts with the app, is started again when it stops, and stops with a quit", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const nova = fakeNova([]);
  nova.up = false;
  const { spawned, manager } = launching(t, nova);
  await manager.start();
  assert.equal(spawned.length, 1, "launched at app start, with no Start click");
  assert.equal(manager.state().running, true);

  nova.up = false;
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(manager.state().running, true, "a Nova that stopped is started again");
  assert.equal(spawned.length, 2);

  await manager.shutdown();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(spawned.length, 2, "one stopped on the Proxy page stays stopped");

  await manager.ensureRunning();
  assert.equal(spawned.length, 3);
  await manager.stop();
  assert.equal(nova.up, false, "a quit shuts Nova down");
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(spawned.length, 3, "and nothing starts it again");
});

test("an executable without managed mode is not launched again at app start", async (t) => {
  const nova = fakeNova([]);
  nova.up = false;
  const first = launching(t, nova, { exitCode: 0 });
  await first.manager.start();
  first.manager.stopPolling();
  assert.equal(first.spawned.length, 1);
  assert.match(first.manager.state().error, /no managed mode/);

  const again = createNovaManager({ ...first.options, spawnImpl: () => { throw new Error("launched again"); } });
  await again.start();
  again.stopPolling();
  assert.match(again.state().error, /no managed mode/, "the next app start remembers it and doesn't open Nova's window");
});
