"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const {
  DEFAULT_IN_APP_LOOPBACKS,
  buildLoopbackMesh,
  loopbackMeshEnvironment,
  persistLoopbackMesh,
} = require("../electron/loopback-mesh.cjs");
const { createExternalServicesController } = require("../electron/external-services.cjs");
const { createManagedExternalServicesController } = require("../electron/managed-external-services.cjs");
const { createManagedComponentController } = require("../electron/managed-components.cjs");

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(__dirname, "..", "..");

function temporaryDirectory(name = "coding-tools-loopback-mesh") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function mockChild(pid = 5100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  return child;
}

test("default mesh pins the in-app five-stack loopbacks", () => {
  const mesh = buildLoopbackMesh();
  assert.equal(mesh.schemaVersion, 1);
  assert.equal(mesh.managedBy, "Coding Tools");
  assert.equal(mesh.loopbackOnly, true);
  assert.equal(mesh.services["codex-router"].url, "http://127.0.0.1:4202");
  assert.equal(mesh.services["commandcode-proxy"].url, "http://127.0.0.1:9090");
  assert.equal(mesh.services["commandcode-proxy"].openaiBaseUrl, "http://127.0.0.1:9090/v1");
  assert.equal(mesh.services["commandcode-proxy"].anthropicBaseUrl, "http://127.0.0.1:9090/v1");
  assert.equal(mesh.services.cpa.url, "http://127.0.0.1:8317");
  assert.equal(mesh.services.paseo.url, "http://127.0.0.1:6768");
  assert.equal(mesh.services.paseo.executionUrl, "ws://127.0.0.1:6768/ws");
  assert.equal(mesh.services.anneal.url, "http://127.0.0.1:5173");
  assert.equal(mesh.services.anneal.executionUrl, "http://127.0.0.1:3000");
  assert.equal(DEFAULT_IN_APP_LOOPBACKS.paseo.url, "http://127.0.0.1:6768");
});

test("Anneal's legacy 3000 snapshot endpoint does not replace the 5173 in-app UI origin", () => {
  const mesh = buildLoopbackMesh([
    { id: "anneal", endpoint: "http://127.0.0.1:3000/", executionEndpoint: "http://127.0.0.1:3000/" },
    { id: "commandcode-proxy", endpoint: "http://127.0.0.1:9091/" },
    { id: "paseo", endpoint: "http://127.0.0.1:6769/", executionEndpoint: "ws://127.0.0.1:6769/ws" },
  ]);
  assert.equal(mesh.services.anneal.url, "http://127.0.0.1:5173");
  assert.equal(mesh.services.anneal.executionUrl, "http://127.0.0.1:3000/");
  assert.equal(mesh.services["commandcode-proxy"].url, "http://127.0.0.1:9091");
  assert.equal(mesh.services["commandcode-proxy"].openaiBaseUrl, "http://127.0.0.1:9091/v1");
  assert.equal(mesh.services.paseo.url, "http://127.0.0.1:6769");
  assert.equal(mesh.services.paseo.executionUrl, "ws://127.0.0.1:6769/ws");
});

test("mesh construction rejects non-loopback overlays", () => {
  assert.throws(
    () => buildLoopbackMesh([{ id: "cpa", endpoint: "https://cpa.example/" }]),
    /loopback/i,
  );
  assert.throws(
    () => buildLoopbackMesh([{ id: "paseo", executionEndpoint: "ws://paseo.example/ws" }]),
    /loopback/i,
  );
});

