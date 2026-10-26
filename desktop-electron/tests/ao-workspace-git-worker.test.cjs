"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const workerThreads = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODULE = require.resolve("../electron/agent-orchestrator-workspace.cjs");

function repository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-git-worker-"));
  const git = (...args) => childProcess.execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "--quiet", "--initial-branch=main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "first");
  fs.writeFileSync(path.join(dir, "new.txt"), "x");
  return dir;
}

/** A fresh copy of the module, loaded while `execFile` (and optionally `Worker`) are replaced. */
function load({ Worker } = {}) {
  const calls = [];
  const realExecFile = childProcess.execFile;
  const realWorker = workerThreads.Worker;
  childProcess.execFile = (...args) => { calls.push(args[1]); return realExecFile(...args); };
  if (Worker) workerThreads.Worker = Worker;
  delete require.cache[MODULE];
  try {
    return { workspace: require(MODULE), calls };
  } finally {
    // The module keeps the functions it was loaded with.
    if (Worker) workerThreads.Worker = realWorker;
    setImmediate(() => { childProcess.execFile = realExecFile; });
  }
}

test("branch reads start git from a worker thread, never on the calling thread", async () => {
  const dir = repository();
  try {
    const { workspace, calls } = load();
    const listed = await workspace.listBranches(dir);
    assert.equal(listed.git, true);
    assert.equal(listed.current, "main");
    assert.equal(listed.defaultBranch, "main");
    assert.deepEqual(listed.folderChanges, { staged: 0, modified: 0, untracked: 1 });
    // Starting a process blocks the thread that starts it (seconds on a busy disk): none here.
    assert.deepEqual(calls, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("git still runs when no worker thread can be started", async () => {
  const dir = repository();
  try {
    const { workspace, calls } = load({ Worker: function Unavailable() { throw new Error("no workers here"); } });
    const listed = await workspace.listBranches(dir);
    assert.equal(listed.current, "main");
    assert.deepEqual(listed.folderChanges, { staged: 0, modified: 0, untracked: 1 });
    assert.ok(calls.length > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
