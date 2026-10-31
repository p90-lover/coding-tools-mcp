"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  DEFAULT_INSPECT_TIMEOUT_MS,
  createExternalServicesController,
  nextKeepAliveDelayMs,
  normalizeLoopbackExecutionEndpoint,
  normalizeLoopbackServiceEndpoint,
  removeIncompleteSnapshots,
  removeSupersededSnapshots,
} = require("../electron/external-services.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function temporaryDirectory() {
  const scratchRoot = path.resolve(root, "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, "coding-tools-external-services-"));
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
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
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

test("retired service archive captures all local state and preserves the old Paseo archive", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  const keyPath = path.join(directory, "external-services.key");
  const dataRoot = path.join(directory, "integrations");
  const retiredIds = ["paseo", "codex-router", "commandcode-proxy", "anneal"];
  for (const id of retiredIds) {
    const statePath = path.join(dataRoot, "state", id, "run.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, id);
  }
  fs.writeFileSync(keyPath, "service-key");
  const managedKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", managedKey, iv);
  const ciphertext = Buffer.concat([cipher.update("retired-recovery-secret", "utf8"), cipher.final()]);
  const originalManagedSecrets = JSON.stringify({
    version: 1,
    components: { anneal: {
      scheme: "aes-256-gcm-v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    } },
  });
  fs.writeFileSync(path.join(dataRoot, "managed-components.key"), managedKey.toString("base64"));
  fs.writeFileSync(path.join(dataRoot, "managed-components.secrets.json"), originalManagedSecrets);
  const previous = path.join(directory, "archives", "paseo", "manifest.json");
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  const previousManifest = JSON.stringify({ schemaVersion: 1, sources: {} });
  fs.writeFileSync(previous, previousManifest);
  const original = JSON.stringify({
    version: 1,
    services: Object.fromEntries(["cpa", ...retiredIds].map((id) => [id, { enabled: true, autoStart: true, keepAlive: true }])),
    secrets: {},
  });
  fs.writeFileSync(filePath, original);

  const controller = createExternalServicesController({ filePath, keyPath, archiveDataRoot: dataRoot });
  assert.deepEqual(controller.snapshot().services.map((service) => service.id), ["cpa"]);
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
  assert.equal(fs.readFileSync(previous, "utf8"), previousManifest);
  const archive = path.join(directory, "archives", "retired-services");
  const manifest = JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8"));
  assert.equal(manifest.sources["external-services.json"], filePath);
  assert.equal(fs.readFileSync(path.join(archive, "external-services.key"), "utf8"), "service-key");
  const archivedKeyPath = path.join(archive, "integrations", "managed-components.key");
  const archivedSecretsPath = path.join(archive, "integrations", "managed-components.secrets.json");
  assert.equal(fs.readFileSync(archivedKeyPath, "utf8"), managedKey.toString("base64"));
  assert.equal(fs.readFileSync(archivedSecretsPath, "utf8"), originalManagedSecrets);
  const recovered = JSON.parse(fs.readFileSync(archivedSecretsPath, "utf8")).components.anneal;
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(fs.readFileSync(archivedKeyPath, "utf8"), "base64"), Buffer.from(recovered.iv, "base64"));
  decipher.setAuthTag(Buffer.from(recovered.tag, "base64"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(recovered.data, "base64")), decipher.final()]).toString("utf8"), "retired-recovery-secret");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(archivedKeyPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(archivedSecretsPath).mode & 0o777, 0o600);
  }
  for (const id of retiredIds) {
    assert.equal(fs.readFileSync(path.join(archive, "integrations", "state", id, "run.json"), "utf8"), id);
  }
  controller.dispose();
});

