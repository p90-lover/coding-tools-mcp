"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ExtraTunnels, aliasOf, parseInventory } = require("../electron/extra-tunnels.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

const MAIN_ID = `tunnel_${"a".repeat(32)}`;
const SECOND_ID = `tunnel_${"b".repeat(32)}`;
const THIRD_ID = `tunnel_${"c".repeat(32)}`;
const FAST = { monitorMs: 60_000, pollMs: 1, startTimeoutMs: 200, failureThreshold: 2, restartWindowMs: 60_000, maxRestarts: 2 };

/** A tunnel-client stand-in: an alias inventory that connect, stop and cleanup act on. */
function fakeClient({ connectFails = false } = {}) {
  const runtimes = new Map();
  const calls = [];
  const runTunnel = async (tunnel, args) => {
    calls.push({ tunnel, args });
    const [, command, alias] = args;
    if (command === "cleanup") {
      const entries = [...runtimes].map(([name, state]) => ({
        alias: name,
        runtime_state: state,
        live_runtime: { system: { pid: 4242 } },
      }));
      return { code: 0, output: JSON.stringify({ entries }), stdout: "", stderr: "" };
    }
    if (command === "stop") {
      if (!runtimes.has(alias)) return { code: 1, output: "alias not found", stdout: "", stderr: "" };
      runtimes.delete(alias);
      return { code: 0, output: "{}", stdout: "", stderr: "" };
    }
    if (command === "connect") {
      if (connectFails) return { code: 1, output: "remote refused the tunnel", stdout: "", stderr: "" };
      runtimes.set(args[args.indexOf("--alias") + 1], "ready");
      return { code: 0, output: "{}", stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  return { runtimes, calls, runTunnel };
}

function setup(options = {}) {
  const coreHome = fs.mkdtempSync(path.join(os.tmpdir(), "extra-tunnels-"));
  const binaryPath = path.join(coreHome, "bin", "tunnel-client.exe");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, "");
  const config = {
    mode: "full",
    browserInteractionMode: "automatic",
    tunnel: { binaryPath, tunnelId: MAIN_ID, profileDir: path.join(coreHome, "tunnel", "profiles"), alias: "codex-chatgpt-web" },
    automaticTunnel: { tunnelId: MAIN_ID },
  };
  const client = fakeClient(options);
  const changes = [];
  const tunnels = new ExtraTunnels({
    coreHome,
    runTunnel: client.runTunnel,
    connectArgs: (_config, tunnel) => ["runtimes", "connect", "--alias", tunnel.alias, "--runtime-api-key", `file:${tunnel.runtimeKeyFile}`],
    absent: output => /not found/.test(output),
    onChange: status => changes.push(status),
    timing: FAST,
  });
  return { coreHome, config, client, tunnels, changes };
}

test("parseInventory maps aliases to state and pid", () => {
  const inventory = parseInventory(JSON.stringify({ entries: [{ alias: "x", runtime_state: "ready", live_runtime: { status: { pid: 7 } } }] }));
  assert.deepEqual(inventory.get("x"), { state: "ready", ready: true, pid: 7 });
  assert.throws(() => parseInventory("{}"), /no entries array/);
});

test("adding a tunnel connects it under its own alias and key, and its status carries no secret", async () => {
  const { coreHome, config, client, tunnels, changes } = setup();
  await tunnels.start(config);
  const added = await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: " sk-secret ", accountId: "acct-2" });
  assert.equal(added.state, "ready");
  assert.equal(added.accountId, "acct-2");
  assert.equal(client.runtimes.get(aliasOf(added.id)), "ready");
  const keyFile = path.join(coreHome, "secrets", `tunnel-runtime-extra-${added.id}.key`);
  assert.equal(fs.readFileSync(keyFile, "utf8"), "sk-secret");
  const connect = client.calls.find(call => call.args[1] === "connect");
  assert.equal(connect.tunnel.binaryPath, config.tunnel.binaryPath);
  assert.equal(connect.tunnel.profileDir, config.tunnel.profileDir);
  assert.ok(connect.args.includes(`file:${keyFile}`));
  assert.doesNotMatch(JSON.stringify(tunnels.status()), /sk-secret|\.key/);
  assert.ok(changes.length > 0);
  tunnels.detach();
});