test("Paseo and Anneal peer env alias CommandCode; MCP env does not", () => {
  const mesh = buildLoopbackMesh();
  const paseo = loopbackMeshEnvironment(mesh, {
    targetId: "paseo",
    commandCodeApiKey: "peer-secret-not-for-json",
    meshPath: "/tmp/loopback-mesh.json",
  });
  assert.equal(paseo.OPENAI_BASE_URL, "http://127.0.0.1:9090/v1");
  assert.equal(paseo.ANTHROPIC_BASE_URL, "http://127.0.0.1:9090/v1");
  assert.equal(paseo.CODING_TOOLS_COMMANDCODE_URL, "http://127.0.0.1:9090");
  assert.equal(paseo.CODING_TOOLS_CPA_URL, "http://127.0.0.1:8317");
  assert.equal(paseo.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
  assert.equal(paseo.OPENAI_API_KEY, "peer-secret-not-for-json");

  const commandcode = loopbackMeshEnvironment(mesh, { targetId: "commandcode-proxy", commandCodeApiKey: "peer-secret-not-for-json" });
  assert.equal(commandcode.OPENAI_BASE_URL, undefined);
  assert.equal(commandcode.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
  assert.equal(commandcode.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
  assert.equal(commandcode.CODING_TOOLS_ANNEAL_EXECUTION_URL, "http://127.0.0.1:3000");

  const mcp = loopbackMeshEnvironment(mesh, { meshPath: "/tmp/loopback-mesh.json" });
  assert.equal(mcp.OPENAI_BASE_URL, undefined);
  assert.equal(mcp.ANTHROPIC_BASE_URL, undefined);
  assert.equal(mcp.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
  assert.equal(mcp.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
  assert.equal(mcp.CODING_TOOLS_COMMANDCODE_OPENAI_BASE_URL, "http://127.0.0.1:9090/v1");
});

test("persisted mesh JSON is URL-only and rejects secrets", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "loopback-mesh.json");
  persistLoopbackMesh(filePath, buildLoopbackMesh());
  const raw = fs.readFileSync(filePath, "utf8");
  assert.equal(raw.includes("proxyApiKey"), false);
  assert.equal(raw.includes("user_"), false);
  assert.equal(raw.includes("OPENAI_API_KEY"), false);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.services["commandcode-proxy"].url, "http://127.0.0.1:9090");
  assert.throws(
    () => persistLoopbackMesh(filePath, { ...parsed, leak: "proxyApiKey" }),
    /secrets/i,
  );
  assert.throws(
    () => persistLoopbackMesh(filePath, { ...parsed, leak: "user_abc123" }),
    /secrets/i,
  );
});

test("external-services runtimeEnvironment advertises Paseo and Anneal origins without OPENAI_BASE_URL", () => {
  const directory = temporaryDirectory("coding-tools-external-mesh");
  const controller = createExternalServicesController({
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      clone: () => ({ json: async () => ({ data: [] }) }),
    }),
    spawnProcess: () => mockChild(),
  });
  const env = controller.runtimeEnvironment();
  assert.equal(env.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
  assert.equal(env.CODING_TOOLS_COMMANDCODE_URL, "http://127.0.0.1:9090");
  assert.equal(env.CODING_TOOLS_COMMANDCODE_OPENAI_BASE_URL, "http://127.0.0.1:9090/v1");
  assert.equal(env.CODING_TOOLS_CPA_URL, "http://127.0.0.1:8317");
  assert.equal(env.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
  assert.equal(env.CODING_TOOLS_PASEO_EXECUTION_URL, "ws://127.0.0.1:6768/ws");
  assert.equal(env.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
  assert.equal(env.CODING_TOOLS_ANNEAL_EXECUTION_URL, "http://127.0.0.1:3000/");
  assert.equal(env.OPENAI_BASE_URL, undefined);
  const meshFile = path.join(directory, "loopback-mesh.json");
  assert.equal(env.CODING_TOOLS_LOOPBACK_MESH, meshFile);
  assert.equal(fs.existsSync(meshFile), true);
  assert.equal(fs.readFileSync(meshFile, "utf8").includes("proxyApiKey"), false);
  controller.dispose();
});

test("managed controller shares one mesh file with MCP and keeps Anneal on 5173", () => {
  const directory = temporaryDirectory("coding-tools-managed-mesh");
  const dataRoot = path.join(directory, "integrations");
  const controller = createManagedExternalServicesController({
    dataRoot,
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      clone: () => ({ json: async () => ({ data: [] }) }),
    }),
    spawnProcess: () => mockChild(),
  });
  const env = controller.runtimeEnvironment();
  const mesh = controller.loopbackMesh();
  assert.equal(mesh.services.anneal.url, "http://127.0.0.1:5173");
  assert.equal(env.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
  assert.equal(env.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.CODING_TOOLS_LOOPBACK_MESH, path.join(dataRoot, "loopback-mesh.json"));
  assert.equal(fs.existsSync(path.join(dataRoot, "loopback-mesh.json")), true);
  controller.dispose();
});

test("installed Codex Router caller key does not recurse through environment construction", () => {
  const directory = temporaryDirectory("coding-tools-managed-router-key");
  const dataRoot = path.join(directory, "integrations");
  const routerManifest = JSON.parse(
    fs.readFileSync(path.join(root, "vendor", "managed-components", "codex-router.json"), "utf8"),
  );
  const routerHome = path.join(dataRoot, "components", "codex-router", routerManifest.version);
  const routerState = path.join(dataRoot, "state", "codex-router", "router");
  fs.mkdirSync(routerHome, { recursive: true });
  fs.mkdirSync(routerState, { recursive: true });
  fs.writeFileSync(path.join(routerHome, ".coding-tools-managed-component.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: routerManifest.id,
    version: routerManifest.version,
    strategy: routerManifest.strategy,
    repository: routerManifest.repository,
    commit: routerManifest.commit,
    installedAt: "2026-09-22T00:00:00.000Z",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(routerState, "caller-secret"), "\uFEFFrouter-caller-key\n", "utf8");

  const warnings = [];
  const controller = createManagedExternalServicesController({
    dataRoot,
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      clone: () => ({ json: async () => ({ data: [] }) }),
    }),
    logger: {
      warn(event, detail) {
        warnings.push({ event, detail });
      },
    },
  });

  const environment = controller.runtimeEnvironment();
  assert.equal(environment.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY, "router-caller-key");
  assert.equal(warnings.some(({ event }) => event === "managed-component.peer-environment-failed"), false);
  controller.dispose();
});

test("managed Start injects peer loopbacks and does not override PROXY_PORT", async () => {
  const manifestRoot = temporaryDirectory("coding-tools-peer-manifests");
  const dataRoot = temporaryDirectory("coding-tools-peer-data");
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const ids = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];
  for (const id of ids) {
    const sha256 = require("node:crypto").createHash("sha256").update(payload).digest("hex");
    fs.mkdirSync(manifestRoot, { recursive: true });
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
        processes: [
          {
            id: "service",
            mode: "foreground",
            executable: "{artifact}",
            arguments: [],
            environment: id === "commandcode-proxy"
              ? { PROXY_HOST: "127.0.0.1", PROXY_PORT: "9090" }
              : {},
          },
        ],
      },
      health: {
        endpoint: `http://127.0.0.1:${id === "codex-router" ? 4202 : id === "commandcode-proxy" ? 9090 : id === "cpa" ? 8317 : id === "paseo" ? 6768 : 5173}/`,
        acceptStatus: [200],
      },
    }, null, 2)}\n`);
  }

  const spawned = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: true,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    }),
    spawnProcess: (executable, args, options) => {
      spawned.push({ executable, args, env: options.env });
      return mockChild(8100 + spawned.length);
    },
    resolveRuntimeExecutable: () => process.execPath,
    peerEnvironment: (manifest) => loopbackMeshEnvironment(buildLoopbackMesh(), {
      targetId: manifest.id,
      commandCodeApiKey: "peer-secret-not-for-json",
    }),
  });

  await controller.installComponent("commandcode-proxy");
  await controller.startComponent("commandcode-proxy");
  const commandcodeEnv = spawned.at(-1).env;
  assert.equal(commandcodeEnv.PROXY_PORT, "9090");
  assert.equal(commandcodeEnv.PROXY_HOST, "127.0.0.1");
  assert.equal(commandcodeEnv.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
  assert.equal(commandcodeEnv.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
  assert.equal(commandcodeEnv.OPENAI_BASE_URL, undefined);

  await controller.installComponent("paseo");
  await controller.startComponent("paseo");
  const paseoEnv = spawned.at(-1).env;
  assert.equal(paseoEnv.OPENAI_BASE_URL, "http://127.0.0.1:9090/v1");
  assert.equal(paseoEnv.ANTHROPIC_BASE_URL, "http://127.0.0.1:9090/v1");
  assert.equal(paseoEnv.CODING_TOOLS_COMMANDCODE_URL, "http://127.0.0.1:9090");
  controller.dispose();
});

test("this change does not rewrite CPA/Router keep-alive in provider-network", () => {
  const diff = execFileSync("git", ["diff", "--", "desktop-electron/electron/provider-network.cjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(diff, "");
  const source = fs.readFileSync(path.join(root, "electron/external-services.cjs"), "utf8");
  assert.match(source, /KEEP_ALIVE_POLL_MS = 20_000/);
  assert.match(source, /KEEP_ALIVE_LEASE_WRITE_MS = 5 \* 60_000/);
});
