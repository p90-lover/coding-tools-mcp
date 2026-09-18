"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  READY_WAIT_MS,
  waitUntilHealthy,
} = require("../electron/loopback-health.cjs");
const {
  createOriginalUiController,
} = require("../electron/original-ui.cjs");
const {
  createExternalServicesController,
} = require("../electron/external-services.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("CPA and Codex Router wait for real /v1/models health, not a live pid", () => {
  assert.equal(READY_WAIT_MS.cpa, 45_000);
  assert.equal(READY_WAIT_MS["codex-router"], 90_000);

  const originalMain = read("electron/original-ui.cjs");
  const managed = read("electron/managed-external-services.cjs");
  const cpaManifest = JSON.parse(read("vendor/managed-components/cpa.json"));
  const routerManifest = JSON.parse(read("vendor/managed-components/codex-router.json"));

  assert.match(originalMain, /return waitUntilReady\(toolId\)/);
  assert.match(managed, /waitUntilListen/);
  assert.match(managed, /waitForHealth: !supervised/);
  assert.match(managed, /A live pid is "starting", never "ready"/);
  assert.equal(cpaManifest.health.endpoint, "http://127.0.0.1:8317/v1/models");
  assert.equal(
    routerManifest.health.endpoint,
    "http://127.0.0.1:4202/_codex-router/{callerKey}/v1/models",
  );
  assert.doesNotMatch(managed, /bundled-runtimes/);
  assert.doesNotMatch(originalMain, /startPeerIds/);
  assert.doesNotMatch(originalMain, /commandcode-proxy|paseo|anneal/);
});

test("waitUntilHealthy stays starting until HTTP health succeeds", async () => {
  let nowMs = 0;
  let status = "starting";
  const inspected = [];
  const result = waitUntilHealthy({
    id: "cpa",
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
      if (nowMs >= 500) status = "ready";
    },
    pollMs: 250,
    timeoutMs: 2_000,
    inspect: async (id) => {
      inspected.push({ id, nowMs, status });
      return { id, status, pid: 8317 };
    },
  });
  const snapshot = await result;
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.pid, 8317);
  assert.ok(inspected.some((entry) => entry.status === "starting"));
  assert.ok(inspected.at(-1).status === "ready");
});

test("a pid without loopback health is never reported ready", async () => {
  let nowMs = 0;
  const snapshot = await waitUntilHealthy({
    id: "codex-router",
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    pollMs: 250,
    timeoutMs: 1_000,
    inspect: async () => ({ id: "codex-router", status: "starting", pid: 4202 }),
  });
  assert.equal(snapshot.status, "starting");
  assert.equal(snapshot.pid, 4202);
  assert.notEqual(snapshot.status, "ready");
});

test("original UI Start waits until CPA is actually ready", async () => {
  let status = "starting";
  let nowMs = 0;
  const calls = [];
  const controller = createOriginalUiController({
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
      if (nowMs >= 500) status = "ready";
    },
    externalServices: {
      snapshot: () => ({
        services: [{
          id: "cpa",
          endpoint: "http://127.0.0.1:8317/",
          status,
          pid: 8317,
          home: "/tmp/cpa-home",
          managedInstall: { state: "installed" },
        }],
      }),
      inspect: async (id) => { calls.push(["inspect", id, status]); },
      start: async (id) => { calls.push(["start", id]); },
    },
  });

  const started = await controller.start("cpa");
  assert.equal(started.status, "ready");
  assert.deepEqual(calls[0], ["start", "cpa"]);
  assert.ok(calls.some((call) => call[0] === "inspect" && call[2] === "starting"));
  controller.dispose();
});

test("CPA inspect is ready only after GET /v1/models succeeds on loopback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-cpa-health-"));
  const child = new EventEmitter();
  child.pid = 8317;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;

  let listening = false;
  const server = await listen((request, response) => {
    if (!listening) {
      response.writeHead(500);
      response.end();
      return;
    }
    if (request.url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/`;

  const controller = createExternalServicesController({
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    spawnProcess: () => child,
  });
  controller.configure("cpa", {
    endpoint,
    home: directory,
    executable: process.execPath,
    arguments: ["-e", "process.stdin.resume()"],
    enabled: true,
  });

  const started = await controller.start("cpa");
  assert.equal(started.status, "starting");
  assert.equal(started.pid, 8317);

  const down = await controller.inspect("cpa");
  assert.notEqual(down.status, "ready");

  listening = true;
  const ready = await controller.inspect("cpa");
  assert.equal(ready.status, "ready");
  assert.equal(ready.modelCount, 1);
  assert.equal(ready.pid, 8317);

  controller.dispose();
  await closeServer(server);
});
