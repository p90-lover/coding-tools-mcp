"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  createManagedComponentController,
} = require("../electron/managed-components.cjs");
const {
  createOriginalUiController,
} = require("../electron/original-ui.cjs");
const {
  ensureOriginalControlCenter,
} = require("../electron/codex-router-original-ui.cjs");
const {
  ROUTER_MARKER_NAME,
  resolveBundledPayload,
} = require("../electron/bundled-runtimes.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mockChild(pid = 9100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

function cpaManifest(payload) {
  const digest = sha256(payload);
  return {
    schemaVersion: 1,
    id: "cpa",
    name: "CPA / CLIProxyAPI",
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: "router-for-me/CLIProxyAPI",
    version: "7.3.7",
    strategy: "release-binary",
    bundle: { required: true, kind: "release-archive" },
    platforms: {
      [process.platform]: {
        [process.arch]: {
          url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.3.7/should-not-fetch.bin",
          sha256: digest,
          fileName: "cpa.bin",
        },
      },
    },
    install: {
      steps: [
        { id: "download-release", kind: "download" },
        { id: "verify-sha256", kind: "verify" },
        { id: "activate", kind: "activate" },
      ],
    },
    launch: {
      processes: [{
        id: "cpa",
        mode: "foreground",
        executable: "{runtime}",
        arguments: ["{adapterRoot}/cpa-managed.cjs", "run", "{home}", "{state}"],
      }],
    },
    health: { endpoint: "http://127.0.0.1:8317/v1/models", acceptStatus: [200] },
  };
}

function routerManifest() {
  return {
    schemaVersion: 1,
    id: "codex-router",
    name: "Codex Router",
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: "duolahypercho/codex-router",
    repositoryUrl: "https://github.com/duolahypercho/codex-router.git",
    version: "0.6.0",
    commit: "930f547d8d8861a47e18a83216e15e73a73aa97c",
    strategy: "git-source",
    bundle: { required: true, kind: "source-tree" },
    install: {
      steps: [
        { id: "assert-router-source", kind: "assert-file", path: "src/foreground-start.mjs" },
        { id: "activate", kind: "activate" },
      ],
    },
    launch: {
      processes: [{
        id: "router",
        mode: "foreground",
        executable: "{runtime}",
        arguments: ["{adapterRoot}/codex-router-managed.cjs", "run", "{home}", "{state}"],
      }],
    },
    health: { endpoint: "http://127.0.0.1:4202/_codex-router/key/v1/models", acceptStatus: [200] },
  };
}

function otherManifest(id, payload) {
  const digest = sha256(payload);
  return {
    schemaVersion: 1,
    id,
    name: id,
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: `fixture/${id}`,
    version: "1.0.0",
    strategy: "release-binary",
    platforms: {
      [process.platform]: {
        [process.arch]: {
          url: `https://github.com/fixture/${id}/releases/download/v1.0.0/${id}.bin`,
          sha256: digest,
          fileName: `${id}.bin`,
        },
      },
    },
    install: {
      steps: [
        { id: "download-release", kind: "download" },
        { id: "verify-sha256", kind: "verify" },
        { id: "activate", kind: "activate" },
      ],
    },
    launch: {
      processes: [{
        id: "service",
        mode: "foreground",
        executable: "{artifact}",
        arguments: [],
      }],
    },
    health: { endpoint: "http://127.0.0.1:9090/", acceptStatus: [200] },
  };
}

function writeRouterSource(sourceRoot) {
  writeJson(path.join(sourceRoot, "package.json"), {
    name: "codex-model-router",
    version: "0.6.0",
  });
  writeFile(path.join(sourceRoot, "src", "foreground-start.mjs"), "export {};\n");
  writeFile(path.join(sourceRoot, "src", "curate-models.mjs"), "export {};\n");
  writeFile(path.join(sourceRoot, "apps", "control-center", "electron", "main.mjs"), "export {};\n");
  writeJson(path.join(sourceRoot, "apps", "control-center", "package.json"), {
    name: "@codex-router/control-center",
    version: "0.6.0",
    main: "electron/main.mjs",
  });
  writeFile(path.join(sourceRoot, "apps", "control-center", "dist", "index.html"), "<!doctype html><title>Control Center</title>");
  writeJson(path.join(sourceRoot, ROUTER_MARKER_NAME), {
    schemaVersion: 1,
    id: "codex-router",
    version: "0.6.0",
    commit: "930f547d8d8861a47e18a83216e15e73a73aa97c",
    skipNetworkPrepare: true,
    includes: { source: true, nodeModules: true, pythonVenv: true, controlCenterRenderer: true },
  });
}

function bundledFixture(payload) {
  const manifestRoot = temporaryDirectory("coding-tools-bundled-manifests");
  const bundleRoot = temporaryDirectory("coding-tools-bundled-runtimes");
  const dataRoot = temporaryDirectory("coding-tools-bundled-data");
  writeJson(path.join(manifestRoot, "cpa.json"), cpaManifest(payload));
  writeJson(path.join(manifestRoot, "codex-router.json"), routerManifest());
  for (const id of ["commandcode-proxy", "paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), otherManifest(id, payload));
  }
  writeFile(path.join(bundleRoot, "cpa", process.platform, process.arch, "cpa.bin"), payload);
  writeRouterSource(path.join(bundleRoot, "codex-router", "source"));
  return { manifestRoot, bundleRoot, dataRoot };
}

test("production CPA and Codex Router manifests require a packaged bundled runtime", () => {
  const cpa = JSON.parse(read("vendor/managed-components/cpa.json"));
  const router = JSON.parse(read("vendor/managed-components/codex-router.json"));
  assert.equal(cpa.bundle.required, true);
  assert.equal(cpa.strategy, "release-binary");
  assert.equal(router.bundle.required, true);
  assert.equal(router.strategy, "git-source");
  assert.equal(router.commit, "930f547d8d8861a47e18a83216e15e73a73aa97c");
});

test("CPA first Start copies the bundled archive and never fetches GitHub", async () => {
  const payload = Buffer.from("bundled-cpa-runtime-v7.3.7", "utf8");
  const { manifestRoot, bundleRoot, dataRoot } = bundledFixture(payload);
  const fetches = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    bundleRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async (url) => {
      fetches.push(String(url));
      throw new Error(`unexpected download: ${url}`);
    },
    spawnProcess: () => mockChild(),
  });

  const projected = controller.project("cpa");
  assert.equal(projected.bundledRuntime, true);
  assert.equal(projected.installState, "not-installed");

  const installed = await controller.installComponent("cpa");
  assert.equal(installed.installState, "installed");
  assert.equal(installed.bundledRuntime, true);
  assert.deepEqual(fetches, []);
  assert.deepEqual(fs.readFileSync(path.join(installed.managedHome, "cpa.bin")), payload);
  controller.dispose();
});

