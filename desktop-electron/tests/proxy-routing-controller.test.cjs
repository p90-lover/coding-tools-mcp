"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const network = require(path.join(root, "electron/provider-network.cjs"));

const USER = "user-sp1-session-1";
const PASS = "pa@ss:word";

// Provider network: every Chromium session goes through the app's egress router (egress-router.cjs),
// which signs in to the proxy itself; the sessions never see a proxy or its sign-in.
function world(t, { startRouter, getCpaConnection, fetchImpl = async () => ({ json: async () => ({ files: [] }), ok: true, status: 200 }) } = {}) {
  const directory = path.join(root, "aiTemp/proxy-routing-controller", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessions = new Map();
  const sessionFor = (name) => {
    if (!sessions.has(name)) sessions.set(name, { name, proxy: null, async setProxy(config) { this.proxy = config; }, async closeAllConnections() {} });
    return sessions.get(name);
  };
  const warnings = [];
  const controller = network.createProviderNetworkController({
    app: {}, browserPartition: "persist:coding-tools-chatgpt",
    getBrowserHost: () => ({ partition: "persist:coding-tools-chatgpt" }),
    logger: { info() {}, warn(event, detail) { warnings.push([event, detail]); }, error() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: sessionFor("default"), fromPartition: sessionFor },
    shell: {}, userData: directory,
    fetchImpl, getCpaConnection,
    ...(startRouter ? { startRouter } : {}),
  });
  return { controller, sessionFor, warnings };
}

/** A stand-in egress router that records the tables it is given. */
function fakeRouter({ port = 17555 } = {}) {
  const state = { started: 0, tables: [], onEvent: null, closed: false };
  state.start = async ({ table, onEvent }) => {
    state.started += 1;
    state.tables.push(table);
    state.onEvent = onEvent;
    return {
      port, running: true,
      setRoutes(next) { state.tables.push(next); },
      reconnect: async () => ({ closed: 0 }), stats: async () => ({}), openPort: async () => port + 1, closePort: async () => {},
      trace: async () => ({ ip: "203.0.113.7", country: "US" }), close: async () => { state.closed = true; },
    };
  };
  state.latest = () => state.tables[state.tables.length - 1];
  return state;
}

test("Global Routing sends every session through the egress router, which holds the proxy's sign-in", async (t) => {
  const router = fakeRouter();
  const { controller, sessionFor } = world(t, { startRouter: router.start });
  const saved = controller.store.saveProxyProfile({ name: "Decodo", endpoint: { protocol: "http", host: "isp.decodo.test", port: 10000 }, username: USER, password: PASS });
  const profile = saved.proxyProfiles.find((item) => item.name === "Decodo");
  controller.store.setGlobalRouting({ enabled: true, profileId: profile.id });
  await controller.applyGlobalRouting();

  assert.equal(router.started, 1);
  const app = router.latest().targets.app;
  assert.deepEqual(app.endpoint, profile.endpoint);
  assert.deepEqual(app.credentials, { username: USER, password: PASS }, "the router signs in for the sessions");
  for (const name of ["default", "persist:coding-tools-chatgpt"]) {
    assert.equal(sessionFor(name).proxy.proxyRules, "http://127.0.0.1:17555", `${name} goes through the router, not straight to the proxy`);
  }
  await controller.applyGlobalRouting();
  assert.equal(router.started, 1, "the running router is reused");

  controller.store.saveProxyProfile({ id: profile.id, name: "Decodo", endpoint: profile.endpoint, password: "new-pass" });
  await controller.applyGlobalRouting();
  assert.deepEqual(router.latest().targets.app.credentials, { username: USER, password: "new-pass" }, "a changed password is in the next table");
  assert.equal(router.started, 1, "no restart for it");

  controller.store.setGlobalRouting({ enabled: false, profileId: profile.id });
  await controller.applyGlobalRouting();
  assert.deepEqual(router.latest().targets.app, { mode: "direct" }, "Direct is the router's direct, not a session change");
  assert.equal(sessionFor("default").proxy.proxyRules, "http://127.0.0.1:17555", "sessions stay on the router, so the next change is live");
});

test("a proxy without a sign-in is still reached through the router; a router that can't start fails a proxy route closed", async (t) => {
  const router = fakeRouter();
  const plain = world(t, { startRouter: router.start });
  const open = plain.controller.store.saveProxyProfile({ name: "Open", endpoint: { protocol: "http", host: "proxy.test", port: 8080 } })
    .proxyProfiles.find((item) => item.name === "Open");
  plain.controller.store.setGlobalRouting({ enabled: true, profileId: open.id });
  await plain.controller.applyGlobalRouting();
  assert.equal(router.latest().targets.app.credentials, null);
  assert.equal(plain.sessionFor("default").proxy.proxyRules, "http://127.0.0.1:17555");

  const broken = world(t, { startRouter: async () => { throw new Error("worker unavailable"); } });
  const signed = broken.controller.store.saveProxyProfile({ name: "Decodo", endpoint: { protocol: "http", host: "isp.decodo.test", port: 10000 }, username: USER, password: PASS })
    .proxyProfiles.find((item) => item.name === "Decodo");
  broken.controller.store.setGlobalRouting({ enabled: true, profileId: signed.id });
  await broken.controller.applyGlobalRouting();
  assert.match(broken.sessionFor("default").proxy.proxyRules, /^http:\/\/127\.0\.0\.1:\d+$/, "never the proxy itself, never direct: the routed session fails until the router runs");
  assert.ok(broken.warnings.some(([event]) => event === "proxy.router_failed"));
});

test("CPA retries a failed route write without rewriting confirmed or virtual credentials", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 120_000 });
  const stable = { name: "stable.json", provider: "claude" };
  const pending = { name: "pending.json", provider: "codex" };
  const virtual = { name: "virtual", provider: "provider-manager" };
  let files = [stable, pending, virtual];
  const writes = [];
  const router = fakeRouter();
  const { controller, warnings } = world(t, {
    startRouter: router.start,
    getCpaConnection: () => ({ managementKey: "fixture-key" }),
    fetchImpl: async (url, { method, body }) => {
      if (method === "GET") return Response.json({ files });
      assert.equal(new URL(url).pathname, "/v0/management/auth-files/fields");
      const { name, proxy_url } = JSON.parse(body);
      writes.push(name);
      if (name === pending.name && writes.filter((value) => value === name).length === 1) {
        return Response.json({ error: `CPA was temporarily unable to save ${proxy_url}` }, { status: 503 });
      }
      if (name === virtual.name) {
        return Response.json({ error: "plugin virtual auth cannot be modified directly; edit or delete the source auth file" }, { status: 409 });
      }
      return Response.json({ status: "ok" });
    },
  });
  await controller.applyGlobalRouting();
  await controller.egressStatus();
  assert.deepEqual(writes, [stable.name, pending.name, virtual.name]);

  t.mock.timers.tick(120_000);
  await controller.egressStatus();
  assert.deepEqual(writes.slice(3), [pending.name]);
  assert.doesNotMatch(JSON.stringify(warnings), /@127\.0\.0\.1/, "warnings never include the router's sign-in");

  files = null;
  t.mock.timers.tick(120_000);
  const beforeRemoval = await controller.egressStatus();
  assert.equal(beforeRemoval.credentials.length, 3, "an invalid response does not erase the last inventory");
  files = [pending, virtual];
  t.mock.timers.tick(120_000);
  await controller.egressStatus();
  assert.equal(writes.length, 4, "the successful retry is remembered");
  files = [stable, pending, virtual];
  t.mock.timers.tick(120_000);
  await controller.egressStatus();
  assert.deepEqual(writes.slice(4), [stable.name], "an account removed and added under the same name needs a new stamp");
});

