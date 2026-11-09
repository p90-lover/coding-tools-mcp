"use strict";

require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  GRACE_MS, MAX_MS, NOTE_NAME, PARENT_WAIT_MS, consumeRelaunchNote, guardRelaunch, installerRunning, listsInstaller, parseArguments, spawnRelaunchGuard,
} = require("../electron/relaunch-guard.cjs");

const GUARD = path.join(__dirname, "..", "electron", "relaunch-guard.cjs");
const MINUTE = 60_000;
const options = { parentPid: 500, executable: "H:\\Apps\\Coding Tools\\Coding Tools.exe", descriptorPath: "G:\\AppData\\.coding-tools\\runtime\\launcher-browser.json" };

/**
 * The guard against a clock that moves only when it sleeps. `parentExitsAt`, `newApp` ({ at, pid })
 * and `installer` ({ from, to }) are minutes since the quit; `executable` false means none is installed.
 */
function scenario({ parentExitsAt = 0.5, newApp = null, installer = null, executable = true } = {}) {
  let t = 0;
  const minutes = () => t / MINUTE;
  const launches = [], notes = [], listings = [];
  const deps = {
    now: () => t,
    wait: async (ms) => { t += ms; },
    alive: (pid) => (pid === options.parentPid ? minutes() < parentExitsAt : newApp !== null && pid === newApp.pid),
    appPid: () => (newApp && minutes() >= newApp.at ? newApp.pid : null),
    installing: () => { listings.push(minutes()); return Boolean(installer && minutes() >= installer.from && minutes() < installer.to); },
    present: () => executable,
    launch: (file) => launches.push({ file, at: minutes() }),
    note: (value) => notes.push(value),
  };
  return { deps, launches, notes, listings, run: () => guardRelaunch(options, deps) };
}

// 2026-11-02 14:21: an install script's keep-bridge quit closed the app and then nothing happened.
test("after a keep-bridge quit nobody finishes, the guard starts the installed app and says why", async () => {
  const s = scenario({ parentExitsAt: 0.5 });
  const result = await s.run();
  assert.equal(result.outcome, "relaunched");
  assert.deepEqual(s.launches.map((launch) => launch.file), [options.executable]);
  const startedAfter = s.launches[0].at - 0.5;
  assert.ok(startedAfter >= GRACE_MS / MINUTE && startedAfter < GRACE_MS / MINUTE + 1, `started ${startedAfter} min after the app exited`);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].by, "relaunch-guard");
  assert.equal(s.notes[0].quitPid, options.parentPid);
  assert.equal(s.notes[0].installerSeen, false);
  assert.match(s.notes[0].reason, /nothing installed or started the app/);
});

test("an app someone else started is left alone; a descriptor the old app left behind does not count", async () => {
  const started = scenario({ newApp: { at: 3, pid: 777 } });
  assert.deepEqual(await started.run(), { outcome: "app-started", pid: 777 });
  assert.deepEqual([started.launches, started.notes], [[], []]);

  const stale = scenario({ newApp: { at: 0, pid: options.parentPid } });
  assert.equal((await stale.run()).outcome, "relaunched");
});

test("a running installer holds the start until a grace period after it ends, with one process listing per period", async () => {
  const s = scenario({ installer: { from: 2, to: 18 } });
  const result = await s.run();
  assert.equal(result.outcome, "relaunched");
  assert.equal(result.installerSeen, true);
  assert.equal(s.launches.length, 1);
  assert.ok(s.launches[0].at >= 18, "never started while the installer runs");
  assert.ok(s.launches[0].at <= 18 + GRACE_MS / MINUTE + 1, `started at minute ${s.launches[0].at}`);
  for (let index = 1; index < s.listings.length; index += 1) {
    assert.ok(s.listings[index] - s.listings[index - 1] >= GRACE_MS / MINUTE, `listed at ${s.listings.join(", ")}`);
  }
  assert.match(s.notes[0].reason, /an installer ran/);
});

test("the guard gives up rather than start an app over an installer, a missing app or one that never exits", async () => {
  const installing = scenario({ installer: { from: 0, to: 600 } });
  assert.equal((await installing.run()).outcome, "installer-still-running");
  assert.deepEqual(installing.launches, []);
  assert.ok(installing.listings.at(-1) >= MAX_MS / MINUTE, "held until the cap");

  const missing = scenario({ executable: false });
  assert.equal((await missing.run()).outcome, "no-app-to-start");
  assert.deepEqual(missing.launches, []);

  const stillRunning = scenario({ parentExitsAt: Infinity });
  assert.equal((await stillRunning.run()).outcome, "app-still-running");
  assert.deepEqual([stillRunning.launches, stillRunning.listings], [[], []]);
  assert.ok(PARENT_WAIT_MS < MAX_MS);
});