test("legacy Paseo settings are archived before retirement", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  const keyPath = path.join(directory, "external-services.key");
  const dataRoot = path.join(directory, "integrations");
  const statePath = path.join(dataRoot, "state", "paseo", "run.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{"run":"legacy"}\n');
  fs.writeFileSync(keyPath, "legacy-service-key\n");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "managed-components.key"), "legacy-component-key\n");
  const original = JSON.stringify({
    version: 1,
    services: { paseo: { enabled: true, autoStart: true, keepAlive: true } },
    secrets: {},
  });
  fs.writeFileSync(filePath, original);

  const controller = createExternalServicesController({ filePath, keyPath, archiveDataRoot: dataRoot });
  assert.deepEqual(controller.snapshot().services.map((service) => service.id), ["cpa"]);
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
  const archive = path.join(directory, "archives", "retired-services");
  const manifest = JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8"));
  assert.equal(manifest.sources["external-services.json"], filePath);
  assert.equal(fs.readFileSync(path.join(archive, "external-services.json"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(archive, "external-services.key"), "utf8"), "legacy-service-key\n");
  assert.equal(fs.readFileSync(path.join(archive, "integrations", "state", "paseo", "run.json"), "utf8"), '{"run":"legacy"}\n');
  assert.equal(fs.readFileSync(path.join(archive, "integrations", "managed-components.key"), "utf8"), "legacy-component-key\n");
  controller.dispose();
});

test("Paseo component state is archived when no service config exists", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const statePath = path.join(dataRoot, "state", "paseo", "run.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "legacy-state");
  const controller = createExternalServicesController({
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    archiveDataRoot: dataRoot,
  });
  const archive = path.join(directory, "archives", "retired-services");
  assert.equal(fs.readFileSync(path.join(archive, "integrations", "state", "paseo", "run.json"), "utf8"), "legacy-state");
  controller.dispose();
});

