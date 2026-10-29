require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
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
  STAGE_DIRECTORY, sweepUpdateLeftovers, commitAppliedUpdate, handOffUpdateRecovery, readJournal, waitForUpdateApply,
  AUTO_INSTALL_FAILURE_LIMIT,
} = require("../electron/app-update.cjs");
const { createJournal, recordResult, rollBack, rollForward, swapIn, writeJsonDurable } = require("../electron/app-update-worker.cjs");
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
    bunVersion: "1.4.3", playwright: "1.62.0", launcher: "bin/codex-chatgpt-web.cmd",
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
    // The fixture is a Windows x64 bundle, checked as one on every CI runner (Linux and macOS too).
    assert.equal(await waitForPackagedRuntimeSource({
      app: { isPackaged: true, getVersion: () => "0.8.0" },
      resourcesPath: path.join(installed, "resources"), timeoutMs: 0, platform: "win32", arch: "x64",
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

const sha = (content) => createHash("sha256").update(content).digest("hex");
const runtimeManifest = (version) => JSON.stringify({ appVersion: version });
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split("/")));
const readResult = (installRoot) => JSON.parse(read(installRoot, "_update/last-result.json"));

/** An install at v1 with v2 staged: app.asar and the runtime manifest change, old.js goes. */
function updateFixture(root, { version = "0.8.0", stagedRuntime = version } = {}) {
  const installRoot = path.join(root, "install");
  const stageRoot = path.join(installRoot, "_update", "stage-x");
  const filesRoot = path.join(stageRoot, "files");
  writeTree(installRoot, {
    "resources/app.asar": "v1", "resources/runtime/manifest.json": runtimeManifest("0.7.0"), "resources/old.js": "old",
  });
  const staged = { "resources/app.asar": "v2", "resources/runtime/manifest.json": runtimeManifest(stagedRuntime), "resources/new.js": "new" };
  writeTree(filesRoot, staged);
  const job = {
    version, parentPid: deadPid(), installRoot, stageRoot, filesRoot, executable: process.execPath,
    changed: Object.keys(staged), obsolete: ["resources/old.js"],
    installedManifest: { version, files: Object.entries(staged).map(([rel, content]) => ({ path: rel, size: content.length, sha256: sha(content) })) },
    logPath: path.join(root, "worker.log"),
  };
  const jobPath = path.join(stageRoot, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job));
  return { installRoot, stageRoot, filesRoot, job, jobPath, journalPath: path.join(installRoot, "_update", "journal.json") };
}