test("CPA refuses first Start when the bundled archive is missing instead of downloading", async () => {
  const payload = Buffer.from("missing-cpa-bundle", "utf8");
  const { manifestRoot, dataRoot } = bundledFixture(payload);
  const emptyBundle = temporaryDirectory("coding-tools-empty-bundle");
  const fetches = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    bundleRoot: emptyBundle,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async (url) => {
      fetches.push(String(url));
      throw new Error(`unexpected download: ${url}`);
    },
  });

  await assert.rejects(
    () => controller.installComponent("cpa"),
    /bundled inside Coding Tools Desktop/i,
  );
  assert.deepEqual(fetches, []);
  controller.dispose();
});

test("Codex Router first Start copies the bundled source and never git clones", async () => {
  const payload = Buffer.from("unused", "utf8");
  const { manifestRoot, bundleRoot, dataRoot } = bundledFixture(payload);
  const commands = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    bundleRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => {
      throw new Error("unexpected download");
    },
    spawnProcess: (executable, args) => {
      commands.push([executable, ...args]);
      throw new Error(`unexpected spawn: ${executable}`);
    },
  });

  const installed = await controller.installComponent("codex-router");
  assert.equal(installed.installState, "installed");
  assert.equal(installed.bundledRuntime, true);
  assert.equal(commands.length, 0);
  assert.equal(
    fs.existsSync(path.join(installed.managedHome, "src", "foreground-start.mjs")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(installed.managedHome, "apps", "control-center", "electron", "main.mjs")),
    true,
  );
  const marker = JSON.parse(fs.readFileSync(path.join(installed.managedHome, ROUTER_MARKER_NAME), "utf8"));
  assert.equal(marker.skipNetworkPrepare, true);
  controller.dispose();
});

