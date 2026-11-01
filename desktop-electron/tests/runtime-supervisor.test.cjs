require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { packagedRuntimePaths } = require("../electron/runtime-command.cjs");
const { linuxDesktopEntry, requireAutostartState } = require("../electron/autostart.cjs");
const {
  MAX_RESTARTS_PER_WINDOW,
  RuntimeSupervisor,
  managedTunnelConnectArgs,
  validateConfig,
} = require("../electron/runtime-supervisor.cjs");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function localHealthServer(statusForPath = () => 200, bodyForPath = () => "ok") {
  const server = http.createServer((request, response) => {
    response.writeHead(statusForPath(request.url || "/"));
    response.end(bodyForPath(request.url || "/"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function launcherConfig(descriptorPath, overrides = {}) {
  const root = path.dirname(descriptorPath);
  return {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-runtime-supervisor-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

test("packaged runtime paths are native on Windows and Unix", () => {
  const windows = packagedRuntimePaths("C:\\Program Files\\Codex\\resources", "win32");
  assert.equal(path.basename(windows.executable), "bun.exe");
  assert.equal(path.basename(windows.entrypoint), "cli.js");

  const linux = packagedRuntimePaths("/opt/codex/resources", "linux");
  assert.equal(path.basename(linux.executable), "bun");
  assert.equal(path.basename(linux.entrypoint), "cli.js");
});

test("Linux autostart launches the durable AppImage invisibly", () => {
  const entry = linuxDesktopEntry(
    { getPath: () => "/tmp/transient-electron" },
    "/home/example/Applications/Codex Web GPT.AppImage",
  );
  assert.match(
    entry,
    /^Exec="\/home\/example\/Applications\/Codex Web GPT\.AppImage" --hidden$/m,
  );
  assert.match(entry, /^Name=Coding Tools$/m);
  assert.doesNotMatch(entry, /APPIMAGE_EXTRACT_AND_RUN/);
  assert.match(entry, /^Terminal=false$/m);
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);
});

test("Linux autostart escapes desktop-entry field codes in executable paths", () => {
  const entry = linuxDesktopEntry(
    { getPath: () => "/tmp/transient-electron" },
    "/home/example/100% ready/Codex Web GPT.AppImage",
  );
  assert.match(entry, /"\/home\/example\/100%% ready\/Codex Web GPT\.AppImage" --hidden/);
});

test("Linux autostart follows the stable installer wrapper across app updates", () => {
  const previous = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = "/home/example/.local/bin/codex-web-gpt";
  try {
    const entry = linuxDesktopEntry({ getPath: () => "/tmp/versioned-appimage-mount" });
    assert.match(entry, /"\/home\/example\/\.local\/bin\/codex-web-gpt" --hidden/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previous;
  }
});

test("launcher autostart fails explicitly when the operating system rejects the requested state", () => {
  assert.deepEqual(
    requireAutostartState({ supported: true, enabled: true }, true),
    { supported: true, enabled: true },
  );
  assert.throws(
    () => requireAutostartState({ supported: true, enabled: false }, true),
    /did not enable launcher autostart/,
  );
});

test("launcher runtime ownership rejects a different browser descriptor", () => {
  assert.throws(
    () => validateConfig(launcherConfig("/one/launcher.json"), "/two/launcher.json"),
    /different launcher browser host/,
  );
});

test("launcher runtime ownership cannot cross production and DEV profiles", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher.json");
  const production = { ...launcherConfig(descriptorPath), solAvailable: true };
  const development = { ...production, purpose: "dev-harness" };
  assert.equal(validateConfig(production, descriptorPath, process.platform, "production"), production);
  assert.equal(validateConfig(development, descriptorPath, process.platform, "development"), development);
  assert.throws(
    () => validateConfig(development, descriptorPath, process.platform, "production"),
    /Production launcher refuses a DEV harness/,
  );
  assert.throws(
    () => validateConfig(production, descriptorPath, process.platform, "development"),
    /DEV launcher refuses a configuration/,
  );
  assert.throws(
    () => validateConfig({ ...production, subagentProtocol: "v0" }, descriptorPath),
    /invalid subagent protocol/,
  );
  assert.throws(
    () => validateConfig({ ...production, stallTimeoutSec: 0 }, descriptorPath),
    /invalid stallTimeoutSec/,
  );
  assert.equal(
    validateConfig({ ...production, stallTimeoutSec: 900 }, descriptorPath).stallTimeoutSec,
    900,
  );
  // Absent (older configs) and either boolean are valid; anything else is not.
  for (const useSavedChats of [undefined, true, false]) {
    assert.doesNotThrow(() => validateConfig({ ...production, useSavedChats }, descriptorPath));
  }
  assert.throws(
    () => validateConfig({ ...production, useSavedChats: "false" }, descriptorPath),
    /invalid useSavedChats/,
  );
});

test("DEV runtime supervision ignores launcher version mismatch and starts only the isolated MCP tunnel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-tunnel-supervisor-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const config = launcherConfig(descriptorPath, {
    releaseVersion: "9.9.9",
    purpose: "dev-harness",
    mode: "full",
    appName: "Codex Native2 DEV",
    tunnel: {
      binaryPath: path.join(root, "bin", "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "secrets", "runtime.key"),
      profileDir: path.join(root, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web-dev",
      alias: "codex-chatgpt-web-dev",
    },
  });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(config)}\n`);
  let daemonStarts = 0;
  let proxyProbes = 0;
  let tunnelStarts = 0;
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    launcherProfile: "development",
  });
  supervisor.proxyHealth = async () => {
    proxyProbes += 1;
    return false;
  };
  supervisor.startTunnel = async () => {
    tunnelStarts += 1;
    supervisor.tunnel = { pid: 123_456_789, exitCode: null, signalCode: null, managed: true };
  };
  supervisor.startDaemon = async () => {
    daemonStarts += 1;
  };
  supervisor.tunnelHealth = async () => true;
  try {
    const runtime = await supervisor.startConfigured();
    assert.equal(runtime.status, "ready");
    assert.equal(runtime.daemonPid, undefined);
    assert.equal(runtime.tunnelPid, 123_456_789);
    assert.equal(tunnelStarts, 1);
    assert.equal(daemonStarts, 0);
    assert.equal(proxyProbes, 0);
    assert.equal(await supervisor.ownedRuntimeReady(config), true);
    const state = JSON.parse(fs.readFileSync(supervisor.statePath, "utf8"));
    assert.equal(state.daemonPid, null);
    assert.equal(state.tunnelPid, 123_456_789);
  } finally {
    supervisor.tunnel = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a process is inspected without blocking the main thread", { skip: process.platform !== "win32" }, async () => {
  // PowerShell through spawnSync (10 s timeout) froze the app while the bridge started or recovered.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-info-"));
  try {
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0", isPackaged: false },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: root,
      coreHome: root,
      browserDescriptorPath: path.join(root, "runtime", "launcher-browser.json"),
    });
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 5);
    const pending = supervisor.processInfo(process.pid);
    assert.ok(pending instanceof Promise);
    const info = await pending;
    clearInterval(ticker);
    assert.ok(ticks > 0, "timers kept running while PowerShell ran");
    assert.ok(info === null || path.basename(info.executablePath).toLowerCase() === path.basename(process.execPath).toLowerCase(), JSON.stringify(info));
    assert.equal(await supervisor.processInfo(-1), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime config is parsed once per change, not on every monitor read", () => {
  // The monitors read config.json every 2-60 s; on a busy hard disk each synchronous read stalled the app.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-config-cache-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const { readFileSync } = fs;
  let reads = 0;
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath))}\n`);
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0", isPackaged: false },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: root,
      coreHome: root,
      browserDescriptorPath: descriptorPath,
    });
    fs.readFileSync = function (file, ...rest) { if (file === configPath) reads += 1; return readFileSync.call(this, file, ...rest); };
    for (let i = 0; i < 5; i++) {
      assert.equal(supervisor.readSetupConfig().port, 17841);
      assert.equal(supervisor.readConfig().port, 17841);
    }
    assert.equal(reads, 1, "ten reads, one parse");
    supervisor.readSetupConfig().port = 1;
    assert.equal(supervisor.readSetupConfig().port, 17841, "a caller's change does not leak into the next read");
    // Another writer (the setup command) changes it: the next read sees it.
    fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, { port: 17999, appName: "Changed app" }))}\n`);
    fs.utimesSync(configPath, new Date(), new Date(Date.now() + 5_000));
    assert.equal(supervisor.readConfig().port, 17999);
    fs.rmSync(configPath);
    assert.equal(supervisor.readSetupConfig(), null);
    assert.equal(supervisor.readConfig(), null);
  } finally {
    fs.readFileSync = readFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with the folder watched, reads of an unchanged runtime config never touch the disk", async () => {
  // 2026-10-31: the one statSync per synchronous read (IPC handlers, setup) froze every window up
  // to 7.9 s, 30 s in an hour, on the busy hard disk.
  const { RuntimeHost } = require("../electron/runtime.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-config-watch-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const sync = { statSync: fs.statSync, readFileSync: fs.readFileSync };
  const logger = { info() {}, warn() {}, error() {} };
  const supervisor = new RuntimeSupervisor({ app: { getVersion: () => "0.2.0", isPackaged: false }, logger,
    sourceRoot: root, coreHome: root, browserDescriptorPath: descriptorPath, watchConfigFile: true });
  const host = new RuntimeHost({ app: { getPath: () => root, getVersion: () => "0.2.0" }, logger,
    sourceRoot: root, browserDescriptorPath: descriptorPath, supervisor });
  const until = async (condition) => {
    for (let tries = 0; tries < 200 && !condition(); tries += 1) await new Promise(resolve => setTimeout(resolve, 10));
    return condition();
  };
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath))}\n`);
    const blocking = [];
    fs.statSync = function (file, ...rest) { if (file === configPath) blocking.push("stat"); return sync.statSync.call(this, file, ...rest); };
    fs.readFileSync = function (file, ...rest) { if (file === configPath) blocking.push("read"); return sync.readFileSync.call(this, file, ...rest); };
    assert.equal(supervisor.readConfig().port, 17841);
    assert.deepEqual(blocking, ["stat", "read"], "the first read checks and parses the file");
    // The watch may still report the write above; once it settles, reads stop checking.
    await new Promise(resolve => setTimeout(resolve, 100));
    supervisor.readConfig();
    blocking.length = 0;
    for (let i = 0; i < 5; i++) {
      assert.equal(supervisor.readSetupConfig().port, 17841);
      assert.equal(host.runtimeConfigSnapshot().config.port, 17841);
    }
    assert.equal((await supervisor.readConfigAsync()).port, 17841);
    assert.deepEqual(blocking, [], "an unchanged file is not checked again");
    supervisor.readSetupConfig().port = 1;
    assert.equal(supervisor.readSetupConfig().port, 17841, "a caller's change does not leak into the next read");

    // Another process (the setup command) replaces it the way it saves: a new file renamed over it.
    const temporary = `${configPath}.tmp-1`;
    fs.writeFileSync(temporary, `${JSON.stringify(launcherConfig(descriptorPath, { port: 17999, appName: "Changed app" }))}\n`);
    fs.renameSync(temporary, configPath);
    assert.ok(await until(() => supervisor.readConfig().port === 17999), "the reported change is read");

    // A setup rollback writes it back: the next read checks the file without waiting for the watch.
    await new Promise(resolve => setTimeout(resolve, 100));
    supervisor.readConfig();
    blocking.length = 0;
    host.restoreSetupCheckpoint([]);
    supervisor.readConfig();
    assert.deepEqual(blocking, ["stat"], "checked once after a restore, and not parsed again unchanged");
  } finally {
    Object.assign(fs, sync);
    supervisor.configWatcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timers read the runtime config without a synchronous disk call, sharing the same cache", async () => {
  // A main-process profile (2026-10-24): the catalog monitor's one statSync of config.json froze
  // every window for 3 s on the busy hard disk holding the app's data.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-config-async-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const sync = { statSync: fs.statSync, readFileSync: fs.readFileSync };
  try {
    // Saved by Windows PowerShell, with a byte order mark.
    fs.writeFileSync(configPath, `﻿${JSON.stringify(launcherConfig(descriptorPath))}\n`);
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0", isPackaged: false },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: root,
      coreHome: root,
      browserDescriptorPath: descriptorPath,
    });
    const blocking = [];
    fs.statSync = function (file, ...rest) { if (file === configPath) blocking.push("stat"); return sync.statSync.call(this, file, ...rest); };
    fs.readFileSync = function (file, ...rest) { if (file === configPath) blocking.push("read"); return sync.readFileSync.call(this, file, ...rest); };
    assert.equal((await supervisor.readConfigAsync()).port, 17841);
    assert.equal((await supervisor.readConfigAsync()).port, 17841);
    assert.deepEqual(blocking, [], "no synchronous call on the timers' path");
    (await supervisor.readConfigAsync()).port = 1;
    assert.equal((await supervisor.readConfigAsync()).port, 17841, "a caller's change does not leak into the next read");
    // The synchronous readers use what the timer parsed: one stat, no second parse.
    assert.equal(supervisor.readConfig().port, 17841);
    assert.deepEqual(blocking, ["stat"]);
    fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, { port: 17999, appName: "Changed app" }))}\n`);
    fs.utimesSync(configPath, new Date(), new Date(Date.now() + 5_000));
    assert.equal((await supervisor.readConfigAsync()).port, 17999, "another writer's change is seen");
    fs.rmSync(configPath);
    assert.equal(await supervisor.readConfigAsync(), null);
  } finally {
    Object.assign(fs, sync);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime snapshot for timers matches the synchronous one without a synchronous disk call", async () => {
  // Seen live 2026-10-31: the MCP events monitor's 30 s bridge check took the synchronous snapshot,
  // and its statSync of config.json froze every window for up to 7.9 s on the busy hard disk.
  const { RuntimeHost } = require("../electron/runtime.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-snapshot-async-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const sync = { statSync: fs.statSync, readFileSync: fs.readFileSync };
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath))}\n`);
    const logger = { info() {}, warn() {}, error() {} };
    const supervisor = new RuntimeSupervisor({ app: { getVersion: () => "0.2.0", isPackaged: false }, logger,
      sourceRoot: root, coreHome: root, browserDescriptorPath: descriptorPath });
    const host = new RuntimeHost({ app: { getPath: () => root, getVersion: () => "0.2.0" }, logger,
      sourceRoot: root, browserDescriptorPath: descriptorPath, supervisor });
    const expected = host.runtimeConfigSnapshot();
    assert.equal(expected.configured, true);
    fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, { port: 17999 }))}\n`);
    fs.utimesSync(configPath, new Date(), new Date(Date.now() + 5_000));
    const blocking = [];
    fs.statSync = function (file, ...rest) { if (file === configPath) blocking.push("stat"); return sync.statSync.call(this, file, ...rest); };
    fs.readFileSync = function (file, ...rest) { if (file === configPath) blocking.push("read"); return sync.readFileSync.call(this, file, ...rest); };
    const changed = await host.runtimeConfigSnapshotAsync();
    assert.deepEqual(blocking, [], "no synchronous call on the timers' path");
    assert.equal(changed.config.port, 17999, "a change on disk is seen");
    Object.assign(fs, sync);
    assert.deepEqual(changed, host.runtimeConfigSnapshot(), "the same snapshot as the synchronous one");
    fs.rmSync(configPath);
    assert.deepEqual(await host.runtimeConfigSnapshotAsync(), host.runtimeConfigSnapshot());
  } finally {
    Object.assign(fs, sync);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher runtime validation rejects a relative full-mode executable before spawn", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher.json");
  assert.throws(() => validateConfig(launcherConfig(descriptorPath, {
    mode: "full",
    tunnel: {
      binaryPath: "tunnel-client",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(os.tmpdir(), "runtime.key"),
      profileDir: path.join(os.tmpdir(), "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }), descriptorPath), /absolute tunnel\.binaryPath/);
});

test("launcher runtime validation accepts native Windows paths and a named pipe", () => {
  const descriptorPath = "C:\\Users\\Example\\AppData\\Local\\Codex Web GPT\\launcher-browser.json";
  const config = {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath.toLowerCase(),
    chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    storageStatePath: "C:\\Users\\Example\\AppData\\Local\\Codex Web GPT\\storage-state.json",
    brokerSocketPath: "\\\\.\\pipe\\codex-chatgpt-web-runtime-supervisor-test",
    headed: true,
    solAvailable: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: ["C:\\Users\\Example\\.codex-chatgpt-web\\runtime\\bun.exe"],
  };
  assert.equal(validateConfig(config, descriptorPath, "win32"), config);
});

test("launcher delegates long-lived tunnel supervision to native runtimes connect", () => {
  const config = launcherConfig("C:\\Users\\Example\\.codex-chatgpt-web\\runtime\\launcher-browser.json", {
    mode: "full",
    runtimeCommand: [
      "C:\\Users\\Example\\.codex-chatgpt-web\\versions\\0.2.0-win32-x64\\runtime\\bun.exe",
      "C:\\Users\\Example\\.codex-chatgpt-web\\versions\\0.2.0-win32-x64\\app\\cli.js",
    ],
    brokerSocketPath: "\\\\.\\pipe\\codex-chatgpt-web-example",
    tunnel: {
      binaryPath: "C:\\Users\\Example\\.codex-chatgpt-web\\bin\\tunnel-client.exe",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: "C:\\Users\\Example\\.codex-chatgpt-web\\secrets\\tunnel-runtime.key",
      profileDir: "C:\\Users\\Example\\.codex-chatgpt-web\\tunnel\\profiles",
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  });
  const invocation = {
    executable: "C:\\Program Files\\Codex Web GPT\\resources\\runtime\\bun.exe",
    args: [
      "C:\\Program Files\\Codex Web GPT\\resources\\runtime\\app\\cli.js",
      "mcp",
      "--broker-socket",
      config.brokerSocketPath,
    ],
    cwd: "C:\\Program Files\\Codex Web GPT\\resources\\runtime",
  };
  const args = managedTunnelConnectArgs(config, invocation);
  assert.deepEqual(args.slice(0, 4), [
    "runtimes", "connect", "--alias", "codex-chatgpt-web",
  ]);
  assert.equal(args.includes("run"), false);
  assert.equal(args.at(-1), "--json");
  assert.equal(args[args.indexOf("--mcp-command") + 1].includes("bun.exe"), true);
  assert.equal(args[args.indexOf("--mcp-command") + 1].includes("\\\\\\\\.\\\\pipe\\\\codex-chatgpt-web-example"), true);
  assert.equal(args[args.indexOf("--mcp-command") + 1].includes("versions"), false);
  assert.throws(
    () => managedTunnelConnectArgs(config),
    /requires an explicit runtime invocation/,
  );
});

test("launcher repairs its runtime before building the tunnel MCP command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-runtime-"));
  const config = launcherConfig(path.join(root, "launcher-browser.json"), {
    mode: "full",
    runtimeCommand: [path.join(root, "versions", "stale", "runtime", "bun")],
    tunnel: {
      binaryPath: path.join(root, "bin", "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "secrets", "tunnel-runtime.key"),
      profileDir: path.join(root, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  });
  const repairedRuntime = path.join(root, "launcher-runtime");
  let runtimeRepairs = 0;
  let connectArgs;
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: true },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    installedRuntimeRoot: path.join(root, "versions", "stale"),
    runtimeRootProvider: () => {
      runtimeRepairs += 1;
      return repairedRuntime;
    },
    coreHome: root,
    browserDescriptorPath: config.browserHostDescriptorPath,
    runtimeInvocationFactory: ({ installedRuntimeRoot, args }) => ({
      executable: path.join(installedRuntimeRoot, "runtime", "bun"),
      args: [path.join(installedRuntimeRoot, "app", "cli.js"), ...args],
      cwd: installedRuntimeRoot,
    }),
  });
  supervisor.runTunnelCommand = async (_config, args) => {
    connectArgs = args;
    return { code: 0, stdout: "", stderr: "", output: "" };
  };

  try {
    await supervisor.runTunnelConnectCommand(config);
    const command = connectArgs[connectArgs.indexOf("--mcp-command") + 1];
    const serializedRuntime = repairedRuntime.replaceAll("\\", "\\\\");
    assert.equal(runtimeRepairs, 1);
    assert.equal(command.includes(serializedRuntime), true);
    assert.equal(command.includes(`${path.sep}versions${path.sep}`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel control failures preserve stderr even when stdout is also present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-control-output-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const result = await supervisor.runTunnelCommand({
      tunnel: {
        binaryPath: process.execPath,
        profileDir: root,
      },
    }, [
      "-e",
      "process.stdout.write('machine-readable output'); process.stderr.write('root failure'); process.exit(9)",
    ], 5_000, "Synthetic tunnel command");
    assert.equal(result.code, 9);
    assert.equal(result.stdout, "machine-readable output");
    assert.equal(result.stderr, "root failure");
    assert.equal(result.output, "root failure\nmachine-readable output");
    // Every command (stop and connect too) runs from a worker thread and times out by its label,
    // its process tree ended.
    const tunnel = { binaryPath: process.execPath, profileDir: root };
    await assert.rejects(supervisor.runTunnelCommand({ tunnel }, ["-e", "setInterval(() => {}, 1000)"], 300, "Synthetic tunnel shutdown"),
      /Synthetic tunnel shutdown timed out after 300ms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary and extra tunnel commands isolate native state and temp files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-extra-tunnel-env-"));
  const descriptorPath = path.join(root, "launcher.json");
  const inheritedDescriptor = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = path.join(root, "stale-inherited.json");
  t.after(() => {
    if (inheritedDescriptor === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = inheritedDescriptor;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    getRuntimeEnvironment: () => ({
      CODING_TOOLS_EXTRA_TUNNEL_TEST: "runtime-service",
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: path.join(root, "stale-supplied.json"),
    }),
  });
  const tunnel = { binaryPath: process.execPath, profileDir: root };
  const args = ["-e", `process.stdout.write(JSON.stringify({
    stateRoot: process.env.TUNNEL_CLIENT_STATE_DIR ?? null,
    temp: process.env.TEMP ?? null,
    tmp: process.env.TMP ?? null,
    service: process.env.CODING_TOOLS_EXTRA_TUNNEL_TEST ?? null,
    descriptor: process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR ?? null,
    inheritedPath: Boolean(process.env.PATH),
  }))`];
  const mainBefore = await supervisor.runTunnelCommand({ tunnel }, args, 5_000, "Main environment probe");
  const extra = await supervisor.extraTunnels.runTunnel(tunnel, args, 5_000, "Extra environment probe");
  const mainAfter = await supervisor.runTunnelCommand({ tunnel }, args, 5_000, "Main environment probe");
  assert.equal(mainBefore.code, 0);
  assert.equal(extra.code, 0);
  assert.deepEqual(JSON.parse(mainAfter.output), JSON.parse(mainBefore.output));
  const primaryStateRoot = path.join(fs.realpathSync.native(root), "tunnel", "primary-runtime");
  assert.deepEqual(JSON.parse(mainBefore.output), {
    stateRoot: primaryStateRoot,
    temp: path.join(primaryStateRoot, "temp"),
    tmp: path.join(primaryStateRoot, "temp"),
    service: process.env.CODING_TOOLS_EXTRA_TUNNEL_TEST ?? null,
    descriptor: descriptorPath,
    inheritedPath: Boolean(process.env.PATH),
  });
  assert.equal(fs.statSync(path.join(primaryStateRoot, "temp")).isDirectory(), true);
  const stateRoot = path.join(root, "tunnel", "extra-runtime");
  assert.deepEqual(JSON.parse(extra.output), {
    stateRoot,
    temp: path.join(stateRoot, "temp"),
    tmp: path.join(stateRoot, "temp"),
    service: "runtime-service",
    descriptor: descriptorPath,
    inheritedPath: JSON.parse(mainBefore.output).inheritedPath,
  });
  assert.equal(fs.statSync(path.join(stateRoot, "temp")).isDirectory(), true);
});

test("primary tunnel commands require migration only for an existing legacy alias", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-primary-tunnel-migration-"));
  const inheritedState = process.env.TUNNEL_CLIENT_STATE_DIR;
  t.after(() => {
    if (inheritedState === undefined) delete process.env.TUNNEL_CLIENT_STATE_DIR;
    else process.env.TUNNEL_CLIENT_STATE_DIR = inheritedState;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const legacyRoot = path.join(root, "legacy-state");
  process.env.TUNNEL_CLIENT_STATE_DIR = legacyRoot;
  fs.mkdirSync(legacyRoot, { recursive: true });
  const alias = "owned-primary";
  const record = { alias, tunnel_id: `tunnel_${"a".repeat(32)}` };
  const legacyFile = path.join(legacyRoot, "aliases.yaml");
  fs.writeFileSync(legacyFile, JSON.stringify({ [alias]: record }));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} }, sourceRoot: root, coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const tunnel = { alias, binaryPath: process.execPath, profileDir: root };
  const args = ["-e", "process.stdout.write('ready')"];
  const run = () => supervisor.runTunnelCommand({ tunnel }, args, 5_000, "Primary migration probe");
  const primaryRoot = path.join(root, "tunnel", "primary-runtime");
  const primaryFile = path.join(primaryRoot, "aliases.yaml");
  await assert.rejects(run(), /primary tunnel.*migration/i);
  assert.equal(fs.existsSync(primaryRoot), false, "blocked migration cannot create a new state root or launch a duplicate");
  fs.mkdirSync(primaryRoot, { recursive: true });
  fs.writeFileSync(primaryFile, "{}");
  await assert.rejects(run(), /primary tunnel.*migration/i);
  fs.writeFileSync(primaryFile, JSON.stringify({ unrelated: record }));
  await assert.rejects(run(), /primary tunnel.*migration/i);
  fs.writeFileSync(primaryFile, JSON.stringify({ [alias]: {} }));
  await assert.rejects(run(), /primary tunnel.*migration/i);
  fs.writeFileSync(primaryFile, "{}");
  fs.writeFileSync(legacyFile, "invalid JSON");
  await assert.rejects(run(), /primary tunnel.*(verify|migration|read)/i);
  fs.writeFileSync(legacyFile, JSON.stringify({ [alias]: record }));
  fs.writeFileSync(primaryFile, JSON.stringify({ [alias]: record }));
  assert.equal((await run()).output, "ready", "a migrated alias uses its app-owned state");
  fs.writeFileSync(primaryFile, "{}");
  fs.writeFileSync(legacyFile, JSON.stringify({ unrelated: record }));
  assert.equal((await run()).output, "ready", "a fresh managed alias is not blocked by unrelated legacy state");
  assert.equal(process.env.TUNNEL_CLIENT_STATE_DIR, legacyRoot, "selection must not change the launcher environment");
});

test("saved extra tunnels require migration when their isolated native state is missing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-extra-tunnel-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tunnel"), { recursive: true });
  fs.writeFileSync(path.join(root, "tunnel", "extra-tunnels.json"), JSON.stringify({
    version: 1,
    tunnels: [{ id: "0123abcd", label: "Saved account", tunnelId: `tunnel_${"b".repeat(32)}`, accountId: "acct-2" }],
  }));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const tunnel = { binaryPath: process.execPath, profileDir: root };
  const args = ["-e", "process.stdout.write('ready')"];
  await assert.rejects(
    async () => supervisor.extraTunnels.runTunnel(tunnel, args, 5_000, "Legacy extra tunnel probe"),
    /extra tunnels require migration/i,
  );
  assert.equal((await supervisor.runTunnelCommand({ tunnel }, args, 5_000, "Main tunnel probe")).output, "ready");
  const stateRoot = path.join(root, "tunnel", "extra-runtime");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "aliases.yaml"), "{}");
  assert.equal((await supervisor.extraTunnels.runTunnel(tunnel, args, 5_000, "Migrated extra tunnel probe")).output, "ready");
});

test("tunnel health diagnostics preserve the machine-readable readiness state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-detail-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  let commandArgs;
  supervisor.runTunnelCommand = async (_config, args) => {
    commandArgs = args;
    return {
      code: 0,
      output: JSON.stringify({
        entries: [{
          alias: "codex-web-gpt",
          runtime_state: "stopped",
          classification: "stale_alias",
          live_runtime: { found: false },
        }],
      }),
    };
  };
  try {
    assert.deepEqual(await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-web-gpt" },
    }), {
      ready: false,
      pid: null,
      state: "stopped",
      processRunning: false,
      healthy: false,
      absent: false,
      statusKnown: true,
      detail: "state=stopped; process_running=false; healthy=false; ready=false; classification=stale_alias; live_admin=false; pid=missing",
    });
    assert.deepEqual(commandArgs, ["runtimes", "cleanup", "--json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel failures surface a bounded summary instead of dumping the JSON payload into the UI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-summary-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const output = JSON.stringify({
    runtime_state: "stopped",
    process_running: false,
    healthy: false,
    ready: false,
    remote_error: "runtime principal cannot use the requested tunnel",
    launch_diagnostics: { log_tail: `old line\n${"x".repeat(4_000)}\nroot failure` },
  });
  supervisor.runTunnelCommand = async () => ({
    code: 2,
    stdout: output,
    stderr: "",
    output,
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-web-gpt" },
    });
    assert.match(health.detail, /state=stopped/);
    assert.match(health.detail, /runtime principal cannot use/);
    assert.doesNotMatch(health.detail, /"launch_diagnostics"/);
    assert.equal(health.detail.length <= 1_200, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel readiness preserves a native managed process identity when one is reported", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-pid-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({
      entries: [{
        alias: "codex-web-gpt",
        runtime_state: "ready",
        classification: "active_runtime",
        live_runtime: {
          found: true,
          base_url: "http://127.0.0.1:12345",
          system: { pid: 123_456_779 },
        },
      }],
    }),
  });
  try {
    assert.deepEqual(await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-web-gpt" },
    }), {
      ready: true,
      pid: 123_456_779,
      state: "ready",
      processRunning: true,
      healthy: true,
      absent: false,
      statusKnown: true,
      detail: "state=ready; process_running=true; healthy=true; ready=true; classification=active_runtime; live_admin=true; pid=123456779",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("steady tunnel monitoring uses the runtime local health endpoints without a control-plane status lookup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-local-tunnel-health-"));
  const health = await localHealthServer(() => 200, pathname => pathname.startsWith("/api/logs")
    ? JSON.stringify({ events: [] }) : "ok");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnel = { pid: process.pid, managed: true };
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  supervisor.readTunnelHealth = async () => {
    throw new Error("control-plane lookup must not run for a healthy local runtime");
  };
  try {
    const observation = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(observation.ready, true);
    assert.equal(observation.statusKnown, true);
    assert.match(observation.detail, /healthz returned HTTP 200/);
    assert.match(observation.detail, /readyz returned HTTP 200/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable local probe plus a stalled native status is unknown, not proof that the tunnel died", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-unknown-tunnel-health-"));
  const port = await freePort();
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnelHealthBaseUrl = `http://127.0.0.1:${port}`;
  supervisor.readTunnelHealth = async () => {
    throw new Error("Tunnel health probe timed out after 5000ms");
  };
  try {
    const observation = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, false);
    assert.match(observation.detail, /native status unavailable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit local readiness failure remains actionable tunnel evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-degraded-tunnel-health-"));
  const health = await localHealthServer(pathname => pathname === "/readyz" ? 503 : 200);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  try {
    const observation = await supervisor.readLocalTunnelHealth();
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, true);
    assert.equal(observation.state, "degraded");
    assert.match(observation.detail, /readyz returned HTTP 503/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recent internal MCP transport failures override false-green tunnel readiness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-mcp-degraded-"));
  const health = await localHealthServer(
    () => 200,
    pathname => pathname.startsWith("/api/logs")
      ? JSON.stringify({
        events: [{
          time: new Date().toISOString(),
          level: "WARN",
          message: "dispatcher received MCP upstream error; posted error response to control plane",
          attrs: {
            failure_source: "client_internal",
            status_code: 502,
            upstream_response_received: false,
            rpc_method: "initialize",
          },
        }],
      })
      : "ok",
  );
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnel = { pid: process.pid, managed: true };
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  try {
    const observation = await supervisor.readLocalTunnelHealth();
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, true);
    assert.equal(observation.fatal, true);
    assert.match(observation.detail, /MCP transport returned internal HTTP 502/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ready inventory cannot replace missing MCP evidence, and local evidence restores readiness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-evidence-"));
  let diagnosticsAvailable = false;
  const health = await localHealthServer(
    pathname => pathname.startsWith("/api/logs") && !diagnosticsAvailable ? 503 : 200,
    pathname => pathname.startsWith("/api/logs") ? JSON.stringify({ events: [] }) : "ok",
  );
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "launcher.json"),
  });
  let inventoryReads = 0;
  let stopped = false;
  supervisor.readTunnelHealth = async () => {
    inventoryReads += 1;
    return { ready: !stopped, statusKnown: true, state: stopped ? "stopped" : "ready",
      processRunning: !stopped, detail: "native inventory" };
  };
  try {
    // This inventory shape is observed on both real managed profiles: ready without a URL.
    const missing = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(missing.ready, false);
    assert.equal(missing.statusKnown, false);
    assert.equal(missing.fatal, false);
    supervisor.tunnelHealthBaseUrl = health.baseUrl;
    const unavailable = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.statusKnown, false);
    assert.equal(unavailable.fatal, false, "unreadable diagnostics are not proof of a broken dispatcher");
    diagnosticsAvailable = true;
    const restored = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(restored.ready, true);
    assert.equal(restored.statusKnown, true);
    assert.equal(inventoryReads, 2, "healthy local monitoring needs no inventory lookup");
    diagnosticsAvailable = false;
    stopped = true;
    const absent = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(absent.ready, false);
    assert.equal(absent.statusKnown, true);
    assert.equal(absent.state, "stopped");
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel readiness accepts the official tmux status without inventing a PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-tmux-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({
      entries: [{
        alias: "codex-chatgpt-web",
        runtime_state: "ready",
        classification: "active_runtime",
        live_runtime: { found: true, base_url: "http://127.0.0.1:12345" },
      }],
    }),
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-chatgpt-web" },
    });
    assert.equal(health.ready, true);
    assert.equal(health.pid, null);
    await supervisor.waitForTunnel({ tunnel: { alias: "codex-chatgpt-web" } }, 1);
    assert.equal(supervisor.tunnel?.managed, true);
    assert.equal(supervisor.tunnel?.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean machine reports the official unknown-alias status as an absent runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-absent-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({ entries: [] }),
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-chatgpt-web" },
    });
    assert.equal(health.ready, false);
    assert.equal(health.absent, true);
    assert.equal(health.statusKnown, true);
    assert.equal(health.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed startup fails immediately when native status reports a stopped runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stopped-start-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.readTunnelHealth = async () => ({
    ready: false,
    pid: null,
    state: "stopped",
    processRunning: false,
    healthy: false,
    absent: false,
    detail: "state=stopped; process_running=false",
  });
  try {
    await assert.rejects(
      supervisor.waitForTunnel({ tunnel: {} }, 120_000),
      /stopped during startup/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher adopts a healthy native managed tunnel without spawning a foreground wrapper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-adopt-"));
  const health = await localHealthServer(() => 200, pathname => pathname.startsWith("/api/logs")
    ? JSON.stringify({ events: [] }) : "ok");
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  let connects = 0;
  let monitors = 0;
  supervisor.tunnelHealthBaseUrl = "http://127.0.0.1:1";
  supervisor.readTunnelHealth = async () => ({
    ready: true,
    pid: process.pid,
    statusKnown: true,
    detail: "ready",
  });
  supervisor.runTunnelConnectCommand = async () => {
    connects += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.runTunnelCommand = async () => ({ code: 0,
    output: JSON.stringify({ local: { effective_health: { base_url: health.baseUrl } } }) });
  supervisor.startTunnelMonitor = () => { monitors += 1; };
  try {
    await supervisor.startTunnel({
      mode: "full",
      tunnel: {
        binaryPath,
        runtimeKeyFile,
        profileDir,
        profileName: "codex-chatgpt-web",
      },
    });
    assert.equal(connects, 0);
    assert.equal(monitors, 1);
    assert.equal(supervisor.tunnel?.pid, process.pid);
    assert.equal(supervisor.tunnel?.managed, true);
    assert.equal(supervisor.tunnelHealthBaseUrl, health.baseUrl, "adoption cannot inherit a stale endpoint");
    assert.equal((await supervisor.readLocalTunnelHealth()).ready, true);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const existingReady of [true, false]) {
  test(`a ${existingReady ? "previously running" : "newly connected"} tunnel cannot start monitoring before MCP verification`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-start-proof-"));
    const health = await localHealthServer(() => 200, pathname => pathname.startsWith("/api/logs")
      ? JSON.stringify({ events: [{ time: new Date().toISOString(),
        message: "dispatcher received MCP upstream error; posted error response to control plane",
        attrs: { failure_source: "client_internal", status_code: 502, upstream_response_received: false, rpc_method: "tools/call" },
      }] }) : "ok");
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0", isPackaged: false },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "launcher.json"),
    });
    let connected = existingReady;
    let monitoring = false;
    const config = { mode: "full", tunnel: { alias: "owned-test" } };
    supervisor.assertTunnelClientReady = () => {};
    supervisor.readTunnelHealth = async () => ({ ready: connected, statusKnown: true,
      state: connected ? "ready" : "stopped", processRunning: connected, pid: null });
    supervisor.runTunnelCommand = async () => ({ code: 0,
      output: JSON.stringify({ local: { effective_health: { base_url: health.baseUrl } } }) });
    supervisor.runTunnelConnectCommand = async () => { connected = true; return { code: 0 }; };
    supervisor.runTunnelStopCommand = async () => { connected = false; return { code: 0 }; };
    supervisor.waitForTunnelStopped = async () => { assert.equal(connected, false); };
    supervisor.startTunnelMonitor = () => { monitoring = true; };
    try {
      await assert.rejects(supervisor.startTunnel(config), /MCP transport is unhealthy/);
      assert.equal(monitoring, false);
      assert.equal(connected, false, "failed startup must complete its existing cleanup");
      assert.equal(supervisor.tunnel, null);
    } finally {
      await health.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("tunnel recovery replaces a false-green managed runtime and proves the fresh MCP transport", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-recovery-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const config = {
    mode: "full",
    tunnel: {
      binaryPath,
      runtimeKeyFile,
      profileDir,
      profileName: "codex-chatgpt-web",
    },
  };
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    launcherProfile: "development",
  });
  const events = [];
  let reads = 0;
  supervisor.readConfig = () => config;
  supervisor.readTunnelHealth = async () => {
    reads += 1;
    return {
      ready: true,
      pid: reads === 1 ? 123_456_778 : 123_456_779,
      statusKnown: true,
      detail: "ready",
    };
  };
  supervisor.runTunnelStopCommand = async () => {
    events.push("stop");
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    events.push("stopped");
  };
  supervisor.runTunnelConnectCommand = async () => {
    events.push("connect");
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelMcpTransport = async () => {
    events.push("mcp");
  };
  supervisor.startTunnelMonitor = () => { events.push("monitor"); };
  supervisor.tryWriteState = () => true;
  try {
    await supervisor.recover("tunnel");
    assert.deepEqual(events, [
      "stop",
      "stopped",
      "connect",
      "mcp",
      "monitor",
    ]);
    assert.equal(supervisor.tunnel?.pid, 123_456_779);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh tunnel recovery discovers its official loopback diagnostics before probing MCP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-discovery-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const config = {
    tunnel: {
      alias: "codex-chatgpt-web",
      binaryPath: path.join(root, "tunnel-client"),
      profileDir: root,
    },
  };
  const commands = [];
  supervisor.runTunnelCommand = async (_config, args) => {
    commands.push(args);
    return {
      code: 0,
      output: JSON.stringify({
        local: { health: { base_url: "http://127.0.0.1:43127" } },
      }),
    };
  };
  supervisor.probeTunnelMcpTransport = async () => ({
    observed: true,
    ok: true,
    fatal: false,
    detail: "MCP transport has no recent internal failures",
  });
  try {
    await supervisor.waitForTunnelMcpTransport(config, 25);
    assert.equal(supervisor.tunnelHealthBaseUrl, "http://127.0.0.1:43127");
    assert.deepEqual(commands, [["runtimes", "status", "codex-chatgpt-web", "--json"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel diagnostics discovery rejects a non-loopback endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-nonlocal-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({ health_url: "https://example.com/healthz" }),
  });
  try {
    await assert.rejects(
      supervisor.discoverTunnelHealthBaseUrl({
        tunnel: { alias: "codex-chatgpt-web", binaryPath: path.join(root, "tunnel-client"), profileDir: root },
      }),
      /no verified loopback endpoint/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher stops an unhealthy managed runtime before reconnecting the alias", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-reconnect-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const events = [];
  let reads = 0;
  supervisor.readTunnelHealth = async () => {
    reads += 1;
    return reads === 1
      ? { ready: false, pid: 123_456_777, statusKnown: true, detail: "state=degraded" }
      : { ready: true, pid: 123_456_776, statusKnown: true, detail: "state=ready" };
  };
  supervisor.runTunnelStopCommand = async () => {
    events.push("stop");
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    events.push("stopped");
  };
  supervisor.runTunnelConnectCommand = async () => {
    events.push("connect");
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelMcpTransport = async () => { events.push("mcp"); };
  supervisor.startTunnelMonitor = () => { events.push("monitor"); };
  try {
    await supervisor.startTunnel({
      mode: "full",
      tunnel: {
        binaryPath,
        runtimeKeyFile,
        profileDir,
        profileName: "codex-chatgpt-web",
      },
    });
    assert.deepEqual(events, [
      "stop",
      "stopped",
      "connect",
      "mcp",
      "monitor",
    ]);
    assert.equal(supervisor.tunnel?.pid, 123_456_776);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a connect that gives up while its tunnel still starts is waited out, not torn down and restarted", async () => {
  // Seen live: on a loaded machine connect exited non-zero with state=starting, the app stopped the
  // tunnel, and the watchdog started it again every two minutes for 20 minutes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-slow-connect-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const config = { mode: "full", tunnel: { binaryPath, runtimeKeyFile, profileDir, profileName: "codex-chatgpt-web" } };
  const run = async (connectState) => {
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0", isPackaged: false },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: root,
      coreHome: root,
      browserDescriptorPath: path.join(root, "launcher.json"),
    });
    const events = [];
    let reads = 0;
    supervisor.readTunnelHealth = async () => {
      reads += 1;
      // The first read is the known-status check before connecting; the tunnel is ready on the next.
      return reads === 1
        ? { ready: false, pid: null, statusKnown: true, absent: true, detail: "alias is not known" }
        : { ready: true, pid: 123_456_775, statusKnown: true, detail: "state=ready" };
    };
    supervisor.runTunnelStopCommand = async () => { events.push("stop"); return { code: 0, output: "{}" }; };
    supervisor.waitForTunnelStopped = async () => { events.push("stopped"); };
    supervisor.runTunnelConnectCommand = async () => {
      events.push("connect");
      const stdout = JSON.stringify({ state: connectState, process_running: connectState !== "stopped", healthy: false, ready: false });
      return { code: 1, stdout, stderr: "", output: stdout };
    };
    supervisor.waitForTunnelMcpTransport = async () => { events.push("mcp"); };
    supervisor.startTunnelMonitor = () => { events.push("monitor"); };
    const outcome = await supervisor.startTunnel(config).then(() => "started", (error) => error.message);
    return { outcome, events, pid: supervisor.tunnel?.pid };
  };
  try {
    const slow = await run("starting");
    assert.equal(slow.outcome, "started");
    assert.deepEqual(slow.events, ["stop", "stopped", "connect", "mcp", "monitor"], "never stopped again after connect");
    assert.equal(slow.pid, 123_456_775, "the running tunnel is adopted");
    const dead = await run("stopped");
    assert.match(dead.outcome, /refused managed startup: state=stopped/, "a tunnel whose process is gone still fails at once");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed tunnel startup accepts an absent alias only after its recorded process has exited", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-dead-cleanup-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.waitForKnownTunnelStatus = async () => ({
    ready: false,
    pid: null,
    state: undefined,
    processRunning: undefined,
    healthy: undefined,
    absent: true,
    statusKnown: true,
    detail: "alias is not known",
  });
  supervisor.runTunnelStopCommand = async () => ({
    code: 1,
    stdout: "",
    stderr: "alias codex-chatgpt-web is not known",
    output: "alias codex-chatgpt-web is not known",
  });
  supervisor.runTunnelConnectCommand = async () => {
    supervisor.tunnel = {
      pid: 999_999_999,
      exitCode: null,
      signalCode: null,
      managed: true,
    };
    throw new Error("synthetic connect failure");
  };
  try {
    await assert.rejects(
      supervisor.startTunnel({
        mode: "full",
        runtimeCommand: [process.execPath],
        brokerSocketPath: path.join(root, "broker.sock"),
        tunnel: {
          binaryPath,
          runtimeKeyFile,
          profileDir: root,
          profileName: "codex-chatgpt-web",
          alias: "codex-chatgpt-web",
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        },
      }),
      (error) => {
        assert.match(error.message, /synthetic connect failure/);
        assert.doesNotMatch(error.message, /startup cleanup failed/);
        return true;
      },
    );
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("graceful tunnel stop uses the native status contract instead of killing a recorded PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-wrapper-stop-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const child = { pid: 123_456_781, exitCode: null, signalCode: null, managed: true };
  const confirmations = [];
  supervisor.tunnel = child;
  supervisor.runTunnelStopCommand = async () => ({ code: 0, output: "{}" });
  supervisor.waitForTunnelStopped = async (_config, timeoutMs) => {
    confirmations.push(timeoutMs);
  };
  try {
    await supervisor.stopTunnelGracefully({ tunnel: {} }, 10);
    assert.deepEqual(confirmations, [10]);
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed native tunnel shutdown keeps the managed runtime monitored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-refused-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const child = { pid: 123_456_780, exitCode: null, signalCode: null };
  let monitorRestarts = 0;
  supervisor.tunnel = child;
  supervisor.runTunnelStopCommand = async () => ({ code: 9, output: "runtime refused stop" });
  supervisor.startTunnelMonitor = () => { monitorRestarts += 1; };
  try {
    await assert.rejects(
      supervisor.stopTunnelGracefully({ tunnel: {} }, 10),
      /runtime refused stop/,
    );
    assert.equal(supervisor.tunnel, child);
    assert.equal(monitorRestarts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted tunnel stop without terminal proof keeps the alias supervised", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-unconfirmed-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  let monitorRestarts = 0;
  supervisor.tunnel = managed;
  supervisor.runTunnelStopCommand = async () => ({ code: 0, output: "{}" });
  supervisor.waitForTunnelStopped = async () => {
    throw new Error("native status remained ambiguous");
  };
  supervisor.startTunnelMonitor = () => { monitorRestarts += 1; };
  try {
    await assert.rejects(
      supervisor.stopTunnelGracefully({ tunnel: {} }, 10),
      /native status remained ambiguous/,
    );
    assert.equal(supervisor.tunnel, managed);
    assert.equal(monitorRestarts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopping a tunnel monitor invalidates results from its previous generation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-monitor-generation-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const before = supervisor.tunnelMonitorGeneration;
    supervisor.stopTunnelMonitor();
    assert.equal(supervisor.tunnelMonitorGeneration, before + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher shutdown reacquires a managed tunnel that was between monitor and recovery states", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-reconcile-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const config = { mode: "full", tunnel: { alias: "codex-chatgpt-web" } };
  let stops = 0;
  let confirmations = 0;
  supervisor.readConfig = () => config;
  supervisor.readTunnelHealth = async () => ({
    ready: true,
    pid: 123_456_779,
    state: "ready",
    processRunning: true,
    healthy: true,
    absent: false,
    statusKnown: true,
    detail: "state=ready",
  });
  supervisor.runTunnelStopCommand = async () => {
    stops += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    confirmations += 1;
  };
  try {
    assert.deepEqual(await supervisor.stopForSetup(), { status: "stopped" });
    assert.equal(stops, 1);
    assert.equal(confirmations, 1);
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crash-loop diagnostics include the last redacted child failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-crash-loop-diagnostic-"));
  const operations = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    publishOperation: operation => operations.push(operation),
  });
  supervisor.restartHistory.tunnel = Array.from(
    { length: MAX_RESTARTS_PER_WINDOW },
    () => Date.now(),
  );
  supervisor.lastChildFailure.tunnel = "tunnel exited (1): invalid profile for [tunnel-id]";
  try {
    supervisor.scheduleRecovery("tunnel");
    const failure = operations.at(-1);
    assert.equal(failure.status, "failed");
    assert.match(failure.message, /automatic restart is disabled/);
    assert.match(failure.message, /last failure: tunnel exited \(1\): invalid profile for \[tunnel-id\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor refuses shutdown while a Codex turn is active and compensates the drain", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.control = async (_config, action) => {
    actions.push(action);
    return action === "drain"
      ? { accepting_turns: false, active_http_turns: 1, active_browser_turns: 0 }
      : { accepting_turns: true, active_http_turns: 1, active_browser_turns: 0 };
  };
  await assert.rejects(
    supervisor.acquireDrain({}, 0),
    /atomic idleness could not be proven.*1 active HTTP turn/,
  );
  assert.deepEqual(actions, ["drain", "resume"]);
});

test("launcher supervisor waits for an in-flight HTTP turn to finish after draining", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  let drainChecks = 0;
  supervisor.control = async (_config, action) => {
    actions.push(action);
    drainChecks += 1;
    return {
      accepting_turns: false,
      active_http_turns: drainChecks === 1 ? 1 : 0,
      active_browser_turns: 0,
    };
  };

  await supervisor.acquireDrain({}, 1_000);
  assert.deepEqual(actions, ["drain", "drain"]);
});

test("explicit launcher shutdown cancels active turns before the graceful stop", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.cancelActiveTurns = async () => {
    actions.push("cancel-turns");
    return { cancelledHttpTurns: 1, cancelledBrowserTurns: 1 };
  };
  supervisor.stopForSetup = async () => {
    actions.push("graceful-stop");
    return { status: "stopped" };
  };

  assert.deepEqual(
    await supervisor.shutdown({ cancelActiveTurns: true, force: true }),
    { status: "stopped" },
  );
  assert.deepEqual(actions, ["cancel-turns", "graceful-stop"]);
});

test("launcher supervisor requests exact browser trace cancellation", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.readConfig = () => ({ controlToken: "control", host: "127.0.0.1", port: 17841 });
  supervisor.daemon = { exitCode: null, signalCode: null };
  supervisor.control = async (_config, action, options) => {
    assert.equal(action, "cancel-turn");
    assert.deepEqual(options.body, { traceId: "trace_exact" });
    assert.equal(options.timeoutMs, 15_000);
    return {
      status: "ok",
      trace_id: "trace_exact",
      cancelled_browser_turns: 1,
      cancelled_broker_turns: 1,
    };
  };

  const result = await supervisor.cancelBrowserTurn("trace_exact");
  assert.equal(result.trace_id, "trace_exact");
});

test("explicit launcher shutdown force-stops only its owned runtime when graceful shutdown fails", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.cancelActiveTurns = async () => { actions.push("cancel-turns"); };
  supervisor.stopForSetup = async () => {
    actions.push("graceful-stop");
    throw new Error("daemon still reports one HTTP turn");
  };
  supervisor.forceStopOwnedRuntime = async error => {
    actions.push(`forced-stop:${error.message}`);
    return { status: "forced", detail: error.message };
  };

  assert.deepEqual(
    await supervisor.shutdown({ cancelActiveTurns: true, force: true }),
    { status: "forced", detail: "daemon still reports one HTTP turn" },
  );
  assert.deepEqual(actions, [
    "cancel-turns",
    "graceful-stop",
    "forced-stop:daemon still reports one HTTP turn",
  ]);
});

test("launcher resumes an owned drained daemon before reporting it ready", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  const child = { pid: 123_456_789, exitCode: null, signalCode: null };
  let accepting = false;
  const actions = [];
  supervisor.daemon = child;
  supervisor.proxyHealth = async (_config, _timeoutMs, expectedPid, requireAccepting) => (
    expectedPid === child.pid && (!requireAccepting || accepting)
  );
  supervisor.control = async (_config, action) => {
    actions.push(action);
    accepting = true;
    return { status: "ok", accepting_turns: true };
  };
  supervisor.waitForProxy = async () => {
    assert.equal(accepting, true);
  };

  await supervisor.startDaemon({});
  assert.deepEqual(actions, ["resume"]);
  assert.equal(supervisor.daemon, child);
});

test("launcher restarts the daemon when a failed stop already terminated the drained child", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  let portReleased = 0;
  let starts = 0;
  supervisor.daemon = null;
  supervisor.waitForPortRelease = async () => { portReleased += 1; };
  supervisor.startDaemon = async () => {
    starts += 1;
    supervisor.daemon = { pid: 123_456_782, exitCode: null, signalCode: null };
  };

  const result = await supervisor.restoreDrainedDaemon({});
  assert.deepEqual(result, { status: "restarted", pid: 123_456_782 });
  assert.equal(portReleased, 1);
  assert.equal(starts, 1);
});

test("launcher marks compensation ready only after both owned runtime processes pass health checks", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.daemon = { pid: 123_456_783, exitCode: null, signalCode: null };
  supervisor.proxyHealth = async () => true;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "browser-only" }), true);

  supervisor.tunnel = { pid: 123_456_784, exitCode: null, signalCode: null };
  supervisor.tunnelHealth = async () => false;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "full" }), false);
  supervisor.tunnelHealth = async () => true;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "full" }), true);
});

