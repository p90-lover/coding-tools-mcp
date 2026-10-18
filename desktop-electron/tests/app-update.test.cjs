const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createHash } = require("node:crypto");

const {
  combineUpdateControllers, combinedUpdateState, createAppUpdateController, createAutoInstaller, extractPack,
  manifestAssetName, packAssetName, parseManifest, planUpdate, safeInstallPath, selectAppRelease,
  sweepUpdateLeftovers,
} = require("../electron/app-update.cjs");
const { swapIn } = require("../electron/app-update-worker.cjs");
const { waitForPackagedRuntimeSource } = require("../electron/runtime-install.cjs");
const { buildAppUpdate, packFor } = require("../scripts/package-app-update.cjs");

const workerPath = path.join(__dirname, "..", "electron", "app-update-worker.cjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "app-update-test-"));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function writeRuntime(appRoot, version) {
  writeTree(appRoot, {
    "resources/runtime/runtime/bun.exe": "bun fixture",
    "resources/runtime/app/cli.js": "cli fixture",
    "resources/runtime/app/browser-helper.cjs": "helper fixture",
    "resources/runtime/bin/codex-chatgpt-web.cmd": "@echo off",
  });
  const runtime = path.join(appRoot, "resources", "runtime");
  const files = fs.readdirSync(runtime, { recursive: true })
    .filter(rel => rel !== "manifest.json" && fs.statSync(path.join(runtime, rel)).isFile())
    .map(rel => {
      const content = fs.readFileSync(path.join(runtime, rel));
      return { path: rel.split(path.sep).join("/"), size: content.length,
        sha256: createHash("sha256").update(content).digest("hex") };
    })
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256");
  for (const file of files) digest.update(file.path + "\0" + file.size + "\0" + file.sha256 + "\0");
  fs.writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify({
    schemaVersion: 2, appVersion: version, platform: "win32", arch: "x64",
    bunVersion: "1.4.0", playwright: "1.62.0", launcher: "bin/codex-chatgpt-web.cmd",
    entrypoint: "app/cli.js", bundleId: digest.digest("hex"), files,
  }));
}

