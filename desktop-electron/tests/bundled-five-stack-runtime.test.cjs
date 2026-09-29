"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const {
  hostNpmPrepareAllowed,
  installWindowsCwdLifecycleFallbacks,
  installWindowsCwdNodeCommands,
  installWindowsNodeBinShims,
  materializeNpmWorkspaceLinks,
  npmSpawnInvocation,
  patchPaseoCodexAppServerAgentSource,
  prepareFiveStackRuntime,
  rewritePackageScriptsToAbsoluteNode,
  resolveNodeExecutable,
  withAbsoluteNodeCommand,
  withAbsoluteNpmCommand,
} = require("../scripts/prepare-five-stack-runtime.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function writePinnedPaseoAgent(sourceRoot) {
  const agent = path.join(sourceRoot, "packages", "server", "src", "server", "agent", "providers", "codex-app-server-agent.ts");
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, `  if (runtimeSettings?.env?.OPENAI_API_KEY?.trim()) {
    providerConfig.env_key = "OPENAI_API_KEY";
    providerConfig.requires_openai_auth = false;
  }`);
  return agent;
}

function temporaryDirectory(name) {
  const scratchRoot = path.join(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
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

test("Paseo 0.8.0 materialization accepts a host-private OpenAI key without embedding it", () => {
  const pinnedSource = `  if (runtimeSettings?.env?.OPENAI_API_KEY?.trim()) {
    providerConfig.env_key = "OPENAI_API_KEY";
    providerConfig.requires_openai_auth = false;
  }`;

  const patched = patchPaseoCodexAppServerAgentSource(pinnedSource);

  assert.equal(patched, `  if (
    runtimeSettings?.env?.OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim()
  ) {
    providerConfig.env_key = "OPENAI_API_KEY";
    providerConfig.requires_openai_auth = false;
  }`);
  assert.throws(
    () => patchPaseoCodexAppServerAgentSource(pinnedSource.replace("if (", "if  (")),
    /FIVE_STACK_PASEO_PATCH_SOURCE_DRIFT/,
  );
});

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
  assert.match(original, /Start module/);
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

  for (const id of ["paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), id === "paseo"
      ? JSON.parse(read("vendor/managed-components/paseo.json")) : bundledManifest(id));
    const source = path.join(cacheRoot, id, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, `${id}.txt`), `${id} bundled\n`);
    if (id === "paseo") writePinnedPaseoAgent(source);
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
  const options = {
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
    nonce: () => crypto.randomUUID(),
  };
  const result = await prepareFiveStackRuntime(options);

  assert.equal(fetched, 0);
  assert.equal(result.outputRoot, outputRoot);
  const paseoBundle = JSON.parse(fs.readFileSync(path.join(outputRoot, "paseo", "BUNDLE.json"), "utf8"));
  assert.equal(paseoBundle.version, "0.8.0");
  assert.equal(paseoBundle.commit, "1e4ba65c6d75a6b061a1d54141f2f105b5908a96");
  assert.equal(paseoBundle.patchRevision, "codex-cpa-host-env-v1");
  assert.match(fs.readFileSync(path.join(outputRoot, "paseo", "source", "packages", "server", "src", "server", "agent", "providers", "codex-app-server-agent.ts"), "utf8"), /process\.env\.OPENAI_API_KEY/);

  const paseoManifestPath = path.join(manifestRoot, "paseo.json");
  const pinnedPaseo = JSON.parse(fs.readFileSync(paseoManifestPath, "utf8"));
  writeJson(paseoManifestPath, { ...pinnedPaseo, commit: "b".repeat(40) });
  await assert.rejects(() => prepareFiveStackRuntime(options), /FIVE_STACK_PASEO_PATCH_PIN_MISMATCH/);
  writeJson(paseoManifestPath, pinnedPaseo);

  const agent = path.join(cacheRoot, "paseo", "source", "packages", "server", "src", "server", "agent", "providers", "codex-app-server-agent.ts");
  const missingSource = path.join(repositoryRoot, "Trash", "codex-app-server-agent.ts");
  fs.mkdirSync(path.dirname(missingSource), { recursive: true });
  fs.renameSync(agent, missingSource);
  await assert.rejects(() => prepareFiveStackRuntime(options), /FIVE_STACK_PASEO_PATCH_SOURCE_DRIFT/);
  fs.renameSync(missingSource, agent);
  assert.deepEqual(fs.readFileSync(path.join(outputRoot, "cpa", "cpa.bin")), payload);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(outputRoot, "cpa", "CODING_TOOLS_BUNDLED.json"), "utf8")).skipNetworkPrepare,
    true,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.productVersion, "0.7.0-rc.14");
  assert.deepEqual(manifest.components.map((component) => component.id), [
    "cpa",
    "paseo",
    "anneal",
  ]);
});