test("the owned-runtime check says which part failed, for the launcher watchdog's log", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  const full = { mode: "full" };
  assert.deepEqual(await supervisor.ownedRuntimeCheck(full), { ready: false, failed: "daemon_missing" });
  supervisor.daemon = { pid: 123_456_785, exitCode: 1, signalCode: null };
  assert.deepEqual(await supervisor.ownedRuntimeCheck(full), { ready: false, failed: "daemon_exited" });
  supervisor.daemon = { pid: 123_456_785, exitCode: null, signalCode: null };
  supervisor.proxyHealth = async () => false;
  assert.deepEqual(await supervisor.ownedRuntimeCheck(full), { ready: false, failed: "daemon_health" });
  supervisor.proxyHealth = async () => true;
  assert.deepEqual(await supervisor.ownedRuntimeCheck(full), { ready: false, failed: "tunnel_missing" });
  supervisor.tunnel = { pid: 123_456_786, exitCode: null, signalCode: null };
  supervisor.tunnelHealth = async () => false;
  assert.deepEqual(await supervisor.ownedRuntimeCheck(full), { ready: false, failed: "tunnel_health" });
  supervisor.tunnelHealth = async () => true;
  assert.deepEqual(await supervisor.ownedRuntimeCheck(full), { ready: true });
  assert.deepEqual(await supervisor.ownedRuntimeCheck({ mode: "browser-only" }), { ready: true });
});

