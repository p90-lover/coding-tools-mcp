"use strict";

// The runtime supervisor's ownership marker (launcher-supervisor.json) is written off the main
// thread. Written synchronously it held every window 0.45-1.6 s on the busy hard disk at watchdog
// restarts, bridge reconnects and degrade/ready changes (launcher.main_blocked, 2026-11-12/13).
// These check that the guarantees the synchronous write gave still hold.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

// A regression must fail, not hang on a write that never reaches the disk the way a test expects.
const it = (name, fn) => test(name, { timeout: 30_000 }, fn);

function supervisorIn(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-writes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const published = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "runtime", "launcher-browser.json"),
    publishOperation: (operation) => published.push(operation),
    ...options,
  });
  const onDisk = () => (fs.existsSync(supervisor.statePath) ? JSON.parse(fs.readFileSync(supervisor.statePath, "utf8")) : null);
  return { root, supervisor, published, onDisk };
}

/** Holds every rename onto `target` (the atomic write's last step) until released. */
function holdRenames(t, target) {
  const rename = fs.promises.rename;
  const held = [];
  fs.promises.rename = async (from, to) => {
    if (to === target) await new Promise((resolve) => held.push(resolve));
    return rename(from, to);
  };
  t.after(() => { fs.promises.rename = rename; });
  return {
    get count() { return held.length; },
    /** Resolves once a write has reached its rename and waits there. */
    async reached() {
      for (let i = 0; i < 500 && held.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(held.length > 0, "a write reached its rename");
    },
    /** Lets every write through from now on. */
    release() { fs.promises.rename = rename; for (const resolve of held.splice(0)) resolve(); },
  };
}

/** Makes every write of a temporary file next to `target` fail, as a full or failing disk does. */
function failWrites(t, target) {
  const writeFile = fs.promises.writeFile;
  fs.promises.writeFile = async (file, ...rest) => {
    if (String(file).startsWith(`${target}.tmp-`)) throw Object.assign(new Error("fixture disk is full"), { code: "ENOSPC" });
    return writeFile(file, ...rest);
  };
  const restore = () => { fs.promises.writeFile = writeFile; };
  t.after(restore);
  return { restore };
}

const settles = (promise, ms = 100) => Promise.race([
  promise.then(() => "settled", () => "settled"),
  new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
]);

it("a state change returns before the marker is written, with no synchronous disk call", async (t) => {
  const { supervisor, onDisk } = supervisorIn(t);
  const syncCalls = [];
  const originals = {};
  for (const name of Object.keys(fs).filter((key) => key.endsWith("Sync") && typeof fs[key] === "function")) {
    originals[name] = fs[name];
    fs[name] = (...args) => { syncCalls.push(name); return originals[name](...args); };
  }
  let writing;
  try {
    writing = supervisor.writeState("ready");
  } finally {
    Object.assign(fs, originals);
  }
  assert.deepEqual(syncCalls, [], "the main thread does not wait on the disk");
  assert.ok(writing instanceof Promise);
  assert.equal(onDisk(), null, "not written yet when the call returns");
  const state = await writing;
  assert.equal(state.status, "ready");
  assert.equal(onDisk().status, "ready", "on disk once the promise resolves");
});

it("a read in this process sees a write still on its way, and a removal", async (t) => {
  const { supervisor, onDisk } = supervisorIn(t);
  await supervisor.writeState("ready");
  const renames = holdRenames(t, supervisor.statePath);
  const degrading = supervisor.writeState("degraded", "daemon exited (1)");
  await renames.reached();
  // The disk still holds "ready" while the write waits.
  assert.equal(onDisk().status, "ready");
  const read = await supervisor.readStateAsync();
  assert.equal(read.status, "degraded");
  assert.equal(read.detail, "daemon exited (1)");
  assert.equal(read.ownerPid, process.pid);
  const clearing = supervisor.clearState();
  assert.equal(await supervisor.readStateAsync(), null, "a removal asked for reads as no marker");
  renames.release();
  await degrading;
  await clearing;
  assert.equal(onDisk(), null);
  assert.equal(await supervisor.readStateAsync(), null);
});

it("writes and removals land in the order asked for", async (t) => {
  const { supervisor, onDisk } = supervisorIn(t);
  const renames = holdRenames(t, supervisor.statePath);
  const first = supervisor.writeState("starting");
  const removed = supervisor.clearState();
  const last = supervisor.writeState("ready");
  // The first write waits at its rename; the removal and the last write wait behind it.
  await renames.reached();
  assert.equal(renames.count, 1);
  assert.equal(await settles(removed), "pending", "a removal never overtakes an earlier write");
  assert.equal(renames.count, 1, "nor does a later write");
  renames.release();
  await Promise.all([first, removed, last]);
  assert.equal(onDisk().status, "ready", "the last request is what the marker holds");

  // A removal asked for after a write leaves no marker behind it.
  const again = supervisor.writeState("degraded", "tunnel lost");
  await supervisor.clearState();
  await again;
  assert.equal(onDisk(), null);
});

it("a read that a write overtakes answers with that write", async (t) => {
  const { supervisor } = supervisorIn(t);
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, JSON.stringify({
    version: 1, ownerPid: 999_999_999, daemonPid: null, tunnelPid: null, status: "external", updatedAt: new Date().toISOString(),
  }));
  const reading = supervisor.readStateAsync();
  const writing = supervisor.writeState("ready");
  assert.equal((await reading).status, "ready");
  await writing;
});

