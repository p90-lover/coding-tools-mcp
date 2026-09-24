"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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

const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
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
      endpoint: `http://127.0.0.1:${id === "codex-router" ? 4202 : id === "commandcode-proxy" ? 9090 : id === "cpa" ? 8317 : id === "paseo" ? 6768 : 5173}/`,
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

test("Paseo patch revision repairs an old marker and preserves state", async () => {
  const manifestRoot = path.join(__dirname, "..", "vendor", "managed-components");
  const paseo = JSON.parse(fs.readFileSync(path.join(manifestRoot, "paseo.json"), "utf8"));
  const anneal = JSON.parse(fs.readFileSync(path.join(manifestRoot, "anneal.json"), "utf8"));
  assert.equal(paseo.patchRevision, "codex-cpa-host-env-v1");
  const scratchRoot = path.join(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const dataRoot = fs.mkdtempSync(path.join(scratchRoot, "paseo-patch-marker-"));
  const bundleRoot = path.join(dataRoot, "bundled");
  const bundleSource = path.join(bundleRoot, "paseo", "source");
  writeJson(path.join(bundleRoot, "paseo", "BUNDLE.json"), {
    id: "paseo", version: paseo.version, commit: paseo.commit, patchRevision: "old-patch",
  });
  writeJson(path.join(bundleSource, "package.json"), {});
  fs.mkdirSync(path.join(bundleSource, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(bundleSource, "dist"), { recursive: true });
  const stateFile = path.join(dataRoot, "state", "paseo", "keep.txt");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "retained");
  const controller = createManagedComponentController({ manifestRoot, dataRoot, bundleRoot });
  try {
    for (const manifest of [paseo, anneal]) {
      const home = path.join(dataRoot, "components", manifest.id, manifest.version);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, manifest.bundle.entrypoint), "{}");
      writeJson(path.join(home, ".coding-tools-managed-component.json"), {
        schemaVersion: 1, id: manifest.id, version: manifest.version,
        strategy: manifest.strategy, repository: manifest.repository, commit: manifest.commit,
      });
    }
    assert.equal(controller.project("paseo").installState, "repair-required");
    assert.equal(controller.project("anneal").installState, "installed");

    await assert.rejects(() => controller.repairComponent("paseo"), /patch revision does not match/);
    writeJson(path.join(bundleRoot, "paseo", "BUNDLE.json"), {
      id: "paseo", version: paseo.version, commit: paseo.commit, patchRevision: paseo.patchRevision,
    });
    await controller.repairComponent("paseo");
    assert.equal(controller.project("paseo").installState, "installed");
    assert.equal(controller.project("anneal").installState, "installed");
    assert.equal(fs.readFileSync(stateFile, "utf8"), "retained");
    const trashEntries = fs.readdirSync(path.join(dataRoot, "Trash", "managed-components", "paseo"));
    assert.equal(trashEntries.length, 1);
    const oldMarker = JSON.parse(fs.readFileSync(path.join(dataRoot, "Trash", "managed-components", "paseo", trashEntries[0], ".coding-tools-managed-component.json"), "utf8"));
    assert.equal(oldMarker.patchRevision, undefined);

    const markerPath = path.join(dataRoot, "components", "paseo", paseo.version, ".coding-tools-managed-component.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.patchRevision, paseo.patchRevision);
    assert.equal(controller.project("paseo").installState, "installed");
  } finally {
    controller.dispose();
  }
});

test("manifest validation rejects remote listeners, unpinned sources, path escape and destructive commands", () => {
  const payload = Buffer.from("fixture");
  const baseline = releaseManifest("codex-router", payload);

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      health: { ...baseline.health, endpoint: "https://example.com/" },
    }, "codex-router"),
    /loopback/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      strategy: "git-source",
      repositoryUrl: "https://github.com/fixture/repository.git",
      commit: "main",
    }, "codex-router"),
    /commit must be pinned/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      install: { steps: [{ id: "escape", kind: "assert-file", path: "../secret" }] },
    }, "codex-router"),
    /escapes the component root/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      install: {
        steps: [{ id: "destructive", kind: "command", executable: "rm", arguments: ["-rf", "."] }],
      },
    }, "codex-router"),
    /destructive executable/i,
  );

  assert.throws(
    () => assertSafeManifest({
      ...baseline,
      install: {
        steps: [{ id: "shell-delete", kind: "command", executable: "bash", arguments: ["-lc", "rm -rf ."] }],
      },
    }, "codex-router"),
    /destructive shell command/i,
  );
});

