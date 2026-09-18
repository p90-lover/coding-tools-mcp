"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
const REAL_IDS = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
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

test("real CommandCode, Paseo and Anneal manifests are bundled-source inside Desktop", () => {
  assert.deepEqual([...BUNDLED_COMPONENT_IDS], ["commandcode-proxy", "paseo", "anneal"]);
  const commandcode = loadManagedManifest("commandcode-proxy", path.join(root, "vendor", "managed-components"));
  const paseo = loadManagedManifest("paseo", path.join(root, "vendor", "managed-components"));
  const anneal = loadManagedManifest("anneal", path.join(root, "vendor", "managed-components"));
  const router = JSON.parse(fs.readFileSync(path.join(root, "vendor/managed-components/codex-router.json"), "utf8"));
  const cpa = JSON.parse(fs.readFileSync(path.join(root, "vendor/managed-components/cpa.json"), "utf8"));

  assert.equal(commandcode.strategy, "bundled-source");
  assert.equal(paseo.strategy, "bundled-source");
  assert.equal(anneal.strategy, "bundled-source");
  assert.equal(commandcode.bundle.entrypoint, "proxy.mjs");
  assert.equal(anneal.credentials.githubReadToken.required, false);
  assert.equal(fs.existsSync(path.join(root, "vendor/bundled/commandcode-proxy/proxy.mjs")), true);
  assert.match(router.health.endpoint, /127\.0\.0\.1:4202|_codex-router/);
  assert.match(cpa.health.endpoint, /127\.0\.0\.1:8317/);
});

test("bundled-source manifests require a pinned commit and in-app entrypoint", () => {
  const baseline = bundledManifest("commandcode-proxy");
  assert.doesNotThrow(() => assertSafeManifest(baseline, "commandcode-proxy"));
  assert.throws(
    () => assertSafeManifest({ ...baseline, commit: "main" }, "commandcode-proxy"),
    /commit must be pinned/i,
  );
  assert.throws(
    () => assertSafeManifest({ ...baseline, bundle: {} }, "commandcode-proxy"),
    /bundled entrypoint/i,
  );
});

test("Start copies the in-app payload without git clone and then launches it", async () => {
  const manifestRoot = temporaryDirectory("coding-tools-bundled-manifests");
  const bundledRoot = temporaryDirectory("coding-tools-bundled-payload");
  const dataRoot = temporaryDirectory("coding-tools-bundled-data");
  const commands = [];
  const children = [];
  const payload = "console.log('bundled-proxy');\n";

  for (const id of REAL_IDS) {
    if (id === "commandcode-proxy") {
      writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id));
      writeBundleTree(bundledRoot, id, payload);
      continue;
    }
    writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id, {
      health: { endpoint: `http://127.0.0.1:${id === "paseo" ? 6768 : 5173}/`, acceptStatus: [200] },
    }));
  }

  const controller = createManagedComponentController({
    manifestRoot,
    bundledRoot,
    dataRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    spawnProcess: (executable, args) => {
      commands.push({ executable, args: [...args] });
      const child = mockChild(9300 + children.length);
      children.push(child);
      return child;
    },
    spawnSyncProcess: (executable, args) => {
      commands.push({ executable, args: [...args], sync: true });
      throw new Error(`unexpected sync spawn: ${executable}`);
    },
    resolveRuntimeExecutable: () => "/runtime/node",
    now: () => "2026-09-18T08:00:00.000Z",
  });

  const before = controller.project("commandcode-proxy");
  assert.equal(before.installState, "not-installed");
  assert.equal(before.missingCredentials.length, 0);

  const started = await controller.startComponent("commandcode-proxy");
  assert.equal(started.installState, "installed");
  assert.equal(started.strategy, "bundled-source");
  assert.equal(fs.readFileSync(path.join(started.managedHome, "proxy.mjs"), "utf8"), payload);
  assert.equal(commands.some((entry) => entry.args?.[0] === "clone"), false);
  assert.equal(children.length, 1);
  assert.equal(started.processes[0].running, true);
  controller.dispose();
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
