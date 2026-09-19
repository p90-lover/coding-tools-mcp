"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  hostNpmPrepareAllowed,
  installWindowsCwdLifecycleFallbacks,
  installWindowsCwdNodeCommands,
  installWindowsNodeBinShims,
  materializeNpmWorkspaceLinks,
  npmSpawnInvocation,
  prepareFiveStackRuntime,
  rewritePackageScriptsToAbsoluteNode,
  resolveNodeExecutable,
  withAbsoluteNodeCommand,
  withAbsoluteNpmCommand,
} = require("../scripts/prepare-five-stack-runtime.cjs");
const { prepare } = require("../electron/codex-router-managed.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function bundledManifest(id, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: `fixture/${id}`,
    repositoryUrl: `https://github.com/fixture/${id}.git`,
    commit: "b".repeat(40),
    version: "1.0.0",
    strategy: extra.strategy || "bundled-source",
    install: { steps: [{ id: "activate", kind: "activate" }] },
    launch: {
      processes: [{ id: "service", mode: "foreground", executable: "node", arguments: [] }],
    },
    health: { endpoint: "http://127.0.0.1:9090/", acceptStatus: [200] },
    ...extra,
  };
}

test("Desktop panels never tell the user to download or install a separate app", () => {
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const original = read("src/features/OriginalUiSurface.tsx");
  const originalUi = read("electron/original-ui.cjs");

  assert.match(surface, /Start all/);
  assert.match(surface, /Repair runtime/);
  assert.doesNotMatch(surface, /Prepare bundled runtime/);
  assert.doesNotMatch(surface, /Install and start all/);
  assert.doesNotMatch(surface, /Install \/ Repair/);
  assert.doesNotMatch(surface, /download a separate app/i);
  assert.doesNotMatch(surface, /must download/i);
  assert.doesNotMatch(surface, /download component first/i);
  assert.doesNotMatch(original, /Install \/ start original runtime/);
  assert.doesNotMatch(original, /Install and start the managed runtime/);
  assert.match(original, /Start original UI/);
  assert.match(original, /Start the bundled runtime/);
  assert.doesNotMatch(originalUi, /Install the pinned Codex Router source/);
  assert.doesNotMatch(originalUi, /Install and start managed CPA/);
});

test("prepare-five-stack-runtime materializes pinned sources and CPA archives from a local cache", async () => {
  const repositoryRoot = temporaryDirectory("coding-tools-five-stack-repo");
  const desktopDir = path.join(repositoryRoot, "desktop-electron");
  const manifestRoot = path.join(desktopDir, "vendor", "managed-components");
  const cacheRoot = path.join(repositoryRoot, "cache");
  const outputRoot = path.join(desktopDir, "build", "five-stack-runtime");
  const payload = Buffer.from("bundled-cpa-archive", "utf8");
  const digest = sha256(payload);

  for (const id of ["codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id));
    const source = path.join(cacheRoot, id, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, `${id}.txt`), `${id} bundled\n`);
  }
  writeJson(path.join(manifestRoot, "cpa.json"), bundledManifest("cpa", {
    strategy: "release-binary",
    commit: undefined,
    platforms: {
      [process.platform]: {
        [process.arch]: {
          url: "https://github.com/fixture/cpa/releases/download/v1.0.0/cpa.bin",
          sha256: digest,
          fileName: "cpa.bin",
        },
      },
    },
  }));
  fs.mkdirSync(path.join(cacheRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, "cpa", "cpa.bin"), payload);

  let fetched = 0;
  const result = await prepareFiveStackRuntime({
    repositoryRoot,
    desktopRoot: desktopDir,
    manifestRoot,
    outputRoot,
    cacheRoot,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("prepare-five-stack-runtime must not fetch when a cache is present");
    },
    spawnSyncProcess: () => {
      throw new Error("prepare-five-stack-runtime must not git clone when a cache is present");
    },
    now: () => "2026-09-18T12:00:00.000Z",
    nonce: () => "fixture",
  });

  assert.equal(fetched, 0);
  assert.equal(result.outputRoot, outputRoot);
  assert.equal(fs.readFileSync(path.join(outputRoot, "commandcode-proxy", "source", "commandcode-proxy.txt"), "utf8"), "commandcode-proxy bundled\n");
  assert.deepEqual(fs.readFileSync(path.join(outputRoot, "cpa", "cpa.bin")), payload);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(outputRoot, "commandcode-proxy", "source", "CODING_TOOLS_BUNDLED.json"), "utf8")).skipNetworkPrepare,
    true,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(outputRoot, "cpa", "CODING_TOOLS_BUNDLED.json"), "utf8")).skipNetworkPrepare,
    true,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.productVersion, "0.7.0-rc.12");
  assert.deepEqual(manifest.components.map((component) => component.id), [
    "codex-router",
    "commandcode-proxy",
    "cpa",
    "paseo",
    "anneal",
  ]);
});

