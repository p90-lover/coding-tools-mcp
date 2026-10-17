"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setAsideInUse, sweepSetAside, agentRuntimeRoots } = require("../electron/in-use-files.cjs");

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
      assert.equal(sweepSetAside(agentRuntimeRoots(resources)), 0, "a set-aside image still running is kept");
    } finally {
      host.kill();
      await new Promise((resolve) => host.once("exit", resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sweepSetAside(agentRuntimeRoots(resources)), 1, "once it exited, the leftover is removed");
    assert.equal(fs.readFileSync(daemon, "utf8"), "new version");
    fs.rmSync(resources, { recursive: true, force: true });
  });
