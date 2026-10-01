"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  assertSafeManifest,
  copyBundledTree,
  createManagedComponentController,
} = require("../electron/managed-components.cjs");
const { createManagedExternalServicesController } = require("../electron/managed-external-services.cjs");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

const COMPONENT_IDS = ["cpa"];

function temporaryDirectory(name) {
  const scratchRoot = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configureTestProxy(dataRoot) {
  const directory = path.join(path.dirname(dataRoot), "providers");
  const store = createProviderNetworkStore({
    filePath: path.join(directory, "provider-network.json"),
    keyPath: path.join(directory, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  store.saveProxyProfile({
    id: "test", name: "Test proxy", enabled: true,
    endpoint: { protocol: "http", host: "proxy.example.test", port: 8080 },
    scopes: ["all"],
  });
  store.setGlobalRouting({ enabled: true, profileId: "test" });
}

function releaseManifest(id, payload) {
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  return {
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
        },
      ],
    },
    health: {
      endpoint: `http://127.0.0.1:${id === "cpa" ? 8317 : id === "paseo" ? 6768 : 5173}/`,
      acceptStatus: [200],
    },
  };
}

function manifestFixture(payload) {
  const manifestRoot = temporaryDirectory("coding-tools-managed-manifests");
  for (const id of COMPONENT_IDS) writeJson(path.join(manifestRoot, `${id}.json`), releaseManifest(id, payload));
  return manifestRoot;
}

function mockChild(pid = 8100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.signalCode = signal;
      child.emit("exit", 0, signal);
    });
    return true;
  };
  return child;
}

function controllerFixture({ fetchImpl, allowNetworkInstall = true, ...overrides } = {}) {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const dataRoot = temporaryDirectory("coding-tools-managed-data");
  const children = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: fetchImpl ?? (async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    })),
    spawnProcess: () => {
      const child = mockChild(8100 + children.length);
      children.push(child);
      return child;
    },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
    resolveRuntimeExecutable: () => process.execPath,
    now: (() => {
      let tick = 0;
      return () => `2026-09-18T03:00:${String(tick++).padStart(2, "0")}.000Z`;
    })(),
    ...overrides,
  });
  return { controller, dataRoot, payload, children };
}

test("CPA remains launchable as the sole managed component", async () => {
  const { controller, children } = controllerFixture();
  try {
    const started = await controller.startComponent("cpa");
    assert.equal(started.installState, "installed");
    assert.equal(children.length, 1);
    assert.deepEqual(controller.snapshot().components.map((component) => component.id), ["cpa"]);
  } finally {
    controller.dispose();
  }
});

test("retired Paseo marker and state remain untouched by the CPA manager", async () => {
  const { controller, dataRoot, children } = controllerFixture();
  const stateFile = path.join(dataRoot, "state", "paseo", "keep.txt");
  const markerPath = path.join(dataRoot, "components", "paseo", "1.0.0", ".coding-tools-managed-component.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "retained");
  writeJson(markerPath, { schemaVersion: 1, id: "paseo", version: "1.0.0", patchRevision: "old-patch" });
  const marker = fs.readFileSync(markerPath, "utf8");
  try {
    assert.throws(() => controller.project("paseo"), /Unknown managed component/);
    await assert.rejects(() => controller.repairComponent("paseo"), /Unknown managed component/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), "retained");
    assert.equal(fs.readFileSync(markerPath, "utf8"), marker);
    assert.deepEqual(children, []);
  } finally {
    controller.dispose();
  }
});

