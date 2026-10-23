"use strict";

// An app update keeps the running CPA and adopts it, so run() never writes the new build's
// config.yaml. The adopt step rewrites it in place (CPA hot-reloads it) only when it changed.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const yaml = require("js-yaml");
const { createManagedComponentController } = require("../electron/managed-components.cjs");
const { refreshConfiguration, runtimeConfiguration } = require("../electron/cpa-managed.cjs");

const shippedManifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "vendor", "managed-components", "cpa.json"), "utf8"));

function temporaryDirectory(name) {
  const scratchRoot = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mockChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = (signal) => {
    queueMicrotask(() => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", 0, signal); });
    return true;
  };
  child.unref = () => {};
  return child;
}

/** A CPA manifest whose service is a stand-in binary and whose adopt step is the shipped one. */
function cpaFixture(payload) {
  const manifestRoot = temporaryDirectory("coding-tools-cpa-adopt-manifests");
  writeJson(path.join(manifestRoot, "cpa.json"), {
    schemaVersion: 1, id: "cpa", name: "cpa", managedBy: "Coding Tools", loopbackOnly: true,
    repository: "fixture/cpa", version: "1.0.0", strategy: "release-binary",
    credentials: shippedManifest.credentials,
    platforms: { [process.platform]: { [process.arch]: {
      url: "https://github.com/fixture/cpa/releases/download/v1.0.0/cpa.bin",
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
      fileName: "cpa.bin",
    } } },
    install: { steps: [{ id: "download-release", kind: "download" }, { id: "verify-sha256", kind: "verify" }, { id: "activate", kind: "activate" }] },
    launch: {
      primaryProcessId: "cpa",
      processes: [{ id: "cpa", mode: "foreground", executable: "{artifact}", arguments: [] }],
      adopt: shippedManifest.launch.adopt,
    },
    health: { endpoint: "http://127.0.0.1:8317/v1/models", acceptStatus: [200] },
  });
  return manifestRoot;
}

function launcher({ manifestRoot, dataRoot, payload, onServiceSpawn }) {
  return createManagedComponentController({
    manifestRoot,
    dataRoot,
    allowNetworkInstall: true,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => new Response(payload, { status: 200 }),
    persistentComponents: ["cpa"],
    healthProbe: async () => true,
    resolveRuntimeExecutable: () => process.execPath,
    resolveCrossUseEnvironment: () => ({ CODING_TOOLS_CPA_OUTBOUND_PROXY_URL: "socks5://127.0.0.1:1080" }),
    // The adopt step really runs cpa-managed.cjs; the CPA service itself is a stand-in.
    spawnProcess: (executable, args, options) => (args[1] === "refresh"
      ? spawn(executable, args, options)
      : onServiceSpawn()),
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
}

test("the shipped adopt step gets the same secrets as the CPA it refreshes", () => {
  const [step] = shippedManifest.launch.adopt;
  const cpa = shippedManifest.launch.processes.find((entry) => entry.id === "cpa");
  assert.deepEqual(step.environment, cpa.environment);
  assert.deepEqual(step.arguments, ["{adapterRoot}/cpa-managed.cjs", "refresh", "{state}"]);
});

test("an adopted CPA with a stale config gets the current config written; an identical one is left alone", async (t) => {
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => survivor.kill());
  const payload = Buffer.from("cpa-adopt-fixture", "utf8");
  const manifestRoot = cpaFixture(payload);
  const dataRoot = path.join(temporaryDirectory("coding-tools-cpa-adopt"), "integrations");
  t.after(() => fs.rmSync(path.dirname(dataRoot), { recursive: true, force: true }));
  t.after(() => fs.rmSync(manifestRoot, { recursive: true, force: true }));

  const first = launcher({ manifestRoot, dataRoot, payload, onServiceSpawn: () => mockChild(survivor.pid) });
  await first.startComponent("cpa");
  const { managementKey, proxyApiKey } = first.runtimeSecrets("cpa");
  first.dispose({ keepPersistent: true });

  // What an older build left: no reasoning-summary payload rule, an old key, and a user setting.
  const state = path.join(dataRoot, "state", "cpa");
  const configPath = path.join(state, "config.yaml");
  const stale = yaml.load(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)));
  delete stale.payload;
  fs.writeFileSync(configPath, yaml.dump({ ...stale, routing: { strategy: "fill-first" } }));
  const before = fs.statSync(configPath, { bigint: true });

  let respawned = 0;
  const second = launcher({ manifestRoot, dataRoot, payload, onServiceSpawn: () => { respawned += 1; return mockChild(9999); } });
  t.after(() => second.dispose({ keepPersistent: true }));
  await second.startComponent("cpa");
  assert.equal(respawned, 0, "CPA is adopted, never restarted");
  assert.equal(survivor.exitCode, null);

  const written = yaml.load(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(written.payload.default[0].params, { "reasoning.summary": "auto" });
  assert.deepEqual(written["api-keys"], [proxyApiKey]);
  assert.equal(written["remote-management"]["secret-key"], managementKey);
  assert.equal(written["proxy-url"], "socks5://127.0.0.1:1080");
  assert.deepEqual(written.routing, { strategy: "fill-first" }, "user settings survive");
  // CPA's watcher follows the file: a replaced file would never be reloaded.
  assert.equal(fs.statSync(configPath, { bigint: true }).ino, before.ino, "rewritten in place");

  const current = fs.readFileSync(configPath);
  const settled = fs.statSync(configPath, { bigint: true });
  const third = launcher({ manifestRoot, dataRoot, payload, onServiceSpawn: () => { respawned += 1; return mockChild(9999); } });
  t.after(() => third.dispose({ keepPersistent: true }));
  await third.startComponent("cpa");
  assert.equal(respawned, 0);
  assert.deepEqual(fs.readFileSync(configPath), current);
  assert.equal(fs.statSync(configPath, { bigint: true }).mtimeNs, settled.mtimeNs, "an identical config is not rewritten");
});

test("a shorter refreshed config replaces every old byte", (t) => {
  const state = temporaryDirectory("coding-tools-cpa-refresh-shorter");
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const configPath = path.join(state, "config.yaml");
  const saved = yaml.load(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)));
  fs.writeFileSync(configPath, yaml.dump({ ...saved, "remote-management": { "secret-key": "x".repeat(4_000) } }));

  assert.equal(refreshConfiguration(state, "m".repeat(40), "p".repeat(40)), "written");
  const expected = runtimeConfiguration(state, "m".repeat(40), "p".repeat(40));
  assert.equal(fs.readFileSync(configPath, "utf8"), expected, "no padding or old tail is left");
  assert.equal(refreshConfiguration(state, "m".repeat(40), "p".repeat(40)), "unchanged");
});
