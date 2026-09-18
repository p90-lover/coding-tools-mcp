"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { npmSpawnInvocation, prepareFiveStackRuntime } = require("../scripts/prepare-five-stack-runtime.cjs");
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
  assert.equal(manifest.productVersion, "0.7.0-rc.11");
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

  const windows = npmSpawnInvocation(["ci"], "win32", {
    Path: "C:\\nodejs;C:\\Windows\\system32",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.match(String(windows.command).replaceAll("\\", "/"), /cmd\.exe$/i);
  assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(String(windows.args[3]).toLowerCase(), /npm\.cmd$/);
  assert.deepEqual(windows.args.slice(4), ["ci"]);
  assert.equal(windows.options.shell, false);
  assert.deepEqual(windows.options.stdio, ["ignore", "pipe", "pipe"]);
  const windowsPath = windows.options.env.Path || windows.options.env.PATH;
  assert.match(windowsPath, /nodejs|node/i);

  const posix = npmSpawnInvocation(["run", "build:server"], "linux");
  assert.match(path.basename(posix.command), /^npm$/);
  assert.deepEqual(posix.args, ["run", "build:server"]);
  assert.equal(posix.options.shell, false);
  assert.deepEqual(posix.options.stdio, ["ignore", "pipe", "pipe"]);
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
      assert.equal(path.basename(call.command).toLowerCase(), "cmd.exe");
      assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(String(call.args[3]).toLowerCase(), /npm\.cmd$/);
    } else {
      assert.match(path.basename(call.command), /^npm$/);
      assert.ok(["ci", "run"].includes(call.args[0]));
    }
  }
});