test("new config and key are archived after an earlier state-only snapshot", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const statePath = path.join(dataRoot, "state", "paseo", "run.json");
  const filePath = path.join(directory, "external-services.json");
  const keyPath = path.join(directory, "external-services.key");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "legacy-state");
  const options = { filePath, keyPath, archiveDataRoot: dataRoot };
  createExternalServicesController(options).dispose();
  const original = JSON.stringify({
    version: 1, services: { paseo: { enabled: true, autoStart: true, keepAlive: true } }, secrets: {},
  });
  fs.writeFileSync(filePath, original);
  fs.writeFileSync(keyPath, "late-key");
  createExternalServicesController(options).dispose();
  const archive = path.join(directory, "archives", "retired-services");
  const latest = JSON.parse(fs.readFileSync(path.join(archive, "latest.json"), "utf8")).relative;
  assert.equal(fs.readFileSync(path.join(archive, latest, "external-services.json"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(archive, latest, "external-services.key"), "utf8"), "late-key");
  assert.equal(fs.readFileSync(archivedFile(archive, latest, "integrations/state/paseo/run.json"), "utf8"), "legacy-state");
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

/** A file of a snapshot: live files sit in the snapshot; retired state may sit where its manifest's stateRoot says. */
function archivedFile(archive, snapshot, relative) {
  const manifest = JSON.parse(fs.readFileSync(path.join(archive, snapshot, "manifest.json"), "utf8"));
  const holder = relative.startsWith("integrations/state/") && manifest.stateRoot !== undefined ? manifest.stateRoot : snapshot;
  return path.join(archive, holder, relative);
}

for (const code of ["ENOENT", "ENOSPC"]) {
  test(`an archive ${code} does not prevent startup or discard unarchived legacy data`, (t) => {
    const directory = temporaryDirectory();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "external-services.json");
    const keyPath = path.join(directory, "external-services.key");
    const key = Buffer.alloc(32, 7).toString("base64");
    const original = {
      version: 1,
      services: { cpa: { enabled: true }, paseo: { enabled: true, autoStart: true } },
      secrets: {
        cpa: { scheme: "electron-safe-storage-v1", data: "cpa-ciphertext" },
        paseo: { scheme: "aes-256-gcm-v1", data: "retired-ciphertext" },
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(original));
    fs.writeFileSync(keyPath, key);
    const options = { filePath, keyPath };
    createExternalServicesController(options).dispose();
    const archive = path.join(directory, "archives", "retired-services");
    const manifest = fs.readFileSync(path.join(archive, "manifest.json"), "utf8");
    original.services.cpa.autoStart = true;
    fs.writeFileSync(filePath, JSON.stringify(original));

    const warnings = [];
    const mkdirSync = fs.mkdirSync;
    let failures = 0;
    let controller;
    fs.mkdirSync = function (target, ...args) {
      if (String(target).startsWith(path.join(archive, "snapshots") + path.sep)) {
        failures += 1;
        throw Object.assign(new Error(`${code}: archive snapshot unavailable`), { code, syscall: "mkdir" });
      }
      return mkdirSync.call(this, target, ...args);
    };
    try {
      controller = createExternalServicesController({
        ...options,
        logger: { warn: (event, detail) => warnings.push({ event, detail }) },
      });
      assert.equal(failures, 1, "the failing snapshot path must actually be exercised");
      assert.deepEqual(controller.snapshot().services.map((service) => service.id), ["cpa"]);
      assert.equal(fs.readFileSync(filePath, "utf8"), JSON.stringify(original));
      controller.configure("cpa", { enabled: false });
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(saved.services.cpa.enabled, false, "CPA changes still persist");
      assert.deepEqual(saved.services.paseo, original.services.paseo);
      assert.deepEqual(saved.secrets, original.secrets, "unarchived credentials must remain recoverable");
      assert.equal(fs.readFileSync(keyPath, "utf8"), key);
      assert.equal(fs.readFileSync(path.join(archive, "manifest.json"), "utf8"), manifest);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].detail.code, code);
    } finally {
      fs.mkdirSync = mkdirSync;
      controller?.dispose();
    }

    // A later launch must archive the preserved data before retiring it from the live file.
    const unarchived = fs.readFileSync(filePath, "utf8");
    const recovered = createExternalServicesController(options);
    try {
      const latest = JSON.parse(fs.readFileSync(path.join(archive, "latest.json"), "utf8")).relative;
      assert.equal(fs.readFileSync(path.join(archive, latest, "external-services.json"), "utf8"), unarchived);
      assert.equal(fs.readFileSync(path.join(archive, latest, "external-services.key"), "utf8"), key);
      recovered.configure("cpa", { enabled: true });
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.deepEqual(Object.keys(saved.services), ["cpa"]);
      assert.deepEqual(saved.secrets, { cpa: original.secrets.cpa });
    } finally {
      recovered.dispose();
    }
  });
}

