"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  BUNDLED_COMPONENT_IDS,
  assertSafeManifest,
  copyBundledTree,
  createManagedComponentController,
  loadManagedManifest,
} = require("../electron/managed-components.cjs");

const root = path.resolve(__dirname, "..");
const REAL_IDS = ["cpa", "paseo", "anneal"];

function temporaryDirectory(name) {
  const scratch = path.resolve(root, "..", "aiTemp");
  fs.mkdirSync(scratch, { recursive: true });
  return fs.mkdtempSync(path.join(scratch, `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mockChild(pid = 9200) {
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

function bundledManifest(id, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: `fixture/${id}`,
    repositoryUrl: `https://github.com/fixture/${id}.git`,
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version: "1.0.0",
    strategy: "bundled-source",
    bundle: { entrypoint: "proxy.mjs", prebuilt: true },
    install: {
      steps: [
        { id: "copy-bundled-source", kind: "bundled-copy" },
        { id: "verify-entrypoint", kind: "assert-file", path: "proxy.mjs" },
        { id: "activate", kind: "activate" },
      ],
    },
    launch: {
      processes: [
        {
          id: "proxy",
          mode: "foreground",
          executable: "{runtime}",
          arguments: ["{home}/proxy.mjs"],
        },
      ],
    },
    health: { endpoint: "http://127.0.0.1:9090/", acceptStatus: [200] },
    ...extra,
  };
}

function writeBundleTree(bundledRoot, id, body = "export default true;\n") {
  const home = path.join(bundledRoot, id);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "proxy.mjs"), body, "utf8");
  fs.writeFileSync(path.join(home, "package.json"), `${JSON.stringify({ name: id, dependencies: {} }, null, 2)}\n`);
  return home;
}

test("Start copies bundled production node_modules so Paseo does not fetch npm packages", () => {
  const source = temporaryDirectory("coding-tools-bundled-node-modules-src");
  const destination = temporaryDirectory("coding-tools-bundled-node-modules-dst");
  const dep = path.join(source, "node_modules", "left-pad");
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({ name: "paseo" }, null, 2)}\n`);
  fs.writeFileSync(path.join(dep, "index.js"), "module.exports = 1\n");
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  fs.writeFileSync(path.join(source, ".git", "HEAD"), "ref: refs/heads/main\n");

  copyBundledTree(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1\n");
  assert.equal(fs.existsSync(path.join(destination, ".git")), false);
});

test("Paseo and Anneal remain bundled while CPA uses its pinned release", () => {
  assert.deepEqual([...BUNDLED_COMPONENT_IDS], ["paseo", "anneal"]);
  const paseo = loadManagedManifest("paseo", path.join(root, "vendor", "managed-components"));
  const anneal = loadManagedManifest("anneal", path.join(root, "vendor", "managed-components"));
  const cpa = loadManagedManifest("cpa", path.join(root, "vendor", "managed-components"));
  assert.equal(paseo.strategy, "bundled-source");
  assert.equal(anneal.strategy, "bundled-source");
  assert.equal(cpa.strategy, "release-binary");
});

test("bundled-source manifests require a pinned commit and in-app entrypoint", () => {
  const baseline = bundledManifest("paseo");
  assert.doesNotThrow(() => assertSafeManifest(baseline, "paseo"));
  assert.throws(
    () => assertSafeManifest({ ...baseline, commit: "main" }, "paseo"),
    /commit must be pinned/i,
  );
  assert.throws(
    () => assertSafeManifest({ ...baseline, bundle: {} }, "paseo"),
    /bundled entrypoint/i,
  );
});

test("Anneal bundled install does not block on a missing GitHub token", async () => {
  const manifestRoot = temporaryDirectory("coding-tools-anneal-manifests");
  const bundledRoot = temporaryDirectory("coding-tools-anneal-payload");
  const dataRoot = temporaryDirectory("coding-tools-anneal-data");
  const spawned = [];
  writeBundleTree(bundledRoot, "anneal");

  for (const id of REAL_IDS) {
    if (id !== "anneal") {
      writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id));
      continue;
    }
    writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id, {
      credentials: { githubReadToken: { required: false, minimumLength: 20, secret: true } },
      health: { endpoint: "http://127.0.0.1:5173/", acceptStatus: [200] },
    }));
  }

  const controller = createManagedComponentController({
    manifestRoot,
    bundledRoot,
    dataRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
    spawnProcess: () => {
      const child = mockChild(9400 + spawned.length);
      spawned.push(child);
      return child;
    },
    resolveRuntimeExecutable: () => process.execPath,
    now: () => "2026-09-18T08:10:00.000Z",
  });

  assert.deepEqual(controller.project("anneal").missingCredentials, []);
  const installed = await controller.installComponent("anneal");
  assert.equal(installed.installState, "installed");
  assert.deepEqual(installed.missingCredentials, []);
  controller.dispose();
});