test("CPA runtime exit preserves installed bytes while missing files and invalid markers repair", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  let downloads = 0;
  const { controller, dataRoot, children } = controllerFixture({
    fetchImpl: async () => {
      downloads += 1;
      return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    },
  });
  try {
    const first = await controller.startComponent("cpa");
    const artifact = path.join(first.managedHome, "cpa.bin");
    const markerPath = path.join(first.managedHome, ".coding-tools-managed-component.json");
    const dependency = path.join(first.managedHome, ".venv", "retained-dependency.txt");
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "retained");
    const marker = fs.readFileSync(markerPath, "utf8");

    children[0].exitCode = 7;
    children[0].emit("exit", 7, null);
    assert.equal(controller.project("cpa").installState, "installed");
    assert.match(controller.project("cpa").error, /service exited \(7\)/);
    const restarted = await controller.startComponent("cpa");
    assert.equal(restarted.installedAt, first.installedAt);
    assert.deepEqual(fs.readFileSync(artifact), payload);
    assert.equal(fs.readFileSync(markerPath, "utf8"), marker);
    assert.equal(fs.readFileSync(dependency, "utf8"), "retained");
    assert.equal(downloads, 1);
    assert.equal(children.length, 2);

    await controller.stopComponent("cpa");
    const missingArtifact = path.join(dataRoot, "Trash", "missing-cpa.bin");
    fs.mkdirSync(path.dirname(missingArtifact), { recursive: true });
    fs.renameSync(artifact, missingArtifact);
    assert.equal(controller.project("cpa").installState, "repair-required");
    await controller.startComponent("cpa");
    assert.deepEqual(fs.readFileSync(artifact), payload);
    assert.equal(downloads, 2);

    await controller.stopComponent("cpa");
    writeJson(markerPath, { schemaVersion: 1, id: "wrong-component" });
    assert.equal(controller.project("cpa").installState, "repair-required");
    await controller.startComponent("cpa");
    assert.equal(controller.project("cpa").installState, "installed");
    assert.deepEqual(fs.readFileSync(artifact), payload);
    assert.equal(downloads, 3);
  } finally {
    controller.dispose();
  }
});

test("CPA peer environment reentry through runtimeConfiguration does not overflow", async () => {
  let controller;
  let entries = 0;
  const fixture = controllerFixture({
    peerEnvironment: (manifest) => {
      entries += 1;
      if (entries > 40) throw new Error("Maximum call stack size exceeded");
      assert.ok(controller.runtimeConfiguration(manifest.id));
      return { CODING_TOOLS_PEER_MARK: "1" };
    },
  });
  controller = fixture.controller;
  try {
    await controller.installComponent("cpa");
    const configuration = controller.runtimeConfiguration("cpa");
    assert.ok(configuration.home.includes("cpa"));
    assert.ok(entries >= 1 && entries < 40);
  } finally {
    controller.dispose();
  }
});

test("CPA managed keys are encrypted and absent from projected snapshots", async () => {
  const { controller, dataRoot } = controllerFixture();
  try {
    await controller.installComponent("cpa");
    const { proxyApiKey, managementKey } = controller.runtimeSecrets("cpa");
    assert.ok(proxyApiKey);
    assert.ok(managementKey);
    const projected = JSON.stringify(controller.snapshot());
    const persisted = fs.readFileSync(path.join(dataRoot, "managed-components.secrets.json"), "utf8");
    assert.equal(controller.project("cpa").secretConfigured, true);
    for (const key of [proxyApiKey, managementKey]) {
      assert.equal(projected.includes(key), false);
      assert.equal(persisted.includes(key), false);
    }
    assert.equal(persisted.includes("proxyApiKey"), false);
    assert.equal(persisted.includes("managementKey"), false);
    assert.equal(JSON.parse(persisted).components.cpa.scheme, "aes-256-gcm-v1");
  } finally {
    controller.dispose();
  }
});