test("update publication rejects an older or corrupt runtime before writing any release asset", async () => {
  const root = tempRoot();
  try {
    const appRoot = path.join(root, "app");
    const output = path.join(root, "out");
    writeTree(appRoot, { "resources/app.asar": "launcher rc23 fixture" });
    writeRuntime(appRoot, "0.7.0-rc.22");
    await assert.rejects(buildAppUpdate({ appRoot, output, version: "0.7.0-rc.23", electron: "41.10.7" }),
      /identity mismatch.*0\.7\.0-rc\.23.*0\.7\.0-rc\.22/s);
    assert.equal(fs.existsSync(output), false);
    writeRuntime(appRoot, "0.7.0-rc.23");
    fs.writeFileSync(path.join(appRoot, "resources", "runtime", "runtime", "bun.exe"), "bad fixture");
    await assert.rejects(buildAppUpdate({ appRoot, output, version: "0.7.0-rc.23", electron: "41.10.7" }),
      /checksum mismatch/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

test("install paths stay inside the install and out of the stage folder", () => {
  assert.equal(safeInstallPath("resources/app.asar"), "resources/app.asar");
  assert.equal(safeInstallPath("Coding Tools.exe"), "Coding Tools.exe");
  for (const bad of ["../x", "/abs", "C:/x", "a\\b", "resources/../x", "_update/job.json", "resources/con.txt", "dir/", "a/./b", "x."]) {
    assert.equal(safeInstallPath(bad), null, bad);
  }
});

test("files group into packs by resources folder", () => {
  assert.equal(packFor("Coding Tools.exe"), "framework");
  assert.equal(packFor("locales/en-US.pak"), "framework");
  assert.equal(packFor("resources/app.asar"), "app");
  assert.equal(packFor("resources/agent-orchestrator/ao-daemon.exe"), "agent-orchestrator");
  assert.equal(packFor("resources/agent-orchestrator/renderer/index.html"), "agent-orchestrator-renderer");
  assert.equal(packFor("resources/app.asar.unpacked/node_modules/x/y.node"), "app-asar-unpacked-node-modules");
});

test("a release update installs only the files that changed", async () => {
  const root = tempRoot();
  try {
    const next = path.join(root, "next");
    const installed = path.join(root, "install");
    const assets = path.join(root, "assets");
    writeTree(next, {
      "Coding Tools.exe": "exe v2 stamp",
      "resources/app.asar": "asar v2",
      "resources/agent-orchestrator/ao-daemon.exe": "daemon same",
      "resources/agent-orchestrator/renderer/index.html": "<html>v2</html>",
      "resources/runtime/app/new.js": "new file",
      "resources/empty.txt": "",
    });
    writeTree(installed, {
      "Coding Tools.exe": "exe v1 stamp",
      "resources/app.asar": "asar v1",
      "resources/agent-orchestrator/ao-daemon.exe": "daemon same",
      "resources/agent-orchestrator/renderer/index.html": "<html>v1</html>",
      "resources/runtime/app/gone.js": "dropped",
    });
    writeRuntime(next, "0.8.0");
    writeRuntime(installed, "0.8.0");
    const built = await buildAppUpdate({ appRoot: next, output: assets, version: "0.8.0", electron: "41.10.7" });
    const manifestText = fs.readFileSync(path.join(assets, built.manifestName), "utf8");
    const manifest = parseManifest(manifestText, { version: "0.8.0", tag: "win_x64" });

    const previous = { files: [{ path: "resources/runtime/app/gone.js" }, { path: "resources/app.asar" }] };
    const checks = [];
    const plan = await planUpdate({
      manifest, installRoot: installed, electronVersion: "41.10.7", previous,
      onProgress: (done, total) => checks.push([done, total]),
    });
    // Every non-framework file is checked once, and the count climbs to the total.
    const checkedFiles = manifest.files.length - 1;
    assert.deepEqual(checks, Array.from({ length: checkedFiles }, (_, i) => [i + 1, checkedFiles]));
    assert.deepEqual(plan.changed.map((file) => file.path).sort(), [
      "resources/agent-orchestrator/renderer/index.html", "resources/app.asar", "resources/empty.txt", "resources/runtime/app/new.js",
      "resources/runtime/manifest.json",
    ]);
    assert.deepEqual(plan.obsolete, ["resources/runtime/app/gone.js"]);
    assert.equal(plan.withFramework, false, "the same Electron keeps its own files");
    assert.ok(!plan.packs.some((pack) => pack.name === "agent-orchestrator"), "an unchanged pack is not downloaded");

    const stage = path.join(root, "stage");
    for (const pack of plan.packs) {
      const wanted = new Map(plan.changed.filter((file) => file.pack === pack.name).map((file) => [file.path, file]));
      await extractPack(path.join(assets, packAssetName("0.8.0", "win_x64", pack.name)), wanted, stage);
    }
    const journal = await swapIn({
      installRoot: installed, filesRoot: stage, changed: plan.changed.map((file) => file.path), obsolete: plan.obsolete,
    }, 123);
    assert.equal(read(installed, "resources/app.asar"), "asar v2");
    assert.equal(read(installed, "resources/runtime/app/new.js"), "new file");
    assert.equal(read(installed, "resources/empty.txt"), "");
    assert.equal(read(installed, "Coding Tools.exe"), "exe v1 stamp");
    assert.equal(fs.existsSync(path.join(installed, "resources", "runtime", "app", "gone.js")), false);
    assert.equal(read(installed, "resources/app.asar.old-123"), "asar v1", "the old file is set aside, not lost");
    assert.equal(journal.filter((entry) => entry.aside).length, 4);
    assert.equal(await waitForPackagedRuntimeSource({
      app: { isPackaged: true, getVersion: () => "0.8.0" },
      resourcesPath: path.join(installed, "resources"), timeoutMs: 0,
    }), path.join(installed, "resources", "runtime"));

    const newElectron = await planUpdate({ manifest, installRoot: installed, electronVersion: "40.0.0" });
    assert.deepEqual(newElectron.changed.map((file) => file.path), ["Coding Tools.exe"], "a new Electron replaces its own files");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt pack file is refused", async () => {
  const root = tempRoot();
  try {
    writeTree(path.join(root, "app"), { "resources/app.asar": "asar" });
    writeRuntime(path.join(root, "app"), "1.0.0");
    const built = await buildAppUpdate({ appRoot: path.join(root, "app"), output: path.join(root, "out"), version: "1.0.0", electron: "1" });
    const wanted = new Map([["resources/app.asar", { size: 4, sha256: "0".repeat(64) }]]);
    await assert.rejects(
      extractPack(path.join(root, "out", packAssetName("1.0.0", "win_x64", built.packs[0].name)), wanted, path.join(root, "stage")),
      /SHA-256/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed swap puts every file back", async () => {
  const root = tempRoot();
  try {
    writeTree(root, { "install/resources/a.txt": "old a", "stage/resources/a.txt": "new a" });
    await assert.rejects(swapIn({
      installRoot: path.join(root, "install"), filesRoot: path.join(root, "stage"),
      changed: ["resources/a.txt", "resources/missing.txt"], obsolete: [],
    }, 9), /missing/);
    assert.equal(read(root, "install/resources/a.txt"), "old a");
    assert.equal(read(root, "stage/resources/a.txt"), "new a");
    assert.equal(fs.existsSync(path.join(root, "install", "resources", "a.txt.old-9")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the worker applies the update after the app has closed and starts it again", () => {
  const root = tempRoot();
  try {
    const installRoot = path.join(root, "install");
    const stageRoot = path.join(installRoot, "_update", "stage-x");

    writeTree(installRoot, { "resources/app.asar": "v1" });
    writeTree(stageRoot, { "files/resources/app.asar": "v2" });

    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    const job = {
      version: "0.8.0", parentPid: dead, installRoot, stageRoot, filesRoot: path.join(stageRoot, "files"),
      executable: process.execPath, changed: ["resources/app.asar"], obsolete: [],
      installedManifest: { version: "0.8.0", files: [{ path: "resources/app.asar", size: 2, sha256: "x" }] },
      logPath: path.join(root, "worker.log"),
    };
    fs.writeFileSync(path.join(stageRoot, "job.json"), JSON.stringify(job));
    const result = spawnSync(process.execPath, [workerPath, path.join(stageRoot, "job.json")], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(installRoot, "resources/app.asar"), "v2");
    assert.equal(fs.existsSync(path.join(installRoot, "resources", "app.asar.old-1")), false);
    assert.equal(JSON.parse(read(installRoot, "_update/installed.json")).version, "0.8.0");
    assert.equal(fs.existsSync(stageRoot), false, "the stage folder is removed");
    assert.match(fs.readFileSync(job.logPath, "utf8"), /v0\.8\.0 applied: 1 file\(s\) replaced/);

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("leftovers still running at update time are removed on a later start", () => {
  const root = tempRoot();
  try {
    writeTree(root, { "resources/x.exe.old-5": "old", "_update/set-aside.json": JSON.stringify(["resources/x.exe.old-5", "../evil.old-1"]) });
    assert.equal(sweepUpdateLeftovers(root), 1);
    assert.equal(fs.existsSync(path.join(root, "resources", "x.exe.old-5")), false);
    assert.equal(fs.existsSync(path.join(root, "_update", "set-aside.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function release(version, names, { draft = false } = {}) {
  return {
    tag_name: `v${version}`, draft,
    assets: names.map((name) => ({ name, browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${version}/${name}` })),
  };
}

test("the newest release with a whole-app update is chosen, not one with only an installer", () => {
  const payload = [
    release("0.7.0-rc.15", ["Coding.Tools_0.7.0-rc.15_windows_x64_setup.exe", "SHA256SUMS.txt"]),
    release("0.7.0-rc.16", [manifestAssetName("0.7.0-rc.16", "win_x64"), "SHA256SUMS.txt"]),
    release("0.7.0-rc.17", [manifestAssetName("0.7.0-rc.17", "win_x64"), "SHA256SUMS.txt"], { draft: true }),
    release("0.7.0-rc.13", [manifestAssetName("0.7.0-rc.13", "win_x64"), "SHA256SUMS.txt"]),
  ];
  assert.equal(selectAppRelease(payload, "0.7.0-rc.14", "win_x64").version, "0.7.0-rc.16");
  assert.equal(selectAppRelease(payload, "0.7.0-rc.16", "win_x64"), null);
});

test("the controller stages the update, starts the worker and closes the app keeping the bridge", async () => {
  const root = tempRoot();
  try {
    const installRoot = path.join(root, "install");
    const assets = path.join(root, "assets");
    writeTree(installRoot, { "Coding Tools.exe": "exe", "resources/app.asar": "v1", "resources/runtime/a.js": "same" });
    writeTree(path.join(root, "next"), { "Coding Tools.exe": "exe2", "resources/app.asar": "v2", "resources/runtime/a.js": "same" });
    writeRuntime(installRoot, "0.8.0");
    writeRuntime(path.join(root, "next"), "0.8.0");
    const built = await buildAppUpdate({ appRoot: path.join(root, "next"), output: assets, version: "0.8.0", electron: "41.10.7" });
    fs.writeFileSync(path.join(assets, "SHA256SUMS.txt"), `${built.sums.join("\n")}\n`);
    const names = fs.readdirSync(assets);
    const fromUrl = (url) => path.join(assets, decodeURIComponent(url.split("/").pop()));
    const downloads = [];
    let workerJob = null;
    let closed = 0;
    const states = [];
    const controller = createAppUpdateController({
      currentVersion: "0.7.0", electronVersion: "41.10.7", platform: "win32", arch: "x64", packaged: true,
      executablePath: path.join(installRoot, "Coding Tools.exe"), logsDirectory: path.join(root, "logs"),
      publish: (state) => states.push(state), logger: null,
      closeForUpdate: async () => { closed += 1; return { ok: true }; },
      dependencies: {
        fetchRelease: async () => [release("0.8.0", names)],
        downloadText: async (url) => fs.readFileSync(fromUrl(url), "utf8"),
        downloadFile: async (url, destination) => { downloads.push(path.basename(fromUrl(url))); fs.copyFileSync(fromUrl(url), destination); },
        spawnWorker: (_runtime, worker, job) => { workerJob = JSON.parse(fs.readFileSync(job, "utf8")); assert.ok(fs.existsSync(worker)); return { pid: 4242, unref() {} }; },
      },
    });
    assert.equal((await controller.checkNow()).status, "available");
    assert.equal(await controller.beginInstall(), true);
    assert.equal(closed, 1);
    assert.deepEqual(downloads, [packAssetName("0.8.0", "win_x64", "app")], "only the pack holding app.asar is downloaded");
    assert.deepEqual(workerJob.changed, ["resources/app.asar"]);
    assert.equal(fs.readFileSync(path.join(workerJob.filesRoot, "resources", "app.asar"), "utf8"), "v2");
    assert.equal(controller.getState().status, "installing");
    assert.ok(states.some((state) => state.status === "downloading" && state.progress === 1));
    // The bar moves while installed files are checked, before any pack downloads, and never goes back.
    const progress = states.filter((state) => state.status === "downloading").map((state) => state.progress);
    assert.ok(progress.some((value) => value > 0 && value <= 0.2), JSON.stringify(progress));
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an app update outranks a GUI-only update, which still installs on its own", async () => {
  assert.equal(combinedUpdateState({ status: "available", version: "0.8.0", kind: "app" }, { status: "available", version: "r2" }).version, "0.8.0");
  assert.equal(combinedUpdateState({ status: "up-to-date" }, { status: "available", version: "r2" }).version, "r2");
  assert.equal(combinedUpdateState({ status: "disabled" }, { status: "disabled" }).status, "disabled");
  const calls = [];
  const fake = (name, status) => ({
    getState: () => ({ status }), checkNow: async () => ({ status }), checkOnce: async () => ({ status }),
    beginInstall: async () => { calls.push(name); return true; }, startPeriodicChecks() {}, stopPeriodicChecks() {},
    getRendererPath: () => "index.html",
  });
  await combineUpdateControllers(fake("app", "up-to-date"), fake("gui", "available")).beginInstall();
  await combineUpdateControllers(fake("app", "available"), fake("gui", "available")).beginInstall();
  assert.deepEqual(calls, ["gui", "app"]);
});

function autoInstallerFixture(overrides = {}) {
  const calls = { install: 0 };
  const options = {
    status: "available", enabled: true, idle: 600, busy: false, clock: 0,
    install: async () => { calls.install += 1; return true; },
    ...overrides,
  };
  const installer = createAutoInstaller({
    controller: { getState: () => ({ status: options.status, version: "9.9.9", kind: "app" }), beginInstall: () => options.install() },
    enabled: () => options.enabled,
    idleSeconds: () => options.idle,
    isBusy: async () => {
      if (options.busy instanceof Error) throw options.busy;
      return options.busy;
    },
    now: () => options.clock,
  });
  return { installer, calls, options };
}

test("automatic updates install a found update once the user is away and nothing runs", async () => {
  const { installer, calls } = autoInstallerFixture();
  assert.equal(await installer.tick(), true);
  assert.equal(calls.install, 1);
});

test("an automatic update waits for an idle user, finished work and the setting", async () => {
  for (const overrides of [
    { idle: 599 },
    { busy: true },
    { busy: new Error("AO is not reachable") },
    { enabled: false },
    { status: "up-to-date" },
    { status: "downloading" },
  ]) {
    const { installer, calls } = autoInstallerFixture(overrides);
    assert.equal(await installer.tick(), false, JSON.stringify(overrides));
    assert.equal(calls.install, 0, JSON.stringify(overrides));
  }
});

test("a failed automatic update waits an hour before trying again", async () => {
  const { installer, calls, options } = autoInstallerFixture({
    install: async () => { calls.install += 1; throw new Error("network down"); },
  });
  assert.equal(await installer.tick(), false);
  options.clock = 59 * 60 * 1000;
  assert.equal(await installer.tick(), false);
  assert.equal(calls.install, 1);
  options.clock = 60 * 60 * 1000;
  options.install = async () => { calls.install += 1; return true; };
  assert.equal(await installer.tick(), true);
  assert.equal(calls.install, 2);
});

test("a launch during an update's file swap waits for it; a marker whose worker is gone is cleared", async () => {
  const { waitForUpdateApply } = require("../electron/app-update.cjs");
  const fsMod = require("node:fs");
  const osMod = require("node:os");
  const pathMod = require("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "app-update-apply-"));
  const marker = pathMod.join(root, "_update", "applying.json");
  try {
    assert.equal(await waitForUpdateApply(root), false, "no update applying: no wait");
    fsMod.mkdirSync(pathMod.dirname(marker), { recursive: true });
    fsMod.writeFileSync(marker, JSON.stringify({ pid: 4242, at: 1000 }));
    let checks = 0;
    const waited = await waitForUpdateApply(root, { now: () => 2000, sleep: async () => { if (++checks === 3) fsMod.rmSync(marker); }, alive: () => true });
    assert.equal(waited, false, "returned once the worker removed its marker");
    assert.equal(checks, 3);
    fsMod.writeFileSync(marker, JSON.stringify({ pid: 4242, at: 1000 }));
    assert.equal(await waitForUpdateApply(root, { now: () => 2000, sleep: async () => {}, alive: () => false }), true);
    assert.equal(fsMod.existsSync(marker), false, "a dead worker's marker is removed");
    fsMod.writeFileSync(marker, JSON.stringify({ pid: 4242, at: 0 }));
    assert.equal(await waitForUpdateApply(root, { now: () => 11 * 60_000, sleep: async () => {}, alive: () => true }), true, "never waits past the cap");
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});
