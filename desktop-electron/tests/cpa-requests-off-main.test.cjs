"use strict";

// Requests to CPA leave from a worker thread, never with Node's fetch on main: a socket connect to
// CPA that the network filter held froze every window for 43.7 s (2026-11-12 09:38Z, chat images and
// the Antigravity sign-in check). Here main's fetch fails and main's socket connects are counted, so
// a module that falls back to either fails.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const offThread = require("../electron/off-thread-run.cjs");
const { createChatImageGenerator } = require("../electron/chat-images.cjs");
const { createAntigravityReauth } = require("../electron/cpa-antigravity-reauth.cjs");
const { createProviderNetworkController } = require("../electron/provider-network.cjs");

async function serveCpa(t, reply) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url.split("?")[0]} ${request.headers.authorization || request.headers["x-management-key"] || ""}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply(request)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

/** Main's fetch throws from here on; every client socket main connects is recorded. */
function mainNetworkWatched(t) {
  const connects = [];
  const realConnect = net.Socket.prototype.connect;
  const realFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (...args) { connects.push(args[0]); return realConnect.apply(this, args); };
  globalThis.fetch = async () => { throw new Error("Node's fetch on main was used"); };
  t.after(() => {
    net.Socket.prototype.connect = realConnect;
    globalThis.fetch = realFetch;
    offThread.resetFetchWorker();
  });
  return connects;
}

test("chat image generation asks CPA from a worker, not with main's fetch", async (t) => {
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4, 1)]);
  const cpa = await serveCpa(t, () => ({ data: [{ b64_json: image.toString("base64") }] }));
  const connects = mainNetworkWatched(t);
  const generate = createChatImageGenerator({ connection: async () => ({ baseUrl: `${cpa.base}/v1`, proxyApiKey: "test-key" }) });

  const result = await generate({ prompt: "a red square" });

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.data, image.toString("base64"));
  assert.deepEqual(cpa.seen, ["POST /v1/images/generations Bearer test-key"]);
  assert.deepEqual(connects, []);
});

test("the Antigravity sign-in check reads CPA's accounts from a worker, not with main's fetch", async (t) => {
  const cpa = await serveCpa(t, () => ({ files: [] }));
  const connects = mainNetworkWatched(t);
  const reauth = createAntigravityReauth({
    cpaConnection: () => ({ baseUrl: cpa.base, managementKey: "test-key" }),
    openExternal: async () => {},
    statePath: path.join(__dirname, "never-written-reauth-state.json"),
  });

  assert.deepEqual(await reauth.accounts(), []);
  assert.deepEqual(cpa.seen, ["GET /v0/management/auth-files Bearer test-key"]);
  assert.deepEqual(connects, []);
});

test("a provider account probe asks CPA's management API from a worker, not with main's fetch", async (t) => {
  const cpa = await serveCpa(t, () => ({ files: [] }));
  const userData = path.join(__dirname, "..", "aiTemp", "cpa-requests-off-main", crypto.randomUUID());
  fs.mkdirSync(userData, { recursive: true });
  const controller = createProviderNetworkController({
    app: {},
    browserPartition: "persist:cpa-off-main-test",
    getBrowserHost: () => null,
    getCpaConnection: () => ({ baseUrl: cpa.base, managementKey: "test-key" }),
    logger: { info() {}, warn() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { setProxy: async () => undefined },
      fromPartition: () => ({ setProxy: async () => undefined }),
    },
    shell: { async openExternal() {} },
    userData,
    sleepImpl: async () => undefined,
  });
  const account = controller.store.saveAccount({
    providerId: "cliproxyapi-antigravity", label: "Antigravity", identity: "", auth: "local_proxy",
    status: "pending", enabled: true, isDefault: false, endpoint: cpa.base, models: [],
    secret: { credential: "unused-account-key" },
  }).accounts.find((entry) => entry.providerId === "cliproxyapi-antigravity");
  const connects = mainNetworkWatched(t);

  await controller.probeProviderAccount(account.id);

  assert.deepEqual(cpa.seen, ["GET /v0/management/auth-files Bearer test-key"]);
  assert.deepEqual(connects, []);
});
