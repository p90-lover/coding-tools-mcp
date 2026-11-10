require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

// 0.8.106, Activity 2026-11-10 02:04Z: starting the MCP tunnel checked tunnel-client.exe with
// existsSync on the main thread, which held every window 6.6 s on the busy hard disk.

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-tunnel-client-"));
  const binaryPath = path.join(root, "tunnel-client.exe");
  const runtimeKeyFile = path.join(root, "tunnel-runtime.key");
  fs.writeFileSync(binaryPath, "tunnel program");
  fs.writeFileSync(runtimeKeyFile, "key");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.8.109", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    launcherProfile: "development",
  });
  return { root, binaryPath, runtimeKeyFile, supervisor, config: { mode: "full", tunnel: { binaryPath, runtimeKeyFile } } };
}

test("the tunnel client and its key are checked without a synchronous disk call", async (t) => {
  const { root, binaryPath, runtimeKeyFile, supervisor, config } = fixture();
  const synchronous = [];
  for (const name of ["existsSync", "statSync", "accessSync", "lstatSync", "openSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, function (target, ...args) {
      if (String(target).startsWith(root)) synchronous.push(name);
      return original.call(this, target, ...args);
    });
  }
  await supervisor.assertTunnelClientReady(config);
  assert.deepEqual(synchronous, [], "the checks wait on the disk off the main thread");

  // Removed off the main thread too, so only the supervisor's own calls are counted.
  await fs.promises.rm(runtimeKeyFile);
  await assert.rejects(supervisor.assertTunnelClientReady(config), { message: `Tunnel runtime key is missing: ${runtimeKeyFile}` });
  await fs.promises.rm(binaryPath);
  await assert.rejects(supervisor.assertTunnelClientReady(config), { message: `Tunnel client is missing: ${binaryPath}` });
  await assert.rejects(supervisor.assertTunnelClientReady({ mode: "full" }), { message: "Tunnel client is missing: not configured" });
  assert.deepEqual(synchronous, [], "a missing file is found off the main thread as well");
});

test("a tunnel start with no client program stops before any tunnel command", async () => {
  const { binaryPath, supervisor, config } = fixture();
  fs.rmSync(binaryPath);
  const did = [];
  supervisor.waitForKnownTunnelStatus = async () => { did.push("status"); return { ready: false, statusKnown: true }; };
  supervisor.runTunnelStopCommand = async () => { did.push("stop"); return { code: 0, output: "" }; };
  supervisor.runTunnelConnectCommand = async () => { did.push("connect"); return { code: 0, output: "" }; };
  await assert.rejects(supervisor.startTunnel(config), /Tunnel client is missing/);
  assert.deepEqual(did, []);
  assert.equal(supervisor.tunnel ?? null, null);
});