test("production Start is fail-closed and never fetches components from the network", () => {
  const controller = read("electron/managed-components.cjs");
  const adapter = read("electron/codex-router-managed.cjs");
  const originalUi = read("electron/codex-router-original-ui.cjs");
  assert.match(controller, /allowNetworkInstall = false/);
  assert.match(controller, /bundleRequired\(manifest\) \|\| !allowNetworkInstall/);
  assert.match(controller, /wsl2ManagedPrepareAllowed/);
  assert.match(controller, /context\.mode === "wsl2"/);
  assert.match(adapter, /bundledSkipNetworkPrepare/);
  assert.match(adapter, /prepareOfflineFromBundle/);
  assert.doesNotMatch(originalUi, /npm ci/);
  assert.match(originalUi, /does not download npm packages at Start/);
  assert.match(originalUi, /is not downloaded separately/);
});

test("Codex Router prepare unpacks from CODING_TOOLS_BUNDLED.json without install.ps1 or bin/install", () => {
  const home = temporaryDirectory("coding-tools-router-bundled-home");
  const state = temporaryDirectory("coding-tools-router-bundled-state");
  fs.mkdirSync(path.join(home, "src"), { recursive: true });
  fs.mkdirSync(path.join(home, "apps", "control-center", "dist"), { recursive: true });
  fs.mkdirSync(path.join(home, "apps", "control-center", "electron"), { recursive: true });
  fs.writeFileSync(path.join(home, "package.json"), `${JSON.stringify({
    name: "codex-model-router",
    version: "0.6.0",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, "src", "foreground-start.mjs"), "export {};\n");
  fs.writeFileSync(path.join(home, "src", "curate-models.mjs"), "export {};\n");
  fs.writeFileSync(path.join(home, "apps", "control-center", "package.json"), `${JSON.stringify({
    name: "@codex-router/control-center",
    version: "0.6.0",
    main: "electron/main.mjs",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, "apps", "control-center", "electron", "main.mjs"), "export {};\n");
  fs.writeFileSync(path.join(home, "apps", "control-center", "dist", "index.html"), "<!doctype html><title>Control Center</title>");
  writeJson(path.join(home, "CODING_TOOLS_BUNDLED.json"), {
    schemaVersion: 1,
    id: "codex-router",
    version: "0.6.0",
    skipNetworkPrepare: true,
  });
  fs.writeFileSync(path.join(home, "install.ps1"), "throw 'network install must not run'\n");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "install"), "#!/bin/bash\nexit 1\n");

  prepare(home, state);

  const callerSecret = fs.readFileSync(path.join(state, "router", "caller-secret"), "utf8").trim();
  assert.ok(callerSecret.length >= 32);
  const wrapper = process.platform === "win32"
    ? path.join(state, "bin", "model-router.cmd")
    : path.join(state, "bin", "model-router");
  assert.equal(fs.existsSync(wrapper), true);
});

