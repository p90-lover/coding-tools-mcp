"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  createExternalServicesController,
  normalizeLoopbackExecutionEndpoint,
  normalizeLoopbackServiceEndpoint,
} = require("../electron/external-services.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-external-services-"));
}

function mockChild(pid = 4100) {
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

function controllerFixture(overrides = {}) {
  const directory = temporaryDirectory();
  const calls = [];
  const child = mockChild();
  const controller = createExternalServicesController({
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      clone: () => ({ json: async () => ({ data: [{ id: "model-a" }] }) }),
      url,
    }),
    spawnProcess: (executable, args, options) => {
      calls.push({ executable, args, options });
      return child;
    },
    runRuntimeCommand: async (args) => ({ stdout: args.join(" "), stderr: "" }),
    getProviderSnapshot: () => ({
      accounts: [
        {
          id: "cc-main",
          providerId: "commandcode-proxy",
          status: "connected",
          enabled: true,
          models: ["claude-sonnet"],
        },
      ],
    }),
    ...overrides,
  });
  return { controller, calls, child, directory };
}

test("external service controller owns the five app-managed services and rejects remote endpoints", () => {
  const { controller } = controllerFixture();
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.services.map((service) => service.id), [
    "codex-router",
    "commandcode-proxy",
    "cpa",
    "paseo",
    "anneal",
  ]);
  assert.throws(() => normalizeLoopbackServiceEndpoint("https://example.com/service"), /loopback/i);
  assert.equal(normalizeLoopbackServiceEndpoint("http://localhost:9090"), "http://localhost:9090/");
  assert.equal(
    normalizeLoopbackExecutionEndpoint("ws://127.0.0.1:6767/ws", "paseo"),
    "ws://127.0.0.1:6767/ws",
  );
  assert.equal(
    normalizeLoopbackExecutionEndpoint("http://127.0.0.1:3000", "anneal"),
    "http://127.0.0.1:3000/",
  );
  assert.throws(
    () => normalizeLoopbackExecutionEndpoint("http://127.0.0.1:6767/ws", "paseo"),
    /WebSocket/i,
  );
  controller.dispose();
});

test("external service settings persist while caller keys stay out of snapshots", () => {
  const { controller, directory } = controllerFixture();
  controller.configure("codex-router", {
    endpoint: "http://127.0.0.1:4202",
    callerKey: "A1234567890123456789012345678901",
    routerCli: "router-cli",
    curateCli: "curate-cli",
  });
  const projected = controller.snapshot().services.find((service) => service.id === "codex-router");
  assert.equal(projected.secretConfigured, true);
  assert.equal(projected.routerCli, "router-cli");
  assert.equal(JSON.stringify(projected).includes("A1234567890123456789012345678901"), false);
  const persisted = fs.readFileSync(path.join(directory, "external-services.json"), "utf8");
  assert.equal(persisted.includes("A1234567890123456789012345678901"), false);
  controller.dispose();
});

test("environment router settings remain compatible and inspection errors redact the caller key", async () => {
  const key = "B1234567890123456789012345678901";
  const { controller } = controllerFixture({
    env: {
      ...process.env,
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: key,
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202",
    },
    fetchImpl: async (url) => {
      throw new Error(`connect failed for ${url}`);
    },
  });
  const initial = controller.snapshot().services.find((service) => service.id === "codex-router");
  assert.equal(initial.secretConfigured, true);
  assert.equal(JSON.stringify(initial).includes(key), false);
  const inspected = await controller.inspect("codex-router");
  assert.equal(inspected.error.includes(key), false);
  assert.match(inspected.error, /\[REDACTED\]/);
  controller.dispose();
});

test("default Paseo and Anneal launch configuration is explicit on every platform", () => {
  const { controller } = controllerFixture();
  for (const id of ["paseo", "anneal"]) {
    const service = controller.snapshot().services.find((candidate) => candidate.id === id);
    assert.ok(service.executable, `${id} default executable must be explicit`);
    assert.ok(service.arguments.length > 0, `${id} default arguments must be explicit`);
    if (process.platform === "win32") {
      assert.equal(path.basename(service.executable).toLowerCase(), "cmd.exe");
      assert.deepEqual(service.arguments.slice(0, 4), ["/d", "/s", "/c", "npm"]);
      assert.deepEqual(service.arguments.slice(4, 6), ["run", id === "paseo" ? "dev:server" : "dev:web"]);
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
  const managedServices = read("electron/managed-external-services.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  const app = read("src/App.tsx");
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const packageScript = read("scripts/package.cjs");
  const runtimeSupervisor = read("electron/runtime-supervisor.cjs");

  assert.match(providerBootstrap, /setProviderBrowserHost/);
  assert.match(main, /setProviderBrowserHost\(\(\) => browserHost\)/);
  assert.match(main, /createManagedExternalServicesController/);
  assert.match(managedServices, /createExternalServicesController/);
  assert.match(managedServices, /createManagedComponentController/);
  assert.match(main, /getRuntimeEnvironment:\s*\(\)\s*=>\s*externalServicesController\.runtimeEnvironment\(\)/);
  assert.match(main, /launcher:external-services-snapshot/);
  assert.match(main, /launcher:managed-components-snapshot/);
  assert.match(main, /launcher:managed-component-install/);
  assert.match(main, /launcher:managed-component-repair/);
  assert.match(main, /launcher:external-service-configure/);
  assert.match(main, /launcher:codex-router-sync/);
  assert.match(runtimeSupervisor, /getRuntimeEnvironment/);
  assert.match(runtimeSupervisor, /const suppliedRuntimeEnvironment = this\.getRuntimeEnvironment\(\)/);
  assert.match(runtimeSupervisor, /\.\.\.runtimeEnvironment/);
  assert.match(preload, /externalServicesSnapshot/);
  assert.match(preload, /managedComponentsSnapshot/);
  assert.match(preload, /installManagedComponent/);
  assert.match(preload, /repairManagedComponent/);
  assert.match(preload, /configureExternalService/);
  assert.match(preload, /syncCodexRouter/);
  assert.match(types, /export interface ExternalServiceSnapshot/);
  assert.match(types, /export type ManagedComponentInstallState/);
  assert.match(types, /externalServicesSnapshot\(\)/);
  assert.match(types, /installManagedComponent\(serviceId: ExternalServiceId\)/);
  assert.match(app, /surface === "integrations"/);
  assert.match(app, /<ExternalServicesSurface/);
  assert.match(surface, /CPA \/ CLIProxyAPI/);
  assert.match(surface, /Codex Router/);
  assert.match(surface, /CommandCode Proxy/);
  assert.match(surface, /Paseo/);
  assert.match(surface, /Anneal/);
  assert.match(surface, /Repair runtime|修復執行環境/);
  assert.match(surface, /Start all|全部啟動/);
  assert.match(surface, /share in-app loopbacks/);
  assert.match(managedServices, /peerEnvironmentFor/);
  assert.match(read("electron/external-services.cjs"), /--with-cpa/);
  assert.match(read("electron/five-stack-cross-use.cjs"), /CODING_TOOLS_CPA_OPENAI_BASE_URL/);
  assert.doesNotMatch(surface, /Prepare bundled runtime/);
  assert.match(surface, /開啟原始介面/);
  assert.match(surface, /外部服務/);
  assert.match(packageScript, /--publish["',\s]+never/);
});