test("installer processes are found by the names install scripts wait out; an unreadable listing counts as one", () => {
  const listing = (...names) => ({ status: 0, stdout: names.map((name) => `"${name}","4242","Console","1","10,000 K"`).join("\r\n") });
  assert.equal(listsInstaller(listing("explorer.exe", "bun.exe", "Coding Tools.exe")), false);
  assert.equal(listsInstaller(listing("explorer.exe", "Coding.Tools_0.8.105_win_x64.exe")), true);
  assert.equal(listsInstaller(listing("old-uninstaller.exe")), true);
  assert.equal(listsInstaller(listing("Un_A.exe")), true);
  assert.equal(listsInstaller({ status: 1, stdout: "" }), true);
  assert.equal(listsInstaller({ status: null, error: new Error("timed out") }), true);

  // It asks for the installer alone, with time to answer: under Bun a 20 s deadline cut off a 40 s full
  // listing of this machine's 968 processes (status null), which would have held every start.
  const calls = [];
  const none = { status: 0, stdout: "INFO: No tasks are running which match the specified criteria.\r\n" };
  assert.equal(installerRunning((file, args, spawnOptions) => { calls.push({ file, args, spawnOptions }); return none; }), false);
  assert.equal(calls[0].file, "tasklist.exe");
  assert.deepEqual(calls[0].args.slice(-2), ["/fi", "IMAGENAME eq Coding.Tools_*"]);
  assert.ok(calls[0].spawnOptions.timeout >= 60_000);
  assert.equal(installerRunning(() => ({ status: null, signal: "SIGTERM", stdout: "" })), true);
});

test("the guard runs from a copy next to the descriptor, on a runtime outside the install folder, detached and hidden", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-guard-"));
  const install = path.join(root, "Apps", "Coding Tools");
  const runtime = path.join(root, "versions", "0.8.106-win32-x64", "runtime", "bun.exe");
  const descriptorPath = path.join(root, "state", "runtime", "launcher-browser.json");
  for (const file of [path.join(install, "Coding Tools.exe"), path.join(install, "resources", "runtime", "runtime", "bun.exe"), runtime]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const executable = path.join(install, "Coding Tools.exe");
  const spawned = [];
  const spawnProcess = (file, args, spawnOptions) => { spawned.push({ file, args, spawnOptions }); return { pid: 4321, once() {}, unref() {} }; };
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    assert.throws(() => spawnRelaunchGuard({ runtime: path.join(install, "resources", "runtime", "runtime", "bun.exe"), executable, descriptorPath, spawnProcess }),
      /outside the install folder/);
    assert.throws(() => spawnRelaunchGuard({ runtime: path.join(root, "missing", "bun.exe"), executable, descriptorPath, spawnProcess }), /missing/);
    assert.deepEqual(spawned, [], "nothing starts from inside the install folder");

    const guard = spawnRelaunchGuard({ runtime, executable, descriptorPath, parentPid: 900, spawnProcess });
    assert.equal(guard.pid, 4321);
    assert.equal(guard.script, path.join(path.dirname(descriptorPath), "relaunch-guard.cjs"));
    assert.equal(fs.readFileSync(guard.script, "utf8"), fs.readFileSync(GUARD, "utf8"));
    const [{ file, args, spawnOptions }] = spawned;
    assert.equal(file, runtime);
    assert.deepEqual(parseArguments(args.slice(1)), { parentPid: 900, executable, descriptorPath });
    assert.deepEqual([spawnOptions.detached, spawnOptions.stdio, spawnOptions.windowsHide], [true, "ignore", true]);
    assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, undefined, "Bun must not inherit the app's run-as-Node switch");

    assert.throws(() => spawnRelaunchGuard({ runtime, executable, descriptorPath, spawnProcess: () => ({ once() {} }) }), /did not start/);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the started app reads the guard's note once, for its in-memory log, and deletes it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-note-"));
  try {
    assert.equal(await consumeRelaunchNote(directory), null);
    fs.writeFileSync(path.join(directory, NOTE_NAME), JSON.stringify({
      version: 1, by: "relaunch-guard", reason: "x".repeat(900), quitPid: 500, exitedAt: 1, relaunchedAt: 2, waitedMs: 300_000, installerSeen: true, extra: "dropped",
    }));
    const note = await consumeRelaunchNote(directory);
    assert.deepEqual({ ...note, reason: note.reason.length }, { reason: 300, quitPid: 500, exitedAt: 1, relaunchedAt: 2, waitedMs: 300_000, installerSeen: true });
    assert.equal(fs.existsSync(path.join(directory, NOTE_NAME)), false);

    fs.writeFileSync(path.join(directory, NOTE_NAME), JSON.stringify({ version: 1, by: "someone-else" }));
    assert.equal(await consumeRelaunchNote(directory), null);
    assert.equal(fs.existsSync(path.join(directory, NOTE_NAME)), false, "a foreign note is not read twice either");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the copied guard needs nothing beside it and runs as its own program", () => {
  const requires = [...fs.readFileSync(GUARD, "utf8").matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(requires.filter((name) => !name.startsWith("node:")), [], "it runs from a copy, under Bun");

  // A real run: its app (a pid that is gone) has exited and a new one (this test) has written the descriptor.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-cli-"));
  try {
    const script = path.join(directory, "relaunch-guard.cjs");
    fs.copyFileSync(GUARD, script);
    const descriptorPath = path.join(directory, "launcher-browser.json");
    fs.writeFileSync(descriptorPath, JSON.stringify({ pid: process.pid }));
    const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    const run = spawnSync(process.execPath, [script, "--parent", String(gone), "--executable", path.join(directory, "app.exe"), "--descriptor", descriptorPath],
      { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(path.join(directory, NOTE_NAME)), false, "nothing to note when the app is back");
    assert.equal(spawnSync(process.execPath, [script, "--parent", "x"], { encoding: "utf8", timeout: 30_000 }).status, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