function runWorker(args, script = workerPath) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("the worker applies the update after the app has closed, keeps the old files until the new version starts, and starts it", async () => {
  const root = tempRoot();
  try {
    const { installRoot, stageRoot, job, jobPath, journalPath } = updateFixture(root);
    runWorker([jobPath]);
    assert.equal(read(installRoot, "resources/app.asar"), "v2");
    assert.equal(read(installRoot, "resources/new.js"), "new");
    assert.equal(exists(installRoot, "resources/old.js"), false);
    assert.equal(JSON.parse(read(installRoot, "_update/installed.json")).version, "0.8.0");
    assert.match(fs.readFileSync(job.logPath, "utf8"), /v0\.8\.0 applied: 3 file\(s\) replaced, 1 removed/);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    assert.equal(journal.state, "placed");
    assert.equal(read(installRoot, `resources/app.asar.old-${journal.stamp}`), "v1", "the last good copy is kept");
    assert.ok(fs.existsSync(stageRoot), "the stage stays until the new version commits");
    assert.deepEqual([readResult(installRoot).ok, readResult(installRoot).stage], [true, "placed"]);
    assert.equal(exists(installRoot, "_update/applying.json"), false);

    // The new version reached whenReady: the old copies and the stage go.
    assert.equal(await commitAppliedUpdate(installRoot, "0.7.9"), null, "another version commits nothing");
    assert.deepEqual(await commitAppliedUpdate(installRoot, "0.8.0"), { version: "0.8.0", removed: 3, leftover: 0 });
    assert.equal(exists(installRoot, `resources/app.asar.old-${journal.stamp}`), false);
    assert.equal(exists(installRoot, `resources/old.js.old-${journal.stamp}`), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(stageRoot), false);
    assert.equal(readResult(installRoot).stage, "started");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the worker undoes an update whose runtime is another version, and records the failure", () => {
  const root = tempRoot();
  try {
    const { installRoot, jobPath, journalPath } = updateFixture(root, { stagedRuntime: "0.7.5" });
    runWorker([jobPath]);
    assert.equal(read(installRoot, "resources/app.asar"), "v1");
    assert.equal(read(installRoot, "resources/old.js"), "old");
    assert.equal(exists(installRoot, "resources/new.js"), false, "a file the update added is taken out again");
    assert.equal(JSON.parse(read(installRoot, "resources/runtime/manifest.json")).appVersion, "0.7.0");
    assert.equal(fs.existsSync(journalPath), false);
    const result = readResult(installRoot);
    assert.deepEqual([result.ok, result.stage, result.failures], [false, "apply", 1]);
    assert.match(result.message, /runtime is v0\.7\.5, not v0\.8\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The swap as a worker killed after placing new.js and setting app.asar aside left it. */
function cutOffSwap(fixture) {
  const { installRoot, filesRoot, job, jobPath, journalPath } = fixture;
  const journal = createJournal(job, jobPath, 77);
  writeJsonDurable(journalPath, journal);
  fs.renameSync(path.join(filesRoot, "resources", "new.js"), path.join(installRoot, "resources", "new.js"));
  fs.renameSync(path.join(installRoot, "resources", "app.asar"), path.join(installRoot, "resources", "app.asar.old-77"));
  fs.writeFileSync(path.join(installRoot, "_update", "applying.json"), JSON.stringify({ pid: job.parentPid, at: 1, jobPath, journal: journalPath }));
  return journal;
}

test("a swap cut off midway is handed to a worker at the next start, which finishes it from the staged files", async () => {
  const root = tempRoot();
  try {
    const fixture = updateFixture(root);
    const { installRoot, journalPath } = fixture;
    cutOffSwap(fixture);
    assert.equal(await waitForUpdateApply(installRoot, { alive: () => false }), true);
    const spawned = [];
    const spawnWorker = (runtime, args) => { spawned.push(args); return { pid: 4243, unref() {} }; };
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.7.0", executable: process.execPath, spawnWorker }), true);
    const [workerScript, mode, handedJournal] = spawned[0];
    assert.deepEqual([mode, handedJournal], ["--recover", journalPath]);
    assert.ok(fs.existsSync(workerScript), "the worker is written from the running app, not taken from the stage");

    runWorker(["--recover", journalPath, String(deadPid())], workerScript);
    assert.equal(read(installRoot, "resources/app.asar"), "v2");
    assert.equal(read(installRoot, "resources/new.js"), "new");
    assert.equal(exists(installRoot, "resources/old.js"), false);
    assert.equal(JSON.parse(read(installRoot, "resources/runtime/manifest.json")).appVersion, "0.8.0");
    assert.equal(read(installRoot, "resources/app.asar.old-77"), "v1", "kept for a rollback until the new version starts");
    assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).state, "placed");
    assert.equal(readResult(installRoot).ok, true);
    assert.equal(exists(installRoot, "_update/applying.json"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cut-off swap whose staged files are gone is undone, and a worker that keeps dying is given up on", () => {
  const root = tempRoot();
  try {
    const fixture = updateFixture(root);
    const { installRoot, stageRoot, journalPath } = fixture;
    cutOffSwap(fixture);
    fs.rmSync(path.join(stageRoot, "files", "resources", "app.asar"));
    runWorker(["--recover", journalPath, String(deadPid())]);
    assert.equal(read(installRoot, "resources/app.asar"), "v1");
    assert.equal(read(installRoot, "resources/old.js"), "old");
    assert.equal(exists(installRoot, "resources/new.js"), false);
    assert.equal(exists(installRoot, "resources/app.asar.old-77"), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(stageRoot), false);
    const result = readResult(installRoot);
    assert.deepEqual([result.ok, result.stage, result.failures], [false, "recover", 1]);

    // A recovery worker that never finishes is started twice, then the app starts as it is.
    writeJsonDurable(journalPath, { ...createJournal(fixture.job, fixture.jobPath, 78), installRoot });
    const spawnWorker = () => ({ pid: 4244, unref() {} });
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.7.0", spawnWorker }), true);
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.7.0", spawnWorker }), true);
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.7.0", spawnWorker }), false);
    assert.equal(fs.existsSync(journalPath), false);
    // A refused worker start lets the app go on starting.
    writeJsonDurable(journalPath, { ...createJournal(fixture.job, fixture.jobPath, 79), installRoot });
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.7.0", spawnWorker: () => ({}) }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new version that fails to start, or keeps crashing before whenReady, is undone and the old one starts", () => {
  const root = tempRoot();
  try {
    const fixture = updateFixture(root);
    const { installRoot, jobPath, journalPath } = fixture;
    runWorker([jobPath]);
    const spawned = [];
    const spawnWorker = (_runtime, args) => { spawned.push(args); return { pid: 4245, unref() {} }; };
    // Starts that reach whenReady commit; a start that has not yet is no reason to undo anything.
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.8.0", spawnWorker }), false);
    assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).launches, 1);
    assert.equal(handOffUpdateRecovery(installRoot, { currentVersion: "0.8.0", spawnWorker, startFailed: "Runtime bundle file is missing: x" }), true);
    assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).state, "restoring");
    let result = readResult(installRoot);
    assert.deepEqual([result.ok, result.stage, result.failures, result.message], [false, "start", 1, "Runtime bundle file is missing: x"]);

    runWorker(["--recover", journalPath, String(deadPid())]);
    assert.equal(read(installRoot, "resources/app.asar"), "v1");
    assert.equal(read(installRoot, "resources/old.js"), "old");
    assert.equal(exists(installRoot, "resources/new.js"), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(readResult(installRoot).failures, 1, "the restore itself is not another failure");
    recordResult(installRoot, { version: "0.8.0", ok: true, stage: "placed" });
    assert.equal(readResult(installRoot).failures, 1, "placing the files again does not clear the count");
    recordResult(installRoot, { version: "0.8.0", ok: false, stage: "start" });
    assert.equal(readResult(installRoot).failures, 2);
    recordResult(installRoot, { version: "0.8.0", ok: true, stage: "started" });
    assert.equal(readResult(installRoot).failures, 0, "a start that reached whenReady clears it");

    // Native crashes skip start()'s catch: the fourth start without a commit undoes the update.
    const again = updateFixture(path.join(root, "again"));
    runWorker([again.jobPath]);
    for (let start = 1; start <= 3; start += 1) {
      assert.equal(handOffUpdateRecovery(again.installRoot, { currentVersion: "0.8.0", spawnWorker }), false, `start ${start}`);
    }
    assert.equal(handOffUpdateRecovery(again.installRoot, { currentVersion: "0.8.0", spawnWorker }), true);
    result = readResult(again.installRoot);
    assert.deepEqual([result.stage, result.failures], ["start", 1]);
    assert.match(result.message, /did not finish starting 3 times/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a swap killed between keeping the old copy and placing the new one is finished or undone either way", async () => {
  const root = tempRoot();
  try {
    for (const direction of ["forward", "back"]) {
      const fixture = updateFixture(path.join(root, direction));
      const { installRoot, job, jobPath } = fixture;
      const journal = createJournal(job, jobPath, 88);
      // The hard link is made; the rename over app.asar never ran.
      fs.linkSync(path.join(installRoot, "resources", "app.asar"), path.join(installRoot, "resources", "app.asar.old-88"));
      if (direction === "forward") {
        assert.equal(await rollForward(journal), true);
        assert.equal(read(installRoot, "resources/app.asar"), "v2");
        assert.equal(read(installRoot, "resources/app.asar.old-88"), "v1");
      } else {
        assert.deepEqual(await rollBack(journal), []);
        assert.equal(read(installRoot, "resources/app.asar"), "v1");
        assert.equal(exists(installRoot, "resources/app.asar.old-88"), false);
        assert.equal(read(installRoot, "_update/stage-x/files/resources/app.asar"), "v2", "the staged file is left as it was");
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a journal pointing outside the install is ignored", () => {
  const root = tempRoot();
  try {
    const fixture = updateFixture(root);
    const journal = createJournal(fixture.job, fixture.jobPath, 5);
    for (const bad of [{ filesRoot: root }, { installRoot: root }, { changed: [{ rel: "../evil" }] }, { schema: 2 }]) {
      writeJsonDurable(fixture.journalPath, { ...journal, ...bad });
      assert.equal(readJournal(fixture.installRoot), null, JSON.stringify(bad));
    }
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
    let turnRunning = true;
    const states = [];
    const controller = createAppUpdateController({
      currentVersion: "0.7.0", electronVersion: "41.10.7", platform: "win32", arch: "x64", packaged: true,
      executablePath: path.join(installRoot, "Coding Tools.exe"), logsDirectory: path.join(root, "logs"),
      publish: (state) => states.push(state), logger: null,
      closeForUpdate: async () => { closed += 1; return { ok: true }; },
      closeBlocker: () => (turnRunning ? "Wait for ChatGPT turn to finish before quitting Coding Tools" : null),
      dependencies: {
        fetchRelease: async () => [release("0.8.0", names)],
        downloadText: async (url) => fs.readFileSync(fromUrl(url), "utf8"),
        downloadFile: async (url, destination) => { downloads.push(path.basename(fromUrl(url))); fs.copyFileSync(fromUrl(url), destination); },
        spawnWorker: (_runtime, worker, job) => { workerJob = JSON.parse(fs.readFileSync(job, "utf8")); assert.ok(fs.existsSync(worker)); return { pid: 4242, unref() {} }; },
      },
    });
    assert.equal((await controller.checkNow()).status, "available");
    // While a ChatGPT turn keeps the app open, a click is refused before anything downloads.
    await assert.rejects(controller.beginInstall(), /Wait for ChatGPT turn to finish/);
    assert.deepEqual(downloads, []);
    assert.equal(closed, 0);
    assert.equal(controller.getState().status, "available");
    assert.equal(fs.existsSync(path.join(installRoot, STAGE_DIRECTORY)), false, "nothing staged");
    turnRunning = false;
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
  // Codex review of #653: running ChatGPT turns are stopped only for a whole-app install, which quits.
  calls.length = 0;
  const beforeAppInstall = async () => { calls.push("stop turns"); };
  await combineUpdateControllers(fake("app", "up-to-date"), fake("gui", "available")).beginInstall({ beforeAppInstall });
  await combineUpdateControllers(fake("app", "available"), fake("gui", "available")).beginInstall({ beforeAppInstall });
  assert.deepEqual(calls, ["gui", "stop turns", "app"]);
  // Declining to stop them installs nothing.
  calls.length = 0;
  await assert.rejects(combineUpdateControllers(fake("app", "available"), fake("gui", "available"))
    .beginInstall({ beforeAppInstall: async () => { throw new Error("Wait for ChatGPT turn to finish"); } }), /Wait for ChatGPT turn/);
  assert.deepEqual(calls, []);
});

function autoInstallerFixture(overrides = {}) {
  const calls = { install: 0 };
  const options = {
    status: "available", enabled: true, idle: 600, busy: false, clock: 0,
    install: async () => { calls.install += 1; return true; },
    ...overrides,
  };
  const installer = createAutoInstaller({
    controller: { getState: () => ({ status: options.status, version: "9.9.9", kind: "app", ...options.state }), beginInstall: () => options.install() },
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

test("a version that failed to apply waits twice as long after each failure, and after three only installs by a click", async () => {
  const hour = 60 * 60 * 1000;
  const { installer, calls, options } = autoInstallerFixture({ state: { failedAttempts: 1, failedAt: 0 } });
  options.clock = 2 * hour - 1;
  assert.equal(await installer.tick(), false);
  options.clock = 2 * hour;
  assert.equal(await installer.tick(), true);
  options.state = { failedAttempts: 2, failedAt: 2 * hour };
  options.clock = 5 * hour;
  assert.equal(await installer.tick(), false, "four hours after the second failure, not three");
  options.clock = 6 * hour;
  assert.equal(await installer.tick(), true);
  options.state = { failedAttempts: AUTO_INSTALL_FAILURE_LIMIT, failedAt: 0 };
  options.clock = 1000 * hour;
  assert.equal(await installer.tick(), false);
  assert.equal(calls.install, 2);
});

test("the controller reports how often the available version failed to apply", async () => {
  const root = tempRoot();
  try {
    const installRoot = path.join(root, "install");
    writeTree(installRoot, {
      "resources/app.asar": "v1",
      "_update/last-result.json": JSON.stringify({ version: "0.8.0", ok: false, stage: "apply", message: "EPERM", failures: 2, at: 1234 }),
    });
    const controller = createAppUpdateController({
      currentVersion: "0.7.0", electronVersion: "41.10.7", platform: "win32", arch: "x64", packaged: true,
      executablePath: path.join(installRoot, "Coding Tools.exe"), logsDirectory: path.join(root, "logs"),
      dependencies: { fetchRelease: async () => [release("0.8.0", [manifestAssetName("0.8.0", "win_x64"), "SHA256SUMS.txt"])] },
    });
    const state = await controller.checkNow();
    assert.deepEqual([state.status, state.failedAttempts, state.failedAt, state.failureMessage], ["available", 2, 1234, "EPERM"]);
    fs.writeFileSync(path.join(installRoot, "_update", "last-result.json"), JSON.stringify({ version: "0.7.9", ok: false, failures: 5 }));
    assert.equal((await controller.checkNow()).failedAttempts, undefined, "another version's failures do not count");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
