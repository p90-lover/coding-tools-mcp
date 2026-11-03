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

async function configureTestProxy(dataRoot) {
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
  await store.saved();
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

function controllerFixture({ fetchImpl, allowNetworkInstall = true, createController = createManagedComponentController, ...overrides } = {}) {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const dataRoot = temporaryDirectory("coding-tools-managed-data");
  const children = [];
  const controller = createController({
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
  return { controller, dataRoot, manifestRoot, payload, children };
}

test("a running component's shown state is read once and rechecked off the main thread", async () => {
  const published = [];
  const { controller, dataRoot } = controllerFixture({ sourceRecheckMs: 0, publish: (value) => published.push(value) });
  try {
    const first = await controller.startComponent("cpa");
    const artifact = path.join(first.managedHome, "cpa.bin");
    const statSync = fs.statSync;
    const existsSync = fs.existsSync;
    let reads = 0;
    fs.statSync = (...args) => { reads += 1; return statSync(...args); };
    fs.existsSync = (...args) => { reads += 1; return existsSync(...args); };
    try {
      // Running: the snapshot answers from what was read, and the recheck runs on fs.promises.
      fs.renameSync(artifact, path.join(dataRoot, "moved-cpa.bin"));
      assert.equal(controller.project("cpa").installState, "installed");
      assert.equal(reads, 0, "no synchronous disk call on the main thread");
    } finally {
      fs.statSync = statSync;
      fs.existsSync = existsSync;
    }
    // The recheck finds the missing file and publishes the change.
    for (let tries = 0; tries < 50 && controller.project("cpa").installState !== "repair-required"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(controller.project("cpa").installState, "repair-required");
    assert.equal(published.at(-1).components[0].installState, "repair-required");
  } finally {
    controller.dispose();
  }
});

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
    // Status answers from memory; a read of the disk (here, the background one) shows the loss.
    assert.equal((await controller.refreshInstallState("cpa")).installState, "repair-required");
    await controller.startComponent("cpa");
    assert.deepEqual(fs.readFileSync(artifact), payload);
    assert.equal(downloads, 2);
    assert.equal(controller.project("cpa").installState, "installed");

    await controller.stopComponent("cpa");
    writeJson(markerPath, { schemaVersion: 1, id: "wrong-component" });
    // A start reads the disk itself, so it repairs even while status still remembers "installed".
    assert.equal(controller.project("cpa").installState, "installed");
    await controller.startComponent("cpa");
    assert.equal(controller.project("cpa").installState, "installed");
    assert.deepEqual(fs.readFileSync(artifact), payload);
    assert.equal(downloads, 3);
  } finally {
    controller.dispose();
  }
});

test("status reads no file synchronously once the install state is known", async () => {
  // One existsSync from project() held the main process for 2 s on a busy disk (2026-10-31).
  const { controller } = controllerFixture();
  const syncNames = ["existsSync", "statSync", "lstatSync", "readFileSync", "readdirSync", "accessSync"];
  const originals = Object.fromEntries(syncNames.map((name) => [name, fs[name]]));
  const calls = [];
  try {
    await controller.installComponent("cpa");
    controller.runtimeSecrets("cpa");
    await controller.refreshInstallState("cpa");
    for (const name of syncNames) {
      fs[name] = (...args) => {
        calls.push(`${name} ${args[0]}`);
        throw new Error(`${name} on the status path`);
      };
    }
    assert.equal(controller.project("cpa").installState, "installed");
    assert.equal(controller.snapshot().components[0].installState, "installed");
    assert.ok(controller.runtimeConfiguration("cpa").home.includes("cpa"));
  } finally {
    Object.assign(fs, originals);
    controller.dispose();
  }
  assert.deepEqual(calls, []);
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
  await configureTestProxy(dataRoot);
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
  await configureTestProxy(dataRoot);
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

for (const update of [false, true]) for (const failure of ["none", "mkdir", "request", "prepare", "failure-record"]) {
  test(`managed install bookkeeping: ${update ? "update" : "base"} ${failure}`, async () => {
    const vm = require("node:vm"), ts = require("typescript");
    const sourcePath = require.resolve("../electron/managed-components.cjs");
    const tree = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set(["installComponent", "operationState", "operationKey", "setOperation", "emit"]);
    const bodies = [];
    const visit = node => {
      if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) bodies.push(node.getText(tree));
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(bodies.length, names.size);
    const base = { id: "cpa", name: "fixture CPA", version: "1.0.0", strategy: "release-binary" };
    const manifest = update ? { ...base, version: "2.0.0", updatedFrom: "1.0.0" } : base;
    const key = update ? "cpa:update" : "cpa";
    const activeOperation = { state: "installed", step: null, error: null };
    const operations = new Map(update ? [["cpa", activeOperation]] : []);
    const root = path.join(__dirname, "virtual-managed-install"), aiTempRoot = path.join(root, "aiTemp");
    const original = new Error(`fixture ${failure} failed`), diagnostic = new Error("fixture FAILED record failed");
    let installed = false, injected = false, prepares = 0, published = 0, release, entered;
    const preparation = new Promise(resolve => { release = resolve; });
    const preparing = new Promise(resolve => { entered = resolve; });
    const install = vm.runInNewContext(bodies.join("\n") + "\ninstallComponent", {
      Error, operations, manifests: new Map([["cpa", base]]), path, crypto, aiTempRoot, platform: "win32", arch: "x64",
      requiredComponentId: id => { assert.equal(id, "cpa"); return id; }, manifestFor: () => base,
      refreshSourceState: async () => ({ state: installed ? "installed" : "not-installed" }),
      missingCredentials: () => [], componentState: () => path.join(root, "state"),
      now: () => "fixture-time", timestampSegment: value => value,
      assertWithin: (parent, child) => assert.ok(child.startsWith(parent + path.sep)),
      snapshot: () => ({ components: [] }), publish: () => { published++; throw new Error("fixture observer failed"); },
      fs: {
        existsSync: () => false,
        mkdirSync(directory) {
          if (failure === "mkdir" && directory.startsWith(aiTempRoot) && !injected) { injected = true; throw original; }
        },
        renameSync() { installed = true; },
      },
      writeJson(file) {
        if (failure === "request" && path.basename(file) === "INSTALL_REQUEST.json" && !injected) { injected = true; throw original; }
        if (failure === "failure-record" && path.basename(file) === "FAILED.json") throw diagnostic;
      },
      prepareReleaseBinary: async () => {
        prepares++;
        if (prepares === 1 && ["prepare", "failure-record"].includes(failure)) throw original;
        if (failure === "none") { entered(); await preparation; }
        return { artifact: "" };
      },
      executeInstallSteps: async () => {}, expectedMarker: () => ({}), markerArtifactRelative: () => null,
      markerPath: home => path.join(home, "marker.json"), componentHome: () => path.join(root, manifest.version),
      project: () => ({ state: operations.get(key)?.state }),
    });
    const options = update ? { manifest } : {};
    if (failure === "none") {
      const pending = install("cpa", options);
      await preparing;
      await assert.rejects(install("cpa", options), /already running/);
      release();
      await pending;
      assert.equal(prepares, 1);
    } else {
      await assert.rejects(install("cpa", options), error => error === original, "diagnostics must not replace the original error");
      assert.equal(operations.get(key).state, "error");
      assert.equal(operations.get(key).step, null);
      assert.equal(operations.get(key).error, original.message);
      await install("cpa", options);
    }
    assert.equal(operations.get(key).state, "installed");
    assert.equal(operations.get(key).error, null);
    if (update) assert.equal(operations.get("cpa"), activeOperation, "candidate progress must not replace the active version's operation");
    assert.ok(published > 0, "the actual emit contains observer exceptions");
  });
}

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
  await configureTestProxy(dataRoot);
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

// The worker has not published a PID until finish() runs. Every child and process-tree
// operation is fake, including handles adopted from a previous launcher.
async function managedOwnerFixture(t, { persistent = false, prepare = false, install = true, healthProbe = async () => true, fetchImpl } = {}) {
  const { createRequire, wrap } = require("node:module");
  const vm = require("node:vm");
  const sourcePath = require.resolve("../electron/managed-components.cjs");
  const localRequire = createRequire(sourcePath);
  const alive = new Set();
  const launches = [];
  const killed = [];
  const control = { refuseKill: false, deferExit: false, exits: [] };
  const terminate = (child, signal) => {
    if (control.refuseKill) throw new Error("fake tree cleanup refused");
    killed.push(child.pid);
    child.killed = true;
    alive.delete(child.pid);
    child.release?.();
    const finish = () => {
      child.exitCode = 0;
      child.signalCode = signal;
      child.emit("exit", 0, signal);
    };
    if (control.deferExit) control.exits.push(finish);
    else queueMicrotask(finish);
  };
  const loaded = { exports: {} };
  const polls = new Map();
  const factory = vm.runInThisContext("(function(setInterval, clearInterval) { return "
    + wrap(fs.readFileSync(sourcePath, "utf8")) + "; })", { filename: sourcePath });
  factory((callback) => {
    const timer = { unref() {} };
    polls.set(timer, callback);
    return timer;
  }, (timer) => polls.delete(timer))(
    loaded.exports, (name) => name === "./process-tree.cjs"
      ? { processRunning: (pid) => alive.has(pid), terminateOwnedProcessTree: terminate }
      : name === "node:child_process"
        ? { spawnSync: () => assert.fail("no real process is permitted") }
        : localRequire(name), loaded, sourcePath, path.dirname(sourcePath));
  const fixture = controllerFixture({
    platform: "win32",
    persistentComponents: persistent ? ["cpa"] : [],
    healthProbe,
    fetchImpl,
    createController: (options) => {
      const file = path.join(options.manifestRoot, "cpa.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      manifest.platforms.win32 = manifest.platforms[process.platform];
      if (prepare) manifest.install.steps.splice(2, 0, {
        id: "prepare", kind: "command", executable: "{runtime}", arguments: [],
      });
      manifest.launch.primaryProcessId = "service";
      manifest.launch.adopt = [{ id: "refresh", executable: "{runtime}", arguments: [], timeoutMs: 1000 }];
      writeJson(file, manifest);
      return loaded.exports.createManagedComponentController(options);
    },
    spawnProcess: (_file, _args, options) => new Promise((resolve) => {
      const child = mockChild(9_000_000 + launches.length);
      child.unref = () => {};
      launches.push({ child, options, finish() { alive.add(child.pid); resolve(child); } });
    }),
    terminateProcessTree: terminate,
  });
  t.after(async () => {
    control.refuseKill = false;
    control.deferExit = false;
    for (const finish of control.exits.splice(0)) finish();
    const dispose = () => {
      try { fixture.controller.dispose(); }
      catch (error) { if (!/needs attention/i.test(error.message)) throw error; }
    };
    dispose();
    for (const launch of launches) {
      launch.finish();
      if (launch.child.exitCode === null && launch.child.signalCode === null) terminate(launch.child, "SIGTERM");
    }
    alive.clear();
    for (const callback of [...polls.values()]) callback();
    await new Promise(setImmediate);
    try { await fixture.controller.stopComponent("cpa"); }
    catch (error) { if (!/needs attention/i.test(error.message)) throw error; }
    dispose();
    assert.equal(polls.size, 0, "all fake PID monitors have been released");
    for (const directory of [fixture.dataRoot, fixture.manifestRoot]) {
      assert.equal(path.dirname(directory), path.resolve(__dirname, "..", "..", "aiTemp"));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const installed = install ? await fixture.controller.installComponent("cpa") : null;
  const recordPath = path.join(fixture.dataRoot, "state", "cpa.process.json");
  const seed = (pid) => {
    alive.add(pid);
    const bundle = path.resolve(path.dirname(sourcePath), "..", "vendor", "bundled", "cpa-plugins", "BUNDLE.json");
    writeJson(recordPath, {
      pid, version: "1.0.0",
      dependencyFingerprint: crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex"),
    });
  };
  return { ...fixture, launches, killed, control, alive, installed, recordPath, seed,
    poll: () => { for (const callback of [...polls.values()]) callback(); },
  };
}

async function waitManagedOwner(check) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("fake managed lifecycle did not reach its expected boundary");
}

test("managed owner: autostart and manual Start coalesce before PID publication", async (t) => {
  const f = await managedOwnerFixture(t);
  const first = f.controller.startComponent("cpa");
  const second = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length > 0);
  await new Promise(setImmediate);
  assert.equal(f.launches.length, 1);
  f.launches[0].finish();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].processes[0].pid, results[1].processes[0].pid);
  await f.controller.startComponent("cpa");
  assert.equal(f.launches.length, 1);
});

test("managed owner: Stop cancels an unknown PID without waiting and retires its late child", async (t) => {
  const f = await managedOwnerFixture(t, { persistent: true });
  let rejected;
  const first = f.controller.startComponent("cpa").catch((error) => { rejected = error; });
  await waitManagedOwner(() => f.launches.length === 1);
  await f.controller.stopComponent("cpa");
  assert.match(rejected?.message || "", /canceled by Stop/);
  await assert.rejects(f.controller.startComponent("cpa"), /retiring|stopping/);
  await assert.rejects(f.controller.restartComponent("cpa"), /retiring|stopping/);
  f.launches[0].finish();
  await first;
  await waitManagedOwner(() => f.launches[0].child.killed);
  await f.controller.stopComponent("cpa");
  assert.equal(fs.existsSync(f.recordPath), false);
  assert.deepEqual(f.controller.project("cpa").processes, []);
  const retry = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 2);
  f.launches[1].finish();
  await retry;
  assert.equal(JSON.parse(fs.readFileSync(f.recordPath, "utf8")).pid, f.launches[1].child.pid);
});

test("managed owner: restart cancels a pending Start instead of launching beside it", async (t) => {
  const f = await managedOwnerFixture(t);
  const first = f.controller.startComponent("cpa");
  first.catch(() => {});
  await waitManagedOwner(() => f.launches.length === 1);
  await assert.rejects(f.controller.restartComponent("cpa"), /canceled|retiring|stopping/);
  await assert.rejects(first, /canceled/);
  assert.equal(f.launches.length, 1);
  f.launches[0].finish();
  await waitManagedOwner(() => f.launches[0].child.killed);
});

test("managed owner: concurrent restarts share the complete stop and replacement", async (t) => {
  const f = await managedOwnerFixture(t, { persistent: true });
  const initial = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await initial;
  const first = f.controller.restartComponent("cpa");
  const second = f.controller.restartComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 2);
  await new Promise(setImmediate);
  assert.equal(f.launches.length, 2, "one replacement is admitted");
  f.launches[1].finish();
  await Promise.all([first, second]);
  f.launches[0].child.emit("error", new Error("late retired-worker error"));
  assert.equal(f.controller.project("cpa").error, null);
  assert.equal(JSON.parse(fs.readFileSync(f.recordPath, "utf8")).pid, f.launches[1].child.pid);
});

test("managed owner: Stop during source refresh cannot dispatch a later spawn", async (t) => {
  const f = await managedOwnerFixture(t);
  await f.controller.refreshInstallState("cpa");
  const original = fs.promises.access;
  let release, held = false;
  const gate = new Promise((resolve) => { release = resolve; });
  fs.promises.access = async (file, ...args) => {
    if (!held && file === f.installed.managedHome) { held = true; await gate; }
    return original(file, ...args);
  };
  try {
    const pending = f.controller.startComponent("cpa");
    pending.catch(() => {});
    await waitManagedOwner(() => held);
    await f.controller.stopComponent("cpa");
    await assert.rejects(pending, /canceled/);
    release();
    await f.controller.refreshInstallState("cpa");
    await new Promise(setImmediate);
    assert.equal(f.launches.length, 0);
  } finally {
    release();
    fs.promises.access = original;
  }
});

test("managed owner: Stop retires a preparation command whose PID arrives later", async (t) => {
  const f = await managedOwnerFixture(t, { prepare: true, install: false });
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => f.launches.length === 1);
  await f.controller.stopComponent("cpa");
  await assert.rejects(pending, /canceled/);
  f.launches[0].finish();
  await waitManagedOwner(() => f.launches[0].child.killed);
  assert.equal(f.launches.length, 1, "the foreground service is never dispatched");
});