test("the registry is read from disk once; later reads and monitor passes use the saved copy", async () => {
  const { coreHome, config, tunnels } = setup();
  await tunnels.start(config);
  const added = await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk", accountId: "acct-2" });
  const registry = path.join(coreHome, "tunnel", "extra-tunnels.json");
  const readFileSync = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (file, ...rest) => { if (file === registry) reads.push(file); return readFileSync(file, ...rest); };
  try {
    await tunnels.check();
    assert.deepEqual(tunnels.status().map(entry => entry.id), [added.id]);
    tunnels.setConnector(added.id, "https://chatgpt.com/connector");
    assert.equal(tunnels.status()[0].connectorHref, "https://chatgpt.com/connector");
  } finally { fs.readFileSync = readFileSync; }
  assert.deepEqual(reads, []);
  // What it saved is what a new launcher reads, once the write it started is in place.
  await tunnels.written();
  const next = new ExtraTunnels({ coreHome, runTunnel: async () => ({ code: 0, output: "{}" }), connectArgs: () => [] });
  assert.equal(next.entries()[0].connectorHref, "https://chatgpt.com/connector");
  tunnels.detach();
});

test("a registry write that fails is not kept: the next read takes what is on disk", async () => {
  const { coreHome, config, tunnels } = setup();
  await tunnels.start(config);
  const added = await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk", accountId: "acct-2" });
  const registry = path.join(coreHome, "tunnel", "extra-tunnels.json");
  const onDisk = fs.readFileSync(registry, "utf8");
  // A folder in the file's place: replacing it fails.
  fs.rmSync(registry);
  fs.mkdirSync(registry);
  tunnels.setConnector(added.id, "https://chatgpt.com/connector");
  assert.equal(tunnels.status()[0].connectorHref, "https://chatgpt.com/connector", "shown before the write lands");
  await tunnels.written();
  fs.rmdirSync(registry);
  fs.writeFileSync(registry, onDisk);
  assert.equal(tunnels.status()[0].connectorHref, null);
  tunnels.detach();
});

test("a tunnel that does not connect is not kept", async () => {
  const { coreHome, config, tunnels } = setup({ connectFails: true });
  await tunnels.start(config);
  await assert.rejects(
    tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk", accountId: null }),
    /did not connect, so it was not added: .*remote refused/,
  );
  assert.deepEqual(tunnels.status(), []);
  assert.deepEqual(fs.readdirSync(path.join(coreHome, "secrets")), []);
  tunnels.detach();
});

test("a tunnel ID or account already in use is refused, and adding needs a running runtime", async () => {
  const { config, tunnels } = setup();
  await assert.rejects(tunnels.add({ label: "Early", tunnelId: SECOND_ID, runtimeKey: "sk" }), /Start the MCP runtime/);
  await tunnels.start(config);
  await assert.rejects(tunnels.add({ label: "Main again", tunnelId: MAIN_ID, runtimeKey: "sk" }), /already connected/);
  await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk", accountId: "acct-2" });
  await assert.rejects(tunnels.add({ label: "Team again", tunnelId: SECOND_ID, runtimeKey: "sk" }), /already connected/);
  await assert.rejects(tunnels.add({ label: "Same account", tunnelId: THIRD_ID, runtimeKey: "sk", accountId: "acct-2" }), /already has its own tunnel/);
  await assert.rejects(tunnels.add({ label: "Bad", tunnelId: "tunnel_nope", runtimeKey: "sk" }), /32 lowercase hexadecimal/);
  tunnels.detach();
});

test("start adopts a ready tunnel and reconnects a stopped one", async () => {
  const { config, client, tunnels } = setup();
  await tunnels.start(config);
  const first = await tunnels.add({ label: "One", tunnelId: SECOND_ID, runtimeKey: "sk" });
  const second = await tunnels.add({ label: "Two", tunnelId: THIRD_ID, runtimeKey: "sk" });
  tunnels.detach(); // a keep-bridge quit: both stay up
  assert.equal(client.runtimes.size, 2);
  client.runtimes.delete(aliasOf(second.id)); // one died while no launcher watched
  client.calls.length = 0;
  await tunnels.start(config);
  const connects = client.calls.filter(call => call.args[1] === "connect").map(call => call.tunnel.alias);
  assert.deepEqual(connects, [aliasOf(second.id)]);
  assert.deepEqual(tunnels.status().map(tunnel => tunnel.state), ["ready", "ready"]);
  assert.match(tunnels.runtime.get(first.id).detail, /Adopted/);
  tunnels.detach();
});

test("the monitor restarts a tunnel that lost readiness, and gives up after repeated failures", async () => {
  const { config, client, tunnels } = setup();
  await tunnels.start(config);
  const added = await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk" });
  const alias = aliasOf(added.id);
  const loseIt = async () => {
    client.runtimes.set(alias, "stopped");
    await tunnels.check();
    await tunnels.check();
    await tunnels.queue;
  };
  await loseIt();
  assert.equal(client.runtimes.get(alias), "ready", "first restart");
  await loseIt();
  assert.equal(client.runtimes.get(alias), "ready", "second restart");
  await loseIt();
  assert.equal(tunnels.status()[0].state, "failed");
  assert.match(tunnels.status()[0].detail, /reconnect it to try again/);
  await tunnels.reconnect(added.id);
  assert.equal(tunnels.status()[0].state, "ready");
  tunnels.detach();
});

