"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");

test("all five stacks keep original visual UI and managed lifecycle wiring", () => {
  const app = read("src/App.tsx");
  const originalUi = read("src/features/OriginalUiSurface.tsx");
  const originalMain = read("electron/original-ui.cjs");
  const cpaManaged = read("electron/cpa-managed.cjs");
  const controlCenter = read("electron/codex-router-original-ui.cjs");
  const commandCode = read("src/features/CommandCodeProxySurface.tsx");
  const integrations = read("src/features/ExternalServicesSurface.tsx");
  const upstream = read("src/features/UpstreamToolSurface.tsx");
  const upstreamMain = read("electron/upstream-tools.cjs");
  const external = read("electron/external-services.cjs");
  const bootstrap = read("electron/managed-bootstrap.cjs");
  const combined = read("electron/managed-external-services.cjs");
  const cpaManifest = JSON.parse(read("vendor/upstream/cpa.json"));
  const paseoManifest = JSON.parse(read("vendor/upstream/paseo.json"));
  const annealManifest = JSON.parse(read("vendor/upstream/anneal.json"));
  const cpaComponent = JSON.parse(read("vendor/managed-components/cpa.json"));

  assert.match(app, /toolId="cpa"/);
  assert.match(app, /toolId="codex-router"/);
  assert.match(app, /toolId="paseo"/);
  assert.match(app, /toolId="anneal"/);

  assert.equal(cpaManifest.sectionPaths.dashboard, "/management.html#/dashboard");
  assert.match(originalUi, /original-ui-section-tabs/);
  assert.match(originalUi, /Copy management key/);
  assert.match(cpaManaged, /disable-control-panel: false/);
  assert.doesNotMatch(originalMain, /cpaManagementKey,/);
  assert.match(originalMain, /copyCpaManagementKey/);
  assert.equal(cpaComponent.strategy, "release-binary");
  assert.ok(cpaComponent.platforms.linux.x64.sha256);

  assert.match(controlCenter, /function openOriginalControlCenter/);
  assert.match(controlCenter, /--router-destination/);
  assert.match(originalUi, /Original Codex Router Control Center/);

  assert.match(commandCode, /CommandCode AI Proxy/);
  assert.match(commandCode, /ANTHROPIC_BASE_URL=/);
  assert.match(commandCode, /onStart/);
  assert.match(commandCode, /onCheck/);
  assert.match(integrations, /CommandCodeProxySurface/);
  assert.match(external, /projectCommandCodeHealth/);
  assert.match(external, /id === "commandcode-proxy"/);

  assert.equal(paseoManifest.sectionPaths.agents, "/sessions");
  assert.equal(paseoManifest.sectionPaths.workspaces, "/open-project");
  assert.match(upstream, /openEmbeddedTool\(toolId, section\)/);
  assert.match(upstream, /is-immersive/);
  assert.doesNotMatch(upstream, /Start pinned source/);

  assert.equal(annealManifest.defaultEndpoint, "http://127.0.0.1:5173/");
  assert.equal(annealManifest.sectionPaths.tasks, "#/tasks");
  assert.match(upstreamMain, /raw\.startsWith\("#"\)/);
  assert.match(upstream, /Coding Tools manages Anneal through WSL2 and Docker on Windows/);
  assert.doesNotMatch(upstream, /port-forward/);

  assert.match(bootstrap, /DEFAULT_COMPONENT_IDS[\s\S]*cpa[\s\S]*codex-router[\s\S]*commandcode-proxy[\s\S]*paseo[\s\S]*anneal/);
  assert.match(combined, /createManagedBootstrap/);
  assert.match(readRepo("docs/superpowers/specs/2026-09-18-one-app-managed-five-stack-design.md"), /Option A — one-app managed/);
});

test("managed security boundaries stay loopback, focused-window, secret-redacted, and no-delete", () => {
  const cpaManaged = read("electron/cpa-managed.cjs");
  const managed = read("electron/managed-components.cjs");
  const originalMain = read("electron/original-ui.cjs");
  const main = read("electron/main.cjs");
  const commandCode = read("src/features/CommandCodeProxySurface.tsx");
  const health = read("electron/external-services.cjs");

  assert.match(cpaManaged, /127\.0\.0\.1/);
  assert.match(cpaManaged, /port: 8317/);
  assert.match(cpaManaged, /allow-remote: false/);
  assert.match(managed, /"Trash", "managed-components"/);
  assert.match(managed, /function moveToTrash/);
  assert.doesNotMatch(managed, /\bfs\.rmSync\b|\bfs\.rmdirSync\b|\bFile\.Delete\b/);
  assert.match(main, /handle\("launcher:original-ui-open",[\s\S]*?assertFocusedMainWindow\(event, true\)/);
  assert.match(commandCode, /app-managed \(not shown\)/);
  assert.match(health, /projectCommandCodeHealth/);
  assert.doesNotMatch(health, /apiKey: boundedText/);
  assert.match(originalMain, /Copy management key[\s\S]*|copyCpaManagementKey/);
});
