"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  compareVersions,
  createManagedComponentController,
  parseChecksums,
  updatedManifest,
} = require("../electron/managed-components.cjs");
const { createComponentUpdater, readyToSwap } = require("../electron/component-updates.cjs");
const { createManagedExternalServicesController } = require("../electron/managed-external-services.cjs");
const { EventEmitter } = require("node:events");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

function temporaryDirectory(name) {
  const scratchRoot = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const assetName = (version) => `cpa_${version}_${process.platform}_${process.arch}.bin`;
const BUNDLED = Buffer.from("cpa 1.0.0", "utf8");
const LATEST = Buffer.from("cpa 1.2.0", "utf8");

function cpaManifest() {
  return {
    schemaVersion: 1,
    id: "cpa",
    name: "CPA",
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: "fixture/cpa",
    version: "1.0.0",
    strategy: "release-binary",
    bundle: { required: true },
    updates: { source: "github-release", checksums: "checksums.txt" },
    platforms: {
      [process.platform]: {
        [process.arch]: {
          url: `https://github.com/fixture/cpa/releases/download/v1.0.0/${assetName("1.0.0")}`,
          sha256: sha256(BUNDLED),
          fileName: assetName("1.0.0"),
        },
      },
    },
    install: { steps: [{ id: "download-release", kind: "download" }, { id: "activate", kind: "activate" }] },
    launch: { processes: [{ id: "service", mode: "foreground", executable: "{artifact}", arguments: [] }] },
    health: { endpoint: "http://127.0.0.1:8317/v1/models", acceptStatus: [200] },
  };
}

/** A GitHub whose latest release is `release.version`; `checksum` overrides its published checksum. */
function fakeGitHub({ checksum = null } = {}) {
  const calls = [];
  const release = { version: "1.2.0" };
  const payload = () => (release.version === "1.2.0" ? LATEST : Buffer.from(`cpa ${release.version}`, "utf8"));
  const fetchImpl = async (url) => {
    const href = String(url);
    const tag = `v${release.version}`;
    calls.push(href);
    if (href === "https://api.github.com/repos/fixture/cpa/releases/latest") {
      return Response.json({ tag_name: tag });
    }
    if (href === `https://github.com/fixture/cpa/releases/download/${tag}/checksums.txt`) {
      return new Response(`${checksum || sha256(payload())}  ${assetName(release.version)}\n${"0".repeat(64)}  other.zip\n`);
    }
    if (href === `https://github.com/fixture/cpa/releases/download/${tag}/${assetName(release.version)}`) {
      return new Response(payload(), { headers: { "content-length": String(payload().length) } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, release };
}

function fixture(github = fakeGitHub(), dataRoot = temporaryDirectory("coding-tools-cpa-update-data")) {
  const manifestRoot = temporaryDirectory("coding-tools-cpa-update-manifests");
  writeJson(path.join(manifestRoot, "cpa.json"), cpaManifest());
  const bundleRoot = temporaryDirectory("coding-tools-cpa-update-bundle");
  fs.mkdirSync(path.join(bundleRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "cpa", assetName("1.0.0")), BUNDLED);
  const controller = createManagedComponentController({
    manifestRoot,
    bundleRoot,
    dataRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: github.fetchImpl,
    resolveRuntimeExecutable: () => process.execPath,
  });
  return { controller, dataRoot, github };
}

test("release versions compare numerically and checksums parse goreleaser lines", () => {
  assert.ok(compareVersions("8.0.46", "8.0.32") > 0);
  assert.ok(compareVersions("8.0.9", "8.0.10") < 0);
  assert.equal(compareVersions("8.1.0", "8.1.0"), 0);
  const checksums = parseChecksums(`${"a".repeat(64)}  CLIProxyAPI_8.0.46_windows_amd64.zip\r\n# comment\n${"B".repeat(64)} *other.tar.gz\n`);
  assert.equal(checksums.get("CLIProxyAPI_8.0.46_windows_amd64.zip"), "a".repeat(64));
  assert.equal(checksums.get("other.tar.gz"), "b".repeat(64));
});

test("an updated manifest renames each asset to the new version and keeps only checksummed ones", () => {
  const base = cpaManifest();
  base.platforms.other = { arm64: { ...base.platforms[process.platform][process.arch], fileName: "cpa_1.0.0_other.bin" } };
  const next = updatedManifest(base, "1.2.0", new Map([[assetName("1.2.0"), sha256(LATEST)]]));
  const asset = next.platforms[process.platform][process.arch];
  assert.equal(next.version, "1.2.0");
  assert.equal(next.updatedFrom, "1.0.0");
  assert.equal(next.bundle.required, false);
  assert.equal(asset.fileName, assetName("1.2.0"));
  assert.equal(asset.url, `https://github.com/fixture/cpa/releases/download/v1.2.0/${assetName("1.2.0")}`);
  assert.equal(next.platforms.other, undefined, "an asset the release has no checksum for was kept");
  assert.throws(() => updatedManifest(base, "1.2.0", new Map()), /no release platform assets/);
  assert.throws(() => updatedManifest(base, "latest", new Map()), /invalid/);
});

test("an update installs beside the running version and becomes active only when activated", async () => {
  const { controller, dataRoot } = fixture();
  const bundled = await controller.installComponent("cpa");
  assert.equal(bundled.version, "1.0.0");

  const check = await controller.checkComponentUpdate("cpa");
  assert.deepEqual([check.current, check.latest, check.available], ["1.0.0", "1.2.0", true]);

  const staged = await controller.installComponentUpdate("cpa");
  assert.equal(staged.staged, true);
  assert.equal(controller.project("cpa").version, "1.0.0", "installing an update switched the running version");
  const updateHome = path.join(dataRoot, "components", "cpa", "1.2.0");
  assert.deepEqual(fs.readFileSync(path.join(updateHome, assetName("1.2.0"))), LATEST);
  assert.ok(fs.existsSync(bundled.managedHome), "the running version's folder was replaced");

  assert.deepEqual(controller.activateComponentUpdate("cpa"), { from: "1.0.0", to: "1.2.0" });
  const active = controller.project("cpa");
  assert.deepEqual([active.version, active.bundledVersion, active.installState], ["1.2.0", "1.0.0", "installed"]);
  assert.equal(controller.activateComponentUpdate("cpa"), null);
  assert.equal((await controller.checkComponentUpdate("cpa")).available, false);
  controller.dispose();
});

test("the running version stays installed while an update downloads beside it", async () => {
  const github = fakeGitHub();
  const seen = [];
  let controller;
  const { controller: created } = fixture({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith(assetName("1.2.0"))) {
        const projected = controller.project("cpa");
        seen.push([projected.installState, projected.updateOperation?.state, projected.updateOperation?.step]);
      }
      return github.fetchImpl(url, init);
    },
  });
  controller = created;
  await controller.installComponent("cpa");
  await controller.installComponentUpdate("cpa");
  assert.deepEqual(seen[0], ["installed", "installing", "download-release"]);
  assert.equal(controller.project("cpa").updateOperation.state, "installed");
  controller.dispose();
});

test("a new launcher runs only a confirmed update; an unchecked one waits as pending", async () => {
  const first = fixture();
  await first.controller.installComponent("cpa");
  await first.controller.installComponentUpdate("cpa");
  first.controller.dispose();

  const second = fixture(fakeGitHub(), first.dataRoot);
  assert.equal(second.controller.project("cpa").version, "1.0.0", "an update that never passed a health check ran at startup");
  assert.equal(second.controller.pendingComponentUpdate("cpa").version, "1.2.0");
  second.controller.activateComponentUpdate("cpa");
  second.controller.confirmComponentUpdate("cpa");
  second.controller.dispose();

  const third = fixture(fakeGitHub(), first.dataRoot);
  assert.equal(third.controller.project("cpa").version, "1.2.0");
  assert.equal(third.controller.pendingComponentUpdate("cpa"), null);
  third.controller.dispose();
});

test("a rejected update never comes back, and the last confirmed one survives the rollback", async () => {
  const github = fakeGitHub();
  const first = fixture(github);
  await first.controller.installComponent("cpa");
  await first.controller.installComponentUpdate("cpa");
  first.controller.activateComponentUpdate("cpa");
  first.controller.confirmComponentUpdate("cpa");

  github.release.version = "1.3.0";
  await first.controller.installComponentUpdate("cpa");
  assert.deepEqual(first.controller.activateComponentUpdate("cpa"), { from: "1.2.0", to: "1.3.0" });
  assert.equal(first.controller.rejectComponentUpdate("cpa", "1.3.0").version, "1.2.0");
  const check = await first.controller.checkComponentUpdate("cpa");
  assert.equal(check.available, false);
  assert.match(check.reason, /failed its health check/);
  first.controller.dispose();

  const next = fixture(github, first.dataRoot);
  assert.equal(next.controller.project("cpa").version, "1.2.0", "the restart fell back past the last working update");
  assert.equal(next.controller.pendingComponentUpdate("cpa"), null);
  next.controller.dispose();
});

test("an update whose download doesn't match the published checksum is not staged", async () => {
  const { controller, dataRoot } = fixture(fakeGitHub({ checksum: "f".repeat(64) }));
  await controller.installComponent("cpa");
  await assert.rejects(controller.installComponentUpdate("cpa"), /checksum|SHA-256|sha256/i);
  assert.equal(controller.project("cpa").version, "1.0.0");
  assert.equal(fs.existsSync(path.join(dataRoot, "state", "cpa.update.json")), false);
  assert.equal(controller.activateComponentUpdate("cpa"), null);
  controller.dispose();
});

test("a failed GitHub check reports its error instead of throwing", async () => {
  const { controller } = fixture({ fetchImpl: async () => new Response("rate limited", { status: 403 }) });
  const check = await controller.checkComponentUpdate("cpa");
  assert.equal(check.available, false);
  assert.match(check.error, /HTTP 403/);
  assert.equal(controller.project("cpa").update.error, check.error);
  controller.dispose();
});

test("an automatic switch waits for CPA to be quiet and never runs over work", () => {
  const minute = 60_000;
  const quiet = { busy: false, systemIdleSeconds: 0, componentIdleMs: 6 * minute, stagedForMs: minute };
  assert.equal(readyToSwap(quiet), true);
  assert.equal(readyToSwap({ ...quiet, busy: true }), false);
  assert.equal(readyToSwap({ ...quiet, busy: true, stagedForMs: 30 * 24 * 60 * minute }), false);
  assert.equal(readyToSwap({ ...quiet, componentIdleMs: 2 * minute }), false);
  const dayLate = { ...quiet, componentIdleMs: 2 * minute, stagedForMs: 25 * 60 * minute };
  assert.equal(readyToSwap(dayLate), false, "a late update switched while the user was at the keyboard");
  assert.equal(readyToSwap({ ...dayLate, systemIdleSeconds: 120 }), true);
  assert.equal(readyToSwap({ ...dayLate, systemIdleSeconds: 120, componentIdleMs: 10_000 }), false);
});

test("the updater stages a found update, then switches once the moment is quiet", async () => {
  let clock = 1_000_000;
  let lastRequest = clock;
  let busy = false;
  const calls = [];
  const updater = createComponentUpdater({
    componentId: "cpa",
    stage: async (id) => { calls.push(`stage:${id}`); return { staged: true, current: "1.0.0", latest: "1.2.0" }; },
    swap: async (id) => { calls.push(`swap:${id}`); return { swapped: true, from: "1.0.0", to: "1.2.0" }; },
    isBusy: async () => busy,
    lastActivityAt: () => lastRequest,
    now: () => clock,
  });
  assert.equal(await updater.trySwap(), null, "switched with nothing staged");
  await updater.check();
  assert.equal(updater.stagedAt(), clock);
  clock += 60_000;
  assert.equal(await updater.trySwap(), null, "switched a minute after CPA's last request");
  clock += 10 * 60_000;
  busy = true;
  assert.equal(await updater.trySwap(), null, "switched during a chat turn");
  busy = false;
  assert.deepEqual(await updater.trySwap(), { swapped: true, from: "1.0.0", to: "1.2.0" });
  assert.equal(updater.stagedAt(), null);
  assert.deepEqual(calls, ["stage:cpa", "swap:cpa"]);
});

test("a busy check that fails counts as busy, and a disabled updater does nothing", async () => {
  let enabled = true;
  const swaps = [];
  const updater = createComponentUpdater({
    componentId: "cpa",
    stage: async () => ({ staged: true }),
    swap: async (id) => { swaps.push(id); return {}; },
    enabled: () => enabled,
    isBusy: async () => { throw new Error("AO unreachable"); },
    lastActivityAt: () => 0,
    now: () => 24 * 60 * 60_000,
  });
  await updater.check();
  assert.equal(await updater.trySwap(), null);
  enabled = false;
  assert.equal(await updater.check(), null);
  assert.deepEqual(swaps, []);
});

test("unknown CPA activity defers the switch to the next start", async () => {
  const swaps = [];
  const updater = createComponentUpdater({
    componentId: "cpa",
    stage: async () => ({ staged: true }),
    swap: async (id) => { swaps.push(id); return {}; },
    lastActivityAt: () => null,
    now: () => 30 * 24 * 60 * 60_000,
  });
  await updater.check();
  assert.equal(await updater.trySwap(), null);
  assert.deepEqual(swaps, []);
});

test("stopping the updater waits for a switch under way and blocks new ones", async () => {
  let finish;
  const order = [];
  const updater = createComponentUpdater({
    componentId: "cpa",
    stage: async () => ({ staged: true }),
    swap: () => new Promise((resolve) => { order.push("swap started"); finish = () => { order.push("swap done"); resolve({ swapped: true }); }; }),
    lastActivityAt: () => 0,
    now: () => 10 * 60_000,
  });
  await updater.check();
  const swapping = updater.trySwap();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = updater.stop().then(() => order.push("stopped"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["swap started"], "stop resolved before the switch finished");
  finish();
  await Promise.all([swapping, stopped]);
  assert.deepEqual(order, ["swap started", "swap done", "stopped"]);
  assert.equal(await updater.check(), null);
  assert.equal(await updater.trySwap(), null);
});

function serviceFixture({ healthyVersions, dataRoot: existingDataRoot = null }) {
  const manifestRoot = temporaryDirectory("coding-tools-cpa-swap-manifests");
  writeJson(path.join(manifestRoot, "cpa.json"), cpaManifest());
  const bundleRoot = temporaryDirectory("coding-tools-cpa-swap-bundle");
  fs.mkdirSync(path.join(bundleRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "cpa", assetName("1.0.0")), BUNDLED);
  const dataRoot = existingDataRoot || path.join(temporaryDirectory("coding-tools-cpa-swap-data"), "integrations");
  // CPA starts only with a network proxy chosen, as in managed-components-runtime.test.cjs.
  const providers = path.join(path.dirname(dataRoot), "providers");
  const store = createProviderNetworkStore({
    filePath: path.join(providers, "provider-network.json"),
    keyPath: path.join(providers, "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  });
  store.saveProxyProfile({
    id: "test", name: "Test proxy", enabled: true,
    endpoint: { protocol: "http", host: "proxy.example.test", port: 8080 },
    scopes: ["all"],
  });
  store.setGlobalRouting({ enabled: true, profileId: "test" });
  const github = fakeGitHub();
  const spawned = [];
  const running = () => /cpa_(\d+\.\d+\.\d+)_/.exec(spawned.at(-1) || "")?.[1];
  const controller = createManagedExternalServicesController({
    manifestRoot, bundleRoot, dataRoot,
    filePath: path.join(dataRoot, "external-services.json"),
    keyPath: path.join(dataRoot, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    resolveRuntimeExecutable: () => process.execPath,
    updateHealthTimeoutMs: 200,
    fetchImpl: async (url, init) => {
      if (String(url).includes("/v1/models")) {
        return Response.json({ data: [] }, { status: healthyVersions.includes(running()) ? 200 : 503 });
      }
      return github.fetchImpl(url, init);
    },
    spawnProcess: (executable) => {
      spawned.push(String(executable));
      const child = new EventEmitter();
      child.pid = 9800 + spawned.length;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        queueMicrotask(() => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", 0, signal); });
        return true;
      };
      return child;
    },
    terminateProcessTree: (child, signal = "SIGTERM") => child.kill(signal),
  });
  return { controller, dataRoot, spawned, running };
}

test("update switches a running CPA to the new release through the service layer", async () => {
  const { controller, dataRoot, running } = serviceFixture({ healthyVersions: ["1.0.0", "1.2.0"] });
  try {
    await controller.start("cpa");
    assert.equal(running(), "1.0.0");
    const result = await controller.updateManagedComponent("cpa");
    assert.deepEqual([result.staged, result.swapped, result.from, result.to], [true, true, "1.0.0", "1.2.0"]);
    assert.equal(running(), "1.2.0");
    assert.equal(controller.managedComponentsSnapshot().components[0].version, "1.2.0");
    assert.match(controller.upstreamConfiguration("cpa").executable, /1\.2\.0/u);
    assert.ok(fs.existsSync(path.join(dataRoot, "components", "cpa", "1.0.0")), "the bundled version was pruned");
  } finally {
    controller.dispose();
  }
});

test("an update that fails its health check rolls back to the running version", async () => {
  const { controller, running } = serviceFixture({ healthyVersions: ["1.0.0"] });
  try {
    await controller.start("cpa");
    const result = await controller.updateManagedComponent("cpa");
    assert.equal(result.swapped, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.error, /health check/);
    assert.equal(running(), "1.0.0");
    assert.equal(controller.managedComponentsSnapshot().components[0].version, "1.0.0");
    assert.equal((await controller.checkManagedComponentUpdate("cpa")).available, false);
  } finally {
    controller.dispose();
  }
});

test("a pending update met at startup goes through the health check and rolls back when it fails", async () => {
  const first = serviceFixture({ healthyVersions: ["1.0.0"] });
  await first.controller.start("cpa");
  assert.equal((await first.controller.updateManagedComponent("cpa", { swap: false })).staged, true);
  first.controller.dispose();

  const next = serviceFixture({ healthyVersions: ["1.0.0"], dataRoot: first.dataRoot });
  try {
    await next.controller.start("cpa");
    assert.equal(next.running(), "1.0.0", "an unhealthy update kept running after startup");
    assert.equal(next.controller.managedComponentsSnapshot().components[0].version, "1.0.0");
    const check = await next.controller.checkManagedComponentUpdate("cpa");
    assert.equal(check.available, false);
    assert.match(check.reason, /failed its health check/);
  } finally {
    next.controller.dispose();
  }
});

test("a healthy pending update met at startup runs and is confirmed for later starts", async () => {
  const first = serviceFixture({ healthyVersions: ["1.0.0", "1.2.0"] });
  await first.controller.start("cpa");
  await first.controller.updateManagedComponent("cpa", { swap: false });
  first.controller.dispose();

  const second = serviceFixture({ healthyVersions: ["1.0.0", "1.2.0"], dataRoot: first.dataRoot });
  await second.controller.start("cpa");
  assert.equal(second.running(), "1.2.0");
  second.controller.dispose();

  const third = serviceFixture({ healthyVersions: ["1.0.0", "1.2.0"], dataRoot: first.dataRoot });
  try {
    assert.equal(third.controller.managedComponentsSnapshot().components[0].version, "1.2.0");
    await third.controller.start("cpa");
    assert.deepEqual(third.spawned.length, 1, "a confirmed update was switched again");
    assert.equal(third.running(), "1.2.0");
  } finally {
    third.controller.dispose();
  }
});

test("pruning keeps the active and bundled versions and moves the rest to Trash", async () => {
  const { controller, dataRoot } = fixture();
  await controller.installComponent("cpa");
  await controller.installComponentUpdate("cpa");
  controller.activateComponentUpdate("cpa");
  fs.mkdirSync(path.join(dataRoot, "components", "cpa", "1.1.0"), { recursive: true });
  controller.pruneComponentVersions("cpa");
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, "components", "cpa")).sort(), ["1.0.0", "1.2.0"]);
  assert.equal(fs.readdirSync(path.join(dataRoot, "Trash", "managed-components", "cpa")).length, 1);
  controller.dispose();
});