test("failed initial health checks stop their child without scheduling crash recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-startup-cleanup-"));
  const childPath = path.join(root, "child.cjs");
  fs.writeFileSync(childPath, "setInterval(() => {}, 1000);\n");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [childPath],
      cwd: root,
    }),
  });
  let recoveries = 0;
  supervisor.waitForProxy = async () => {
    throw new Error("synthetic health failure");
  };
  supervisor.scheduleRecovery = () => {
    recoveries += 1;
  };
  try {
    await assert.rejects(supervisor.startDaemon({}), /synthetic health failure/);
    assert.equal(supervisor.daemon, null);
    assert.equal(recoveries, 0);
  } finally {
    await supervisor.stopChild("daemon").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher preserves stale ownership evidence when an old active runtime cannot be drained", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-active-stale-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(launcherConfig(descriptorPath, {
    releaseVersion: "0.1.16",
    controlToken: "active-stale-control-token-0123456789abcdef",
  }))}\n`);
  const staleState = {
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: process.pid,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(staleState)}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  supervisor.proxyHealth = async () => true;
  supervisor.stopStaleOwnedRuntime = async () => {
    throw new Error("daemon has 0 active HTTP turn(s) and 1 active browser turn(s)");
  };

  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "external");
    assert.match(result.detail, /1 active browser turn/);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), staleState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher recovers a stale tunnel even when no stale Responses proxy is reachable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-tunnel-only-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(launcherConfig(descriptorPath, {
    mode: "full",
    controlToken: "stale-tunnel-control-token-0123456789abcdef",
    tunnel: {
      binaryPath: path.join(root, "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "runtime.key"),
      profileDir: path.join(root, "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }))}\n`);
  fs.writeFileSync(path.join(root, "runtime", "launcher-supervisor.json"), `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: process.pid,
    status: "degraded",
    updatedAt: new Date().toISOString(),
  })}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  let recovered = 0;
  supervisor.proxyHealth = async () => false;
  supervisor.stopStaleOwnedRuntime = async () => {
    recovered += 1;
    return true;
  };
  supervisor.startTunnel = async () => {
    supervisor.tunnel = { pid: 123_456_780 };
  };
  supervisor.startDaemon = async () => {
    supervisor.daemon = { pid: 123_456_781 };
  };
  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "ready");
    assert.equal(recovered, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale ownership recovery stops a managed tmux runtime even though it has no PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-tmux-tunnel-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  })}\n`);
  supervisor.proxyHealthPayload = async () => null;
  supervisor.waitForKnownTunnelStatus = async () => ({
    ready: true,
    pid: null,
    state: "ready",
    processRunning: true,
    healthy: true,
    absent: false,
    statusKnown: true,
    detail: "state=ready; process_running=true; healthy=true; ready=true; pid=missing",
  });
  let stops = 0;
  supervisor.runTunnelStopCommand = async () => {
    stops += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => ({
    ready: false,
    pid: null,
    state: "stopped",
    processRunning: false,
    absent: false,
    statusKnown: true,
    detail: "state=stopped; process_running=false",
  });
  try {
    assert.equal(await supervisor.stopStaleOwnedRuntime({
      mode: "full",
      tunnel: { alias: "codex-chatgpt-web" },
    }), true);
    assert.equal(stops, 1);
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a ready tunnel whose health discovery times out once is still verified, not torn down", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  // As on 2026-10-30 04:50: connect reported ready, then one 5 s discovery call timed out.
  let discoveries = 0;
  supervisor.discoverTunnelHealthBaseUrl = async () => {
    discoveries += 1;
    if (discoveries === 1) throw new Error("Local tunnel health discovery timed out after 5000ms");
    supervisor.tunnelHealthBaseUrl = "http://127.0.0.1:43123";
    return supervisor.tunnelHealthBaseUrl;
  };
  supervisor.probeTunnelMcpTransport = async () => ({ observed: true, ok: true, fatal: false, detail: "ok" });
  const health = await supervisor.waitForTunnelMcpTransport({ tunnel: { alias: "codex-chatgpt-web" } });
  assert.equal(health.ok, true);
  assert.equal(discoveries, 2);
});