test("release installation verifies bytes, activates atomically and reports the pinned install", async () => {
  const { controller, payload } = controllerFixture();
  const installed = await controller.installComponent("codex-router");

  assert.equal(installed.installState, "installed");
  assert.equal(installed.version, "1.0.0");
  assert.ok(installed.installedAt);
  const artifact = path.join(installed.managedHome, "codex-router.bin");
  assert.deepEqual(fs.readFileSync(artifact), payload);
  const marker = JSON.parse(fs.readFileSync(path.join(installed.managedHome, ".coding-tools-managed-component.json"), "utf8"));
  assert.equal(marker.id, "codex-router");
  assert.equal(marker.version, "1.0.0");
  assert.equal(marker.artifact, "codex-router.bin");
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
  const first = await controller.installComponent("paseo");
  fs.writeFileSync(path.join(first.managedHome, "user-retained.txt"), "retain me", "utf8");

  const repaired = await controller.repairComponent("paseo");
  assert.equal(repaired.installState, "installed");
  assert.equal(fs.existsSync(path.join(repaired.managedHome, "user-retained.txt")), false);

  const trashRoot = path.join(dataRoot, "Trash", "managed-components", "paseo");
  const retainedDirectories = fs.readdirSync(trashRoot);
  assert.equal(retainedDirectories.length, 1);
  const retainedRoot = path.join(trashRoot, retainedDirectories[0]);
  assert.equal(fs.readFileSync(path.join(retainedRoot, "user-retained.txt"), "utf8"), "retain me");
  assert.ok(fs.existsSync(path.join(retainedRoot, "CODING_TOOLS_TRASH_RECORD.json")));
  controller.dispose();
});

test("peer environment reentry through runtimeConfiguration does not overflow", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const dataRoot = temporaryDirectory("coding-tools-peer-reentry");
  let controller;
  let entries = 0;
  controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: true,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    }),
    spawnProcess: () => mockChild(9100),
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
    resolveRuntimeExecutable: () => process.execPath,
    peerEnvironment: (manifest) => {
      entries += 1;
      if (entries > 40) throw new Error("Maximum call stack size exceeded");
      const configuration = controller.runtimeConfiguration(manifest.id);
      assert.ok(configuration);
      return { CODING_TOOLS_PEER_MARK: "1" };
    },
  });
  await controller.installComponent("commandcode-proxy");
  const configuration = controller.runtimeConfiguration("commandcode-proxy");
  assert.equal(configuration.home.includes("commandcode-proxy"), true);
  assert.ok(entries >= 1 && entries < 40);
  controller.dispose();
});

test("CommandCode managed proxy key is encrypted and never appears in projected snapshots", async () => {
  const { controller, dataRoot } = controllerFixture();
  const installed = await controller.installComponent("commandcode-proxy");
  assert.equal(installed.secretConfigured, true);
  assert.equal(JSON.stringify(controller.snapshot()).includes("proxyApiKey"), false);

  const persisted = fs.readFileSync(path.join(dataRoot, "managed-components.secrets.json"), "utf8");
  assert.equal(persisted.includes("proxyApiKey"), false);
  assert.equal(persisted.includes("generated-main-process-only"), false);
  controller.dispose();
});

test("managed foreground lifecycle reports running process and stops it with bounded termination", async () => {
  const { controller, children } = controllerFixture();
  await controller.installComponent("anneal");
  const started = await controller.startComponent("anneal");
  assert.equal(started.processes.length, 1);
  assert.equal(started.processes[0].running, true);
  assert.equal(children.length, 1);

  const stopped = await controller.stopComponent("anneal");
  assert.equal(children[0].killed, true);
  assert.equal(stopped.processes.length, 0);
  controller.dispose();
});

test("Start materializes a missing managed component before launching it", async () => {
  const { controller, children } = controllerFixture();
  const started = await controller.startComponent("commandcode-proxy");
  assert.equal(started.installState, "installed");
  assert.equal(started.processes.length, 1);
  assert.equal(started.processes[0].running, true);
  assert.equal(children.length, 1);
  controller.dispose();
});

