"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("Managed Apps tab status is driven by window.codingTools.apps handles", () => {
  const surface = source("src/features/ManagedAppsSurface.tsx");
  assert.match(surface, /window\.codingTools\?\.apps/);
  assert.match(surface, /ManagedAppsSnapshot/);
  assert.match(surface, /new Map\(snapshot\.apps\.map\(\(app\) => \[app\.handle, app\]/);
  assert.match(surface, /api\.onChanged\(setSnapshot\)/);
  assert.doesNotMatch(surface, /externalServicesSnapshot\(\)/);
  assert.doesNotMatch(surface, /onExternalServicesChanged/);
});

test("preload exposes a leak-free managed-app change subscription", () => {
  const preload = source("electron/preload.cjs");
  const contracts = source("src/api/contracts.ts");
  assert.match(preload, /onChanged: \(listener\) => subscribeManagedApps/);
  assert.match(preload, /launcher:external-services-changed/);
  assert.match(preload, /launcher:provider-network-changed/);
  assert.match(preload, /removeListener\(channel, refresh\)/);
  assert.match(contracts, /onChanged\(listener: \(snapshot: ManagedAppsSnapshot\) => void\): \(\) => void/);
});