test("managed owner: failed late cleanup retains a handle and blocks replacement until retry", async (t) => {
  const f = await managedOwnerFixture(t);
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => f.launches.length === 1);
  await f.controller.stopComponent("cpa");
  await assert.rejects(pending, /canceled/);
  f.control.refuseKill = true;
  f.launches[0].finish();
  await waitManagedOwner(() => /fake tree cleanup refused/.test(f.controller.project("cpa").error || ""));
  assert.equal(f.controller.project("cpa").processes[0].pid, f.launches[0].child.pid);
  await assert.rejects(f.controller.startComponent("cpa"), /stopping|retiring/);
  await assert.rejects(f.controller.stopComponent("cpa"), /fake tree cleanup refused/);
  f.control.refuseKill = false;
  await f.controller.stopComponent("cpa");
  assert.deepEqual(f.controller.project("cpa").processes, []);
});

test("managed owner: explicit Stop stays canceled during keep-running disposal", async (t) => {
  const f = await managedOwnerFixture(t, { persistent: true });
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => f.launches.length === 1);
  await f.controller.stopComponent("cpa");
  f.controller.dispose({ keepPersistent: true });
  await assert.rejects(pending, /canceled/);
  f.launches[0].finish();
  await waitManagedOwner(() => f.launches[0].child.killed);
  assert.equal(fs.existsSync(f.recordPath), false);
});