test("CPA inspection errors redact managed keys from projected status", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const manifest = releaseManifest("cpa", payload);
  manifest.credentials = { proxyApiKey: {}, managementKey: {} };
  writeJson(path.join(manifestRoot, "cpa.json"), manifest);
  const bundleRoot = temporaryDirectory("coding-tools-cpa-redaction-bundle");
  fs.mkdirSync(path.join(bundleRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "cpa", "cpa.bin"), payload);
  const dataRoot = path.join(temporaryDirectory("coding-tools-cpa-redaction"), "integrations");
  configureTestProxy(dataRoot);
  const keys = { proxyApiKey: "CPA+proxy/fixture?key", managementKey: "CPA+management/fixture?key" };
  let failInspection = false;
  const controller = createManagedExternalServicesController({
    manifestRoot, bundleRoot, dataRoot,
    filePath: path.join(dataRoot, "external-services.json"),
    keyPath: path.join(dataRoot, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    resolveRuntimeExecutable: () => process.execPath,
    fetchImpl: async (url) => {
      if (String(url).includes("/v1/models")) {
        if (failInspection) throw new Error(`inspection failed with ${Object.values(keys).flatMap((key) => [key, encodeURIComponent(key)]).join(" ")}`);
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    },
    spawnProcess: () => mockChild(9700),
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  try {
    for (const [name, value] of Object.entries(keys)) controller.setManagedComponentCredential("cpa", name, value);
    await controller.start("cpa");
    const request = controller.loopbackRequest("cpa");
    assert.equal(request.headers.Authorization, `Bearer ${keys.proxyApiKey}`);
    assert.equal(request.managementHeaders["X-Management-Key"], keys.managementKey);
    failInspection = true;
    const inspected = await controller.inspect("cpa");
    assert.equal(inspected.error, "inspection failed with [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
    for (const projected of [inspected, controller.snapshot()]) {
      const text = JSON.stringify(projected);
      for (const value of Object.values(keys)) {
        assert.equal(text.includes(value), false);
        assert.equal(text.includes(encodeURIComponent(value)), false);
      }
    }
    failInspection = false;
    const healthy = await controller.inspect("cpa");
    assert.equal(healthy.error, null);
    assert.equal(healthy.status, "ready");
  } finally {
    controller.dispose();
  }
});

test("CPA managed component snapshot redacts a secret-bearing process error", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const manifest = releaseManifest("cpa", payload);
  manifest.credentials = { proxyApiKey: {}, managementKey: {} };
  writeJson(path.join(manifestRoot, "cpa.json"), manifest);
  const bundleRoot = temporaryDirectory("coding-tools-cpa-managed-error-bundle");
  fs.mkdirSync(path.join(bundleRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "cpa", "cpa.bin"), payload);
  const dataRoot = path.join(temporaryDirectory("coding-tools-cpa-managed-error"), "integrations");
  configureTestProxy(dataRoot);
  const keys = { proxyApiKey: "CPA+proxy/fixture?key", managementKey: "CPA+management/fixture?key" };
  let child;
  const controller = createManagedExternalServicesController({
    manifestRoot, bundleRoot, dataRoot,
    filePath: path.join(dataRoot, "external-services.json"),
    keyPath: path.join(dataRoot, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    resolveRuntimeExecutable: () => process.execPath,
    fetchImpl: async (url) => String(url).includes("/v1/models")
      ? new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } }),
    spawnProcess: () => { child = mockChild(9701); return child; },
    terminateProcessTree: (owned, signal = "SIGTERM") => owned.kill(signal),
  });
  try {
    for (const [name, value] of Object.entries(keys)) controller.setManagedComponentCredential("cpa", name, value);
    await controller.start("cpa");
    child.emit("error", new Error(`spawn failed with ${Object.values(keys).flatMap((key) => [key, encodeURIComponent(key)]).join(" ")}`));
    const component = controller.managedComponentsSnapshot().components[0];
    assert.equal(component.error, "service: spawn failed with [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
    const service = controller.snapshot().services.find((entry) => entry.id === "cpa");
    assert.equal(service.managedInstall.error, component.error);
    for (const projected of [controller.managedComponentsSnapshot(), service]) {
      const text = JSON.stringify(projected);
      for (const value of Object.values(keys)) {
        assert.equal(text.includes(value), false);
        assert.equal(text.includes(encodeURIComponent(value)), false);
      }
    }
  } finally {
    controller.dispose();
  }
});

test("manifest validation rejects remote listeners, unpinned sources, path escape and destructive commands", () => {
  const payload = Buffer.from("fixture");
  const baseline = releaseManifest("cpa", payload);

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      health: { ...baseline.health, endpoint: "https://example.com/" },
    }, "cpa"),
    /loopback/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      strategy: "git-source",
      repositoryUrl: "https://github.com/fixture/repository.git",
      commit: "main",
    }, "cpa"),
    /commit must be pinned/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      install: { steps: [{ id: "escape", kind: "assert-file", path: "../secret" }] },
    }, "cpa"),
    /escapes the component root/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      install: {
        steps: [{ id: "destructive", kind: "command", executable: "rm", arguments: ["-rf", "."] }],
      },
    }, "cpa"),
    /destructive executable/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      install: {
        steps: [{ id: "shell-delete", kind: "command", executable: "bash", arguments: ["-lc", "rm -rf ."] }],
      },
    }, "cpa"),
    /destructive shell command/i,
  );
});

test("release installation verifies bytes, activates atomically and reports the pinned install", async () => {
  const { controller, payload } = controllerFixture();
  const installed = await controller.installComponent("cpa");

  assert.equal(installed.installState, "installed");
  assert.equal(installed.version, "1.0.0");
  assert.ok(installed.installedAt);
  const artifact = path.join(installed.managedHome, "cpa.bin");
  assert.deepEqual(fs.readFileSync(artifact), payload);
  const marker = JSON.parse(fs.readFileSync(path.join(installed.managedHome, ".coding-tools-managed-component.json"), "utf8"));
  assert.equal(marker.id, "cpa");
  assert.equal(marker.version, "1.0.0");
  assert.equal(marker.artifact, "cpa.bin");
  controller.dispose();
});

