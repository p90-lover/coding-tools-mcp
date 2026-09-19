"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(desktopRoot, relativePath));

test("the CPA managed-app tab hosts the original management application inside Coding Tools", () => {
  assert.equal(exists("electron/cpa-managed.cjs"), true, "managed CPA runtime adapter is missing");
  assert.equal(exists("electron/original-ui.cjs"), true, "original UI controller is missing");
  assert.equal(exists("src/features/OriginalUiSurface.tsx"), true, "original UI renderer is missing");
  assert.equal(exists("src/features/original-ui.css"), true, "original UI styles are missing");

  const tabs = read("src/features/ManagedAppsSurface.tsx");
  const surface = read("src/features/OriginalUiSurface.tsx");
  assert.match(tabs, /OriginalUiSurface/);
  assert.match(tabs, /toolId="cpa"/);
  assert.match(surface, /<iframe/);
  assert.match(surface, /management key/i);
  assert.doesNotMatch(surface, /new\s+BrowserWindow|child_process|spawn\s*\(/);
});

test("managed CPA keeps the original panel loopback-only and never opens a browser itself", () => {
  assert.equal(exists("vendor/managed-components/cpa.json"), true, "managed CPA manifest is missing");
  assert.equal(exists("vendor/upstream/cpa.json"), true, "CPA original UI manifest is missing");
  const adapter = read("electron/cpa-managed.cjs");
  assert.match(adapter, /host: \\"127\.0\.0\.1\\"/);
  assert.match(adapter, /port: 8317/);
  assert.match(adapter, /allow-remote: false/);
  assert.match(adapter, /disable-control-panel: false/);
  assert.match(adapter, /--no-browser/);
});

test("CPA management-key copy is focused-window IPC and returns only redacted metadata", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  assert.match(main, /launcher:original-ui-copy-cpa-key/);
  assert.match(main, /assertFocusedMainWindow\(event, true\)/);
  assert.match(preload, /copyCpaManagementKey/);
  assert.match(types, /copyCpaManagementKey\(\): Promise<\{\s*copied: boolean;\s*length: number;\s*\}>/s);
  assert.doesNotMatch(types, /copyCpaManagementKey\(\)[\s\S]{0,160}(value|managementKey|secret): string/);
});