test("a failed keep-alive lease write does not fail healthy CPA inspection", async (t) => {
  const warnings = [];
  const { controller, directory } = controllerFixture({
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  controller.configure("cpa", { keepAlive: true });
  const filePath = path.join(directory, "external-services.json");
  const saved = fs.readFileSync(filePath, "utf8");
  // The state file is written flushed (durable-state.cjs), through openSync rather than writeFileSync.
  const openSync = fs.openSync;
  let failedWrites = 0;
  fs.openSync = function (target, ...args) {
    if (String(target).startsWith(filePath + ".tmp-")) {
      failedWrites += 1;
      throw Object.assign(new Error("ENOSPC: lease storage is full"), { code: "ENOSPC" });
    }
    return openSync.call(this, target, ...args);
  };
  try {
    assert.equal((await controller.inspect("cpa")).status, "ready");
    assert.equal(failedWrites, 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].detail.code, "ENOSPC");
    assert.throws(() => controller.configure("cpa", { autoStart: true }), { code: "ENOSPC" });
    assert.equal(fs.readFileSync(filePath, "utf8"), saved);
  } finally {
    fs.openSync = openSync;
    controller.dispose();
  }
});

test("legacy Paseo cannot reenable keep-alive through configuration", () => {
  const { controller } = controllerFixture();
  assert.throws(() => controller.configure("paseo", { enabled: true, autoStart: true, keepAlive: true }), /Unknown external service/);
  assert.deepEqual(controller.snapshot().services.map((service) => service.id), ["cpa"]);
  controller.dispose();
});

test("CPA config write keeps only CPA live secrets after archiving raw retired secrets", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  const keyPath = path.join(directory, "external-services.key");
  const cpaSecret = { scheme: "electron-safe-storage-v1", data: "cpa-ciphertext" };
  const original = JSON.stringify({
    version: 1,
    services: { cpa: { enabled: true }, paseo: { enabled: true, autoStart: true } },
    secrets: {
      cpa: cpaSecret,
      paseo: { scheme: "aes-256-gcm-v1", data: "retired-ciphertext" },
      anneal: { scheme: "electron-safe-storage-v1", data: "retired-anneal" },
      "codex-router": { scheme: "electron-safe-storage-v1", data: "retired-router" },
      "commandcode-proxy": { scheme: "electron-safe-storage-v1", data: "retired-commandcode" },
    },
  });
  fs.writeFileSync(filePath, original);
  fs.writeFileSync(keyPath, "original-key");
  const controller = createExternalServicesController({ filePath, keyPath });
  const archive = path.join(directory, "archives", "retired-services", "external-services.json");
  assert.equal(fs.readFileSync(archive, "utf8"), original);
  controller.configure("cpa", { autoStart: true });
  const live = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(live.secrets, { cpa: cpaSecret });
  assert.equal(live.services.cpa.autoStart, true);
  controller.dispose();
});

test("missing managed secrets key refuses migration without changing service config", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  const dataRoot = path.join(directory, "integrations");
  fs.mkdirSync(dataRoot, { recursive: true });
  const original = JSON.stringify({ version: 1, services: { cpa: { enabled: true } }, secrets: {} });
  fs.writeFileSync(filePath, original);
  fs.writeFileSync(path.join(dataRoot, "managed-components.secrets.json"), JSON.stringify({
    version: 1,
    components: { anneal: { scheme: "aes-256-gcm-v1", data: "retired-ciphertext" } },
  }));
  assert.throws(() => createExternalServicesController({
    filePath,
    keyPath: path.join(directory, "external-services.key"),
    archiveDataRoot: dataRoot,
  }), /managed component key/i);
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("missing Paseo archive key refuses startup without changing original config", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  const original = JSON.stringify({
    version: 1,
    services: { paseo: { enabled: true, autoStart: true, keepAlive: true } },
    secrets: { paseo: { scheme: "aes-256-gcm-v1", data: "ciphertext" } },
  });
  fs.writeFileSync(filePath, original);
  assert.throws(
    () => createExternalServicesController({ filePath, keyPath: path.join(directory, "external-services.key") }),
    /archive|key/i,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("a disk that refuses the retired-services archive no longer stops the app from starting", () => {
  // Seen in the fatal log (2026-10-18/19): "ENOSPC ... write" and "ENOENT ... mkdir
  // ...retired-services\snapshots\<id>" thrown from the archive stopped every launch.
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {} }));
  // A file where the archive folder goes: its mkdir fails the way a refused folder did.
  fs.writeFileSync(path.join(directory, "archives"), "not a folder");
  const warnings = [];
  const controller = createExternalServicesController({ filePath, keyPath: path.join(directory, "external-services.key"),
    logger: { warn: (event, detail) => warnings.push({ event, detail }), info() {}, error() {}, debug() {} } });
  assert.ok(controller.snapshot().services.length >= 1, "the controller started");
  assert.equal(warnings[0]?.event, "external_services.archive_failed");
});