test("CommandCode Proxy keeps its existing download installer and is not part of this bundle", async () => {
  const payload = Buffer.from("commandcode-still-downloads", "utf8");
  const { manifestRoot, bundleRoot, dataRoot } = bundledFixture(payload);
  const fetches = [];
  const controller = createManagedComponentController({
    manifestRoot,
    dataRoot,
    bundleRoot,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    },
    spawnProcess: () => mockChild(),
  });

  const installed = await controller.installComponent("commandcode-proxy");
  assert.equal(installed.installState, "installed");
  assert.equal(installed.bundledRuntime, false);
  assert.equal(fetches.length, 1);
  controller.dispose();
});

test("original UI Start activates the bundled CPA runtime instead of a separate app download", async () => {
  const calls = [];
  const controller = createOriginalUiController({
    sleep: async () => {},
    longRun: false,
    externalServices: {
      snapshot: () => ({
        services: [{
          id: "cpa",
          endpoint: "http://127.0.0.1:8317/",
          status: "ready",
          pid: 8317,
          home: "/tmp/cpa-home",
          managedInstall: { state: "not-installed", bundledRuntime: true },
        }],
      }),
      inspect: async () => {},
      installManagedComponent: async (id) => { calls.push(["install", id]); },
      start: async (id) => { calls.push(["start", id]); },
    },
  });
  const started = await controller.start("cpa");
  assert.equal(started.bundledRuntime, true);
  assert.deepEqual(calls, [["install", "cpa"]]);
  controller.dispose();
});

test("Control Center Start uses the bundled renderer and Coding Tools Electron without npm or electron downloads", () => {
  const originalUi = read("electron/codex-router-original-ui.cjs");
  const managed = read("electron/codex-router-managed.cjs");
  assert.match(originalUi, /does not download npm packages at Start/);
  assert.match(originalUi, /not downloaded separately/);
  assert.doesNotMatch(originalUi, /npm", \["ci"/);
  assert.doesNotMatch(originalUi, /electron\/install\.js/);
  assert.match(managed, /skipNetworkPrepare/);
  assert.match(managed, /prepareOfflineFromBundle/);
  assert.doesNotMatch(managed, /npm ci/);
});

test("Windows package-time npm ci uses cmd.exe so Node does not EINVAL on npm.cmd", () => {
  const {
    npmExecutable,
    windowsBatchSpawn,
  } = require("../scripts/prepare-bundled-runtimes.cjs");
  assert.equal(npmExecutable("win32"), "npm.cmd");
  assert.equal(npmExecutable("linux"), "npm");
  assert.deepEqual(
    windowsBatchSpawn("npm.cmd", ["ci", "--omit=dev"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    }),
    {
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "ci", "--omit=dev"],
    },
  );
  assert.deepEqual(
    windowsBatchSpawn("npm", ["ci"], { platform: "linux" }),
    { executable: "npm", args: ["ci"] },
  );
  const bundled = read("scripts/prepare-bundled-runtimes.cjs");
  assert.match(bundled, /windowsBatchSpawn/);
  assert.match(bundled, /\/d", "\/s", "\/c"/);
  assert.match(bundled, /scratchRoot/);
  assert.match(bundled, /relocateUnpublishedRouterFiles/);
  assert.doesNotMatch(bundled, /stagingRoot, "aiTemp-router-extract"/);
});

test("published Router source relocates tests instead of deleting them", () => {
  const { relocateUnpublishedRouterFiles } = require("../scripts/prepare-bundled-runtimes.cjs");
  const sourceRoot = temporaryDirectory("coding-tools-prune-router");
  const unpublishedRoot = temporaryDirectory("coding-tools-unpublished-router");
  fs.mkdirSync(path.join(sourceRoot, "test"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "test", "routing.test.mjs"), "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n");
  fs.mkdirSync(path.join(sourceRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "scripts", "verify-grok-service-tier.mjs"), "sk-test\n");
  fs.writeFileSync(path.join(sourceRoot, "scripts", "keep.mjs"), "keep\n");
  relocateUnpublishedRouterFiles(sourceRoot, unpublishedRoot);
  assert.equal(fs.existsSync(path.join(sourceRoot, "test")), false);
  assert.equal(fs.existsSync(path.join(sourceRoot, "scripts", "verify-grok-service-tier.mjs")), false);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "scripts", "keep.mjs"), "utf8"), "keep\n");
  assert.equal(
    fs.readFileSync(path.join(unpublishedRoot, "test", "routing.test.mjs"), "utf8"),
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n",
  );
});

