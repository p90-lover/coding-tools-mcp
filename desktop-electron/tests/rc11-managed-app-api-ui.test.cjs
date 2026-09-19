"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("Managed Apps tab health is driven by window.codingTools.apps handles", () => {
  const surface = source("src/features/ManagedAppsSurface.tsx");
  assert.match(surface, /window\.codingTools\?\.apps/);
  assert.match(surface, /ManagedAppsSnapshot/);
  assert.match(surface, /new Map\(snapshot\.apps\.map\(\(app\) => \[app\.handle, app\]/);
  assert.match(surface, /api\.onChanged\(setSnapshot\)/);
  assert.doesNotMatch(surface, /externalServicesSnapshot\(\)/);
  assert.doesNotMatch(surface, /onExternalServicesChanged/);
});

test("all five visible tabs keep their current real UI surfaces", () => {
  const surface = source("src/features/ManagedAppsSurface.tsx");
  for (const handle of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(surface, new RegExp(`id: \\"${handle}\\"`));
  }
  assert.match(surface, /ProviderCenterSurface/);
  assert.match(surface, /OriginalUiSurface/);
  assert.match(surface, /ExternalServicesSurface/);
  assert.match(surface, /PaseoOrchestratorSurface/);
  assert.match(surface, /AnnealTasksSurface/);
  assert.match(surface, /UpstreamToolSurface/);
});

test("tab status uses redacted setup metadata and keeps outage handles visible", () => {
  const surface = source("src/features/ManagedAppsSurface.tsx");
  assert.match(surface, /const app = appByHandle\.get\(tab\.id\)/);
  assert.match(surface, /const managedState = app\?\.managed\?\.state/);
  assert.match(surface, /const setupStatus = app\?\.setup\?\.status/);
  assert.match(surface, /managedState === "unavailable"/);
  assert.match(surface, /setupStatus === "blocked"/);
});
