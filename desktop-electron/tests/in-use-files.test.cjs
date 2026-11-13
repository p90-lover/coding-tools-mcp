"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setAsideInUse, sweepSetAside, agentRuntimeRoots } = require("../electron/in-use-files.cjs");
// The app update's own names: this file names them too (update.cjs copies it on its own).
const { JOURNAL, MARKER } = require("../electron/app-update-worker.cjs");

test("an update sets a running agent's executable aside, then cleans it up once it has exited",
  { skip: process.platform !== "win32" && "renaming a running image is the Windows case" }, async () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "ct-in-use-"));
    const [ao] = agentRuntimeRoots(resources);
    fs.mkdirSync(path.join(ao, "nested"), { recursive: true });
    const daemon = path.join(ao, "ao-daemon.exe");
    const idle = path.join(ao, "nested", "helper.dll");
    fs.copyFileSync(process.execPath, daemon);
    fs.writeFileSync(idle, "not loaded");
    const host = spawn(daemon, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      const moved = setAsideInUse(agentRuntimeRoots(resources), { now: () => 42 });
      assert.deepEqual(moved, [`${daemon}.old-42`], "only the running image is moved");
      assert.equal(fs.existsSync(daemon), false, "its path is free for the installer");
      assert.equal(fs.existsSync(idle), true, "an image nothing runs stays put");
      assert.equal(host.exitCode, null, "the running agent keeps going");
      fs.writeFileSync(daemon, "new version");
      assert.equal(await sweepSetAside(agentRuntimeRoots(resources)), 0, "a set-aside image still running is kept");
    } finally {
      host.kill();
      await new Promise((resolve) => host.once("exit", resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await sweepSetAside(agentRuntimeRoots(resources)), 1, "once it exited, the leftover is removed");
    assert.equal(fs.readFileSync(daemon, "utf8"), "new version");
    fs.rmSync(resources, { recursive: true, force: true });
  });

test("start-up's sweep leaves an app update's old copies alone while that update is in flight", async () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-in-use-update-"));
  const resources = path.join(installRoot, "resources");
  const [ao, runtime] = agentRuntimeRoots(resources);
  const oldDaemon = path.join(ao, "ao-daemon.exe.old-1794588862196");
  const oldShim = path.join(runtime, "node_modules", ".bin", "node-which.old-1794588862196");
  for (const file of [oldDaemon, oldShim]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "the old version a rollback puts back");
  }
  const updateRoot = path.join(installRoot, "_update");
  fs.mkdirSync(updateRoot);
  try {
    // A worker waiting to swap, or swapping: its marker names a live process (this one stands in).
    fs.writeFileSync(path.join(updateRoot, MARKER), JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.equal(await sweepSetAside(agentRuntimeRoots(resources), { installRoot }), 0);
    assert.equal(fs.existsSync(oldDaemon) && fs.existsSync(oldShim), true, "a swap's old copies stay for its rollback");

    // Swapped, the worker gone, the journal kept until the new version proves itself.
    fs.rmSync(path.join(updateRoot, MARKER));
    fs.writeFileSync(path.join(updateRoot, JOURNAL), JSON.stringify({ schema: 1, state: "placed" }));
    assert.equal(await sweepSetAside(agentRuntimeRoots(resources), { installRoot }), 0);
    assert.equal(fs.existsSync(oldDaemon), true, "a placed update's old copies stay until it commits");

    // A marker whose worker died does not hold the sweep back; nor does a finished update.
    fs.rmSync(path.join(updateRoot, JOURNAL));
    fs.writeFileSync(path.join(updateRoot, MARKER), JSON.stringify({ pid: 2 ** 31 - 2, at: Date.now() }));
    assert.equal(await sweepSetAside(agentRuntimeRoots(resources), { installRoot }), 2);
    assert.equal(fs.existsSync(oldDaemon) || fs.existsSync(oldShim), false);
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
});
