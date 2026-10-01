"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function supervisorFor(root, { persistentBridge = true } = {}) {
  const events = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info: (event, detail) => events.push([event, detail]), warn() {}, error: (event, detail) => events.push([event, detail]) },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    launcherProfile: "production",
    persistentBridge,
  });
  return { supervisor, events };
}

function writeOwnership(root, state) {
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime", "launcher-supervisor.json"), JSON.stringify({
    version: 1, tunnelPid: null, status: "detached", updatedAt: new Date().toISOString(), ...state,
  }));
}

// A long-lived stand-in for a bridge daemon left behind by a previous launcher.
function survivingDaemon() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return child;
}

const config = { mode: "full", releaseVersion: "0.2.0" };

test("a persistent launcher adopts a healthy bridge left by a dead launcher instead of stopping it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bridge-"));
  const daemon = survivingDaemon();
  t.after(() => daemon.kill());
  const deadOwner = 2 ** 22 - 3;
  writeOwnership(root, { ownerPid: deadOwner, daemonPid: daemon.pid });
  const { supervisor, events } = supervisorFor(root);
  supervisor.proxyHealthPayload = async () => ({ service: "codex-chatgpt-web", mode: "full", version: "0.2.0", pid: daemon.pid });
  assert.equal(await supervisor.adoptRunningDaemon(config), true);
  assert.equal(supervisor.daemon.pid, daemon.pid);
  assert.equal(supervisor.daemon.adopted, true);
  assert.ok(events.some(([event]) => event === "runtime.daemon_adopted"));

  // Detaching for a restart leaves the bridge running and records it for the next launcher.
  const detached = await supervisor.detach("test-restart");
  assert.equal(detached.status, "detached");
  assert.equal(detached.daemonPid, daemon.pid);
  assert.equal(daemon.exitCode, null);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "runtime", "launcher-supervisor.json"), "utf8"));
  assert.equal(saved.status, "detached");
  assert.equal(saved.daemonPid, daemon.pid);
});

test("adoption refuses a live foreign owner, a version mismatch, or a non-persistent launcher", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bridge-"));
  const daemon = survivingDaemon();
  t.after(() => daemon.kill());
  const health = { service: "codex-chatgpt-web", mode: "full", version: "0.2.0", pid: daemon.pid };

  writeOwnership(root, { ownerPid: daemon.pid, daemonPid: daemon.pid });
  const liveOwner = supervisorFor(root).supervisor;
  liveOwner.proxyHealthPayload = async () => health;
  assert.equal(await liveOwner.adoptRunningDaemon(config), false, "another launcher still owns it");

  writeOwnership(root, { ownerPid: 2 ** 22 - 3, daemonPid: daemon.pid });
  const oldBridge = supervisorFor(root).supervisor;
  oldBridge.proxyHealthPayload = async () => ({ ...health, version: "0.1.9" });
  assert.equal(await oldBridge.adoptRunningDaemon(config), false, "an updated bridge must restart");

  const plain = supervisorFor(root, { persistentBridge: false }).supervisor;
  plain.proxyHealthPayload = async () => health;
  assert.equal(await plain.adoptRunningDaemon(config), false);
  assert.equal((await plain.detach()).status, "not-persistent");
});

test("an adopted daemon that dies unexpectedly is reported and recovered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bridge-"));
  const daemon = survivingDaemon();
  writeOwnership(root, { ownerPid: 2 ** 22 - 3, daemonPid: daemon.pid });
  const { supervisor, events } = supervisorFor(root);
  supervisor.proxyHealthPayload = async () => ({ service: "codex-chatgpt-web", mode: "full", version: "0.2.0", pid: daemon.pid });
  let recovered = null;
  supervisor.scheduleRecovery = (name) => { recovered = name; };
  assert.equal(await supervisor.adoptRunningDaemon(config), true);
  supervisor.restartableChildren.add(supervisor.daemon);
  daemon.kill();
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(supervisor.daemon, null);
  assert.equal(recovered, "daemon");
  assert.ok(events.some(([event, detail]) => event === "runtime.daemon_exited" && detail?.adopted === true));
});

test("a persistent launcher keeps the bridge up when the MCP tunnel is not ready yet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bridge-"));
  const { supervisor, events } = supervisorFor(root);
  const { runtimeReleaseVersion } = require("../electron/runtime-command.cjs");
  const started = { mode: "full", releaseVersion: runtimeReleaseVersion(supervisor) };
  supervisor.readConfig = () => started;
  supervisor.adoptRunningDaemon = async () => false;
  supervisor.proxyHealth = async () => false;
  supervisor.readState = () => null;
  const order = [];
  supervisor.startDaemon = async () => { order.push("daemon"); supervisor.daemon = { pid: process.pid }; };
  supervisor.startTunnel = async () => { order.push("tunnel"); throw new Error("tunnel health discovery timed out"); };
  const result = await supervisor.startIfConfigured();
  assert.deepEqual(order, ["daemon", "tunnel"]);
  assert.equal(result.status, "degraded");
  assert.equal(result.daemonPid, process.pid);
  assert.equal(supervisor.daemon?.pid, process.pid, "the bridge is not torn down");
  assert.ok(events.every(([event]) => event !== "runtime.startup_failed"));
  supervisor.daemon = null;
});
