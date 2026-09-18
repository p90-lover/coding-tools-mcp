"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "paseo", "anneal"];

test("all external runtimes have pinned in-app managed component manifests", () => {
  for (const id of COMPONENT_IDS) {
    const manifest = readJson(`vendor/managed-components/${id}.json`);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.id, id);
    assert.equal(manifest.managedBy, "Coding Tools");
    assert.equal(manifest.loopbackOnly, true);
    assert.ok(manifest.version);
    assert.ok(manifest.strategy);
    assert.ok(manifest.health?.endpoint);
    assert.ok(Array.isArray(manifest.install?.steps));
    assert.ok(Array.isArray(manifest.launch?.processes));
    assert.ok(manifest.launch.processes.length > 0);
  }
});

test("Codex Router is pinned to a checksum-verified Windows release binary", () => {
  const manifest = readJson("vendor/managed-components/codex-router.json");
  assert.equal(manifest.strategy, "release-binary");
  assert.equal(manifest.repository, "duolahypercho/codex-router");
  assert.equal(manifest.version, "0.6.0");
  assert.match(manifest.platforms.win32.x64.url, /model-router-0\.6\.0-windows-x64\.exe$/);
  assert.match(manifest.platforms.win32.x64.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.configure.runtimeCommand, "router integrate");
});

test("CommandCode Proxy is a pinned managed service using the existing CLI session authority", () => {
  const manifest = readJson("vendor/managed-components/commandcode-proxy.json");
  assert.equal(manifest.strategy, "git-source");
  assert.equal(manifest.repository, "zahidhussaina2l/commandcode-proxy");
  assert.equal(manifest.commit, "c123a3ebe017415ef45e619600a1110198dea7f8");
  assert.equal(manifest.credentials.accountAuthority, "CPA Provider Hub");
  assert.equal(manifest.credentials.sessionSource, "~/.commandcode/auth.json");
  assert.equal(manifest.launch.processes[0].environment.PROXY_HOST, "127.0.0.1");
  assert.equal(manifest.launch.processes[0].environment.PROXY_PORT, "9090");
});

test("Paseo installation builds and runs the pinned upstream server", () => {
  const manifest = readJson("vendor/managed-components/paseo.json");
  assert.equal(manifest.strategy, "git-source");
  assert.equal(manifest.repository, "getpaseo/paseo");
  assert.equal(manifest.commit, "1e4ba65c6d75a6b061a1d54141f2f105b5908a96");
  assert.ok(manifest.install.steps.some((step) => step.arguments?.includes("ci")));
  assert.ok(manifest.install.steps.some((step) => step.arguments?.includes("build:server")));
  assert.equal(manifest.launch.processes[0].environment.PASEO_LISTEN, "127.0.0.1:6768");
  assert.equal(manifest.health.endpoint, "http://127.0.0.1:6768/");
});

test("Anneal includes PostgreSQL, API, runner and web with a Windows WSL2 boundary", () => {
  const manifest = readJson("vendor/managed-components/anneal.json");
  assert.equal(manifest.strategy, "git-source");
  assert.equal(manifest.repository, "mosonlab/anneal");
  assert.equal(manifest.commit, "e43b72b10ad389f090a0be18eea5d2bcef468f5e");
  assert.equal(manifest.platformModes.win32, "wsl2");
  assert.deepEqual(manifest.launch.processes.map((entry) => entry.id), [
    "postgres",
    "api",
    "runner",
    "web",
  ]);
  assert.ok(manifest.install.steps.some((step) => step.id === "setup-local"));
  assert.ok(manifest.install.steps.some((step) => step.id === "db-migrate"));
  assert.equal(manifest.health.endpoint, "http://127.0.0.1:5173/");
  assert.equal(manifest.executionEndpoint, "http://127.0.0.1:3000/");
});

test("managed component controller stages under aiTemp and preserves replaced installs in Trash", () => {
  const source = read("electron/managed-components.cjs");
  assert.match(source, /aiTemp/);
  assert.match(source, /Trash/);
  assert.match(source, /moveToTrash/);
  assert.match(source, /installComponent/);
  assert.match(source, /repairComponent/);
  assert.match(source, /verifySha256/);
  assert.match(source, /assertSafeManifest/);
  assert.doesNotMatch(source, /\b(?:rmSync|unlinkSync|rmdirSync)\s*\(/);
});

test("managed installation is wired through the combined controller, focused IPC, preload, types and UI", () => {
  const main = read("electron/main.cjs");
  const combined = read("electron/managed-external-services.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  const surface = read("src/features/ExternalServicesSurface.tsx");

  assert.match(main, /createManagedExternalServicesController/);
  assert.match(main, /launcher:managed-components-snapshot/);
  assert.match(main, /launcher:managed-component-install/);
  assert.match(main, /launcher:managed-component-repair/);
  assert.match(combined, /createManagedComponentController/);
  assert.match(combined, /installManagedComponent/);
  assert.match(combined, /repairManagedComponent/);
  assert.match(preload, /managedComponentsSnapshot/);
  assert.match(preload, /installManagedComponent/);
  assert.match(preload, /repairManagedComponent/);
  assert.match(types, /ManagedComponentInstallState/);
  assert.match(types, /installManagedComponent\(serviceId: ExternalServiceId\)/);
  assert.match(surface, /Install \/ Repair|安裝／修復/);
  assert.match(surface, /managedInstall/);
  assert.match(surface, /Advanced manual configuration|進階手動設定/);
});

test("packaging retains managed manifests and manager modules", () => {
  const packageJson = readJson("package.json");
  assert.ok(packageJson.build.files.includes("vendor/managed-components/**"));
  assert.ok(packageJson.build.files.includes("electron/**"));
});