function bundledSourceManifest(id) {
  const entry = id === "commandcode-proxy" ? "proxy.mjs" : "package.json";
  const port = id === "commandcode-proxy" ? 9090 : id === "paseo" ? 6768 : 5173;
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

test("bundled-source unpacks from app resources without git clone or network fetch", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = temporaryDirectory("coding-tools-bundled-manifests");
  const bundleRoot = temporaryDirectory("coding-tools-bundled-runtime");
  const dataRoot = temporaryDirectory("coding-tools-bundled-data");
  for (const id of COMPONENT_IDS) {
    writeJson(path.join(manifestRoot, `${id}.json`), id === "commandcode-proxy"
      ? bundledSourceManifest(id)
      : releaseManifest(id, payload));
  }
  const sourceRoot = path.join(bundleRoot, "commandcode-proxy", "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "proxy.mjs"), "export const bundled = true;\n");
  writeJson(path.join(bundleRoot, "MANIFEST.json"), { schemaVersion: 1 });

  let fetched = 0;
  const children = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    bundleRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("network fetch must not run for bundled-source");
    },
    spawnProcess: () => {
      const child = mockChild(9100 + children.length);
      children.push(child);
      return child;
    },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });

  const started = await controller.startComponent("commandcode-proxy");
  assert.equal(started.installState, "installed");
  assert.equal(fetched, 0);
  assert.equal(
    fs.readFileSync(path.join(started.managedHome, "proxy.mjs"), "utf8"),
    "export const bundled = true;\n",
  );
  controller.dispose();
});

test("Windows WSL Anneal stages Linux dependencies without leaking credentials in arguments", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = temporaryDirectory("coding-tools-anneal-wsl-manifests");
  const bundleRoot = temporaryDirectory("coding-tools-anneal-wsl-bundle");
  const dataRoot = temporaryDirectory("coding-tools-anneal-wsl-data");
  for (const id of COMPONENT_IDS) {
    const manifest = id === "anneal" ? bundledSourceManifest(id) : releaseManifest(id, payload);
    if (id === "anneal") {
      manifest.platformModes = { win32: "wsl2" };
      manifest.credentials = { githubReadToken: { required: false, minimumLength: 20, secret: true } };
      manifest.install.steps.splice(1, 0, {
        id: "install-dependencies",
        kind: "command",
        executable: "{npm}",
        arguments: ["ci"],
        skipIfFile: "node_modules",
        skipIfExists: "node_modules",
        execution: "managed-mode",
      });
      manifest.install.steps.splice(2, 0, {
        id: "restore-or-create-config",
        kind: "command",
        executable: "bash",
        arguments: ["-lc", "true"],
        environment: { GITHUB_READ_TOKEN: "{secret:githubReadToken}" },
        execution: "managed-mode",
      });
    }
    writeJson(path.join(manifestRoot, id + ".json"), manifest);
  }
  const bundled = path.join(bundleRoot, "anneal", "source");
  writeJson(path.join(bundled, "package.json"), { name: "anneal-fixture" });
  fs.mkdirSync(path.join(bundled, "node_modules", "win32-only"), { recursive: true });
  fs.writeFileSync(path.join(bundled, "node_modules", "win32-only", "index.js"), "windows");
  const spawned = [];
  const controller = createManagedComponentController({
    manifestRoot,
    bundleRoot,
    dataRoot,
    platform: "win32",
    env: { ...process.env, WSLENV: "KEEP_ME/p:GITHUB_READ_TOKEN/w" },
    resolveCrossUseEnvironment: (id) => id === "anneal" ? { HTTPS_PROXY: "http://proxy.example.test:8080", NO_PROXY: "127.0.0.1" } : {},
    safeStorage: { isEncryptionAvailable: () => false },
    spawnSyncProcess: () => ({ status: 0, stdout: "/mnt/c/anneal-fixture\n", stderr: "" }),
    spawnProcess: (executable, args, options) => {
      spawned.push({ executable, args, env: options.env });
      const child = mockChild(9400 + spawned.length);
      queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); });
      return child;
    },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  const fixtureToken = "fixture-" + "x".repeat(32);
  controller.setComponentCredential("anneal", "githubReadToken", fixtureToken);
  try {
    const installed = await controller.installComponent("anneal");
    assert.equal(installed.installState, "installed");
    assert.equal(fs.existsSync(path.join(installed.managedHome, "node_modules", "win32-only")), false);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].executable, "wsl.exe");
    assert.match(spawned[0].args.join(" "), /npm.*ci/);
    assert.equal(spawned.some((entry) => entry.args.join(" ").includes(fixtureToken)), false);
    assert.equal(spawned[1].env.GITHUB_READ_TOKEN, fixtureToken);
    assert.equal(spawned[1].env.HTTPS_PROXY, "http://proxy.example.test:8080");
    assert.match(spawned[1].env.WSLENV, /(?:^|:)HTTPS_PROXY\/u(?:$|:)/);
    assert.match(spawned[1].env.WSLENV, /(?:^|:)NO_PROXY\/u(?:$|:)/);
    assert.match(spawned[1].env.WSLENV, /(?:^|:)KEEP_ME\/p(?:$|:)/);
    assert.match(spawned[1].env.WSLENV, /(?:^|:)GITHUB_READ_TOKEN\/u(?:$|:)/);
    assert.doesNotMatch(spawned[1].env.WSLENV, /GITHUB_READ_TOKEN\/w/);
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

