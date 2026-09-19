"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createOriginalUiController,
  normalizeLoopbackEndpoint,
  sectionUrl,
  loadManifest,
  TOOL_IDS,
} = require("../electron/original-ui.cjs");
const {
  ORIGINAL_SECTIONS,
  openOriginalControlCenter,
} = require("../electron/codex-router-original-ui.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function controlCenterFixture() {
  const home = temporaryDirectory("coding-tools-router-home-");
  const state = temporaryDirectory("coding-tools-router-state-");
  const appRoot = path.join(home, "apps", "control-center");
  fs.mkdirSync(path.join(appRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "electron"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify({
    name: "@codex-router/control-center",
    version: "0.6.0",
    main: "electron/main.mjs",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(appRoot, "dist", "index.html"), "<!doctype html><title>Control Center</title>");
  fs.writeFileSync(path.join(appRoot, "electron", "preload.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(appRoot, "electron", "main.mjs"), "export {};\n");
  return { home, state, appRoot };
}

test("original UI manifests pin CPA management.html hash routes and Codex Router Control Center sections", () => {
  const cpa = loadManifest("cpa");
  const router = loadManifest("codex-router");

  assert.deepEqual(TOOL_IDS, ["cpa", "codex-router", "paseo", "anneal"]);
  assert.equal(cpa.repository, "router-for-me/CLIProxyAPI");
  assert.equal(cpa.version, "7.3.7");
  assert.equal(cpa.defaultEndpoint, "http://127.0.0.1:8317/");
  assert.deepEqual(cpa.sections, [
    "dashboard",
    "ai-providers",
    "auth-files",
    "oauth",
    "quota",
    "config",
    "logs",
    "system",
    "plugins",
  ]);
  assert.equal(cpa.sectionPaths.dashboard, "/management.html#/dashboard");
  assert.equal(cpa.sectionPaths.oauth, "/management.html#/oauth");
  assert.equal(
    sectionUrl(cpa, "http://127.0.0.1:8317/", "config"),
    "http://127.0.0.1:8317/management.html#/config",
  );

  assert.equal(router.repository, "duolahypercho/codex-router");
  assert.equal(router.commit, "930f547d8d8861a47e18a83216e15e73a73aa97c");
  assert.deepEqual(router.sections, [...ORIGINAL_SECTIONS]);
});

test("original UI endpoints stay on loopback and never carry credentials", () => {
  assert.equal(normalizeLoopbackEndpoint("http://127.0.0.1:8317"), "http://127.0.0.1:8317/");
  assert.throws(() => normalizeLoopbackEndpoint("https://example.com"), /127\.0\.0\.1/);
  assert.throws(() => normalizeLoopbackEndpoint("http://user:secret@127.0.0.1:8317"), /credentials/);
});

test("CPA original UI installs when missing, then returns the Coding Tools API handle", async () => {
  const calls = [];
  const clipboard = { written: "" };
  const controller = createOriginalUiController({
    sleep: async () => {},
    electronExecutable: path.join(os.tmpdir(), "missing-electron"),
    externalServices: {
      snapshot: () => ({
        services: [{
          id: "cpa",
          endpoint: "http://127.0.0.1:8317/",
          status: "ready",
          pid: 8317,
          home: "/tmp/cpa-home",
          stateDir: "/tmp/cpa-state",
          managedInstall: { state: "not-installed" },
        }],
      }),
      inspect: async () => {},
      installManagedComponent: async (id) => { calls.push(["install", id]); },
      start: async (id) => { calls.push(["start", id]); },
      cpaConnection: () => ({ managementKey: "a".repeat(36), proxyApiKey: "b".repeat(36) }),
    },
  });

  const started = await controller.start("cpa");
  assert.equal(started.id, "cpa");
  assert.deepEqual(calls, [["install", "cpa"]]);

  const opened = await controller.openEmbedded("cpa", "oauth");
  assert.equal(opened.embedded, false);
  assert.equal(opened.originalWindow, false);
  assert.equal(opened.api.via, "codingTools.apps");
  assert.equal(opened.api.moduleId, "cpa");
  assert.equal(opened.url, "");
  assert.equal(opened.tool.originalChrome, true);

  const copied = controller.copyCpaManagementKey({
    writeText: (value) => { clipboard.written = value; },
  });
  assert.equal(copied.copied, true);
  assert.equal(copied.length, 36);
  assert.equal(clipboard.written, "a".repeat(36));
  controller.dispose();
});

test("Codex Router open path uses Coding Tools APIs and does not launch Control Center", async () => {
  const fixture = controlCenterFixture();
  const spawned = [];
  const fakeElectron = path.join(fixture.appRoot, "fake-electron");
  fs.writeFileSync(fakeElectron, "");
  const child = { pid: 4202, exitCode: null, signalCode: null, once() {}, kill() {} };
  const controller = createOriginalUiController({
    sleep: async () => {},
    electronExecutable: fakeElectron,
    spawnProcess: (executable, args, options) => {
      spawned.push({ executable, args, options });
      return child;
    },
    externalServices: {
      snapshot: () => ({
        services: [{
          id: "codex-router",
          endpoint: "http://127.0.0.1:4202/",
          status: "ready",
          pid: 91,
          home: fixture.home,
          stateDir: fixture.state,
          managedInstall: { state: "installed" },
        }],
      }),
      inspect: async () => {},
      start: async () => {},
    },
  });

  const opened = await controller.openEmbedded("codex-router", "models");
  assert.equal(opened.embedded, false);
  assert.equal(opened.originalWindow, false);
  assert.equal(opened.api.moduleId, "codex-router");
  assert.equal(opened.api.via, "codingTools.apps");
  assert.equal(spawned.length, 0);
  controller.dispose();
});

test("Control Center usage section uses the original --router-destination argv", () => {
  const fixture = controlCenterFixture();
  const fakeElectron = path.join(fixture.appRoot, "fake-electron");
  fs.writeFileSync(fakeElectron, "");
  const spawned = [];
  openOriginalControlCenter({
    home: fixture.home,
    state: fixture.state,
    section: "usage",
    electronExecutable: fakeElectron,
    spawnProcess: (executable, args, options) => {
      spawned.push({ executable, args, options });
      return { pid: 7 };
    },
  });
  assert.deepEqual(spawned[0].args.slice(-2), ["--router-destination", "usage"]);
});

test("managed Codex Router prepare also builds the original Control Center", () => {
  const managed = read("electron/codex-router-managed.cjs");
  const manifest = JSON.parse(read("vendor/managed-components/codex-router.json"));
  assert.match(managed, /apps\/control-center\/electron\/main\.mjs/);
  assert.match(managed, /ensureOriginalControlCenter/);
  assert.match(managed, /bundledSkipNetworkPrepare/);
  assert.match(managed, /prepareOfflineFromBundle/);
  assert.equal(manifest.bundle.required, true);
  assert.equal(
    manifest.install.steps.find((step) => step.id === "assert-control-center")?.path,
    "apps/control-center/electron/main.mjs",
  );
});

test("managed CPA keeps the original control panel enabled on loopback", () => {
  const adapter = read("electron/cpa-managed.cjs");
  assert.match(adapter, /disable-control-panel: false/);
  assert.match(adapter, /allow-remote: false/);
  assert.match(adapter, /host: \\"127\.0\.0\.1\\"/);
  assert.match(adapter, /--no-browser/);
  assert.match(adapter, /cpa-codex-long-run/);
});

test("desktop shell routes CPA and Codex Router to the original UI surface", () => {
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const preload = read("electron/preload.cjs");
  const main = read("electron/main.cjs");
  const surface = read("src/features/OriginalUiSurface.tsx");
  const css = read("src/features/original-ui.css");
  const integrations = read("src/features/ExternalServicesSurface.tsx");

  assert.match(types, /Surface = .* "cpa" \| "codex-router"/);
  assert.match(types, /originalUiSnapshot\(\): Promise<OriginalUiCatalog>/);
  assert.match(preload, /launcher:original-ui-snapshot/);
  assert.match(preload, /launcher:original-ui-copy-cpa-key/);
  assert.match(main, /createOriginalUiController/);
  assert.match(main, /handle\("launcher:original-ui-open", \(event, toolId, section\) => \{\s*assertFocusedMainWindow\(event, false\)/);
  assert.match(app, /navigateSurface\("cpa"\)/);
  assert.match(app, /navigateSurface\("codex-router"\)/);
  assert.match(app, /<details className="sidebar-more"/);
  assert.match(app, /surface === "cpa"/);
  assert.match(app, /toolId="cpa"/);
  assert.match(app, /toolId="codex-router"/);
  assert.match(surface, /data-original-chrome="true"/);
  assert.match(surface, /Copy management key/);
  assert.match(surface, /codingTools\?\.apps/);
  assert.match(css, /\.original-ui-surface/);
  assert.match(css, /flex: 1 1 auto/);
  assert.match(integrations, /Open module APIs/);
  assert.doesNotMatch(integrations, /CPA Provider Hub/);
  assert.match(main, /cpa-codex-long-run\.json/);
});