test("managed owner: PID-less errors clean admission and a later Start succeeds", async (t) => {
  const f = await managedOwnerFixture(t);
  const initial = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].child.pid = undefined;
  f.launches[0].finish();
  await initial;
  f.launches[0].child.emit("error", new Error("fake ENOENT"));
  assert.deepEqual(f.controller.project("cpa").processes, []);
  const retry = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 2);
  f.launches[1].finish();
  await retry;
  assert.equal(f.controller.project("cpa").processes[0].pid, f.launches[1].child.pid);
});

test("managed owner: a nonterminal worker error keeps its live child stoppable", async (t) => {
  const f = await managedOwnerFixture(t);
  const pending = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await pending;
  f.launches[0].child.emit("error", new Error("fake worker output lost"));
  assert.equal(f.controller.project("cpa").processes[0].running, true);
  await assert.rejects(f.controller.startComponent("cpa"), /stopping/);
  await f.controller.stopComponent("cpa");
  assert.equal(f.launches[0].child.killed, true);
});

test("managed owner: an unverified saved PID is never killed by Stop or a late failed health reply", async (t) => {
  let release, probed = false;
  const health = new Promise((resolve) => { release = resolve; });
  const f = await managedOwnerFixture(t, { persistent: true, healthProbe: () => { probed = true; return health; } });
  f.seed(9_100_001);
  const original = fs.readFileSync(f.recordPath);
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => probed);
  await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
  await assert.rejects(pending, /canceled/);
  assert.deepEqual(f.killed, []);
  assert.deepEqual(fs.readFileSync(f.recordPath), original);
  release(false);
  await new Promise(setImmediate);
  await assert.rejects(f.controller.startComponent("cpa"), /needs attention/);
  await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
  assert.throws(() => f.controller.dispose({ keepPersistent: true }), /needs attention/);
  assert.deepEqual(f.killed, []);
  assert.deepEqual(fs.readFileSync(f.recordPath), original);
});