test("external service controller owns only CPA and rejects remote endpoints", () => {
  const { controller } = controllerFixture();
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.services.map((service) => service.id), ["cpa"]);
  assert.throws(() => normalizeLoopbackServiceEndpoint("https://example.com/service"), /loopback/i);
  assert.equal(normalizeLoopbackServiceEndpoint("http://localhost:9090"), "http://localhost:9090/");
  assert.throws(() => normalizeLoopbackExecutionEndpoint("ws://127.0.0.1:6767/ws", "paseo"), /Unknown external service/);
  assert.throws(() => normalizeLoopbackExecutionEndpoint("http://127.0.0.1:3000", "anneal"), /Unknown external service/);
  assert.throws(
    () => normalizeLoopbackExecutionEndpoint("http://127.0.0.1:6767/ws", "paseo"),
    /Unknown external service/,
  );
  controller.dispose();
});

test("Windows external cleanup uses owned trees and retains failed handles", { skip: process.platform !== "win32" }, async () => {
  let blocked = true;
  const terminated = [];
  const { controller, child } = controllerFixture({
    fetchImpl: async () => { throw new Error("offline"); },
    terminateProcessTree: (owned) => {
      if (blocked) throw new Error("tree termination refused");
      terminated.push(owned);
      owned.exitCode = 1;
      queueMicrotask(() => owned.emit("exit", 1, null));
    },
  });
  controller.configure("cpa", { executable: "fixture-cpa" });
  await controller.start("cpa");
  child.kill = () => assert.fail("Windows cleanup must not kill only the wrapper");
  await assert.rejects(controller.stop("cpa"), /tree termination refused/);
  assert.equal(controller.snapshot().services.find((service) => service.id === "cpa").owned, true);
  assert.throws(() => controller.dispose(), /tree termination refused/);
  assert.equal(controller.snapshot().services.find((service) => service.id === "cpa").owned, true);
  blocked = false;
  controller.dispose();
  assert.deepEqual(terminated, [child]);
  assert.equal(controller.snapshot().services.find((service) => service.id === "cpa").owned, false);
});

test("external start cannot spawn after disposal while inspection is in flight", async () => {
  let finishInspect;
  const inspection = new Promise((resolve) => { finishInspect = resolve; });
  const { controller, calls } = controllerFixture({ fetchImpl: () => inspection });
  controller.configure("cpa", { executable: "fixture-cpa" });
  const pending = controller.start("cpa");
  controller.dispose();
  finishInspect({ ok: false, status: 503, headers: { get: () => "text/plain" } });
  await assert.rejects(pending, /disposed/);
  assert.deepEqual(calls, []);
  await assert.rejects(controller.start("cpa"), /disposed/);
});

test("retired services have no launch configuration in the live catalog", () => {
  const { controller } = controllerFixture();
  assert.deepEqual(controller.snapshot().services.map((service) => service.id), ["cpa"]);
  for (const id of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
    assert.throws(() => controller.upstreamConfiguration(id), /Unknown external service/);
  }
  controller.dispose();
});

