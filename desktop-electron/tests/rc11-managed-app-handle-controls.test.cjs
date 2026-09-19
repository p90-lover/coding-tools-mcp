"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const surfacePath = path.join(root, "src", "features", "ManagedAppsSurface.tsx");
const cssPath = path.join(root, "src", "features", "managed-apps.css");

function source(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("Managed Apps exposes one handle-driven lifecycle toolbar", () => {
  const surface = source(surfacePath);
  assert.match(surface, /className="managed-app-toolbar"/);
  assert.match(surface, /data-managed-app-handle=\{selectedTab\}/);
  assert.match(surface, /api\.invoke\(\{/);
  assert.match(surface, /handle:\s*selectedTab/);
  assert.match(surface, /confirm:\s*true/);
  assert.match(surface, /operations\.includes\("inspect"\)/);
  assert.match(surface, /operations\.includes\("start"\)/);
  assert.match(surface, /operations\.includes\("stop"\)/);
  assert.match(surface, /operations\.includes\("restart"\)/);
  assert.match(surface, /operations\.includes\("repair"\)/);
  assert.match(surface, /operations\.includes\("sync"\)/);
});

test("one control can reconcile every stable app handle without separate installers", () => {
  const surface = source(surfacePath);
  assert.match(surface, /api\.reconcile\(\{/);
  assert.match(surface, /reason:\s*"managed-apps-toolbar"/);
  assert.match(surface, /confirm:\s*true/);
  assert.match(surface, /Install and start all/);
  assert.match(surface, /安裝並啟動全部/);
});

test("the handle toolbar has responsive product styling and retains the real app surfaces", () => {
  const surface = source(surfacePath);
  const css = source(cssPath);
  assert.match(css, /\.managed-app-toolbar\s*\{/);
  assert.match(css, /\.managed-app-toolbar-actions\s*\{/);
  assert.match(css, /\.managed-app-toolbar-status\s*\{/);
  assert.match(surface, /<ProviderCenterSurface/);
  assert.match(surface, /<OriginalUiSurface/);
  assert.match(surface, /<ExternalServicesSurface/);
  assert.match(surface, /<PaseoOrchestratorSurface/);
  assert.match(surface, /<AnnealTasksSurface/);
});
