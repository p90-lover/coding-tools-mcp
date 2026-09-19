"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  FIVE_STACK_ENDPOINTS,
  inAppGenericProviders,
  peerEnvironmentFor,
  publicUrlMap,
  writeInAppProvidersFile,
} = require("../electron/five-stack-cross-use.cjs");
const { createManagedComponentController } = require("../electron/managed-components.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

test("in-app cross-use map pins all five loopbacks and does not recurse CPA into itself", () => {
  const urls = publicUrlMap();
  assert.equal(urls.CODING_TOOLS_CPA_URL, FIVE_STACK_ENDPOINTS.cpa.origin);
  assert.equal(urls.CODING_TOOLS_CODEX_ROUTER_URL, FIVE_STACK_ENDPOINTS["codex-router"].origin);
  assert.equal(urls.CODING_TOOLS_COMMANDCODE_URL, FIVE_STACK_ENDPOINTS["commandcode-proxy"].origin);
  assert.equal(urls.CODING_TOOLS_PASEO_URL, FIVE_STACK_ENDPOINTS.paseo.origin);
  assert.equal(urls.CODING_TOOLS_PASEO_EXECUTION_URL, FIVE_STACK_ENDPOINTS.paseo.ws);
  assert.equal(urls.CODING_TOOLS_ANNEAL_URL, FIVE_STACK_ENDPOINTS.anneal.web);
  assert.equal(urls.CODING_TOOLS_ANNEAL_EXECUTION_URL, FIVE_STACK_ENDPOINTS.anneal.api);

  const secrets = {
    cpaProxyApiKey: "c".repeat(36),
    commandCodeProxyApiKey: "k".repeat(36),
    routerCallerKey: "A".repeat(32),
  };
  const routerEnv = peerEnvironmentFor("codex-router", secrets);
  assert.equal(routerEnv.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(routerEnv.OPENAI_API_KEY, secrets.cpaProxyApiKey);
  assert.equal(routerEnv.CODING_TOOLS_COMMANDCODE_URL, "http://127.0.0.1:9090");

  const cpaEnv = peerEnvironmentFor("cpa", secrets);
  assert.equal(cpaEnv.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
  assert.equal(cpaEnv.OPENAI_BASE_URL, undefined);
  assert.equal(cpaEnv.OPENAI_API_KEY, undefined);

  const commandCodeEnv = peerEnvironmentFor("commandcode-proxy", secrets);
  assert.equal(commandCodeEnv.COMMANDCODE_UPSTREAM_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(commandCodeEnv.COMMANDCODE_UPSTREAM_API_KEY, secrets.cpaProxyApiKey);

  const paseoEnv = peerEnvironmentFor("paseo", secrets);
  assert.equal(paseoEnv.PASEO_ANNEAL_API_URL, "http://127.0.0.1:3000");
  const annealEnv = peerEnvironmentFor("anneal", secrets);
  assert.equal(annealEnv.ANNEAL_PASEO_URL, "http://127.0.0.1:6768");
});

test("Router Start writes in-app CPA and CommandCode provider descriptors", () => {
  const state = temporaryDirectory("coding-tools-cross-use-router");
  const filePath = writeInAppProvidersFile(path.join(state, "router"));
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.providers.map((provider) => provider.id), ["cpa", "commandcode-proxy"]);
  assert.equal(parsed.providers[0].baseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(parsed.providers[1].baseUrl, "http://127.0.0.1:9090/v1");
  assert.deepEqual(inAppGenericProviders().map((provider) => provider.allowPrivate), [true, true]);
});

test("managed launch env injects in-app CPA for Router and CommandCode, never for CPA itself", async () => {
  const crypto = require("node:crypto");
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestRoot = temporaryDirectory("coding-tools-cross-use-manifests");
  const dataRoot = temporaryDirectory("coding-tools-cross-use-data");
  const ids = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];
  for (const id of ids) {
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
        processes: [{ id: "service", mode: "foreground", executable: "{artifact}", arguments: [] }],
      },
      health: { endpoint: "http://127.0.0.1:8317/", acceptStatus: [200] },
    }, null, 2)}\n`);
  }

  const spawned = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENAI_"))),
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    }),
    spawnProcess: (_executable, _args, options) => {
      spawned.push(options.env);
      const { EventEmitter } = require("node:events");
      const child = new EventEmitter();
      child.pid = 9400 + spawned.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
      };
      return child;
    },
    resolveCrossUseEnvironment: (componentId) => peerEnvironmentFor(componentId, {
      cpaProxyApiKey: "c".repeat(36),
      commandCodeProxyApiKey: "k".repeat(36),
      routerCallerKey: "A".repeat(32),
    }),
  });

  await controller.startComponent("codex-router");
  const routerEnv = spawned.at(-1);
  assert.equal(routerEnv.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(routerEnv.CODING_TOOLS_COMMANDCODE_URL, "http://127.0.0.1:9090");
  assert.equal(
    fs.existsSync(path.join(dataRoot, "state", "codex-router", "router", "in-app-providers.json")),
    true,
  );

  spawned.length = 0;
  await controller.startComponent("cpa");
  const cpaEnv = spawned.at(-1);
  assert.equal(cpaEnv.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
  assert.equal(cpaEnv.OPENAI_BASE_URL, undefined);
  controller.dispose();
});

test("Integrations copy and sync plan advertise in-app cross-use instead of external installs", () => {
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const services = read("electron/external-services.cjs");
  const managed = read("electron/managed-external-services.cjs");
  assert.match(surface, /share in-app loopbacks/);
  assert.doesNotMatch(surface, /separately installed/);
  assert.match(services, /--with-cpa/);
  assert.match(services, /--cpa-base-url/);
  assert.match(managed, /peerEnvironmentFor/);
  assert.match(managed, /runtime-supervisor/);
});

test("crossUseSecrets reads caller-secret from disk and never calls runtimeConfiguration", () => {
  const managed = read("electron/managed-external-services.cjs");
  const components = read("electron/managed-components.cjs");
  assert.match(managed, /function readRouterCallerKey\(/);
  assert.match(managed, /charCodeAt\(0\) === 0xFEFF/);
  assert.match(managed, /readRouterCallerKey\(\)/);
  const start = managed.indexOf("function crossUseSecrets(");
  const end = managed.indexOf("function managedConfiguration(");
  assert.ok(start >= 0 && end > start);
  const body = managed.slice(start, end);
  assert.match(body, /readRouterCallerKey\(\)/);
  assert.doesNotMatch(body, /runtimeConfiguration\s*\(\s*["']codex-router["']\s*\)/);
  assert.match(components, /let peerEnvBusy = false/);
  assert.match(components, /let crossUseEnvBusy = false/);
  assert.match(components, /managed-component\.cross-use-environment-reentered/);
  assert.match(components, /managed-component\.peer-environment-reentered/);
});

test("managed runtimeEnvironment reads a BOM-prefixed router caller-secret from disk", () => {
  const { createManagedExternalServicesController } = require("../electron/managed-external-services.cjs");
  const { EventEmitter } = require("node:events");
  const directory = temporaryDirectory("coding-tools-caller-secret");
  const dataRoot = path.join(directory, "integrations");
  const callerKey = "A".repeat(32);
  fs.mkdirSync(path.join(dataRoot, "state", "codex-router", "router"), { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot, "state", "codex-router", "router", "caller-secret"),
    `\uFEFF${callerKey}\n`,
    "utf8",
  );
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
    spawnProcess: () => {
      const child = new EventEmitter();
      child.pid = 1;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true;
      return child;
    },
  });
  try {
    const env = controller.runtimeEnvironment();
    assert.equal(env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY, callerKey);
  } finally {
    controller.dispose();
  }
});

test("commandSpec reentry through runtimeConfiguration does not overflow", async () => {
  const { EventEmitter } = require("node:events");
  const crypto = require("node:crypto");
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestRoot = temporaryDirectory("coding-tools-reentry-manifests");
  const dataRoot = temporaryDirectory("coding-tools-reentry-data");
  const ids = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];
  for (const id of ids) {
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
        processes: [{ id: "service", mode: "foreground", executable: "{artifact}", arguments: [] }],
      },
      health: { endpoint: "http://127.0.0.1:4202/", acceptStatus: [200] },
    }, null, 2)}\n`);
  }

  const warnings = [];
  const spawned = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: true,
    safeStorage: { isEncryptionAvailable: () => false },
    logger: {
      warn: (event, details) => warnings.push({ event, details }),
    },
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    }),
    spawnProcess: (_executable, _args, options) => {
      spawned.push(options.env);
      const child = new EventEmitter();
      child.pid = 9500 + spawned.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
      };
      return child;
    },
    resolveCrossUseEnvironment: (componentId) => {
      controller.runtimeConfiguration(componentId);
      return { CODING_TOOLS_TEST_CROSS_USE: "1" };
    },
    peerEnvironment: () => {
      controller.runtimeConfiguration("codex-router");
      return { CODING_TOOLS_TEST_PEER: "1" };
    },
  });

  await controller.startComponent("codex-router");
  const env = spawned.at(-1);
  assert.equal(env.CODING_TOOLS_TEST_CROSS_USE, "1");
  assert.ok(warnings.some((entry) => entry.event === "managed-component.cross-use-environment-reentered"));
  assert.ok(warnings.some((entry) => entry.event === "managed-component.peer-environment-reentered"));
  controller.dispose();
});