test("managed owner: Stop also fences an adopted CPA refresh command", async (t) => {
  const f = await managedOwnerFixture(t, { persistent: true });
  f.seed(9_100_002);
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => f.launches.length === 1);
  await f.controller.stopComponent("cpa");
  await assert.rejects(pending, /canceled/);
  assert.equal(f.alive.has(9_100_002), false);
  f.launches[0].finish();
  await waitManagedOwner(() => f.launches[0].child.killed);
  assert.equal(fs.existsSync(f.recordPath), false);
  assert.equal(f.launches.length, 1);
});

test("managed owner: an idempotent Start preserves the current child's later exit status", async (t) => {
  const f = await managedOwnerFixture(t);
  const initial = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await initial;
  await f.controller.startComponent("cpa");
  const child = f.launches[0].child;
  child.exitCode = 7;
  child.emit("exit", 7, null);
  assert.match(f.controller.project("cpa").error, /service exited \(7\)/);
});

test("managed owner: Stop during download cannot dispatch a later preparation command", async (t) => {
  let release, downloading = false;
  const download = new Promise((resolve) => { release = resolve; });
  const f = await managedOwnerFixture(t, {
    install: false, prepare: true,
    fetchImpl: () => { downloading = true; return download; },
  });
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => downloading);
  await f.controller.stopComponent("cpa");
  await assert.rejects(pending, /canceled/);
  release(new Response(f.payload, { status: 200 }));
  await waitManagedOwner(() => /canceled/.test(f.controller.project("cpa").error || ""));
  assert.equal(f.launches.length, 0);
});