test("Windows five-stack npm prepare uses cmd.exe npm.cmd with npm on PATH", () => {
  const source = read("scripts/prepare-five-stack-runtime.cjs");
  assert.match(source, /npm\.cmd/);
  assert.match(source, /withNpmOnPath/);
  assert.match(source, /resolveNodeExecutable/);
  assert.match(source, /isBunExecutable/);
  assert.match(source, /npm_config_scripts_prepend_node_path/);
  assert.match(source, /resolveNpmCliJs/);
  assert.match(source, /npm-cli\.js/);
  assert.match(source, /coding-tools-node-shims/);
  assert.match(source, /rewritePackageScriptsToAbsoluteNode/);
  assert.match(source, /installWindowsCwdNodeCommands/);
  assert.match(source, /installWindowsCwdLifecycleFallbacks/);
  assert.match(source, /windowsCmdWithInjectedPath/);
  assert.match(source, /--ignore-scripts/);
  assert.match(source, /materializeNpmWorkspaceLinks/);
  assert.match(source, /next\.PATH = mergedPath/);
  assert.match(source, /RUNNER_TOOL_CACHE/);
  assert.match(source, /isUsableNodeExecutable/);

  const windows = npmSpawnInvocation(["ci"], "win32", {
    Path: "C:\\nodejs;C:\\Windows\\system32",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.match(String(windows.command).replaceAll("\\", "/"), /cmd\.exe$/i);
  assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(windows.args.length, 4);
  assert.match(String(windows.args[3]), /set "PATH=/);
  assert.match(String(windows.args[3]), /call /);
  assert.match(String(windows.args[3]).toLowerCase(), /npm\.cmd/);
  assert.match(String(windows.args[3]), /\bci\b/);
  assert.equal(windows.options.shell, false);
  assert.equal(windows.options.windowsVerbatimArguments, true);
  assert.deepEqual(windows.options.stdio, ["ignore", "pipe", "pipe"]);
  const windowsPath = windows.options.env.PATH;
  assert.match(windowsPath, /nodejs|node/i);
  assert.equal(windows.options.env.Path, undefined);
  assert.equal(windows.options.env.npm_config_script_shell, undefined);
  assert.match(String(windows.options.env.PATHEXT), /EXE/i);

  const posix = npmSpawnInvocation(["run", "build:server"], "linux");
  assert.match(path.basename(posix.command), /^npm$/);
  assert.deepEqual(posix.args, ["run", "build:server"]);
  assert.equal(posix.options.shell, false);
  assert.deepEqual(posix.options.stdio, ["ignore", "pipe", "pipe"]);
});

test("Windows five-stack npm prepare prefers real node.exe over a bun npm shim", () => {
  const root = temporaryDirectory("coding-tools-windows-node-path");
  const bunShimDir = path.join(root, "bun");
  const nodeDir = path.join(root, "nodejs");
  fs.mkdirSync(bunShimDir, { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(path.join(bunShimDir, "bun.exe"), "");
  fs.writeFileSync(path.join(bunShimDir, "npm.cmd"), "@echo bun-npm-shim\r\n");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo real-npm\r\n");
  fs.writeFileSync(path.join(nodeDir, "node.exe"), "");

  const windows = npmSpawnInvocation(["run", "build:server"], "win32", {
    Path: `${bunShimDir};${nodeDir};C:\\Windows\\system32`,
    TEMP: root,
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.match(String(windows.args[3]), /set "PATH=/);
  assert.ok(String(windows.args[3]).includes(path.join(nodeDir, "npm.cmd")));
  assert.equal(windows.options.env.npm_node_execpath, path.join(nodeDir, "node.exe"));
  assert.equal(windows.options.env.npm_config_scripts_prepend_node_path, "true");
  const windowsPath = windows.options.env.PATH;
  assert.ok(windowsPath.split(";")[0].endsWith("coding-tools-node-shims"));
  assert.ok(windowsPath.split(";").includes(nodeDir));
  assert.match(windowsPath, /nodejs/);
  assert.equal(windows.options.env.Path, undefined);
  assert.equal(windows.options.env.npm_config_script_shell, undefined);
  assert.equal(
    fs.readFileSync(path.join(root, "coding-tools-node-shims", "node.cmd"), "utf8"),
    `@echo off\r\n"${path.join(nodeDir, "node.exe")}" %*\r\n`,
  );
});

test("Windows five-stack npm prepare merges Path and PATH when bun splits them", () => {
  const root = temporaryDirectory("coding-tools-windows-split-path");
  const bunShimDir = path.join(root, "bun");
  const nodeDir = path.join(root, "nodejs");
  fs.mkdirSync(bunShimDir, { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(path.join(bunShimDir, "bun.exe"), "");
  fs.writeFileSync(path.join(bunShimDir, "npm.cmd"), "@echo bun-npm-shim\r\n");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo real-npm\r\n");
  fs.writeFileSync(path.join(nodeDir, "node.exe"), "");

  const windows = npmSpawnInvocation(["run", "build:server"], "win32", {
    PATH: bunShimDir,
    Path: `${nodeDir};C:\\Windows\\system32`,
    TEMP: root,
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.match(String(windows.args[3]), /set "PATH=/);
  assert.ok(String(windows.args[3]).includes(path.join(nodeDir, "npm.cmd")));
  assert.equal(windows.options.env.npm_node_execpath, path.join(nodeDir, "node.exe"));
  assert.equal(windows.options.env.Path, undefined);
  assert.ok(windows.options.env.PATH.split(";").includes(nodeDir));
});

test("Windows five-stack npm prepare keeps an explicit node.exe even if bun dropped PATH", () => {
  const root = temporaryDirectory("coding-tools-windows-explicit-node");
  const bunShimDir = path.join(root, "bun");
  const nodeDir = path.join(root, "nodejs");
  const nodeExe = path.join(nodeDir, "node.exe");
  fs.mkdirSync(bunShimDir, { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(path.join(bunShimDir, "bun.exe"), "");
  fs.writeFileSync(path.join(bunShimDir, "npm.cmd"), "@echo bun-npm-shim\r\n");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo real-npm\r\n");
  fs.writeFileSync(nodeExe, "");

  const windows = npmSpawnInvocation(["ci"], "win32", {
    PATH: bunShimDir,
    CODING_TOOLS_NODE_EXE: nodeExe,
    TEMP: root,
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.equal(windows.options.env.npm_node_execpath, nodeExe);
  assert.match(String(windows.args[3]), /set "PATH=/);
  assert.ok(String(windows.args[3]).includes(path.join(nodeDir, "npm.cmd")));
  assert.ok(windows.options.env.PATH.split(";").includes(nodeDir));
  assert.equal(windows.options.env.Path, undefined);
});

test("Windows five-stack npm prepare runs npm-cli.js through node.exe when present", () => {
  const root = temporaryDirectory("coding-tools-windows-npm-cli");
  const bunShimDir = path.join(root, "bun");
  const nodeDir = path.join(root, "nodejs");
  const npmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  const nodeExe = path.join(nodeDir, "node.exe");
  fs.mkdirSync(bunShimDir, { recursive: true });
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(path.join(bunShimDir, "bun.exe"), "");
  fs.writeFileSync(path.join(bunShimDir, "npm.cmd"), "@echo bun-npm-shim\r\n");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo real-npm\r\n");
  fs.writeFileSync(nodeExe, "");
  fs.writeFileSync(npmCli, "#!/usr/bin/env node\n");

  const windows = npmSpawnInvocation(["run", "build:server"], "win32", {
    Path: `${bunShimDir};${nodeDir};C:\\Windows\\system32`,
    TEMP: root,
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.match(String(windows.command).replaceAll("\\", "/"), /cmd\.exe$/i);
  assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(String(windows.args[3]), /set "PATH=/);
  assert.ok(String(windows.args[3]).includes(nodeExe));
  assert.ok(String(windows.args[3]).includes(npmCli));
  assert.match(String(windows.args[3]), /build:server/);
  assert.equal(windows.options.env.npm_execpath, npmCli);
  assert.equal(windows.options.env.npm_node_execpath, nodeExe);
  assert.equal(windows.options.env.Path, undefined);
  assert.ok(windows.options.env.PATH.split(";")[0].endsWith("coding-tools-node-shims"));
  assert.ok(windows.options.env.PATH.split(";").includes(nodeDir));
  assert.match(
    fs.readFileSync(path.join(root, "coding-tools-node-shims", "node.cmd"), "utf8"),
    /node\.exe/,
  );
});

test("five-stack prepare rewrites nested node scripts to an absolute node.exe", () => {
  const root = temporaryDirectory("coding-tools-rewrite-node-scripts");
  const nodeExe = path.join(root, "node.exe");
  const protocol = path.join(root, "packages", "protocol");
  fs.mkdirSync(protocol, { recursive: true });
  fs.writeFileSync(nodeExe, "");
  fs.writeFileSync(nodeExe.replace(/node\.exe$/i, "npm.cmd"), "");
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "paseo",
    private: true,
    scripts: { "build:server": "npm run build --workspace=@getpaseo/protocol && tsc" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(protocol, "package.json"), `${JSON.stringify({
    name: "@getpaseo/protocol",
    scripts: {
      "generate:validators": "node scripts/generate-validation-aot.mjs",
      build: "npm run generate:validators",
    },
  }, null, 2)}\n`);

  const npmCmd = nodeExe.replace(/node\.exe$/i, "npm.cmd");
  const rewritten = rewritePackageScriptsToAbsoluteNode(root, nodeExe, npmCmd);
  assert.equal(rewritten, 2);
  const protocolPkg = JSON.parse(fs.readFileSync(path.join(protocol, "package.json"), "utf8"));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(protocolPkg.scripts["generate:validators"], `${nodeExe} scripts/generate-validation-aot.mjs`);
  assert.equal(protocolPkg.scripts.build, `${npmCmd} run generate:validators`);
  assert.match(rootPkg.scripts["build:server"], /npm\.cmd run build/);
  assert.equal(
    withAbsoluteNodeCommand("node scripts/generate-validation-aot.mjs", "C:\\Program Files\\nodejs\\node.exe"),
    "node scripts/generate-validation-aot.mjs",
  );
  assert.equal(
    withAbsoluteNpmCommand("npm run generate:validators", "C:\\nodejs\\npm.cmd"),
    "C:\\nodejs\\npm.cmd run generate:validators",
  );
});

test("Windows workspace npm scripts get node.cmd inside node_modules/.bin", () => {
  const root = temporaryDirectory("coding-tools-windows-npm-bin-shims");
  const nodeDir = path.join(root, "nodejs");
  const nodeExe = path.join(nodeDir, "node.exe");
  const protocol = path.join(root, "packages", "protocol");
  const controlCenter = path.join(root, "apps", "control-center");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(protocol, { recursive: true });
  fs.mkdirSync(controlCenter, { recursive: true });
  fs.writeFileSync(nodeExe, "");

  const written = installWindowsNodeBinShims(root, { CODING_TOOLS_NODE_EXE: nodeExe }, "win32");
  const expected = [
    path.join(root, "node_modules", ".bin", "node.cmd"),
    path.join(protocol, "node_modules", ".bin", "node.cmd"),
    path.join(controlCenter, "node_modules", ".bin", "node.cmd"),
  ];
  for (const cmd of expected) {
    assert.ok(written.includes(cmd), `missing ${cmd}`);
    assert.match(fs.readFileSync(cmd, "utf8"), /node\.exe/);
  }
  assert.equal(installWindowsNodeBinShims(root, { CODING_TOOLS_NODE_EXE: nodeExe }, "linux").length, 0);
});

test("Windows package directories get node.cmd in CWD for empty PATH cmd lookup", () => {
  const root = temporaryDirectory("coding-tools-windows-cwd-node");
  const nodeDir = path.join(root, "nodejs");
  const nodeExe = path.join(nodeDir, "node.exe");
  const protocol = path.join(root, "packages", "protocol");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(protocol, { recursive: true });
  fs.writeFileSync(nodeExe, "");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo real-npm\r\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(protocol, "package.json"), "{}\n");

  const written = installWindowsCwdNodeCommands(root, {
    CODING_TOOLS_NODE_EXE: nodeExe,
    TEMP: root,
  }, "win32");
  const expected = [
    path.join(root, "node.cmd"),
    path.join(protocol, "node.cmd"),
  ];
  for (const cmd of expected) {
    assert.ok(written.includes(cmd), `missing ${cmd}`);
    assert.equal(
      fs.readFileSync(cmd, "utf8"),
      `@echo off\r\n"${nodeExe}" %*\r\n`,
    );
    assert.equal(fs.readFileSync(cmd.replace(/\.cmd$/i, ".bat"), "utf8"), fs.readFileSync(cmd, "utf8"));
    const npmCmd = cmd.replace(/node\.cmd$/i, "npm.cmd");
    assert.ok(written.includes(npmCmd), `missing ${npmCmd}`);
    const npmBody = fs.readFileSync(npmCmd, "utf8");
    assert.match(npmBody, /set "PATH=/);
    assert.match(npmBody, /npm\.cmd/);
  }
  assert.equal(installWindowsCwdNodeCommands(root, { CODING_TOOLS_NODE_EXE: nodeExe }, "linux").length, 0);
});

test("Windows package directories forward hoisted tsc.cmd into CWD without copying %~dp0 shims", () => {
  const root = temporaryDirectory("coding-tools-windows-cwd-tsc");
  const client = path.join(root, "packages", "client");
  const hoisted = path.join(root, "node_modules", ".bin", "tsc.cmd");
  fs.mkdirSync(client, { recursive: true });
  fs.mkdirSync(path.dirname(hoisted), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(client, "package.json"), "{}\n");
  fs.writeFileSync(hoisted, "@echo off\r\n\"%~dp0\\node.exe\" \"%~dp0\\..\\typescript\\bin\\tsc\" %*\r\n");

  const written = installWindowsCwdLifecycleFallbacks(root, "win32");
  const cwdTsc = path.join(client, "tsc.cmd");
  assert.ok(written.includes(cwdTsc));
  const body = fs.readFileSync(cwdTsc, "utf8");
  assert.match(body, /call "/);
  assert.ok(body.includes(hoisted));
  assert.doesNotMatch(body, /%~dp0/);
  assert.equal(installWindowsCwdLifecycleFallbacks(root, "linux").length, 0);
});

test("prepare-five-stack-runtime npm ci uses the platform spawn adapter", async () => {
  const repositoryRoot = temporaryDirectory("coding-tools-five-stack-npm");
  const desktopDir = path.join(repositoryRoot, "desktop-electron");
  const manifestRoot = path.join(desktopDir, "vendor", "managed-components");
  const cacheRoot = path.join(repositoryRoot, "cache");
  const outputRoot = path.join(desktopDir, "build", "five-stack-runtime");
  const payload = Buffer.from("bundled-cpa-archive", "utf8");
  const digest = sha256(payload);

  for (const id of ["codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id));
    const sourceRoot = path.join(cacheRoot, id, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, `${id}.txt`), `${id} bundled\n`);
    if (id === "paseo") {
      writeJson(path.join(sourceRoot, "package.json"), { name: "paseo", private: true });
    }
    if (id === "anneal") {
      writeJson(path.join(sourceRoot, "package.json"), { name: "anneal", private: true });
    }
    if (id === "codex-router") {
      const controlCenter = path.join(sourceRoot, "apps", "control-center");
      fs.mkdirSync(controlCenter, { recursive: true });
      writeJson(path.join(controlCenter, "package.json"), { name: "control-center", private: true });
    }
  }
  writeJson(path.join(manifestRoot, "cpa.json"), bundledManifest("cpa", {
    strategy: "release-binary",
    platforms: {
      [process.platform]: {
        [process.arch]: {
          fileName: "cpa.bin",
          url: "https://example.invalid/cpa.bin",
          sha256: digest,
        },
      },
    },
  }));
  fs.mkdirSync(path.join(cacheRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, "cpa", "cpa.bin"), payload);

  const calls = [];
  await prepareFiveStackRuntime({
    repositoryRoot,
    desktopRoot: desktopDir,
    manifestRoot,
    outputRoot,
    cacheRoot,
    prepareDependencies: true,
    fetchImpl: async () => {
      throw new Error("prepare-five-stack-runtime must not fetch when a cache is present");
    },
    spawnSyncProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "", error: null };
    },
    now: () => "2026-09-18T12:00:00.000Z",
    nonce: () => "fixture-npm",
  });

  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.ok(call.options.env);
    if (process.platform === "win32") {
      const commandBase = path.basename(call.command).toLowerCase();
      assert.equal(commandBase, "cmd.exe");
      assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(String(call.args[3]), /set "PATH=/);
      assert.equal(call.options.windowsVerbatimArguments, true);
      const line = String(call.args[3]).toLowerCase();
      assert.ok(line.includes("npm-cli.js") || line.includes("npm.cmd"));
      if (line.includes(" ci") || line.endsWith(" ci") || /\bci\b/.test(line)) {
        assert.match(line, /ignore-scripts/);
      }
      if (/\bprune\b/.test(line)) {
        assert.match(line, /omit=dev/);
        assert.match(line, /ignore-scripts/);
      }
    } else {
      assert.match(path.basename(call.command), /^npm$/);
      assert.ok(["ci", "run", "prune"].includes(call.args[0]));
      if (call.args[0] === "ci") assert.deepEqual(call.args.slice(0, 2), ["ci", "--ignore-scripts"]);
      if (call.args[0] === "prune") {
        assert.ok(call.args.includes("--omit=dev"));
        assert.ok(call.args.includes("--ignore-scripts"));
      }
    }
  }
});

test("Windows five-stack npm prepare rejects bun node.exe in favor of hostedtoolcache", () => {
  const root = temporaryDirectory("coding-tools-windows-toolcache-node");
  const bunShimDir = path.join(root, "bun");
  const toolcache = path.join(root, "hostedtoolcache");
  const nodeDir = path.join(toolcache, "node", "22.16.0", "x64");
  const bunNode = path.join(bunShimDir, "node.exe");
  fs.mkdirSync(bunShimDir, { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(path.join(bunShimDir, "bun.exe"), "");
  fs.writeFileSync(bunNode, "");
  fs.writeFileSync(path.join(nodeDir, "node.exe"), "");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo real-npm\r\n");

  assert.equal(
    resolveNodeExecutable({
      PATH: bunShimDir,
      CODING_TOOLS_NODE_EXE: bunNode,
      npm_node_execpath: bunNode,
      RUNNER_TOOL_CACHE: toolcache,
    }, "win32"),
    path.join(nodeDir, "node.exe"),
  );
});

test("five-stack prepare replaces npm workspace links with real copies before publish", () => {
  const root = temporaryDirectory("coding-tools-five-stack-workspace-links");
  const source = path.join(root, "source");
  const app = path.join(source, "packages", "app");
  const scoped = path.join(source, "node_modules", "@getpaseo");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(scoped, { recursive: true });
  fs.writeFileSync(path.join(app, "index.js"), "export const app = true\n");
  fs.mkdirSync(path.join(app, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(app, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
  fs.symlinkSync(path.relative(scoped, app), path.join(scoped, "app"));

  materializeNpmWorkspaceLinks(source);

  const materialized = path.join(scoped, "app");
  assert.equal(fs.lstatSync(materialized).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(materialized, "index.js"), "utf8"), "export const app = true\n");
  assert.equal(fs.existsSync(path.join(materialized, "node_modules")), false);
  assert.equal(fs.readFileSync(path.join(app, "index.js"), "utf8"), "export const app = true\n");
});

test("Windows five-stack prepare skips host npm for WSL2 stacks such as Anneal", async () => {
  assert.equal(hostNpmPrepareAllowed({ platformModes: { win32: "wsl2" } }, "win32"), false);
  assert.equal(hostNpmPrepareAllowed({ platformModes: { win32: "native" } }, "win32"), true);
  assert.equal(hostNpmPrepareAllowed({}, "linux"), true);
  assert.match(read("scripts/prepare-five-stack-runtime.cjs"), /hostNpmPrepareAllowed/);
  assert.match(read("vendor/managed-components/anneal.json"), /"win32": "wsl2"/);

  const repositoryRoot = temporaryDirectory("coding-tools-five-stack-wsl2");
  const desktopDir = path.join(repositoryRoot, "desktop-electron");
  const manifestRoot = path.join(desktopDir, "vendor", "managed-components");
  const cacheRoot = path.join(repositoryRoot, "cache");
  const outputRoot = path.join(desktopDir, "build", "five-stack-runtime");
  const payload = Buffer.from("bundled-cpa-archive", "utf8");
  const digest = sha256(payload);

  for (const id of ["codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id, id === "anneal"
      ? { platformModes: { win32: "wsl2", linux: "native", darwin: "native" } }
      : {}));
    const sourceRoot = path.join(cacheRoot, id, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, `${id}.txt`), `${id} bundled\n`);
    if (id === "paseo" || id === "anneal") {
      writeJson(path.join(sourceRoot, "package.json"), { name: id, private: true });
    }
    if (id === "codex-router") {
      const controlCenter = path.join(sourceRoot, "apps", "control-center");
      fs.mkdirSync(controlCenter, { recursive: true });
      writeJson(path.join(controlCenter, "package.json"), { name: "control-center", private: true });
    }
  }
  writeJson(path.join(manifestRoot, "cpa.json"), bundledManifest("cpa", {
    strategy: "release-binary",
    platforms: {
      win32: {
        x64: {
          fileName: "cpa.bin",
          url: "https://example.invalid/cpa.bin",
          sha256: digest,
        },
      },
    },
  }));
  fs.mkdirSync(path.join(cacheRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, "cpa", "cpa.bin"), payload);

  const calls = [];
  await prepareFiveStackRuntime({
    repositoryRoot,
    desktopRoot: desktopDir,
    manifestRoot,
    outputRoot,
    cacheRoot,
    platform: "win32",
    arch: "x64",
    prepareDependencies: true,
    fetchImpl: async () => {
      throw new Error("prepare-five-stack-runtime must not fetch when a cache is present");
    },
    spawnSyncProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "", error: null };
    },
    now: () => "2026-09-18T12:00:00.000Z",
    nonce: () => "fixture-wsl2",
  });

  assert.equal(calls.some((call) => String(call.options?.cwd || "").includes(`${path.sep}anneal${path.sep}`)), false);
  assert.ok(calls.some((call) => String(call.options?.cwd || "").includes(`${path.sep}paseo${path.sep}`)));
  assert.equal(fs.existsSync(path.join(outputRoot, "anneal", "source", "package.json")), true);
});

test("Windows installer smoke uses the 45-minute bundled-payload budget", () => {
  const smoke = read("scripts/smoke-package.cjs");
  assert.match(smoke, /WINDOWS_INSTALLER_TIMEOUT_MS = 45 \* 60_000/);
  assert.match(smoke, /timeout: WINDOWS_INSTALLER_TIMEOUT_MS/);
  assert.match(read("electron/update-worker.cjs"), /timeout: 45 \* 60_000/);
  assert.match(read("vendor/managed-components/cpa-codex-provider-backends.openapi.json"), /127\.0\.0\.1:8317/);
  assert.match(read("vendor/managed-components/cpa-codex-provider-backends.openapi.json"), /127\.0\.0\.1:4202/);
});