test("health discovery that never answers still fails with its own reason", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.discoverTunnelHealthBaseUrl = async () => {
    throw new Error("Local tunnel health discovery timed out after 5000ms");
  };
  await assert.rejects(
    supervisor.waitForTunnelMcpTransport({ tunnel: { alias: "codex-chatgpt-web" } }, 1_500),
    /Local tunnel health discovery timed out after 5000ms/,
  );
});

test("one timed-out inventory probe is polled again, not taken as an external owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-slow-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  })}\n`);
  supervisor.proxyHealthPayload = async () => null;
  // As on 2026-10-29 00:58: the CLI's cold start on a loaded machine outlasts the 5 s probe once.
  const probes = [];
  supervisor.runTunnelCommand = async (_config, args, timeoutMs, label) => {
    probes.push(args.join(" "));
    if (probes.length === 1) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    const inventory = JSON.stringify({ entries: [] });
    return { code: 0, stdout: inventory, stderr: "", output: inventory };
  };
  assert.equal(await supervisor.stopStaleOwnedRuntime({
    mode: "full",
    tunnel: { alias: "codex-chatgpt-web" },
  }), true);
  assert.deepEqual(probes, ["runtimes cleanup --json", "runtimes cleanup --json"]);
  assert.equal(fs.existsSync(supervisor.statePath), false);
});

