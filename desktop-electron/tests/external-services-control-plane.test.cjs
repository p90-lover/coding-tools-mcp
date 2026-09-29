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
  assert.equal(fs.readFileSync(path.join(archive, latest, "integrations", "state", "paseo", "run.json"), "utf8"), "legacy-state");
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
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