test("managed owner: unverified disposal preserves the record and does not grant PID kill authority", async (t) => {
  for (const keepPersistent of [true, false]) {
    let release, probed = false;
    const health = new Promise((resolve) => { release = resolve; });
    const f = await managedOwnerFixture(t, { persistent: true, healthProbe: () => { probed = true; return health; } });
    f.seed(9_200_000 + Number(keepPersistent));
    const original = fs.readFileSync(f.recordPath);
    const pending = f.controller.startComponent("cpa");
    pending.catch(() => {});
    await waitManagedOwner(() => probed);
    if (keepPersistent) {
      f.controller.dispose({ keepPersistent: true });
      await assert.rejects(pending, /disposed/);
    } else {
      assert.throws(() => f.controller.dispose(), /needs attention/);
      await assert.rejects(pending, /needs attention/);
    }
    release(false);
    await new Promise(setImmediate);
    assert.equal(f.killed.length, 0);
    assert.deepEqual(fs.readFileSync(f.recordPath), original);
    if (!keepPersistent) {
      // A refused dispose did not mark the controller disposed or erase the failed Stop.
      await assert.rejects(f.controller.startComponent("cpa"), /needs attention/);
      assert.throws(() => f.controller.dispose({ keepPersistent: true }), /needs attention/);
    }
  }
});

