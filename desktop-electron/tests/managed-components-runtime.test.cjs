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
  createManagedComponentController,
} = require("../electron/managed-components.cjs");

const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "paseo", "anneal"];

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
      endpoint: `http://127.0.0.1:${id === "codex-router" ? 4202 : id === "commandcode-proxy" ? 9090 : id === "paseo" ? 6768 : 5173}/`,
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

function controllerFixture() {
  const payload = Buffer.from("managed-component-fixture-v1", "utf8");
  const manifestRoot = manifestFixture(payload);
  const dataRoot = temporaryDirectory("coding-tools-managed-data");
  const children = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    }),
    spawnProcess: () => {
      const child = mockChild(8100 + children.length);
      children.push(child);
      return child;
    },
    resolveRuntimeExecutable: () => process.execPath,
    now: (() => {
      let tick = 0;
      return () => `2026-09-18T03:00:${String(tick++).padStart(2, "0")}.000Z`;
    })(),
  });
  return { controller, dataRoot, payload, children };
}

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
