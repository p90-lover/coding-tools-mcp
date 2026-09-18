"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(desktopRoot, relative), "utf8");
const readJson = (relative) => JSON.parse(read(relative));

test("the Apps workspace exposes every integrated application as a dedicated tab", () => {
  const source = read("src/features/IntegratedAppsSurface.tsx");
  for (const tabId of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(source, new RegExp(`\\"${tabId}\\"`), `missing ${tabId} tab`);
  }
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /coding-tools-integrated-app-tab-v1/);
  assert.doesNotMatch(source, /credential|token|secret/i, "tab preference must not persist credentials");
});

test("the launcher exposes one Apps navigation entry and keeps legacy surfaces compatible", () => {
  const types = read("src/types.ts");
  const shell = read("src/App.tsx");
  assert.match(types, /export type Surface =[^;]*"apps"/s);
  assert.match(shell, /surface === "apps"/);
  assert.match(shell, /<IntegratedAppsSurface/);
  assert.match(shell, /navigateSurface\("apps"\)/);
});

test("focused service mode reuses the existing lifecycle controller", () => {
  const source = read("src/features/ExternalServicesSurface.tsx");
  assert.match(source, /focusServiceId\?: ExternalServiceId/);
  assert.match(source, /focusServiceId/);
  assert.match(source, /configureExternalService/);
  assert.match(source, /startExternalService/);
  assert.match(source, /restartExternalService/);
  assert.match(source, /stopExternalService/);
});

test("Paseo and Anneal tabs use their real upstream routes", () => {
  const paseo = readJson("vendor/upstream/paseo.json");
  const anneal = readJson("vendor/upstream/anneal.json");
  assert.equal(paseo.sectionPaths.sessions, "/sessions");
  assert.equal(paseo.sectionPaths.workspaces, "/open-project");
  assert.equal(paseo.sectionPaths.settings, "/settings");
  assert.equal(anneal.sectionPaths.tasks, "#/tasks");
  assert.equal(anneal.sectionPaths.projects, "#/projects");
  assert.equal(anneal.sectionPaths.settings, "#/settings");
});

test("ready upstream tools open their first section automatically", () => {
  const source = read("src/features/UpstreamToolSurface.tsx");
  assert.match(source, /inspectUpstreamTool\(toolId\)/);
  assert.match(source, /current\.status === "ready"/);
  assert.match(source, /openEmbeddedTool\(toolId, section\)/);
});