test("an unreadable inventory is no evidence of failure", async () => {
  const { config, client, tunnels } = setup();
  await tunnels.start(config);
  await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk" });
  const runTunnel = tunnels.runTunnel;
  tunnels.runTunnel = async () => ({ code: 1, output: "control plane unavailable" });
  for (let pass = 0; pass < 5; pass += 1) await tunnels.check();
  tunnels.runTunnel = runTunnel;
  assert.equal(tunnels.status()[0].state, "ready");
  assert.equal(client.calls.filter(call => call.args[1] === "connect").length, 1);
  tunnels.detach();
});

test("stopAll stops every tunnel; remove stops one and forgets its key", async () => {
  const { coreHome, config, client, tunnels } = setup();
  await tunnels.start(config);
  const one = await tunnels.add({ label: "One", tunnelId: SECOND_ID, runtimeKey: "sk" });
  const two = await tunnels.add({ label: "Two", tunnelId: THIRD_ID, runtimeKey: "sk" });
  await tunnels.remove(one.id);
  assert.equal(client.runtimes.has(aliasOf(one.id)), false);
  assert.equal(fs.existsSync(path.join(coreHome, "secrets", `tunnel-runtime-extra-${one.id}.key`)), false);
  assert.deepEqual(tunnels.status().map(tunnel => tunnel.id), [two.id]);
  assert.deepEqual(await tunnels.stopAll(config), []);
  assert.equal(client.runtimes.size, 0);
  assert.equal(tunnels.config, null);
  assert.equal(tunnels.monitorTimer, null);
});

test("a removed account's tunnel stays, unassigned, so another account can take it", async () => {
  const { config, client, tunnels, changes } = setup();
  await tunnels.start(config);
  const team = await tunnels.add({ label: "Team", tunnelId: SECOND_ID, runtimeKey: "sk", accountId: "acct-2" });
  await tunnels.add({ label: "Other", tunnelId: THIRD_ID, runtimeKey: "sk", accountId: "acct-3" });
  const before = changes.length;
  assert.equal(tunnels.forgetAccount("acct-2"), 1);
  assert.equal(changes.length, before + 1, "the change is published");
  assert.deepEqual(tunnels.status().map(tunnel => tunnel.accountId), [null, "acct-3"]);
  assert.equal(client.runtimes.get(aliasOf(team.id)), "ready", "the tunnel keeps running");
  assert.equal(tunnels.forgetAccount("acct-2"), 0);
  assert.equal(changes.length, before + 1, "nothing to forget publishes nothing");
  await tunnels.add({ label: "New", tunnelId: `tunnel_${"d".repeat(32)}`, runtimeKey: "sk", accountId: "acct-2" });
  tunnels.detach();
});

test("an extra tunnel's connector uses the connector name with that tunnel's ID", () => {
  const { extraConnectorSettings } = require("../electron/mcp-connector-setup.cjs");
  const runtimeHost = { mcpConnectorName: () => "Codex" };
  assert.deepEqual(extraConnectorSettings(runtimeHost, SECOND_ID), {
    name: "Codex", tunnelId: SECOND_ID, transport: "tunnel", authentication: "none",
  });
  assert.throws(() => extraConnectorSettings(runtimeHost, "tunnel_x"), /no valid tunnel ID/);
});

test("the supervisor runs extra tunnels with its own tunnel client and MCP command", () => {
  const coreHome = fs.mkdtempSync(path.join(os.tmpdir(), "extra-tunnels-supervisor-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.0.0" },
    logger: { info() {}, warn() {}, error() {} },
    coreHome,
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    runtimeInvocationFactory: ({ args }) => ({ executable: "bun.exe", args: ["cli.ts", ...args] }),
  });
  const config = { browserInteractionMode: "automatic", brokerSocketPath: "\\\\.\\pipe\\broker" };
  const tunnel = {
    alias: "codex-chatgpt-web-extra-0123abcd",
    profileName: "codex-chatgpt-web-extra-0123abcd",
    profileDir: path.join(coreHome, "tunnel", "profiles"),
    binaryPath: path.join(coreHome, "bin", "tunnel-client.exe"),
    tunnelId: SECOND_ID,
    runtimeKeyFile: path.join(coreHome, "secrets", "tunnel-runtime-extra-0123abcd.key"),
  };
  const args = supervisor.extraTunnels.connectArgs(config, tunnel);
  assert.deepEqual(args.slice(0, 4), ["runtimes", "connect", "--alias", tunnel.alias]);
  assert.equal(args[args.indexOf("--tunnel-id") + 1], SECOND_ID);
  assert.match(args[args.indexOf("--mcp-command") + 1], /"mcp" "--contract" "native" "--broker-socket"/);
});