test("release download retries a transient upstream HTTP failure before activating", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  let attempts = 0;
  const { controller } = controllerFixture({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("temporary upstream failure", { status: 500 });
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    },
  });

  const installed = await controller.installComponent("cpa");
  assert.equal(installed.installState, "installed");
  assert.equal(attempts, 2);
  controller.dispose();
});

test("repair preserves the previous installation under Trash instead of deleting it", async () => {
  const { controller, dataRoot } = controllerFixture();
  const first = await controller.installComponent("cpa");
  fs.writeFileSync(path.join(first.managedHome, "user-retained.txt"), "retain me", "utf8");

  const repaired = await controller.repairComponent("cpa");
  assert.equal(repaired.installState, "installed");
  assert.equal(fs.existsSync(path.join(repaired.managedHome, "user-retained.txt")), false);

  const trashRoot = path.join(dataRoot, "Trash", "managed-components", "cpa");
  const retainedDirectories = fs.readdirSync(trashRoot);
  assert.equal(retainedDirectories.length, 1);
  const retainedRoot = path.join(trashRoot, retainedDirectories[0]);
  assert.equal(fs.readFileSync(path.join(retainedRoot, "user-retained.txt"), "utf8"), "retain me");
  assert.ok(fs.existsSync(path.join(retainedRoot, "CODING_TOOLS_TRASH_RECORD.json")));
  controller.dispose();
});

test("managed foreground lifecycle reports running process and stops it with bounded termination", async () => {
  const { controller, children } = controllerFixture();
  await controller.installComponent("cpa");
  const started = await controller.startComponent("cpa");
  assert.equal(started.processes.length, 1);
  assert.equal(started.processes[0].running, true);
  assert.equal(children.length, 1);

  const stopped = await controller.stopComponent("cpa");
  assert.equal(children[0].killed, true);
  assert.equal(stopped.processes.length, 0);
  controller.dispose();
});

function bundledSourceManifest(id) {
  const entry = "package.json";
  const port = id === "cpa" ? 8317 : id === "paseo" ? 6768 : 5173;
  return {
    schemaVersion: 1,
    id,
    name: id,
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: `fixture/${id}`,
    repositoryUrl: `https://github.com/fixture/${id}.git`,
    commit: "a".repeat(40),
    version: "1.0.0",
    strategy: "bundled-source",
    bundle: { required: true, entrypoint: entry },
    install: {
      steps: [
        { id: "unpack-bundled-source", kind: "unpack-bundle" },
        { id: "verify-entrypoint", kind: "assert-file", path: entry },
        { id: "activate", kind: "activate" },
      ],
    },
    launch: {
      processes: [
        {
          id: "service",
          mode: "foreground",
          executable: "{runtime}",
          arguments: [`{home}/${entry}`],
        },
      ],
    },
    health: {
      endpoint: `http://127.0.0.1:${port}/`,
      acceptStatus: [200],
    },
  };
}

test("managed service start refuses installed Paseo before spawning", async () => {
  const manifestRoot = temporaryDirectory("coding-tools-retired-paseo-manifests");
  const dataRoot = path.join(temporaryDirectory("coding-tools-retired-paseo-data"), "integrations");
  configureTestProxy(dataRoot);
  for (const id of COMPONENT_IDS) writeJson(path.join(manifestRoot, `${id}.json`), bundledSourceManifest(id));
  const manifest = bundledSourceManifest("paseo");
  const home = path.join(dataRoot, "components", "paseo", manifest.version);
  writeJson(path.join(home, "package.json"), { name: "paseo-fixture" });
  writeJson(path.join(home, ".coding-tools-managed-component.json"), {
    schemaVersion: 1, id: manifest.id, version: manifest.version,
    strategy: manifest.strategy, repository: manifest.repository, commit: manifest.commit,
    installedAt: new Date().toISOString(),
  });
  const spawned = [];
  const controller = createManagedExternalServicesController({
    manifestRoot, dataRoot,
    filePath: path.join(dataRoot, "external-services.json"),
    keyPath: path.join(dataRoot, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    resolveRuntimeExecutable: () => process.execPath,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "text/plain" } }),
    spawnProcess: () => { spawned.push("paseo"); return mockChild(); },
  });
  try {
    for (const id of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
      for (const operation of ["start", "restart", "installManagedComponent", "repairManagedComponent"]) {
        await assert.rejects(() => controller[operation](id), /retired/i);
      }
    }
    assert.deepEqual(spawned, []);
  } finally {
    controller.dispose();
  }
});

