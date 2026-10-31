"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const network = require(path.join(root, "electron/provider-network.cjs"));
const { decodoRequestUrl, parseDecodoEndpoints, normalizeDecodoSettings } = require(path.join(root, "electron/decodo-proxies.cjs"));
const { createBrowserAccounts: openBrowserAccounts } = require(path.join(root, "electron/browser-accounts.cjs"));

const BASE = "persist:coding-tools-chatgpt";

function fixtureRoot(t) {
  const directory = path.join(root, "aiTemp/chatgpt-browser-proxies", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  t.after(async () => {
    await accountsSaved();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

// Accounts save off the main thread: a test folder goes once every store opened in it is written.
const opened = new Set();
function createBrowserAccounts(options) {
  const accounts = openBrowserAccounts(options);
  opened.add(accounts);
  return accounts;
}
const accountsSaved = () => Promise.all([...opened].map((accounts) => accounts.saved()));

const decodoBody = (ports, { wrap = false } = {}) => {
  const list = ports.map(port => `http://user-sp1-session-${port}:pa%40ss@gate.decodo.com:${port}`);
  return JSON.stringify(wrap ? JSON.stringify(list) : list);
};

function world(t, { body = decodoBody([10001, 10002, 10003]) } = {}) {
  const sessions = new Map();
  const sessionFor = (name) => {
    if (!sessions.has(name)) sessions.set(name, { name, proxy: null, closed: 0, async setProxy(config) { this.proxy = config; }, async closeAllConnections() { this.closed += 1; } });
    return sessions.get(name);
  };
  const userData = fixtureRoot(t);
  const accounts = createBrowserAccounts({ dataRoot: path.join(userData, "browser-accounts"), profile: "production" });
  let activePartition = BASE;
  const requests = [];
  const controller = network.createProviderNetworkController({
    app: {},
    browserPartition: BASE,
    getBrowserHost: () => ({ partition: activePartition }),
    getBrowserProxyBinding: (partition) => accounts.proxyForPartition(partition),
    logger: { info() {}, warn() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: sessionFor("default"), fromPartition: sessionFor },
    shell: {},
    userData,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, text: async () => body };
    },
  });
  return { controller, accounts, sessionFor, requests, setActive: (partition) => { activePartition = partition; } };
}

test("the Decodo request asks for sticky sessions from the proxy user, as ProxyBridge Nova did", () => {
  const url = new URL(decodoRequestUrl(normalizeDecodoSettings({ username: "sp1", country: "US", count: 5, sessionMinutes: 30 }), "secret"));
  assert.equal(url.origin + url.pathname, "https://api.decodo.com/v2/endpoints-custom/back-connect");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    username: "sp1", password: "secret", session_type: "sticky", session_time: "30", count: "5", page: "1",
    protocol: "http", response_format: "json", output_format: "protocol:auth@endpoint", country: "us",
  });
  assert.throws(() => normalizeDecodoSettings({ country: "USA" }), /two-letter/);
  assert.throws(() => decodoRequestUrl(normalizeDecodoSettings({ username: "sp1" }), ""), /username and password/);
});

test("Decodo's list parses from either shape, keeps a stable id per endpoint, and refuses foreign hosts", () => {
  const plain = parseDecodoEndpoints(decodoBody([10001, 10002]), { country: "us" });
  const wrapped = parseDecodoEndpoints(decodoBody([10001, 10002], { wrap: true }), { country: "us" });
  assert.deepEqual(plain, wrapped);
  assert.equal(plain.length, 2);
  assert.match(plain[0].id, /^decodo:[0-9a-f]{32}$/);
  assert.equal(plain[0].name, "Decodo US 10001");
  assert.deepEqual(plain[0].endpoint, { protocol: "http", host: "gate.decodo.com", port: 10001 });
  assert.equal(plain[0].password, "pa@ss");
  assert.equal(parseDecodoEndpoints(decodoBody([10001]))[0].id, plain[0].id, "the same endpoint keeps its id");
  assert.throws(() => parseDecodoEndpoints(JSON.stringify(["http://u:p@evil.example:10001"])), /invalid proxy endpoint/);
  assert.throws(() => parseDecodoEndpoints("[]"), /empty or invalid/);
});

test("a sync turns Decodo's endpoints into proxy profiles and a second sync updates them in place", async (t) => {
  const { controller, requests } = world(t);
  controller.store.saveDecodoSettings({ username: "sp1", password: "secret", count: 3 });
  assert.equal(controller.store.snapshot().decodo.hasPassword, true);
  assert.equal(JSON.stringify(controller.store.snapshot()).includes("secret"), false, "the password never reaches the snapshot");
  const first = await controller.syncDecodo();
  assert.deepEqual([first.added, first.updated], [3, 0]);
  const second = await controller.syncDecodo();
  assert.deepEqual([second.added, second.updated], [0, 3]);
  assert.equal(controller.store.snapshot().proxyProfiles.length, 3);
  assert.ok(controller.store.snapshot().decodo.lastSyncAt);
  assert.equal(requests.length, 2);
});

test("one proxy per account: binding a proxy another account holds is refused", (t) => {
  const { accounts } = world(t);
  const second = accounts.add();
  accounts.setProxy("main", "decodo:a");
  assert.throws(() => accounts.setProxy(second, "decodo:a"), /already bound to ChatGPT account 1/);
  accounts.setProxy(second, "decodo:b");
  assert.equal(accounts.proxyForPartition(BASE), "decodo:a");
  assert.equal(accounts.proxyForPartition(`${BASE}-${second}`), "decodo:b");
  accounts.setProxy("main", null);
  assert.equal(accounts.proxyForPartition(BASE), null);
});

test("a bound account keeps its own proxy through Global Routing, and its 407 gets only its own sign-in", async (t) => {
  const { controller, accounts, sessionFor, setActive } = world(t);
  controller.store.saveDecodoSettings({ username: "sp1", password: "secret" });
  await controller.syncDecodo();
  const [own, global] = controller.store.snapshot().proxyProfiles;
  const second = accounts.add();
  const partition = `${BASE}-${second}`;
  accounts.setProxy(second, own.id);
  setActive(partition);
  controller.store.setGlobalRouting({ enabled: true, profileId: global.id });
  await controller.applyGlobalRouting();
  assert.equal(sessionFor(partition).proxy.proxyRules, `http://gate.decodo.com:${own.endpoint.port}`);
  assert.equal(sessionFor(BASE).proxy.proxyRules, `http://gate.decodo.com:${global.endpoint.port}`, "the unbound account follows Global Routing");
  assert.ok(sessionFor(partition).closed >= 1, "old connections are dropped");

  const answer = (contents, port) => {
    const replies = [];
    const handled = controller.handleProxyLogin({ preventDefault() {} }, { isProxy: true, host: "gate.decodo.com", port },
      (user, pass) => replies.push([user, pass]), contents);
    return { handled, replies };
  };
  const boundPage = { session: sessionFor(partition) };
  assert.deepEqual(answer(boundPage, own.endpoint.port).replies, [[`user-sp1-session-${own.endpoint.port}`, "pa@ss"]]);
  assert.equal(answer(boundPage, global.endpoint.port).handled, false, "a bound page never receives the global proxy's sign-in");
  assert.deepEqual(answer({ session: sessionFor("default") }, global.endpoint.port).replies, [[`user-sp1-session-${global.endpoint.port}`, "pa@ss"]]);

  accounts.setProxy(second, null);
  assert.equal(await controller.routeBrowserPartition(partition), global.id, "unbound again, it takes Global Routing's");
});