test("a timed-out inventory probe reads as unknown status with its reason", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.runTunnelCommand = async (_config, _args, timeoutMs, label) => {
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  };
  const health = await supervisor.readTunnelHealth({ tunnel: { alias: "codex-chatgpt-web" } });
  assert.equal(health.statusKnown, false);
  assert.equal(health.ready, false);
  assert.equal(health.absent, false);
  assert.match(health.detail, /Local tunnel inventory probe timed out after 5000ms/);
});

for (const [label, content] of [["empty", Buffer.alloc(0)], ["zero-filled", Buffer.alloc(179)]]) {
  test(`launcher recovers a ${label} ownership marker without losing its bytes`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-empty-ownership-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const descriptor = path.join(root, "launcher.json");
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0", isPackaged: false },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: root, coreHome: root, browserDescriptorPath: descriptor,
    });
    fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
    fs.writeFileSync(supervisor.statePath, content);
    assert.equal(supervisor.readState(), null);
    // Set aside as missing (a power cut's torn marker), its bytes kept in Trash: checked below.
    assert.equal(fs.existsSync(supervisor.statePath), false);
    supervisor.readConfig = () => launcherConfig(descriptor);
    supervisor.proxyHealth = async () => false;
    let starts = 0;
    supervisor.startDaemon = async () => { starts += 1; };
    supervisor.startTunnel = async () => {};
    assert.equal((await supervisor.startConfigured()).status, "ready");
    assert.equal(starts, 1);
    assert.equal(JSON.parse(fs.readFileSync(supervisor.statePath, "utf8")).status, "ready");
    const trash = path.join(root, "Trash");
    const backups = fs.readdirSync(trash);
    assert.ok(backups.length > 0);
    for (const backup of backups) {
      assert.deepEqual(fs.readFileSync(path.join(trash, backup, "launcher-supervisor.json")), content);
    }
  });
}