test("runtimeEnvironment exposes the shared in-app loopback mesh without OPENAI_BASE_URL", () => {
  const { controller, directory } = controllerFixture();
  const env = controller.runtimeEnvironment();
  assert.equal(env.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
  assert.equal(env.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
  assert.equal(env.CODING_TOOLS_COMMANDCODE_OPENAI_BASE_URL, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(JSON.stringify(env).includes("proxyApiKey"), false);
  assert.equal(fs.existsSync(path.join(directory, "loopback-mesh.json")), true);
  controller.dispose();
});

// Retired services never run again, so their archived state cannot change. Every launch used to
// re-read all of it (about a gigabyte of Paseo state on a real install) before the window opened.
test("an unchanged retired-services archive is confirmed without reading state contents", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const statePath = path.join(dataRoot, "state", "paseo", "big.bin");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, Buffer.alloc(64 * 1024, 7));
  const options = {
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    archiveDataRoot: dataRoot,
  };
  createExternalServicesController(options).dispose();
  const archive = path.join(directory, "archives", "retired-services");
  const snapshotsBefore = fs.existsSync(path.join(archive, "snapshots")) ? fs.readdirSync(path.join(archive, "snapshots")).length : 0;

  const readFileSync = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function spy(file, ...rest) { reads.push(String(file)); return readFileSync.call(this, file, ...rest); };
  try {
    createExternalServicesController(options).dispose();
  } finally {
    fs.readFileSync = readFileSync;
  }
  assert.deepEqual(reads.filter((file) => file.endsWith("big.bin")), [], "state contents must not be re-read");
  const snapshotsAfter = fs.existsSync(path.join(archive, "snapshots")) ? fs.readdirSync(path.join(archive, "snapshots")).length : 0;
  assert.equal(snapshotsAfter, snapshotsBefore, "no new snapshot for unchanged state");
});

// Seen live: a changed external-services.json re-linked ~23,000 frozen files into a new snapshot on
// the main thread, holding the window back ~10 minutes. A live-file change now touches live files only.
test("a live-file change snapshots only the live files and points at the unchanged retired state", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const statePath = path.join(dataRoot, "state", "paseo", "big.bin");
  const filePath = path.join(directory, "external-services.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, Buffer.alloc(64 * 1024, 7));
  const options = { filePath, keyPath: path.join(directory, "external-services.key"), archiveDataRoot: dataRoot };
  createExternalServicesController(options).dispose();
  const archive = path.join(directory, "archives", "retired-services");
  const touched = [];
  const { linkSync, copyFileSync } = fs;
  fs.linkSync = function spy(from, to) { touched.push(String(to)); return linkSync.call(this, from, to); };
  fs.copyFileSync = function spy(from, to, ...rest) { touched.push(String(to)); return copyFileSync.call(this, from, to, ...rest); };
  try {
    for (const version of [1, 2]) {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {}, secrets: { change: version } }));
      createExternalServicesController(options).dispose();
    }
  } finally {
    fs.linkSync = linkSync;
    fs.copyFileSync = copyFileSync;
  }
  assert.deepEqual(touched.filter((file) => file.includes(path.join("integrations", "state"))), [], "retired state is neither linked nor copied");
  const latest = JSON.parse(fs.readFileSync(path.join(archive, "latest.json"), "utf8")).relative;
  assert.equal(fs.existsSync(path.join(archive, latest, "integrations", "state")), false);
  // Two changes later, the newest snapshot still names the first one (the archive root), which holds the state.
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive, latest, "manifest.json"), "utf8")).stateRoot, "");
  assert.deepEqual(fs.readFileSync(archivedFile(archive, latest, "integrations/state/paseo/big.bin")), fs.readFileSync(statePath));
  assert.match(fs.readFileSync(path.join(archive, latest, "external-services.json"), "utf8"), /"change":2/);
  // Each change is still its own snapshot: the history keeps every live version.
  assert.equal(fs.readdirSync(path.join(archive, "snapshots")).length, 2);
});

test("a live file rewritten with the same size and mtime is still a change: live files are compared by content", () => {
  // CI 2026-10-31: two same-size writes in one millisecond kept size and mtime, and the second was missed.
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "external-services.json");
  const options = { filePath, keyPath: path.join(directory, "external-services.key") };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {}, secrets: { change: 1 } }));
  createExternalServicesController(options).dispose();
  const { mtime } = fs.statSync(filePath);
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {}, secrets: { change: 2 } }));
  fs.utimesSync(filePath, mtime, mtime);
  createExternalServicesController(options).dispose();
  const archive = path.join(directory, "archives", "retired-services");
  const latest = JSON.parse(fs.readFileSync(path.join(archive, "latest.json"), "utf8")).relative;
  assert.match(fs.readFileSync(path.join(archive, latest, "external-services.json"), "utf8"), /"change":2/);
});