test("managed owner: explicit Stop owns an in-flight restart's stop-to-start handoff", async (t) => {
  const f = await managedOwnerFixture(t);
  const initial = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await initial;
  f.control.deferExit = true;
  const restarting = f.controller.restartComponent("cpa");
  restarting.catch(() => {});
  await waitManagedOwner(() => f.control.exits.length === 1);
  const stopping = f.controller.stopComponent("cpa");
  for (const finish of f.control.exits.splice(0)) finish();
  await stopping;
  await assert.rejects(restarting, /canceled/);
  f.control.deferExit = false;
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.controller.project("cpa").processes, []);
});

test("managed owner: a known-dead adopted PID cannot finish as installed after health or refresh", async (t) => {
  for (const exitAt of ["health", "refresh", "none"]) {
    let release, probed = false;
    const health = new Promise((resolve) => { release = resolve; });
    const f = await managedOwnerFixture(t, { persistent: true, healthProbe: () => { probed = true; return health; } });
    const pid = 9_300_000 + ["health", "refresh", "none"].indexOf(exitAt);
    f.seed(pid);
    const pending = f.controller.startComponent("cpa");
    pending.catch(() => {});
    await waitManagedOwner(() => probed);
    if (exitAt === "health") { f.alive.delete(pid); f.poll(); }
    release(true);
    if (exitAt !== "health") {
      await waitManagedOwner(() => f.launches.length === 1);
      f.launches[0].finish();
      await waitManagedOwner(() => f.controller.project("cpa").processes.some((entry) => entry.id === "refresh"));
      if (exitAt === "refresh") { f.alive.delete(pid); f.poll(); }
      f.launches[0].child.exitCode = 0;
      f.launches[0].child.emit("exit", 0, null);
    }
    if (exitAt === "none") {
      const result = await pending;
      assert.equal(result.processes[0].pid, pid, "a healthy completed adoption is still accepted");
      assert.equal(result.error, null);
    } else {
      await assert.rejects(pending, /stopped while.*adopt/i);
      assert.equal(f.controller.project("cpa").processes.some((entry) => entry.pid === pid), false);
      assert.match(f.controller.project("cpa").error, /stopped while.*adopt/i);
      assert.equal(fs.existsSync(f.recordPath), false);
      if (exitAt === "health") assert.equal(f.launches.length, 0);
    }
  }
});

test("managed owner: a second Restart coalesces during its admitted known-child stop", async (t) => {
  const f = await managedOwnerFixture(t);
  const initial = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await initial;
  f.control.deferExit = true;
  const first = f.controller.restartComponent("cpa");
  const secondPending = [];
  await waitManagedOwner(() => f.control.exits.length === 1);
  const second = f.controller.restartComponent("cpa");
  second.catch((error) => secondPending.push(error));
  for (const finish of f.control.exits.splice(0)) finish();
  f.control.deferExit = false;
  await waitManagedOwner(() => f.launches.length === 2);
  f.launches[1].finish();
  const result = await Promise.all([first, second]);
  assert.equal(secondPending.length, 0);
  assert.equal(f.launches.length, 2);
  assert.equal(result[0].processes[0].pid, result[1].processes[0].pid);
});

test("managed owner: failed unverified Stop survives stale-version, changed-record and missing-record retries", async (t) => {
  let release, probed = false, healthy = false;
  const health = new Promise((resolve) => { release = resolve; });
  const f = await managedOwnerFixture(t, {
    persistent: true, healthProbe: () => { if (!probed) { probed = true; return health; } return healthy; },
  });
  f.seed(9_400_001);
  const original = fs.readFileSync(f.recordPath);
  const originalRecord = JSON.parse(original);
  const initial = f.controller.startComponent("cpa");
  initial.catch(() => {});
  await waitManagedOwner(() => probed);
  await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
  await assert.rejects(initial, /canceled/);
  release(false);
  await new Promise(setImmediate);
  for (const replacement of [
    { ...originalRecord, version: "0.9.0" },
    { ...originalRecord, dependencyFingerprint: "changed-by-another-owner" },
  ]) {
    writeJson(f.recordPath, replacement);
    const bytes = fs.readFileSync(f.recordPath);
    await assert.rejects(f.controller.startComponent("cpa"), /needs attention/);
    await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
    assert.deepEqual(fs.readFileSync(f.recordPath), bytes);
    assert.deepEqual(f.killed, []);
  }
  fs.rmSync(f.recordPath);
  await assert.rejects(f.controller.startComponent("cpa"), /needs attention/);
  assert.throws(() => f.controller.dispose({ keepPersistent: true }), /needs attention/);
  assert.equal(fs.existsSync(f.recordPath), false);
  assert.deepEqual(f.killed, []);

  // An explicit fresh successful verification, rather than another failed Stop, resolves attention.
  fs.writeFileSync(f.recordPath, original);
  healthy = true;
  const retry = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await waitManagedOwner(() => f.controller.project("cpa").processes.some((entry) => entry.id === "refresh"));
  f.launches[0].child.exitCode = 0;
  f.launches[0].child.emit("exit", 0, null);
  assert.equal((await retry).processes[0].pid, originalRecord.pid);
  await f.controller.stopComponent("cpa");
  assert.deepEqual(f.killed, [originalRecord.pid]);
  assert.equal(fs.existsSync(f.recordPath), false);
  f.controller.dispose({ keepPersistent: true });
});

