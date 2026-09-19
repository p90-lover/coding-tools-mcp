"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

test("CPA retains every original CLIProxyAPI management section", () => {
  const manifest = JSON.parse(read("vendor/upstream/cpa.json"));
  assert.deepEqual(manifest.sections, [
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
  for (const section of manifest.sections) {
    assert.match(manifest.sectionPaths[section], /^\/management\.html#\//u);
  }
});

test("the original CPA host retains selected section and shows reconnect-aware status", () => {
  const surface = read("src/features/OriginalUiSurface.tsx");
  const types = read("src/types.ts");
  const styles = read("src/features/original-ui.css");

  assert.match(types, /selectedSection\?: string/);
  assert.match(types, /uiStatus\?: "ready" \| "starting" \| "reconnecting" \| "blocked" \| "stopped" \| "offline"/);
  assert.match(surface, /function selectedFrom\(tool: OriginalUiSnapshot \| null\)/);
  assert.match(surface, /function displayStatusOf\(tool: OriginalUiSnapshot\)/);
  assert.match(surface, /className="original-ui-section-tabs"/);
  assert.match(surface, /tool\.sections\.map\(\(section\) =>/);
  assert.match(surface, /section === selectedSection \? "is-active" : ""/);
  assert.match(surface, /withReconnect\(frameUrl, reconnectGenerationOf\(tool\)\)/);
  assert.match(surface, /Reconnecting/);
  assert.match(surface, /正在重連/);
  assert.match(surface, /Reconnect paused/);
  assert.match(surface, /重連已暫停/);
  assert.match(styles, /\.original-ui-section-tabs/);
  assert.match(styles, /status-reconnecting/);
  assert.match(styles, /status-blocked/);
});

test("CPA recovery reopens the last selected original section", () => {
  const surface = read("src/features/OriginalUiSurface.tsx");
  assert.match(surface, /const recovered = lastStatus\.current !== ""/);
  assert.match(surface, /const generationBumped = generation > lastGeneration\.current/);
  assert.match(surface, /openSection\(selectedSection \|\| selectedFrom\(tool\)\)/);
  assert.match(surface, /setSelectedSection\(\(value\) => value \|\| selectedFrom\(current\)\)/);
});

test("CPA management key stays behind focused privileged IPC", () => {
  const surface = read("src/features/OriginalUiSurface.tsx");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");

  assert.match(surface, /api\.copyCpaManagementKey\(\)/);
  assert.match(main, /assertFocusedMainWindow\(event, true\)/);
  assert.match(main, /copyCpaManagementKey/);
  assert.match(preload, /copyCpaManagementKey/);
  assert.doesNotMatch(surface, /managementKey\s*[:=]/);
  assert.doesNotMatch(surface, /secret-key/);
});

test("the CPA parity lane preserves all tracked files", () => {
  const workflow = read("../.github/workflows/rc11-cpa-original-ui-parity-current.yml");
  assert.match(workflow, /git diff --diff-filter=D/);
  assert.match(workflow, /test -z/);
  assert.match(workflow, /rc11-cpa-original-ui-parity-current\.test\.cjs/);
});