it("a failed write rejects its caller; tryWriteState stops restarts and publishes the failure", async (t) => {
  const { supervisor, published, onDisk } = supervisorIn(t);
  await supervisor.writeState("ready");
  const failing = failWrites(t, supervisor.statePath);
  await assert.rejects(supervisor.writeState("degraded", "x"), /fixture disk is full/);
  assert.equal(onDisk().status, "ready", "the old marker stays");
  assert.equal((await supervisor.readStateAsync()).status, "ready", "a read after a failure goes back to the disk");

  supervisor.restartTimers.daemon = setTimeout(() => assert.fail("a restart must not run"), 60_000);
  assert.equal(await supervisor.tryWriteState("failed", "y"), false);
  assert.equal(supervisor.stopping, true);
  assert.equal(supervisor.restartTimers.daemon, null, "a scheduled restart is cancelled");
  assert.ok(published.some((operation) => operation.name === "runtime-supervisor" && operation.status === "failed"
    && /Could not persist launcher runtime ownership: fixture disk is full/.test(operation.message)));

  failing.restore();
  supervisor.stopping = false;
  assert.equal(await supervisor.tryWriteState("failed", "y"), true, "a state whose write failed is not remembered as written");
  assert.equal(onDisk().status, "failed");
});

async function startedChild(t, supervisor) {
  const child = Object.assign(new EventEmitter(), { pid: 424_242, exitCode: null, signalCode: null, stdout: null, stderr: null });
  supervisor.spawnProcess = async () => child;
  await supervisor.spawnChild("daemon", { executable: "bun.exe", args: ["serve"], cwd: os.tmpdir() });
  supervisor.restartableChildren.add(child);
  return child;
}

it("a child's exit restarts it only once its state is on disk", async (t) => {
  const { supervisor, onDisk } = supervisorIn(t);
  const child = await startedChild(t, supervisor);
  assert.equal(onDisk().status, "starting", "spawnChild returns once the marker names the child");
  assert.equal(onDisk().daemonPid, 424_242);
  let scheduled = 0;
  supervisor.scheduleRecovery = () => { scheduled += 1; };
  const renames = holdRenames(t, supervisor.statePath);
  child.emit("exit", 1, null);
  await renames.reached();
  assert.equal(scheduled, 0, "no restart while the degraded state is being written");
  renames.release();
  for (let i = 0; i < 100 && scheduled === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scheduled, 1);
  assert.equal(onDisk().status, "degraded");
  assert.equal(onDisk().daemonPid, null);
});

it("a child's exit whose state cannot be written stops recovery", async (t) => {
  const { supervisor, published } = supervisorIn(t);
  const child = await startedChild(t, supervisor);
  let scheduled = 0;
  supervisor.scheduleRecovery = () => { scheduled += 1; };
  failWrites(t, supervisor.statePath);
  const failed = new Promise((resolve) => {
    const publish = supervisor.publishOperation;
    supervisor.publishOperation = (operation) => { publish(operation); if (operation.name === "runtime-supervisor") resolve(operation); };
  });
  child.emit("exit", 1, null);
  assert.equal((await failed).status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scheduled, 0, "a child the marker no longer accounts for is not restarted");
  assert.equal(supervisor.stopping, true);
  assert.equal(published.filter((operation) => operation.name === "runtime-supervisor").length, 1);
});

it("detach returns only once the marker the next launcher adopts from is on disk", async (t) => {
  const { supervisor, onDisk } = supervisorIn(t, { persistentBridge: true });
  const child = await startedChild(t, supervisor);
  child.release = () => {};
  const renames = holdRenames(t, supervisor.statePath);
  // A state change still on its way when the app quits lands first; detach's lands after it.
  const degrading = supervisor.writeState("degraded", "tunnel lost");
  await renames.reached();
  const detaching = supervisor.detach("launcher-quit");
  assert.equal(await settles(detaching), "pending", "detach waits for the write");
  assert.equal(onDisk().status, "starting");
  renames.release();
  const detached = await detaching;
  await degrading;
  assert.equal(detached.status, "detached");
  assert.equal(detached.daemonPid, 424_242);
  assert.equal(onDisk().status, "detached");
  assert.equal(onDisk().daemonPid, 424_242, "the next launcher finds the bridge it adopts");
});

it("a stop returns only once the marker is removed, after a write queued before it", async (t) => {
  const { supervisor, onDisk } = supervisorIn(t);
  await supervisor.writeState("ready");
  const renames = holdRenames(t, supervisor.statePath);
  const degrading = supervisor.writeState("degraded", "daemon exited (1)");
  await renames.reached();
  supervisor.readConfig = () => null;
  const stopping = supervisor.stopForSetup();
  assert.equal(await settles(stopping), "pending");
  renames.release();
  assert.deepEqual(await stopping, { status: "stopped" });
  await degrading;
  assert.equal(onDisk(), null, "the earlier write does not bring the marker back");
});