test("managed owner: a proven-gone candidate permits a fresh known spawned child", async (t) => {
  let release, probed = false;
  const health = new Promise((resolve) => { release = resolve; });
  const f = await managedOwnerFixture(t, { persistent: true, healthProbe: () => { probed = true; return health; } });
  f.seed(9_400_002);
  const initial = f.controller.startComponent("cpa");
  initial.catch(() => {});
  await waitManagedOwner(() => probed);
  await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
  await assert.rejects(initial, /canceled/);
  release(false);
  await new Promise(setImmediate);
  f.alive.delete(9_400_002);
  const retry = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await retry;
  assert.deepEqual(f.killed, []);
  await f.controller.stopComponent("cpa");
  assert.deepEqual(f.killed, [f.launches[0].child.pid]);
});

test("managed owner: record replacement during verification is retained without killing either PID", async (t) => {
  let release, probed = false;
  const health = new Promise((resolve) => { release = resolve; });
  const f = await managedOwnerFixture(t, { persistent: true, healthProbe: () => { probed = true; return health; } });
  f.seed(9_400_003);
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => probed);
  const replacement = { ...JSON.parse(fs.readFileSync(f.recordPath)), pid: 9_500_003, startedAt: "another-owner" };
  f.alive.add(replacement.pid);
  writeJson(f.recordPath, replacement);
  const bytes = fs.readFileSync(f.recordPath);
  release(true);
  await assert.rejects(pending, /needs attention/);
  await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
  assert.throws(() => f.controller.dispose({ keepPersistent: true }), /needs attention/);
  assert.deepEqual(fs.readFileSync(f.recordPath), bytes);
  assert.deepEqual(f.killed, []);
  assert.equal(f.launches.length, 0);
});

test("managed owner: an owned exit cannot erase a same-PID record from another owner", async (t) => {
  const f = await managedOwnerFixture(t, { persistent: true });
  const pending = f.controller.startComponent("cpa");
  await waitManagedOwner(() => f.launches.length === 1);
  f.launches[0].finish();
  await pending;
  writeJson(f.recordPath, { ...JSON.parse(fs.readFileSync(f.recordPath)), startedAt: "another-owner" });
  const bytes = fs.readFileSync(f.recordPath);
  f.launches[0].child.exitCode = 7;
  f.launches[0].child.emit("exit", 7, null);
  assert.deepEqual(fs.readFileSync(f.recordPath), bytes);
  await assert.rejects(f.controller.stopComponent("cpa"), /needs attention/);
  assert.deepEqual(fs.readFileSync(f.recordPath), bytes);
});

test("managed owner: a record written during worker start cannot be overwritten by the late PID", async (t) => {
  const f = await managedOwnerFixture(t, { persistent: true, healthProbe: async () => false });
  const pending = f.controller.startComponent("cpa");
  pending.catch(() => {});
  await waitManagedOwner(() => f.launches.length === 1);
  f.seed(9_500_004);
  const bytes = fs.readFileSync(f.recordPath);
  f.launches[0].finish();
  await assert.rejects(pending, /needs attention/);
  assert.deepEqual(f.killed, [f.launches[0].child.pid], "only the child this launcher actually started is retired");
  assert.deepEqual(fs.readFileSync(f.recordPath), bytes);
  await assert.rejects(f.controller.startComponent("cpa"), /needs attention/);
  assert.deepEqual(fs.readFileSync(f.recordPath), bytes);
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
  // The command starts off the main thread, so dispose() can come before the start hands its child
  // back; the start then ends that child itself.
  await assert.rejects(pending, /disposed/);
  assert.deepEqual(terminated, [child]);
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
  // The output log an older build kept goes; none is written again.
  const oldLog = path.join(first.dataRoot, "state", "cpa.process.log");
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, "old output\n");
  fs.writeFileSync(`${oldLog}.1`, "older output\n");
  await first.controller.startComponent("cpa");
  assert.equal(spawnOptions.length, 1);
  assert.equal(spawnOptions[0].detached, true);
  assert.equal(spawnOptions[0].stdio, "ignore", "output is discarded, neither piped nor kept in a file");
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(`${oldLog}.1`), false);
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