test("packaging ships bundled CPA and Codex Router outside the download path", () => {
  const pack = JSON.parse(read("package.json"));
  const resources = read("scripts/prepare-package-resources.cjs");
  const bundled = read("scripts/prepare-bundled-runtimes.cjs");
  const verifier = read("scripts/verify-package.cjs");
  const manager = read("electron/managed-components.cjs");
  const surface = read("src/features/OriginalUiSurface.tsx");
  const integrations = read("src/features/ExternalServicesSurface.tsx");

  assert.ok(pack.build.files.includes("vendor/bundled-runtimes/**"));
  assert.ok(pack.build.asarUnpack.includes("vendor/bundled-runtimes/**"));
  assert.ok(pack.build.asarUnpack.includes("electron/bundled-runtimes.cjs"));
  assert.match(pack.scripts["build:package-resources"], /prepare-bundled-runtimes/);
  assert.match(resources, /bundled-runtimes/);
  assert.match(resources, /CLIProxyAPI_7\.3\.7_windows_amd64\.zip/);
  assert.match(bundled, /skipNetworkPrepare: true/);
  assert.match(verifier, /bundled-cpa/);
  assert.match(verifier, /bundled-codex-router/);
  assert.match(verifier, /bundledRouterVendorPath/);
  assert.match(read("scripts/smoke-package.cjs"), /WINDOWS_INSTALLER_TIMEOUT_MS = 45 \* 60_000/);
  assert.match(read("scripts/smoke-package.cjs"), /timeout: WINDOWS_INSTALLER_TIMEOUT_MS/);
  assert.match(manager, /copy-bundled-archive/);
  assert.match(manager, /copy-bundled-source/);
  assert.match(surface, /Start original UI/);
  assert.doesNotMatch(surface, /Install \/ start original runtime/);
  assert.match(integrations, /Activate bundled runtime/);
  assert.match(read("electron/cpa-codex-long-run.cjs"), /keepalive-seconds: 15/);
});

test("bundled payload resolver requires the official Control Center files", () => {
  const bundleRoot = temporaryDirectory("coding-tools-router-bundle");
  writeRouterSource(path.join(bundleRoot, "codex-router", "source"));
  const resolved = resolveBundledPayload(routerManifest(), { bundleRoot });
  assert.equal(resolved.id, "codex-router");
  assert.equal(resolved.skipNetworkPrepare, true);
});

test("ensureOriginalControlCenter does not spawn npm when the renderer is already bundled", () => {
  const home = temporaryDirectory("coding-tools-cc-home");
  writeRouterSource(home);
  const runs = [];
  const prepared = ensureOriginalControlCenter(home, {
    npm: "npm-should-not-run",
    run: (...args) => {
      runs.push(args);
      throw new Error("npm should not run at Start");
    },
  });
  assert.equal(runs.length, 0);
  assert.match(prepared.renderer, /index\.html$/);
});
