"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { retireProxyGateway } = require("../electron/proxy-gateway-retire.cjs");

const logger = { info() {}, warn() {} };

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ct-gateway-retire-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const providers = path.join(userData, "providers");
  const store = createProviderNetworkStore({
    filePath: path.join(providers, "provider-network.json"),
    keyPath: path.join(providers, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  store.saveProxyProfile({ id: "direct", name: "Global proxy", enabled: true,
    endpoint: { protocol: "http", host: "proxy.example", port: 10000 }, scopes: ["all"] });
  store.saveProxyProfile({ id: "local-relay", name: "ProxyBridge local", enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17891 }, scopes: ["all"] });
  store.saveProxyProfile({ id: "builtin-gateway", name: "Built-in proxy gateway", enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 17894 },
    username: "ct", password: "gateway-key", scopes: ["all"] });
  const write = (name, value) => fs.writeFileSync(path.join(providers, name), typeof value === "string" ? value : JSON.stringify(value));
  return { userData, providers, store, write };
}

// A stand-in for an older version's helper: its control port answers like the gateway's.
async function fakeHelper(t, pid) {
  const helper = { stopped: false, stops: 0 };
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer control-token") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/stop") {
      helper.stops += 1;
      helper.stopped = true;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ service: "coding-tools-proxy-gateway", pid }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  helper.port = server.address().port;
  return helper;
}

test("a route left on the removed gateway goes straight to the gateway's upstream; the gateway leaves nothing behind", async (t) => {
  const { userData, providers, store, write } = fixture(t);
  store.setGlobalRouting({ enabled: true, profileId: "builtin-gateway" });
  const helper = await fakeHelper(t, 4242);
  // Seen live: "Use for this app" was switched on over ProxyBridge; the upstream keeps the exit.
  write("proxy-gateway.json", { version: 1, useForApp: true, upstreamProfileId: "direct",
    previousGlobal: { enabled: true, profileId: "local-relay" } });
  write("proxy-gateway.state.json", { version: 2, pid: 4242, controlPort: helper.port, controlToken: "control-token" });
  write("proxy-gateway.log", "old helper output\n");

  const result = await retireProxyGateway({ userData, store, logger, isRunning: (pid) => pid === 4242 && !helper.stopped, kill() { throw new Error("not needed"); } });

  assert.deepEqual(result, { retired: true, routeRestored: true, helperGone: true });
  assert.equal(helper.stops, 1);
  const snapshot = store.snapshot();
  assert.deepEqual([snapshot.routing.globalEnabled, snapshot.routing.globalProfileId], [true, "direct"]);
  assert.equal(snapshot.proxyProfiles.some((profile) => profile.id === "builtin-gateway"), false);
  assert.equal(store.proxySecret("builtin-gateway"), null, "the access key is deleted, not archived");
  assert.deepEqual(fs.readdirSync(providers).filter((name) => name.startsWith("proxy-gateway")), []);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(providers, "provider-network.json"), "utf8"))).includes("builtin-gateway"), false);
});

test("a gateway that was never used for the app keeps the app's route; a helper that does not prove itself is left alone and retried", async (t) => {
  const { userData, providers, store, write } = fixture(t);
  store.setGlobalRouting({ enabled: true, profileId: "direct" });
  write("proxy-gateway.json", { version: 1, useForApp: false, previousGlobal: null });
  // The pid is alive but nothing answers on the control port (another process may own the pid now).
  write("proxy-gateway.state.json", { version: 2, pid: 5151, controlPort: 1, controlToken: "control-token" });
  const killed = [];

  const result = await retireProxyGateway({ userData, store, logger, isRunning: (pid) => pid === 5151, kill: (pid) => killed.push(pid), timeoutMs: 500 });

  assert.deepEqual(result, { retired: true, routeRestored: false, helperGone: false });
  assert.deepEqual(killed, []);
  assert.equal(store.snapshot().routing.globalProfileId, "direct");
  assert.equal(store.snapshot().proxyProfiles.some((profile) => profile.id === "builtin-gateway"), false);
  assert.deepEqual(fs.readdirSync(providers).filter((name) => name.startsWith("proxy-gateway")), ["proxy-gateway.state.json"]);
});

test("without a usable upstream, a route on the gateway goes back to the route it replaced", async (t) => {
  const { userData, store, write } = fixture(t);
  store.setGlobalRouting({ enabled: true, profileId: "builtin-gateway" });
  store.archiveProxyProfile("direct");
  write("proxy-gateway.json", { version: 1, useForApp: true, upstreamProfileId: "direct",
    previousGlobal: { enabled: true, profileId: "local-relay" } });

  await retireProxyGateway({ userData, store, logger, isRunning: () => false });

  assert.deepEqual([store.snapshot().routing.globalEnabled, store.snapshot().routing.globalProfileId], [true, "local-relay"]);
});

test("a route on the gateway with nothing to go back to becomes direct", async (t) => {
  const { userData, store } = fixture(t);
  store.setGlobalRouting({ enabled: true, profileId: "builtin-gateway" });

  const result = await retireProxyGateway({ userData, store, logger, isRunning: () => false });

  assert.equal(result.routeRestored, true);
  assert.deepEqual([store.snapshot().routing.globalEnabled, store.snapshot().routing.globalProfileId], [false, null]);
});

test("an install that never had the gateway is not touched", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ct-gateway-retire-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const store = { snapshot: () => ({ proxyProfiles: [], routing: {} }), removeProxyProfile() { throw new Error("must not write"); }, setGlobalRouting() { throw new Error("must not write"); } };
  assert.deepEqual(await retireProxyGateway({ userData, store, logger }), { retired: false });
});