test("a retired-state change after an inherited snapshot gets a full snapshot again", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const stateDir = path.join(dataRoot, "state", "paseo");
  const filePath = path.join(directory, "external-services.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "kept.bin"), "kept");
  const options = { filePath, keyPath: path.join(directory, "external-services.key"), archiveDataRoot: dataRoot };
  createExternalServicesController(options).dispose();
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {}, secrets: { change: 1 } }));
  createExternalServicesController(options).dispose();
  const archive = path.join(directory, "archives", "retired-services");
  // Retired state is normally frozen; if it ever changes, the walk notices only when no stats were recorded,
  // so drop the recorded stats the way a pre-stats archive would look, then change a file.
  fs.writeFileSync(path.join(stateDir, "added.bin"), "new");
  const latest = () => JSON.parse(fs.readFileSync(path.join(archive, "latest.json"), "utf8")).relative;
  const manifestPath = path.join(archive, latest(), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, stats: Object.fromEntries(Object.entries(manifest.stats).filter(([key]) => !key.startsWith("integrations/state/"))) }));
  createExternalServicesController(options).dispose();
  const full = JSON.parse(fs.readFileSync(path.join(archive, latest(), "manifest.json"), "utf8"));
  assert.equal(full.stateRoot, undefined, "a snapshot holding its own state names no stateRoot");
  assert.equal(fs.readFileSync(path.join(archive, latest(), "integrations", "state", "paseo", "kept.bin"), "utf8"), "kept");
  assert.equal(fs.readFileSync(path.join(archive, latest(), "integrations", "state", "paseo", "added.bin"), "utf8"), "new");
});

test("snapshots an interrupted launch left behind are removed, but never a complete, young or linked one", async () => {
  const directory = temporaryDirectory();
  const archive = path.join(directory, "archives", "retired-services");
  const snapshots = path.join(archive, "snapshots");
  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  const make = (name, files) => {
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(snapshots, name, relative)), { recursive: true });
      fs.writeFileSync(path.join(snapshots, name, relative), content);
    }
    return path.join(snapshots, name);
  };
  const old = new Date(Date.now() - 60 * 60_000);
  const complete = make(id(1), { "manifest.json": "{}", "external-services.json": "{}" });
  const interrupted = make(id(2), { "integrations/state/paseo/a.bin": "a" });
  const young = make(id(3), { "integrations/state/paseo/b.bin": "b" });
  for (const folder of [complete, interrupted]) fs.utimesSync(folder, old, old);
  const outside = path.join(directory, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(snapshots, id(4)), "junction");
  const removed = await removeIncompleteSnapshots(archive);
  assert.deepEqual(removed, [id(2)]);
  assert.equal(fs.existsSync(interrupted), false);
  assert.equal(fs.existsSync(complete) && fs.existsSync(young), true);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep", "a linked folder is never entered");
});