test("retired Anneal cannot stage WSL dependencies or accept credentials", async () => {
  const spawned = [];
  const { controller, dataRoot } = controllerFixture({
    platform: "win32",
    spawnSyncProcess: () => { spawned.push("wsl"); throw new Error("WSL must not run"); },
    spawnProcess: () => { spawned.push("child"); throw new Error("Anneal must not spawn"); },
  });
  const stateFile = path.join(dataRoot, "state", "anneal", "run.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "retired-state");
  try {
    assert.throws(() => controller.setComponentCredential("anneal", "githubReadToken", "fixture-token"), /Unknown managed component/);
    await assert.rejects(() => controller.installComponent("anneal"), /Unknown managed component/);
    await assert.rejects(() => controller.startComponent("anneal"), /Unknown managed component/);
    assert.deepEqual(spawned, []);
    assert.equal(fs.readFileSync(stateFile, "utf8"), "retired-state");
  } finally {
    controller.dispose();
  }
});

test("in-app bundled copy can omit Windows dependencies for WSL staging", () => {
  const source = temporaryDirectory("coding-tools-anneal-in-app-source");
  const destination = temporaryDirectory("coding-tools-anneal-in-app-destination");
  writeJson(path.join(source, "package.json"), { name: "anneal-fixture" });
  fs.mkdirSync(path.join(source, "node_modules", "win32-only"), { recursive: true });
  fs.writeFileSync(path.join(source, "node_modules", "win32-only", "index.js"), "windows");
  copyBundledTree(source, destination, { skipNodeModules: true });
  assert.equal(fs.existsSync(path.join(destination, "package.json")), true);
  assert.equal(fs.existsSync(path.join(destination, "node_modules")), false);
});

test("release-binary copies a bundled archive instead of downloading it", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const bundleRoot = temporaryDirectory("coding-tools-cpa-bundle");
  const dataRoot = temporaryDirectory("coding-tools-cpa-data");
  fs.mkdirSync(path.join(bundleRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "cpa", "cpa.bin"), payload);
  writeJson(path.join(bundleRoot, "MANIFEST.json"), { schemaVersion: 1 });
  let fetched = 0;
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    bundleRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("network fetch must not run when the CPA archive is bundled");
    },
    spawnProcess: () => mockChild(9200),
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });

  const installed = await controller.installComponent("cpa");
  assert.equal(installed.installState, "installed");
  assert.equal(fetched, 0);
  assert.deepEqual(fs.readFileSync(path.join(installed.managedHome, "cpa.bin")), payload);
  controller.dispose();
});

test("Start fails closed when the bundled CPA archive is missing from app resources", async () => {
  const { controller } = controllerFixture({ allowNetworkInstall: false });
  await assert.rejects(
    () => controller.installComponent("cpa"),
    /bundled inside Coding Tools Desktop|missing from this build/i,
  );
  controller.dispose();
});

test("CPA bundled-source Start fails closed when app resources are missing", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = temporaryDirectory("coding-tools-missing-bundle-manifests");
  const dataRoot = temporaryDirectory("coding-tools-missing-bundle-data");
  writeJson(path.join(manifestRoot, "cpa.json"), bundledSourceManifest("cpa"));
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: false,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => {
      throw new Error("network fetch must not run when the bundled runtime is missing");
    },
    spawnProcess: () => assert.fail("missing CPA bundle must not spawn"),
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  await assert.rejects(
    () => controller.startComponent("cpa"),
    /bundled runtime is missing|bundled inside Coding Tools Desktop/i,
  );
  controller.dispose();
});

test("Windows managed cleanup terminates owned trees and retains failed handles", { skip: process.platform !== "win32" }, async () => {
  const terminated = [];
  let blocked = false;
  const { controller, children } = controllerFixture({
    terminateProcessTree: (child) => {
      if (blocked) throw new Error("tree termination refused");
      terminated.push(child);
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
    },
  });
  await controller.startComponent("cpa");
  children[0].kill = () => assert.fail("Windows cleanup must not kill only the adapter");
  await controller.stopComponent("cpa");
  assert.deepEqual(terminated, [children[0]]);
  assert.equal(controller.project("cpa").installState, "installed");

  await controller.startComponent("cpa");
  blocked = true;
  await assert.rejects(controller.stopComponent("cpa"), /tree termination refused/);
  assert.equal(controller.project("cpa").processes[0].running, true);
  assert.throws(() => controller.dispose(), /tree termination refused/);
  assert.equal(controller.project("cpa").processes[0].running, true);
  blocked = false;
  controller.dispose();
  assert.deepEqual(terminated, children);
  assert.deepEqual(controller.project("cpa").processes, []);
});