test("a persistent start that finishes after dispose is kept by a keep-running quit and ended by any other", async () => {
  for (const keepPersistent of [true, false]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let requested;
    const asked = new Promise((resolve) => { requested = resolve; });
    const child = mockChild(keepPersistent ? 9100 : 9101);
    child.unref = () => {};
    const { controller, dataRoot } = controllerFixture({
      persistentComponents: ["cpa"],
      healthProbe: async () => true,
      // The start is off the main thread: it hands its child back only after dispose() ran.
      spawnProcess: async () => { requested(); await gate; return child; },
      terminateProcessTree: (owned, signal) => owned.kill(signal),
    });
    const pending = controller.startComponent("cpa");
    await asked;
    controller.dispose({ keepPersistent });
    release();
    if (keepPersistent) {
      await pending;
      assert.equal(child.killed, false, "a keep-running quit leaves CPA for the next launcher");
      const record = JSON.parse(fs.readFileSync(path.join(dataRoot, "state", "cpa.process.json"), "utf8"));
      assert.equal(record.pid, 9100, "and records it, so the next launcher adopts it");
    } else {
      await assert.rejects(pending, /disposed/);
      assert.equal(child.killed, true, "any other dispose ends the program it could not see");
    }
  }
});

test("a persistent CPA captures its plugin bundle before spawn and replaces an outdated bundle", async (t) => {
  const { spawn } = require("node:child_process");
  const { createRequire, wrap } = require("node:module");
  const vm = require("node:vm");
  const scratch = temporaryDirectory("coding-tools-cpa-dependency");
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const adapterRoot = path.join(scratch, "electron");
  const bundle = path.join(scratch, "vendor", "bundled", "cpa-plugins", "BUNDLE.json");
  writeJson(bundle, { cline: { sha256: "old-plugin" } });
  const expected = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
  const sourcePath = require.resolve("../electron/managed-components.cjs");
  const loaded = { exports: {} };
  vm.runInThisContext(wrap(fs.readFileSync(sourcePath, "utf8")), { filename: sourcePath })(
    loaded.exports, createRequire(sourcePath), loaded, sourcePath, adapterRoot);
  const createController = loaded.exports.createManagedComponentController;
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (survivor.exitCode === null) survivor.kill(); });
  const first = controllerFixture({
    createController, persistentComponents: ["cpa"], healthProbe: async () => true,
    spawnProcess: () => {
      writeJson(bundle, { cline: { sha256: "new-plugin" } });
      const child = mockChild(survivor.pid);
      child.unref = () => {};
      return child;
    },
  });
  await first.controller.startComponent("cpa");
  const recordPath = path.join(first.dataRoot, "state", "cpa.process.json");
  assert.equal(JSON.parse(fs.readFileSync(recordPath)).dependencyFingerprint, expected,
    "the record describes the bundle at launch, not bytes changed during spawn");
  first.controller.dispose({ keepPersistent: true });
  let spawned = 0;
  const second = controllerFixture({
    createController, dataRoot: first.dataRoot, persistentComponents: ["cpa"], healthProbe: async () => true,
    spawnProcess: () => { spawned += 1; const child = mockChild(9999); child.unref = () => {}; return child; },
  }).controller;
  t.after(() => second.dispose({ keepPersistent: true }));
  await second.startComponent("cpa");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(spawned, 1, "the same CPA version with old plugins is replaced");
  assert.notEqual(survivor.exitCode === null && survivor.signalCode === null, true);
});

test("a persistent CPA with no plugin fingerprint is replaced even at the current version", async (t) => {
  const { spawn } = require("node:child_process");
  const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (stale.exitCode === null) stale.kill(); });
  let spawned = 0;
  const { controller, dataRoot } = controllerFixture({
    persistentComponents: ["cpa"], healthProbe: async () => true,
    spawnProcess: () => { spawned += 1; const child = mockChild(9999); child.unref = () => {}; return child; },
  });
  t.after(() => controller.dispose({ keepPersistent: true }));
  writeJson(path.join(dataRoot, "state", "cpa.process.json"), { pid: stale.pid, version: "1.0.0" });
  await controller.startComponent("cpa");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(spawned, 1);
  assert.notEqual(stale.exitCode === null && stale.signalCode === null, true);
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
