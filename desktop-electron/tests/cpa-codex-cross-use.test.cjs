"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  CPA_LOOPBACK,
  ROUTER_LOOPBACK,
  attachCpaCodexLongRun,
  desktopCrossUseEnvironment,
  managedLoopbackHealthTargets,
  startPeerIds,
} = require("../electron/cpa-codex-long-run.cjs");
const { createOriginalUiController } = require("../electron/original-ui.cjs");
const { createManagedComponentController } = require("../electron/managed-components.cjs");
const { environment } = require("../electron/codex-router-managed.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mockChild(pid = 4202) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

test("CPA and Codex Router share frozen Desktop loopbacks for host routing", () => {
  assert.equal(CPA_LOOPBACK.origin, "http://127.0.0.1:8317");
  assert.equal(CPA_LOOPBACK.port, 8317);
  assert.equal(CPA_LOOPBACK.healthUrl, "http://127.0.0.1:8317/v1/models");
  assert.equal(ROUTER_LOOPBACK.origin, "http://127.0.0.1:4202");
  assert.equal(ROUTER_LOOPBACK.port, 4202);
  assert.deepEqual(startPeerIds("codex-router"), ["cpa"]);
  assert.deepEqual(startPeerIds("cpa"), []);
  assert.deepEqual(startPeerIds("commandcode-proxy"), []);
  assert.deepEqual(startPeerIds("paseo"), []);
  assert.deepEqual(startPeerIds("anneal"), []);

  const env = desktopCrossUseEnvironment({
    cpaProxyApiKey: "p".repeat(36),
    routerCallerKey: "k".repeat(32),
  });
  assert.equal(env.CODING_TOOLS_CPA_URL, "http://127.0.0.1:8317");
  assert.equal(env.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
  assert.equal(env.CODING_TOOLS_CPA_PROXY_API_KEY, "p".repeat(36));
  assert.equal(env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY, "k".repeat(32));

  const health = managedLoopbackHealthTargets({
    cpaProxyApiKey: "p".repeat(36),
    routerCallerKey: "k".repeat(32),
  });
  assert.equal(health.cpa.url, "http://127.0.0.1:8317/v1/models");
  assert.equal(health.cpa.headers.Authorization, `Bearer ${"p".repeat(36)}`);
  assert.equal(health["codex-router"].url, `http://127.0.0.1:4202/_codex-router/${"k".repeat(32)}/v1/models`);
});

test("managed health contracts stay on the shared CPA and Router loopbacks", () => {
  const cpa = JSON.parse(read("vendor/managed-components/cpa.json"));
  const router = JSON.parse(read("vendor/managed-components/codex-router.json"));
  assert.equal(cpa.health.endpoint, CPA_LOOPBACK.healthUrl);
  assert.equal(cpa.health.authorization, "Bearer {secret:proxyApiKey}");
  assert.equal(router.health.endpoint, `${ROUTER_LOOPBACK.origin}/_codex-router/{callerKey}/v1/models`);
  assert.match(read("electron/managed-external-services.cjs"), /ensureStartPeers/);
  assert.match(read("electron/managed-external-services.cjs"), /desktopCrossUseEnvironment/);
  assert.match(read("electron/managed-components.cjs"), /launchEnvironmentFor/);
  assert.doesNotMatch(read("electron/managed-external-services.cjs"), /startPeerIds\("commandcode-proxy"\)/);
});

test("Router launch env always pins the CPA loopback so Desktop can route without a separate app", () => {
  const home = temporaryDirectory("coding-tools-cross-use-router-home-");
  const state = temporaryDirectory("coding-tools-cross-use-router-state-");
  const previous = process.env.CODING_TOOLS_CPA_PROXY_API_KEY;
  process.env.CODING_TOOLS_CPA_PROXY_API_KEY = "p".repeat(36);
  try {
    const launched = environment(home, state);
    assert.equal(launched.CODING_TOOLS_CPA_URL, CPA_LOOPBACK.origin);
    assert.equal(launched.CODING_TOOLS_CODEX_ROUTER_URL, ROUTER_LOOPBACK.origin);
    assert.equal(launched.CODING_TOOLS_CPA_PROXY_API_KEY, "p".repeat(36));
  } finally {
    if (previous === undefined) delete process.env.CODING_TOOLS_CPA_PROXY_API_KEY;
    else process.env.CODING_TOOLS_CPA_PROXY_API_KEY = previous;
  }
});

test("original UI Start for Codex Router starts bundled CPA first and leaves CommandCode/Paseo/Anneal alone", async () => {
  const calls = [];
  const controller = createOriginalUiController({
    sleep: async () => {},
    longRun: false,
    externalServices: {
      snapshot: () => ({
        services: [
          {
            id: "cpa",
            endpoint: CPA_LOOPBACK.endpoint,
            status: "ready",
            pid: 8317,
            home: "/tmp/cpa-home",
            managedInstall: { state: "installed", bundledRuntime: true },
          },
          {
            id: "codex-router",
            endpoint: ROUTER_LOOPBACK.endpoint,
            status: "ready",
            pid: 4202,
            home: "/tmp/router-home",
            managedInstall: { state: "installed", bundledRuntime: true },
          },
        ],
      }),
      inspect: async () => {},
      start: async (id) => { calls.push(["start", id]); },
    },
  });
  await controller.start("codex-router");
  assert.deepEqual(calls, [["start", "cpa"], ["start", "codex-router"]]);
  assert.equal(calls.some((entry) => entry[1] === "commandcode-proxy"), false);
  assert.equal(calls.some((entry) => entry[1] === "paseo"), false);
  assert.equal(calls.some((entry) => entry[1] === "anneal"), false);
  controller.dispose();
});

test("desired-run for Codex Router also desires CPA on the shared loopbacks", async () => {
  const calls = [];
  const inner = {
    snapshot: () => ({
      version: 1,
      tools: [
        { id: "cpa", status: "ready", pid: 8317, originalChrome: true },
        { id: "codex-router", status: "ready", pid: 4202, originalChrome: true },
      ],
    }),
    inspect: async (id) => ({
      id,
      status: "ready",
      pid: id === "cpa" ? 8317 : 4202,
      originalChrome: true,
    }),
    start: async (id) => {
      calls.push(["start", id]);
      return { id, status: "ready", pid: id === "cpa" ? 8317 : 4202, originalChrome: true };
    },
    stop: async (id) => ({ id, status: "offline", pid: null, originalChrome: true }),
    restart: async (id) => inner.start(id),
    openEmbedded: async (id) => ({ tool: { id, status: "ready", pid: 4202 }, section: "dashboard", url: "", embedded: false }),
    openExternalTool: async (id) => inner.openEmbedded(id),
    copyCpaManagementKey: () => ({ copied: true, length: 36 }),
    dispose() {},
  };
  const supervisor = attachCpaCodexLongRun(inner, { resumeOnCreate: false });
  await supervisor.start("codex-router");
  const tools = Object.fromEntries(supervisor.snapshot().tools.map((tool) => [tool.id, tool]));
  assert.equal(tools.cpa.longRun.desiredRunning, true);
  assert.equal(tools["codex-router"].longRun.desiredRunning, true);
  assert.deepEqual(calls, [["start", "codex-router"]]);
  supervisor.dispose();
});

test("managed Router spawn receives the CPA loopback URL and proxy key without touching other stack apps", async () => {
  const payload = Buffer.from("cross-use-router-fixture", "utf8");
  const manifestRoot = temporaryDirectory("coding-tools-cross-use-manifests-");
  const dataRoot = temporaryDirectory("coding-tools-cross-use-data-");
  const ids = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];
  for (const id of ids) {
    const sha256 = require("node:crypto").createHash("sha256").update(payload).digest("hex");
    fs.writeFileSync(path.join(manifestRoot, `${id}.json`), `${JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      managedBy: "Coding Tools",
      loopbackOnly: true,
      repository: `fixture/${id}`,
      version: "1.0.0",
      strategy: "release-binary",
      platforms: {
        [process.platform]: {
          [process.arch]: {
            url: `https://github.com/fixture/${id}/releases/download/v1.0.0/${id}.bin`,
            sha256,
            fileName: `${id}.bin`,
          },
        },
      },
      install: {
        steps: [
          { id: "download-release", kind: "download" },
          { id: "verify-sha256", kind: "verify" },
          { id: "activate", kind: "activate" },
        ],
      },
      launch: {
        processes: [{
          id: "service",
          mode: "foreground",
          executable: "{artifact}",
          arguments: [],
        }],
      },
      health: {
        endpoint: id === "codex-router"
          ? ROUTER_LOOPBACK.endpoint
          : id === "cpa"
            ? CPA_LOOPBACK.endpoint
            : "http://127.0.0.1:9090/",
        acceptStatus: [200],
      },
    }, null, 2)}\n`);
  }

  const spawned = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    }),
    spawnProcess: (executable, args, options) => {
      spawned.push({ executable, args, env: options.env });
      return mockChild();
    },
    launchEnvironmentFor: (id) => (
      id === "codex-router"
        ? desktopCrossUseEnvironment({ cpaProxyApiKey: "p".repeat(36) })
        : {}
    ),
  });
  await controller.installComponent("codex-router");
  await controller.startComponent("codex-router");
  const routerSpawn = spawned.at(-1);
  assert.equal(routerSpawn.env.CODING_TOOLS_CPA_URL, CPA_LOOPBACK.origin);
  assert.equal(routerSpawn.env.CODING_TOOLS_CODEX_ROUTER_URL, ROUTER_LOOPBACK.origin);
  assert.equal(routerSpawn.env.CODING_TOOLS_CPA_PROXY_API_KEY, "p".repeat(36));

  spawned.length = 0;
  await controller.installComponent("paseo");
  await controller.startComponent("paseo");
  const paseoSpawn = spawned.at(-1);
  assert.equal(paseoSpawn.env.CODING_TOOLS_CPA_URL, undefined);
  controller.dispose();
});