test("bundled-source Start fails closed when app resources are missing", async () => {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = temporaryDirectory("coding-tools-missing-bundle-manifests");
  const dataRoot = temporaryDirectory("coding-tools-missing-bundle-data");
  for (const id of COMPONENT_IDS) {
    writeJson(path.join(manifestRoot, `${id}.json`), id === "paseo"
      ? bundledSourceManifest(id)
      : releaseManifest(id, payload));
  }
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: false,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => {
      throw new Error("network fetch must not run when the bundled runtime is missing");
    },
    spawnProcess: () => mockChild(9300),
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  await assert.rejects(
    () => controller.startComponent("paseo"),
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

test("Router runtime exit preserves completed install state and generated dependencies", async () => {
  const { controller, children } = controllerFixture();
  try {
    const started = await controller.startComponent("codex-router");
    const dependency = path.join(started.managedHome, ".venv", "retained-dependency.txt");
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "retained");
    children[0].exitCode = 7;
    children[0].emit("exit", 7, null);
    const failed = controller.project("codex-router");
    assert.equal(failed.installState, "installed");
    assert.match(failed.error, /service exited \(7\)/);
    const restarted = await controller.startComponent("codex-router");
    assert.equal(restarted.installedAt, started.installedAt);
    assert.equal(fs.readFileSync(dependency, "utf8"), "retained");
    assert.equal(children.length, 2);
  } finally {
    controller.dispose();
  }
});

test("Router composite caller key resolves without recursive launch expansion", async (t) => {
  const manifestRoot = temporaryDirectory("coding-tools-router-composite-manifests");
  const dataRoot = path.join(temporaryDirectory("coding-tools-router-composite-data"), "integrations");
  configureTestProxy(dataRoot);
  for (const id of COMPONENT_IDS) writeJson(path.join(manifestRoot, `${id}.json`), bundledSourceManifest(id));
  const manifest = bundledSourceManifest("codex-router");
  const home = path.join(dataRoot, "components", "codex-router", manifest.version);
  writeJson(path.join(home, "package.json"), { name: "router-fixture" });
  writeJson(path.join(home, ".coding-tools-managed-component.json"), {
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    strategy: manifest.strategy,
    repository: manifest.repository,
    commit: manifest.commit,
    installedAt: new Date().toISOString(),
  });
  const state = path.join(dataRoot, "state", "codex-router", "router");
  fs.mkdirSync(state, { recursive: true });
  const callerKey = "router-composite-fixture-key-1234567890";
  fs.writeFileSync(path.join(state, "caller-secret"), callerKey);
  const spawned = [];
  const controller = createManagedExternalServicesController({
    manifestRoot,
    dataRoot,
    filePath: path.join(dataRoot, "external-services.json"),
    keyPath: path.join(dataRoot, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    resolveRuntimeExecutable: () => process.execPath,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, clone: () => ({ json: async () => ({ data: [] }) }) }),
    spawnProcess: () => {
      const child = mockChild(8700 + spawned.length);
      spawned.push(child);
      return child;
    },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  try {
    const startedAt = performance.now();
    controller.snapshot();
    const connection = controller.loopbackRequest("codex-router");
    const started = await controller.start("codex-router");
    const environment = controller.runtimeEnvironment();
    const elapsedMs = performance.now() - startedAt;
    t.diagnostic(`Router snapshot + loopback + Start + environment: ${elapsedMs.toFixed(1)} ms`);
    assert.equal(connection.modelsPath, `/_codex-router/${callerKey}/v1/models`);
    assert.equal(environment.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY, callerKey);
    assert.equal(started.managedInstall.state, "installed");
    assert.equal(spawned.length, 1);
    assert.ok(elapsedMs < 5000, "caller-key lookup must not recurse through environment expansion");
  } finally {
    controller.dispose();
  }
});

test("runtime failure restarts in place while missing package files and invalid markers repair", async () => {
  const componentId = "codex-router";
  const manifestRoot = temporaryDirectory("coding-tools-restart-manifests");
  const bundleRoot = temporaryDirectory("coding-tools-restart-bundle");
  const dataRoot = path.join(temporaryDirectory("coding-tools-restart-data"), "integrations");
  configureTestProxy(dataRoot);
  for (const id of COMPONENT_IDS) writeJson(path.join(manifestRoot, `${id}.json`), bundledSourceManifest(id));
  const source = path.join(bundleRoot, componentId, "source");
  writeJson(path.join(source, "package.json"), { name: "router-fixture", revision: 1 });
  const routerState = path.join(dataRoot, "state", componentId, "router");
  fs.mkdirSync(routerState, { recursive: true });
  fs.writeFileSync(path.join(routerState, "caller-secret"), "router-restart-fixture-key-1234567890");
  const children = [];
  const controller = createManagedExternalServicesController({
    manifestRoot,
    bundleRoot,
    dataRoot,
    filePath: path.join(dataRoot, "external-services.json"),
    keyPath: path.join(dataRoot, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    resolveRuntimeExecutable: () => process.execPath,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, clone: () => ({ json: async () => ({ data: [] }) }) }),
    spawnProcess: () => {
      const child = mockChild(8500 + children.length);
      children.push(child);
      return child;
    },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  try {
    const first = await controller.start(componentId);
    const home = first.managedInstall.home;
    const dependency = path.join(home, ".venv", "retained-dependency.txt");
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "verified runtime dependency");
    const markerPath = path.join(home, ".coding-tools-managed-component.json");
    const marker = fs.readFileSync(markerPath, "utf8");
    const installs = path.join(dataRoot, "aiTemp", "managed-components");
    const originalInstallCount = fs.readdirSync(installs).length;
    writeJson(path.join(source, "package.json"), { name: "router-fixture", revision: 2 });

    children[0].exitCode = 7;
    children[0].emit("exit", 7, null);
    const failed = controller.snapshot().services.find((entry) => entry.id === componentId);
    const restarted = await controller.start(componentId);
    assert.equal(fs.existsSync(dependency), true, "runtime failure must not replace the installed home");
    assert.equal(fs.readFileSync(dependency, "utf8"), "verified runtime dependency");
    assert.equal(fs.readFileSync(markerPath, "utf8"), marker);
    assert.equal(fs.readdirSync(installs).length, originalInstallCount);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "package.json"), "utf8")).revision, 1);
    assert.equal(failed.managedInstall.state, "installed");
    assert.equal(failed.status, "error");
    assert.match(failed.error, /service exited \(7\)/);
    assert.equal(restarted.managedInstall.state, "installed");
    assert.equal(restarted.error, null);

    await controller.stop(componentId);
    fs.renameSync(path.join(home, "package.json"), path.join(dataRoot, "Trash", "missing-package.json"));
    assert.equal(controller.snapshot().services.find((entry) => entry.id === componentId).managedInstall.state, "repair-required");
    await controller.start(componentId);
    assert.equal(fs.readdirSync(installs).length, originalInstallCount + 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "package.json"), "utf8")).revision, 2);

    await controller.stop(componentId);
    writeJson(markerPath, { schemaVersion: 1, id: "wrong-component" });
    assert.equal(controller.snapshot().services.find((entry) => entry.id === componentId).managedInstall.state, "repair-required");
    await controller.start(componentId);
    assert.equal(fs.readdirSync(installs).length, originalInstallCount + 2);
    assert.equal(controller.snapshot().services.find((entry) => entry.id === componentId).managedInstall.state, "installed");
  } finally {
    controller.dispose();
  }
});
