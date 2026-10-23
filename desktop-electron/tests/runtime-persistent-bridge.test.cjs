"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

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
  // A real foreign launcher: the app's main process, not a child of this one.
  liveOwner.processInfo = () => ({ parentPid: 2 ** 22 - 5, executablePath: "Coding Tools.exe", commandLine: '"Coding Tools.exe"' });
  assert.equal(await liveOwner.adoptRunningDaemon(config), false, "another launcher still owns it");

  // Windows reused the quit owner's PID for this app's own NetworkService child (seen live): that
  // is not another launcher, and the bridge is adopted.
  const reused = supervisorFor(root).supervisor;
  reused.proxyHealthPayload = async () => health;
  reused.processInfo = () => ({ parentPid: process.pid, executablePath: "Coding Tools.exe",
    commandLine: '"Coding Tools.exe" --type=utility --utility-sub-type=network.mojom.NetworkService' });
  assert.equal(await reused.adoptRunningDaemon(config), true, "a reused PID is not an owner");
  await reused.detach("test-restart");
  writeOwnership(root, { ownerPid: daemon.pid, daemonPid: daemon.pid });
  for (const commandLine of ['"Coding Tools.exe" C:\\x\\browser-helper.cjs', '"Coding Tools.exe" --type=renderer']) {
    const helper = supervisorFor(root).supervisor;
    helper.proxyHealthPayload = async () => health;
    helper.processInfo = () => ({ parentPid: 2 ** 22 - 5, executablePath: "Coding Tools.exe", commandLine });
    assert.equal(await helper.launcherOwnerRunning(daemon.pid), false, commandLine);
  }
  const unknown = supervisorFor(root).supervisor;
  unknown.processInfo = () => null;
  assert.equal(await unknown.launcherOwnerRunning(daemon.pid), true, "an uninspectable live PID stays an owner");

  writeOwnership(root, { ownerPid: 2 ** 22 - 3, daemonPid: daemon.pid });
  const oldBridge = supervisorFor(root).supervisor;
  oldBridge.proxyHealthPayload = async () => ({ ...health, version: "0.1.9" });
  assert.equal(await oldBridge.adoptRunningDaemon(config), false, "an updated bridge must restart");

  const plain = supervisorFor(root, { persistentBridge: false }).supervisor;
  plain.proxyHealthPayload = async () => health;
  assert.equal(await plain.adoptRunningDaemon(config), false);
  assert.equal((await plain.detach()).status, "not-persistent");
});

test("a same-version patch replaces an idle bridge that runs an older runtime bundle", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bridge-"));
  const daemon = survivingDaemon();
  t.after(() => daemon.kill());
  const health = { service: "codex-chatgpt-web", mode: "full", version: "0.2.0", pid: daemon.pid };
  const oldRoot = path.join(root, "versions", "0.2.0-win32-x64");
  const patchedRoot = `${oldRoot}-b9bd1747bbd7`;
  const ownership = { ownerPid: 2 ** 22 - 3, daemonPid: daemon.pid, daemonRuntimeRoot: oldRoot };

  writeOwnership(root, ownership);
  const idle = supervisorFor(root);
  idle.supervisor.runtimeRootProvider = () => patchedRoot;
  idle.supervisor.proxyHealthPayload = async () => ({ ...health, active_browser_turns: 0 });
  assert.equal(await idle.supervisor.adoptRunningDaemon(config), false, "the patched runtime must take over");
  assert.ok(idle.events.some(([event]) => event === "runtime.daemon_outdated"));

  // A bridge in the middle of a turn keeps it; the next launch replaces it.
  const busy = supervisorFor(root).supervisor;
  busy.runtimeRootProvider = () => patchedRoot;
  busy.proxyHealthPayload = async () => ({ ...health, active_browser_turns: 1 });
  assert.equal(await busy.adoptRunningDaemon(config), true);
  assert.equal(busy.snapshot("ready").daemonRuntimeRoot, oldRoot, "the adopted bridge keeps its recorded folder");

  // Same folder, or a state written before folders were recorded: adopt as before.
  writeOwnership(root, ownership);
  const same = supervisorFor(root).supervisor;
  same.runtimeRootProvider = () => oldRoot.toUpperCase();
  same.proxyHealthPayload = async () => health;
  assert.equal(await same.adoptRunningDaemon(config), process.platform === "win32");
  writeOwnership(root, { ownerPid: 2 ** 22 - 3, daemonPid: daemon.pid });
  const legacy = supervisorFor(root).supervisor;
  legacy.runtimeRootProvider = () => patchedRoot;
  legacy.proxyHealthPayload = async () => health;
  assert.equal(await legacy.adoptRunningDaemon(config), true);
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

test("a persistent bridge's output is discarded, never kept in a log file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  // An older build's log files go.
  fs.writeFileSync(path.join(runtime, "daemon.log"), "old line\n");
  fs.writeFileSync(path.join(runtime, "daemon.log.1"), "older line\n");
  const { supervisor } = supervisorFor(root);
  const child = supervisor.spawnChild("daemon", {
    executable: process.execPath, args: ["-e", "console.log('listening'); console.error('a warning')"], cwd: root,
  });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.stdout, null);
  assert.equal(child.stderr, null);
  assert.deepEqual(fs.readdirSync(runtime).filter((name) => name.includes("log")), []);
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