test("managed start cannot spawn after disposal while installation is in flight", async () => {
  let finishDownload;
  const download = new Promise((resolve) => { finishDownload = resolve; });
  const { controller, payload, children } = controllerFixture({ fetchImpl: () => download });
  const pending = controller.startComponent("cpa");
  controller.dispose();
  finishDownload(new Response(payload, { status: 200 }));
  await assert.rejects(pending, /disposed/);
  assert.deepEqual(children, []);
  await assert.rejects(controller.startComponent("cpa"), /disposed/);
});

test("Windows disposal owns an in-flight managed preparation command", { skip: process.platform !== "win32" }, async () => {
  const payload = Buffer.from("managed-preparation-fixture");
  const manifestRoot = manifestFixture(payload);
  const manifest = releaseManifest("cpa", payload);
  manifest.install.steps.push({ id: "prepare", kind: "command", executable: "{runtime}", arguments: [] });
  writeJson(path.join(manifestRoot, "cpa.json"), manifest);
  const child = mockChild(8300);
  let prepared;
  const spawned = new Promise((resolve) => { prepared = resolve; });
  const terminated = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot: temporaryDirectory("coding-tools-preparation-dispose"),
    allowNetworkInstall: true,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, { status: 200 }),
    spawnProcess: () => { prepared(); return child; },
    terminateProcessTree: (owned, signal) => { terminated.push(owned); owned.kill(signal); },
  });
  const pending = controller.startComponent("cpa");
  await spawned;
  controller.dispose();
  assert.deepEqual(terminated, [child]);
  await assert.rejects(pending, /disposed/);
  assert.deepEqual(controller.project("cpa").processes, []);
});

test("a persistent CPA runs detached, survives a keep-running dispose, and is adopted by the next launcher", async (t) => {
  const { spawn } = require("node:child_process");
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => survivor.kill());
  const spawnOptions = [];
  const first = controllerFixture({
    persistentComponents: ["cpa"],
    healthProbe: async () => true,
    spawnProcess: (_executable, _args, options) => {
      spawnOptions.push(options);
      const child = mockChild(survivor.pid);
      child.unref = () => {};
      return child;
    },
  });
  await first.controller.startComponent("cpa");
  assert.equal(spawnOptions.length, 1);
  assert.equal(spawnOptions[0].detached, true);
  assert.equal(typeof spawnOptions[0].stdio[1], "number", "output goes to a log file, not a pipe");
  const recordPath = path.join(first.dataRoot, "state", "cpa.process.json");
  assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).pid, survivor.pid);

  first.controller.dispose({ keepPersistent: true });
  assert.equal(survivor.exitCode, null, "keep-running dispose must not stop CPA");
  assert.equal(fs.existsSync(recordPath), true);

  let spawnedAgain = 0;
  const { controller: second } = controllerFixture({
    dataRoot: first.dataRoot,
    persistentComponents: ["cpa"],
    healthProbe: async () => true,
    spawnProcess: () => { spawnedAgain += 1; return mockChild(9999); },
  });
  t.after(() => second.dispose({ keepPersistent: true }));
  await second.startComponent("cpa");
  assert.equal(spawnedAgain, 0, "a healthy CPA of the same version is adopted, not restarted");
  assert.equal(survivor.exitCode, null);
});

test("a persistent CPA from an older version is stopped and replaced instead of adopted", async (t) => {
  const { spawn } = require("node:child_process");
  const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (stale.exitCode === null) stale.kill(); });
  let spawned = 0;
  const { controller, dataRoot } = controllerFixture({
    persistentComponents: ["cpa"],
    healthProbe: async () => true,
    spawnProcess: () => { spawned += 1; const child = mockChild(9100); child.unref = () => {}; return child; },
  });
  t.after(() => controller.dispose());
  writeJson(path.join(dataRoot, "state", "cpa.process.json"), { pid: stale.pid, version: "0.9.0", startedAt: "2026-09-01T00:00:00.000Z" });
  await controller.startComponent("cpa");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.notEqual(stale.exitCode === null && stale.signalCode === null, true, "the old CPA is stopped");
  assert.equal(spawned, 1, "the current version is started");
});