test("production Start is fail-closed and never fetches components from the network", () => {
  const controller = read("electron/managed-components.cjs");
  assert.match(controller, /allowNetworkInstall = false/);
  assert.match(controller, /bundleRequired\(manifest\) \|\| !allowNetworkInstall/);
  assert.match(controller, /wsl2ManagedPrepareAllowed/);
  assert.match(controller, /context\.mode === "wsl2"/);
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
  assert.match(String(windows.args[3]), /(?:call .*npm\.cmd|node\.exe.*npm-cli\.js)/i);
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
    CODING_TOOLS_NODE_EXE: path.join(nodeDir, "node.exe"),
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
    CODING_TOOLS_NODE_EXE: path.join(nodeDir, "node.exe"),
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
    CODING_TOOLS_NODE_EXE: nodeExe,
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

test("Windows workspace npm scripts track both cmd and bat shims for cleanup", () => {
  const root = temporaryDirectory("coding-tools-windows-npm-bin-shims");
  const nodeDir = path.join(root, "nodejs");
  const nodeExe = path.join(nodeDir, "node.exe");
  const protocol = path.join(root, "packages", "protocol");
  const controlCenter = path.join(root, "apps", "control-center");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(protocol, { recursive: true });
  fs.mkdirSync(controlCenter, { recursive: true });
  fs.writeFileSync(nodeExe, "");
  fs.writeFileSync(path.join(nodeDir, "npm.cmd"), "@echo npm\r\n");

  const written = installWindowsNodeBinShims(root, { CODING_TOOLS_NODE_EXE: nodeExe }, "win32");
  const expected = [root, protocol, controlCenter].flatMap((dir) =>
    ["node.cmd", "node.bat", "npm.cmd", "npm.bat"].map((name) => path.join(dir, "node_modules", ".bin", name)));
  assert.deepEqual(new Set(written), new Set(expected));
  for (const cmd of expected) {
    assert.ok(written.includes(cmd), `missing ${cmd}`);
    assert.match(fs.readFileSync(cmd, "utf8"), /node\.exe|npm\.cmd/);
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

test("Windows five-stack npm keeps nested Paseo commands below cmd's limit", () => {
  const root = temporaryDirectory("coding-tools-short-npm-path");
  const sourceRoot = path.join(root, "paseo");
  const nodeDir = path.join(root, "nodejs");
  const gitDir = path.join(root, "git");
  const pythonDir = path.join(root, "python");
  const systemDir = path.join(root, "system32");
  for (const dir of [nodeDir, gitDir, pythonDir, systemDir]) fs.mkdirSync(dir, { recursive: true });
  for (const [dir, name] of [
    [nodeDir, "node.exe"], [nodeDir, "npm.cmd"], [gitDir, "git.exe"],
    [pythonDir, "python.exe"], [systemDir, "cmd.exe"],
  ]) fs.writeFileSync(path.join(dir, name), "");
  for (const name of ["server", "client", "app", "protocol", "sdk", "desktop", "tools", "shared"]) {
    fs.mkdirSync(path.join(sourceRoot, "packages", name), { recursive: true });
  }
  const unrelated = Array.from({ length: 20 }, (_, i) => path.join(root, "unrelated", `long-unused-path-${i}`));
  const invocation = npmSpawnInvocation(["run", "build:server"], "win32", {
    Path: [...unrelated, systemDir, gitDir, pythonDir, nodeDir].join(";"),
    CODING_TOOLS_NODE_EXE: path.join(nodeDir, "node.exe"),
    TEMP: root,
    ComSpec: path.join(systemDir, "cmd.exe"),
  }, sourceRoot);
  const npmPath = invocation.options.env.PATH;
  for (const dir of [nodeDir, gitDir, pythonDir, systemDir, path.join(sourceRoot, "node_modules", ".bin")]) {
    assert.ok(npmPath.split(";").includes(dir), `missing ${dir}`);
  }
  assert.ok(!npmPath.includes("long-unused-path"));
  assert.ok(!npmPath.includes(path.join(sourceRoot, "packages", "server", "node_modules", ".bin")));
  assert.ok(invocation.args[3].length < 2500, `cmd.exe argument length ${invocation.args[3].length}`);
});

test("Paseo manifest enables the embedded web UI and isolates its home", () => {
  const manifest = JSON.parse(read("vendor/managed-components/paseo.json"));
  assert.deepEqual(manifest.health.acceptStatus, [200], "missing UI and authorization errors must not report the module ready");
  assert.deepEqual(manifest.launch.processes[0].environment, {
    PASEO_LISTEN: "127.0.0.1:6768",
    PASEO_HOME: "{state}",
    PASEO_WEB_UI_ENABLED: "true",
    PASEO_WEB_UI_DIST_DIR: "{home}/packages/server/dist/server/web-ui",
  });
});

test("Windows five-stack npm prepare rejects bun node.exe in favor of a real Node", () => {
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

  const resolved = resolveNodeExecutable({
      PATH: bunShimDir,
      CODING_TOOLS_NODE_EXE: bunNode,
      npm_node_execpath: bunNode,
      RUNNER_TOOL_CACHE: toolcache,
    }, "win32");
  assert.notEqual(resolved, bunNode);
  assert.ok([process.execPath, path.join(nodeDir, "node.exe")].includes(resolved), resolved);
});

test("five-stack prepare replaces npm workspace links with real copies before publish", { skip: process.platform === "win32" }, () => {
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

test("Windows five-stack prepare skips host npm for WSL2 stacks such as Anneal", async (t) => {
  assert.equal(hostNpmPrepareAllowed({ platformModes: { win32: "wsl2" } }, "win32"), false);
  assert.equal(hostNpmPrepareAllowed({ platformModes: { win32: "native" } }, "win32"), true);
  assert.equal(hostNpmPrepareAllowed({}, "linux"), true);
  assert.match(read("scripts/prepare-five-stack-runtime.cjs"), /hostNpmPrepareAllowed/);
  assert.match(read("vendor/managed-components/anneal.json"), /"win32": "wsl2"/);

  const repositoryRoot = temporaryDirectory("coding-tools-five-stack-wsl2");
  const retainedShims = path.join(repositoryRoot, "Trash", "build-shims");
  fs.mkdirSync(retainedShims, { recursive: true });
  let retainedCount = 0;
  t.mock.method(fs, "unlinkSync", (file) => {
    assert.ok(path.resolve(file).startsWith(`${repositoryRoot}${path.sep}`));
    fs.renameSync(file, path.join(retainedShims, `${retainedCount++}-${path.basename(file)}`));
  });
  const desktopDir = path.join(repositoryRoot, "desktop-electron");
  const manifestRoot = path.join(desktopDir, "vendor", "managed-components");
  const cacheRoot = path.join(repositoryRoot, "cache");
  const outputRoot = path.join(desktopDir, "build", "five-stack-runtime");
  const payload = Buffer.from("bundled-cpa-archive", "utf8");
  const digest = sha256(payload);

  for (const id of ["paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), id === "paseo"
      ? JSON.parse(read("vendor/managed-components/paseo.json")) : bundledManifest(id, id === "anneal"
      ? { platformModes: { win32: "wsl2", linux: "native", darwin: "native" } }
      : {}));
    const sourceRoot = path.join(cacheRoot, id, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, `${id}.txt`), `${id} bundled\n`);
    if (id === "paseo") writePinnedPaseoAgent(sourceRoot);
    if (id === "paseo" || id === "anneal") {
      writeJson(path.join(sourceRoot, "package.json"), { name: id, private: true });
    }
    if (id === "codex-router") {
      fs.mkdirSync(path.join(sourceRoot, "requirements"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "requirements", "python.txt"), "litellm==1.96.0 --hash=sha256:fixture\n");
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
      if (args.includes("-c") && args.join(" ").includes("print(sys.executable)")) return { status: 0, stdout: `${path.join(repositoryRoot, "python.exe")}\n` };
      if (args.includes("download")) {
        fs.writeFileSync(path.join(args[args.indexOf("--dest") + 1], "litellm-fixture.whl"), "fixture");
        return { status: 0, stdout: "", stderr: "" };
      }
      calls.push({ command, args, options });
      if (options.cwd.endsWith(path.join("paseo", "source")) && args.join(" ").includes("build:web")) {
        const webDist = path.join(options.cwd, "packages", "app", "dist");
        fs.mkdirSync(webDist, { recursive: true });
        fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>Paseo</title>");
      }
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
  assert.match(read("vendor/managed-components/cpa-provider-backend.openapi.json"), /127\.0\.0\.1:8317/);
});
