"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8");
}

function retainedTestRoot(name) {
  const root = path.join(
    REPOSITORY_ROOT,
    "aiTemp",
    "rc8-external-services-tests",
    `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("external service controller owns the four architecture-B services and rejects remote endpoints", () => {
  const {
    SERVICE_IDS,
    createExternalServicesController,
    normalizeLoopbackServiceEndpoint,
  } = require("../electron/external-services.cjs");

  assert.deepEqual(
    SERVICE_IDS,
    ["codex-router", "commandcode-proxy", "paseo", "anneal"],
  );
  assert.equal(
    normalizeLoopbackServiceEndpoint("http://localhost:4202"),
    "http://localhost:4202/",
  );
  assert.equal(
    normalizeLoopbackServiceEndpoint("http://[::1]:3000/tasks"),
    "http://[::1]:3000/tasks/",
  );
  assert.throws(
    () => normalizeLoopbackServiceEndpoint("https://example.com/"),
    /loopback/i,
  );
  assert.throws(
    () => normalizeLoopbackServiceEndpoint("file:///tmp/router"),
    /HTTP/i,
  );
  assert.equal(typeof createExternalServicesController, "function");
});

test("external service settings persist while caller keys stay out of snapshots", async () => {
  const { createExternalServicesController } = require("../electron/external-services.cjs");
  const root = retainedTestRoot("persistence");
  const calls = [];
  const controller = createExternalServicesController({
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "router-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    runRuntimeCommand: async (args) => ({ args, stdout: "synced", stderr: "" }),
  });

  const configured = controller.configure("codex-router", {
    endpoint: "http://127.0.0.1:4202",
    executable: "model-router",
    arguments: ["codex", "serve"],
    routerCli: "model-router",
    curateCli: "curate-models",
    callerKey: "caller_key_abcdefghijklmnopqrstuvwxyz_0123456789",
    enabled: true,
    autoStart: false,
  });

  assert.equal(configured.secretConfigured, true);
  assert.equal(configured.endpoint, "http://127.0.0.1:4202/");
  assert.equal(JSON.stringify(controller.snapshot()).includes("caller_key_"), false);
  assert.deepEqual(controller.runtimeEnvironment(), {
    CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202",
    CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: "caller_key_abcdefghijklmnopqrstuvwxyz_0123456789",
    CODING_TOOLS_COMMANDCODE_URL: "http://127.0.0.1:9090",
  });

  const inspection = await controller.inspect("codex-router");
  assert.equal(inspection.status, "ready");
  assert.match(calls[0], /_codex-router\/caller_key_/);

  const sync = await controller.syncCodexRouter();
  assert.equal(sync.ok, true);
  assert.deepEqual(sync.args.slice(0, 4), ["router", "integrate", "--apply", "--with-commandcode-proxy"]);

  controller.dispose();

  const reopened = createExternalServicesController({
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  const router = reopened.snapshot().services.find((service) => service.id === "codex-router");
  assert.equal(router.endpoint, "http://127.0.0.1:4202/");
  assert.equal(router.secretConfigured, true);
  assert.equal(Object.hasOwn(router, "callerKey"), false);
  reopened.dispose();
});

test("environment router settings remain compatible and inspection errors redact the caller key", async () => {
  const { createExternalServicesController } = require("../electron/external-services.cjs");
  const root = retainedTestRoot("environment");
  const callerKey = "environment_caller_key_abcdefghijklmnopqrstuvwxyz_0123456789";
  const controller = createExternalServicesController({
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    env: {
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4312",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey,
      CODING_TOOLS_COMMANDCODE_URL: "http://127.0.0.1:9191",
    },
    fetchImpl: async (url) => {
      throw new Error(`connection failed for ${url}`);
    },
  });

  const router = controller.snapshot().services.find((service) => service.id === "codex-router");
  assert.equal(router.secretConfigured, true);
  assert.equal(JSON.stringify(router).includes(callerKey), false);
  assert.deepEqual(controller.runtimeEnvironment(), {
    CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4312",
    CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey,
    CODING_TOOLS_COMMANDCODE_URL: "http://127.0.0.1:9191",
  });

  const inspected = await controller.inspect("codex-router");
  assert.equal(inspected.status, "offline");
  assert.equal(inspected.error.includes(callerKey), false);
  assert.match(inspected.error, /\[REDACTED\]/);
  controller.dispose();
});

test("default Paseo and Anneal launch configuration is explicit on every platform", () => {
  const { createExternalServicesController } = require("../electron/external-services.cjs");
  const root = retainedTestRoot("launch-defaults");
  const controller = createExternalServicesController({
    filePath: path.join(root, "external-services.json"),
    keyPath: path.join(root, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    env: {},
  });
  for (const id of ["paseo", "anneal"]) {
    const service = controller.snapshot().services.find((candidate) => candidate.id === id);
    assert.ok(service.executable);
    assert.ok(service.arguments.length >= 2);
    if (process.platform === "win32") {
      assert.match(path.basename(service.executable).toLowerCase(), /^cmd(?:\.exe)?$/);
      assert.deepEqual(service.arguments.slice(0, 4), ["/d", "/s", "/c", "npm"]);
    } else {
      assert.equal(service.executable, "npm");
      assert.deepEqual(service.arguments.slice(0, 2), ["run", id === "paseo" ? "dev:server" : "dev:web"]);
    }
  }
  controller.dispose();
});

test("BrowserHost, IPC, GUI, Provider Hub, and package-only builder are wired together", () => {
  const providerBootstrap = read("electron/provider-bootstrap.cjs");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  const app = read("src/App.tsx");
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const packageScript = read("scripts/package.cjs");
  const runtimeSupervisor = read("electron/runtime-supervisor.cjs");

  assert.match(providerBootstrap, /setProviderBrowserHost/);
  assert.match(main, /setProviderBrowserHost\(\(\) => browserHost\)/);
  assert.match(main, /createExternalServicesController/);
  assert.match(main, /getRuntimeEnvironment:\s*\(\)\s*=>\s*externalServicesController\.runtimeEnvironment\(\)/);
  assert.match(main, /launcher:external-services-snapshot/);
  assert.match(main, /launcher:external-service-configure/);
  assert.match(main, /launcher:codex-router-sync/);
  assert.match(runtimeSupervisor, /getRuntimeEnvironment/);
  assert.match(runtimeSupervisor, /const suppliedRuntimeEnvironment = this\.getRuntimeEnvironment\(\)/);
  assert.match(runtimeSupervisor, /\.\.\.runtimeEnvironment/);
  assert.match(preload, /externalServicesSnapshot/);
  assert.match(preload, /configureExternalService/);
  assert.match(preload, /syncCodexRouter/);
  assert.match(types, /export interface ExternalServiceSnapshot/);
  assert.match(types, /externalServicesSnapshot\(\)/);
  assert.match(app, /surface === "integrations"/);
  assert.match(app, /<ExternalServicesSurface/);
  assert.match(surface, /CPA Provider Hub/);
  assert.match(surface, /Codex Router/);
  assert.match(surface, /CommandCode Proxy/);
  assert.match(surface, /Paseo/);
  assert.match(surface, /Anneal/);
  assert.match(surface, /供應商中心/);
  assert.match(surface, /外部服務/);
  assert.match(packageScript, /--publish["',\s]+never/);
});