test("a zero-filled marker never authorizes taking over a healthy unowned runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-empty-unowned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = path.join(root, "launcher.json");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root, coreHome: root, browserDescriptorPath: descriptor,
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, Buffer.alloc(179));
  supervisor.readConfig = () => launcherConfig(descriptor);
  supervisor.proxyHealth = async () => true;
  supervisor.startDaemon = async () => assert.fail("must not start a second runtime");
  supervisor.control = async () => assert.fail("must not control an unowned runtime");
  assert.equal((await supervisor.startConfigured()).status, "external");
  assert.equal(supervisor.daemon, null);
});

test("launcher fails closed on a corrupt runtime ownership marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-corrupt-runtime-state-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, "{\"version\":1}\n");
  try {
    assert.throws(() => supervisor.readState(), /ownership state is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a marker a power cut tore (NUL bytes, or empty) reads as missing and is cleared, not as corrupt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-torn-runtime-state-"));
  const warnings = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn(event, detail) { warnings.push([event, detail]); }, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  try {
    // 2026-10-23: after a hard reset the file kept its 233-byte size, all NULs, and every watchdog
    // restart failed on it for 25 minutes.
    for (const torn of [Buffer.alloc(233), Buffer.alloc(0), Buffer.from("\n")]) {
      fs.writeFileSync(supervisor.statePath, torn);
      assert.equal(supervisor.readState(), null);
      assert.equal(fs.existsSync(supervisor.statePath), false, "it is set aside");
    }
    assert.deepEqual(warnings.map(([event]) => event), ["runtime.state_torn", "runtime.state_torn", "runtime.state_torn"]);
    assert.equal(warnings[0][1].bytes, 233);
    supervisor.writeState("idle");
    assert.equal(supervisor.readState().status, "idle");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable marker is set aside only when it was written before this boot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-preboot-runtime-state-"));
  const warnings = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn: (event) => warnings.push(event), error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  // Cut off mid-write: not the NULs the torn check sets aside, and not JSON either.
  fs.writeFileSync(supervisor.statePath, "{\n  \"version\": 1,\n  \"ownerPid\": 324");
  try {
    // Written since this boot: its processes may be alive, so it still fails closed.
    assert.throws(() => supervisor.readState(), /ownership state is invalid/);
    assert.equal(fs.existsSync(supervisor.statePath), true);

    const beforeBoot = new Date(Date.now() - os.uptime() * 1_000 - 60_000);
    fs.utimesSync(supervisor.statePath, beforeBoot, beforeBoot);
    assert.equal(supervisor.readState(), null);
    assert.equal(fs.existsSync(supervisor.statePath), false, "it is set aside, as a torn marker is");
    assert.deepEqual(warnings, ["runtime.state_discarded"]);
    const [backup] = fs.readdirSync(path.join(root, "Trash"));
    assert.equal(fs.readFileSync(path.join(root, "Trash", backup, "launcher-supervisor.json"), "utf8"), "{\n  \"version\": 1,\n  \"ownerPid\": 324");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the ownership marker is flushed to disk before it replaces the old one", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime-supervisor.cjs"), "utf8");
  assert.match(source, /writePrivateFileAtomic\(this\.statePath, [^\n]*\{ durable: true \}\)/);
  const { writePrivateFileAtomic } = require("../electron/atomic-file.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-durable-write-"));
  const synced = [];
  const fsync = fs.fsyncSync;
  fs.fsyncSync = (descriptor) => { synced.push(descriptor); return fsync(descriptor); };
  try {
    const file = path.join(root, "state.json");
    writePrivateFileAtomic(file, "{\"a\":1}\n", { durable: true });
    assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":1}\n");
    assert.equal(synced.length, 1);
    writePrivateFileAtomic(file, "{\"a\":2}\n");
    assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":2}\n");
    assert.equal(synced.length, 1, "only durable writes pay for a flush");
    assert.deepEqual(fs.readdirSync(root), ["state.json"]);
  } finally {
    fs.fsyncSync = fsync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher clears an empty stale ownership marker when Windows reuses its PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-reused-owner-pid-"));
  const pidOccupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: pidOccupant.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "failed",
    updatedAt: new Date().toISOString(),
  })}\n`);
  try {
    assert.deepEqual(await supervisor.startConfigured(), { status: "not-configured" });
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    pidOccupant.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed full-runtime marker with no child evidence cannot block removal on a stalled tunnel probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dead-runtime-removal-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, {
    mode: "full",
    tunnel: {
      binaryPath: path.join(root, "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "runtime.key"),
      profileDir: path.join(root, "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }))}\n`);
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    ownerPid: process.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "external",
    updatedAt: new Date().toISOString(),
  })}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  let tunnelProbes = 0;
  supervisor.proxyHealth = async () => false;
  supervisor.readTunnelHealth = async () => {
    tunnelProbes += 1;
    throw new Error("Tunnel health probe timed out after 5000ms");
  };
  try {
    assert.deepEqual(await supervisor.stopForSetup(), { status: "stopped" });
    assert.equal(tunnelProbes, 0);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external migration clears only stale launcher ownership evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-external-migration-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  const state = (ownerPid) => ({
    version: 1,
    ownerPid,
    daemonPid: null,
    tunnelPid: null,
    status: "failed",
    updatedAt: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state(process.pid))}\n`);
    assert.throws(
      () => supervisor.prepareExternalMigration(),
      /ownership processes are still alive/,
    );
    fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state(999_999_999))}\n`);
    supervisor.prepareExternalMigration();
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor starts, health-checks, drains, and stops its daemon", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-supervisor-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const serverPath = path.join(root, "fake-runtime.cjs");
  const port = await freePort();
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, {
    port,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
  }))}\n`);
  fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const http = require("node:http");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let draining = false;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({
      status: "ok",
      service: "codex-chatgpt-web",
      mode: config.mode,
      version: config.releaseVersion,
      pid: process.pid,
      accepting_turns: !draining,
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/admin/drain") draining = true;
  else if (request.method === "POST" && request.url === "/admin/resume") draining = false;
  else if (request.method === "POST" && request.url === "/admin/shutdown" && draining) {
    response.end(JSON.stringify({ status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    server.close(() => process.exit(0));
    return;
  }
  else {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  response.end(JSON.stringify({ accepting_turns: !draining, active_http_turns: 0, active_browser_turns: 0 }));
});
server.listen(config.port, config.host);
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`);

  const records = [];
  const logger = {
    info(event, detail) { records.push({ level: "info", event, detail }); },
    warn(event, detail) { records.push({ level: "warning", event, detail }); },
    error(event, detail) { records.push({ level: "error", event, detail }); },
  };
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger,
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [serverPath, configPath],
      cwd: root,
    }),
  });

  try {
    const started = await supervisor.startIfConfigured();
    assert.equal(started.status, "ready");
    const state = JSON.parse(fs.readFileSync(path.join(root, "runtime", "launcher-supervisor.json"), "utf8"));
    assert.equal(state.status, "ready");
    assert.equal(Number.isInteger(state.daemonPid), true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).ok, true);

    const stopped = await supervisor.stopForSetup();
    assert.equal(stopped.status, "stopped");
    assert.equal(fs.existsSync(path.join(root, "runtime", "launcher-supervisor.json")), false);
    assert.equal(records.some((record) => record.event === "runtime.daemon_started"), true);
  } finally {
    await supervisor.stopForSetup().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor safely replaces an idle daemon left by a crashed launcher owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-owner-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  const configPath = path.join(root, "config.json");
  const serverPath = path.join(root, "fake-runtime.cjs");
  const port = await freePort();
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, {
    port,
    controlToken: "stale-owner-test-control-token-0123456789",
  }))}\n`);
  fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const http = require("node:http");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let draining = false;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "close");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({
      status: "ok",
      service: "codex-chatgpt-web",
      mode: config.mode,
      version: config.releaseVersion,
      pid: process.pid,
      accepting_turns: !draining,
    }));
    return;
  }
  if (request.headers.authorization !== "Bearer " + config.controlToken) {
    response.statusCode = 401;
    response.end("{}");
    return;
  }
  if (request.method === "POST" && request.url === "/admin/drain") draining = true;
  else if (request.method === "POST" && request.url === "/admin/resume") draining = false;
  else if (request.method === "POST" && request.url === "/admin/shutdown" && draining) {
    response.end(JSON.stringify({ status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    server.close(() => process.exit(0));
    return;
  } else {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  response.end(JSON.stringify({ status: "ok", accepting_turns: !draining, active_http_turns: 0, active_browser_turns: 0 }));
});
server.listen(config.port, config.host);
`);
  const stale = spawn(process.execPath, [serverPath, configPath], {
    cwd: root,
    stdio: "ignore",
  });
  const logger = { info() {}, warn() {}, error() {} };
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger,
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [serverPath, configPath],
      cwd: root,
    }),
  });

  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).ok, true);
    fs.writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      ownerPid: 999_999_999,
      daemonPid: stale.pid,
      tunnelPid: null,
      status: "ready",
      updatedAt: new Date().toISOString(),
    })}\n`);

    const started = await supervisor.startIfConfigured();
    assert.equal(started.status, "ready");
    assert.notEqual(started.daemonPid, stale.pid);
    assert.equal(stale.exitCode !== null || stale.killed, true);
  } finally {
    await supervisor.stopForSetup().catch(() => {});
    if (stale.exitCode === null) stale.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
