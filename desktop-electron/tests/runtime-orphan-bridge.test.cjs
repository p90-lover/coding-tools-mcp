"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

const DEAD_PID = 0x7ffffff0;

// A launcher stopped without its shutdown (an install, a crash) left its bridge on the Responses
// port under a marker a later launch overwrote. Every later start then refused the port as an
// "external owner" and "Install into Codex" could never turn the route on.
function fixture(info) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-orphan-bridge-"));
  const executable = path.join(root, "runtime", "bun.exe");
  const entry = path.join(root, "app", "cli.js");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(executable, "");
  fs.writeFileSync(entry, "");
  const calls = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "1.0.0", isPackaged: true },
    logger: { info() {}, warn(event, detail) { calls.push(["warn", event, detail]); }, error() {} },
    sourceRoot: root,
    coreHome: root,
    installedRuntimeRoot: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    runtimeInvocationFactory: ({ args }) => ({ executable, args: [entry, ...args], cwd: root }),
    processInfo: () => (typeof info === "function" ? info({ executable, entry }) : info),
  });
  supervisor.readState = () => ({ ownerPid: DEAD_PID, daemonPid: DEAD_PID - 1, tunnelPid: null, updatedAt: new Date().toISOString() });
  supervisor.clearState = () => calls.push(["clearState"]);
  supervisor.proxyHealthPayload = async () => ({ service: "codex-chatgpt-web", mode: "browser", version: "1.0.0", pid: 4242 });
  supervisor.acquireDrain = async () => true;
  supervisor.control = async (_config, action) => { calls.push(["control", action]); return { status: "ok" }; };
  supervisor.waitForProcessExit = async (label, pid) => calls.push(["exit", pid]);
  supervisor.waitForPortRelease = async () => calls.push(["port"]);
  const config = { mode: "browser", releaseVersion: "1.0.0", host: "127.0.0.1", port: 1 };
  return { root, supervisor, calls, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("this install's own bridge whose launcher is gone is shut down gracefully and replaced", async () => {
  const f = fixture(({ executable, entry }) => ({ executablePath: executable, commandLine: `${executable} ${entry} serve`, parentPid: DEAD_PID }));
  try {
    assert.equal(await f.supervisor.stopStaleOwnedRuntime(f.config), true);
    assert.deepEqual(f.calls.filter(([kind]) => kind !== "warn"), [["control", "shutdown"], ["exit", 4242], ["port"], ["clearState"]],
      "the orphan's own pid is the one waited for, after a graceful shutdown");
    assert.ok(f.calls.some(([kind, event]) => kind === "warn" && event === "runtime.orphaned_bridge_detected"));
  } finally {
    f.cleanup();
  }
});

test("anything that is not provably this install's orphaned bridge stays an external owner", async () => {
  const cases = {
    "its launcher is still alive": ({ executable, entry }) => ({ executablePath: executable, commandLine: `${executable} ${entry} serve`, parentPid: process.pid }),
    "another executable": ({ entry }) => ({ executablePath: path.join(os.tmpdir(), "bun.exe"), commandLine: `bun.exe ${entry} serve`, parentPid: DEAD_PID }),
    "another entrypoint": ({ executable }) => ({ executablePath: executable, commandLine: `${executable} C:\\other\\cli.js serve`, parentPid: DEAD_PID }),
    "not the serve command": ({ executable, entry }) => ({ executablePath: executable, commandLine: `${executable} ${entry} route status`, parentPid: DEAD_PID }),
    "process details unknown": () => null,
  };
  for (const [name, info] of Object.entries(cases)) {
    const f = fixture(info);
    try {
      await assert.rejects(f.supervisor.stopStaleOwnedRuntime(f.config), /does not match the stale launcher marker/, name);
      assert.deepEqual(f.calls.filter(([kind]) => kind === "control"), [], `${name}: nothing was stopped`);
    } finally {
      f.cleanup();
    }
  }
});
