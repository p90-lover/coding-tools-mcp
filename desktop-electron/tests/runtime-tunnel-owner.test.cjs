require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

/** A supervisor whose tunnel status and start/stop commands are fakes; it records what it did. */
function harness({ reuse, ready = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-tunnel-owner-"));
  const binaryPath = path.join(root, "tunnel-client.exe");
  fs.writeFileSync(binaryPath, "tunnel program v1");
  const logs = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.8.36", isPackaged: false },
    logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event), error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    launcherProfile: "development",
    reuseTunnelOnlyWhenMatching: () => reuse,
  });
  const did = [];
  supervisor.assertTunnelClientReady = () => {};
  supervisor.waitForKnownTunnelStatus = async () => ({ ready, pid: 4321, statusKnown: true });
  supervisor.waitForTunnelMcpTransport = async () => {};
  supervisor.startTunnelMonitor = () => { did.push("monitor"); };
  supervisor.runTunnelStopCommand = async () => { did.push("stop"); return { code: 0, output: "" }; };
  supervisor.waitForTunnelStopped = async () => {};
  supervisor.runTunnelConnectCommand = async () => { did.push("connect"); return { code: 0, output: "" }; };
  supervisor.waitForTunnel = async () => { supervisor.tunnel = { pid: 9876, exitCode: null, signalCode: null, managed: true }; };
  const config = { mode: "full", tunnel: { binaryPath } };
  return { root, binaryPath, supervisor, config, did, logs };
}

test("with the setting on, a ready tunnel this app did not start with its current program is restarted", async () => {
  const { root, supervisor, config, did, logs } = harness({ reuse: true });
  try {
    await supervisor.startTunnel(config);
    assert.deepEqual(did, ["stop", "connect", "monitor"], "no owner record (a tunnel from before this check): restarted");
    assert.ok(logs.includes("runtime.tunnel_replaced_mismatch"));
    const owner = JSON.parse(fs.readFileSync(path.join(root, "runtime", "tunnel-owner.json"), "utf8"));
    assert.equal(owner.pid, 9876);
    assert.equal(owner.appVersion, "0.8.36");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tunnel started by this app with the same program is adopted; a new program restarts it", async () => {
  const { root, binaryPath, supervisor, config, did, logs } = harness({ reuse: true });
  try {
    await supervisor.recordTunnelOwner(config, 4321);
    await supervisor.startTunnel(config);
    assert.deepEqual(did, ["monitor"], "adopted without a restart");
    assert.ok(logs.includes("runtime.tunnel_adopted"));

    did.length = 0;
    fs.writeFileSync(binaryPath, "tunnel program v2, a different size");
    await supervisor.startTunnel(config);
    assert.deepEqual(did, ["stop", "connect", "monitor"], "the update shipped a new tunnel program");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a ready tunnel whose endpoint discovery times out at adoption is kept, not stopped; other failures still stop it", async () => {
  // Seen live 2026-10-31 08:22: after a relaunch the surviving tunnel was ready, discovery timed out
  // twice on the busy machine, and the cleanup stopped the tunnel the agents were using.
  const { root, supervisor, config, did, logs } = harness({ reuse: false });
  try {
    supervisor.waitForTunnelMcpTransport = async () => { throw new Error("Local tunnel health discovery timed out after 5000ms"); };
    await supervisor.startTunnel(config);
    assert.deepEqual(did, ["monitor"], "kept and watched, never stopped");
    assert.ok(logs.includes("runtime.tunnel_adopted_unverified"));
    assert.equal(supervisor.tunnel?.pid, 4321);

    did.length = 0;
    supervisor.waitForTunnelMcpTransport = async () => { throw new Error("MCP transport returned internal HTTP 502 for initialize"); };
    await assert.rejects(supervisor.startTunnel(config), /HTTP 502/);
    assert.deepEqual(did, ["stop"], "a tunnel that answers with failures is still cleaned up");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with the setting off, any ready tunnel is adopted, as before", async () => {
  const { root, supervisor, config, did } = harness({ reuse: false });
  try {
    await supervisor.startTunnel(config);
    assert.deepEqual(did, ["monitor"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