test("CPA stops credential writes after an authorization refusal", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 120_000 });
  const calls = [];
  const router = fakeRouter();
  const { controller } = world(t, {
    startRouter: router.start,
    getCpaConnection: () => ({ managementKey: "fixture-key" }),
    fetchImpl: async (_url, { method }) => {
      calls.push(method);
      if (method === "GET") return Response.json({ files: [{ name: "first.json" }, { name: "second.json" }] });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    },
  });
  await controller.applyGlobalRouting();
  await controller.egressStatus();
  t.mock.timers.tick(120_000);
  await controller.egressStatus();
  assert.deepEqual(calls, ["GET", "PATCH"], "no second credential or follow-up request during CPA's lockout window");
});

test("a refused sign-in is logged at most once a minute, naming no secret", async (t) => {
  const router = fakeRouter();
  const { controller, warnings } = world(t, { startRouter: router.start });
  const profile = controller.store.saveProxyProfile({ name: "Decodo", endpoint: { protocol: "http", host: "isp.decodo.test", port: 10000 }, username: USER, password: PASS })
    .proxyProfiles.find((item) => item.name === "Decodo");
  controller.store.setGlobalRouting({ enabled: true, profileId: profile.id });
  await controller.applyGlobalRouting();
  router.onEvent({ type: "signin", profileId: profile.id, ok: false });
  router.onEvent({ type: "signin", profileId: profile.id, ok: false });
  const refused = warnings.filter(([event]) => event === "proxy.sign_in_refused");
  assert.equal(refused.length, 1);
  assert.doesNotMatch(JSON.stringify(refused), /pa@ss|user-sp1/);
  assert.equal(controller.store.snapshot().proxyProfiles.find((item) => item.id === profile.id).signInRefused, true, "the Proxy page shows it");
  router.onEvent({ type: "signin", profileId: profile.id, ok: true });
  assert.equal(controller.store.snapshot().proxyProfiles.find((item) => item.id === profile.id).signInRefused, undefined, "and clears it when the proxy takes the sign-in again");
});

test("Chromium's 407 from the router gets the session's route token and the router key, nothing else does", async (t) => {
  const router = fakeRouter();
  const { controller, sessionFor } = world(t, { startRouter: router.start });
  await controller.applyGlobalRouting();
  const answer = (authInfo, webContents) => {
    let given = null;
    const handled = controller.handleProxyLogin({ preventDefault() {} }, authInfo, (...args) => { given = args; }, webContents);
    return { handled, given };
  };
  const fromApp = answer({ isProxy: true, host: "127.0.0.1", port: 17555 }, { session: sessionFor("default") });
  assert.equal(fromApp.handled, true);
  assert.equal(fromApp.given[0], "app");
  assert.equal(fromApp.given[1].length, 64, "the router key");
  const fromAccount = answer({ isProxy: true, host: "127.0.0.1", port: 17555 }, { session: sessionFor("persist:coding-tools-chatgpt") });
  assert.match(fromAccount.given[0], /^b-[0-9a-f]{20}$/, "a Browser-tab account signs in as itself");
  assert.equal(answer({ isProxy: true, host: "isp.decodo.test", port: 10000 }, { session: sessionFor("default") }).handled, false, "a real proxy never gets an answer from here");
  assert.equal(answer({ isProxy: true, host: "127.0.0.1", port: 9999 }, null).handled, false, "nor another loopback port");
  assert.equal(answer({ isProxy: false, host: "127.0.0.1", port: 17555 }, null).handled, false, "nor a site");
});