test("superseded snapshots are removed, keeping the latest, the newest few and the state they name", async () => {
  const directory = temporaryDirectory();
  const archive = path.join(directory, "archives", "retired-services");
  const snapshots = path.join(archive, "snapshots");
  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  const make = (n, manifest, minutesAgo) => {
    fs.mkdirSync(path.join(snapshots, id(n), "integrations", "state", "paseo"), { recursive: true });
    fs.writeFileSync(path.join(snapshots, id(n), "external-services.json"), "{}");
    const file = path.join(snapshots, id(n), "manifest.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: {}, stats: {}, ...manifest }));
    const at = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(file, at, at);
  };
  // 1 holds the frozen state every later snapshot points to; 2 and 3 are old history; 4, 5 the newest.
  make(1, {}, 500);
  fs.writeFileSync(path.join(snapshots, id(1), "integrations", "state", "paseo", "state.bin"), "frozen");
  make(2, { stateRoot: `snapshots/${id(1)}` }, 400);
  make(3, { stateRoot: `snapshots/${id(1)}` }, 300);
  make(4, { stateRoot: `snapshots/${id(1)}` }, 200);
  make(5, { stateRoot: `snapshots/${id(1)}` }, 100);
  fs.writeFileSync(path.join(archive, "latest.json"), JSON.stringify({ relative: `snapshots/${id(5)}` }));
  const outside = path.join(directory, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(snapshots, id(6)), "junction");

  const removed = await removeSupersededSnapshots(archive);
  assert.deepEqual(removed.sort(), [id(2), id(3)]);
  assert.equal(fs.readFileSync(path.join(snapshots, id(1), "integrations", "state", "paseo", "state.bin"), "utf8"), "frozen");
  assert.equal([4, 5].every((n) => fs.existsSync(path.join(snapshots, id(n), "manifest.json"))), true);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep", "a linked folder is never entered");
  assert.deepEqual(await removeSupersededSnapshots(archive), [], "nothing more once only kept snapshots remain");

  // An unreadable manifest among the kept stops the pass with nothing removed.
  make(7, { stateRoot: `snapshots/${id(1)}` }, 50);
  make(8, { stateRoot: `snapshots/${id(1)}` }, 10);
  fs.writeFileSync(path.join(snapshots, id(8), "manifest.json"), "{torn");
  fs.writeFileSync(path.join(archive, "latest.json"), JSON.stringify({ relative: `snapshots/${id(8)}` }));
  assert.deepEqual(await removeSupersededSnapshots(archive), []);
  assert.equal([4, 5, 7, 8].every((n) => fs.existsSync(path.join(snapshots, id(n)))), true);
});

test("archived retired state is not walked again on later launches", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const stateDir = path.join(dataRoot, "state", "codex-router", "python");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "lib.py"), "x");
  const options = {
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    archiveDataRoot: dataRoot,
  };
  createExternalServicesController(options).dispose();
  const readdirSync = fs.readdirSync;
  const walked = [];
  fs.readdirSync = function spy(dir, ...rest) { walked.push(String(dir)); return readdirSync.call(this, dir, ...rest); };
  try {
    createExternalServicesController(options).dispose();
  } finally {
    fs.readdirSync = readdirSync;
  }
  assert.deepEqual(walked.filter((dir) => dir.includes(path.join("state", "codex-router"))), [], "frozen retired state must not be walked");
});

test("rewriting the live service file with the same content does not snapshot retired state again", () => {
  const directory = temporaryDirectory();
  const dataRoot = path.join(directory, "integrations");
  const statePath = path.join(dataRoot, "state", "codex-router", "lib.py");
  const filePath = path.join(directory, "external-services.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "x");
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {}, secrets: {} }));
  const options = { filePath, keyPath: path.join(directory, "external-services.key"), archiveDataRoot: dataRoot };
  createExternalServicesController(options).dispose();
  const archive = path.join(directory, "archives", "retired-services");
  const snapshots = () => (fs.existsSync(path.join(archive, "snapshots")) ? fs.readdirSync(path.join(archive, "snapshots")).length : 0);
  const before = snapshots();
  const manifest = path.join(archive, "manifest.json");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(manifest, old, old);
  const manifestWritten = fs.statSync(manifest).mtimeMs;
  // Same bytes, newer mtime: what every launch does to this file.
  for (const offset of [60_000, 120_000]) {
    const later = new Date(Date.now() + offset);
    fs.writeFileSync(filePath, fs.readFileSync(filePath));
    fs.utimesSync(filePath, later, later);
    createExternalServicesController(options).dispose();
  }
  assert.equal(snapshots(), before, "no new snapshot for an unchanged file");
  assert.equal(fs.statSync(manifest).mtimeMs, manifestWritten, "nor a rewrite of the manifest, which lists every retired file");
  // A real change still gets its own snapshot.
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, services: {}, secrets: { changed: true } }));
  createExternalServicesController(options).dispose();
  assert.equal(snapshots(), before + 1);
});
