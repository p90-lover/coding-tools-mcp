"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

test("current main exposes one persisted five-tab Managed Apps workspace", () => {
  const surfacePath = path.join(desktopRoot, "src", "features", "ManagedAppsSurface.tsx");
  assert.equal(fs.existsSync(surfacePath), true, "ManagedAppsSurface.tsx must exist on the current-main integration lane");

  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const state = read("electron/state.cjs");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const surface = fs.readFileSync(surfacePath, "utf8");

  assert.match(types, /ManagedAppTabId = "cpa" \| "codex-router" \| "commandcode-proxy" \| "paseo" \| "anneal"/);
  assert.match(types, /managedAppTab: ManagedAppTabId/);
  assert.match(state, /MANAGED_APP_TAB_SET/);
  assert.match(state, /managedAppTab: "cpa"/);
  assert.match(main, /launcher:managed-app-tab/);
  assert.match(main, /assertFocusedMainWindow\(event, true\)/);
  assert.match(preload, /setManagedAppTab/);
  assert.match(app, /<ManagedAppsSurface/);
  assert.match(app, /surface === "apps"/);
  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(surface, new RegExp(`id: "${id}"`));
  }
});

test("current main keeps each Managed Apps locale distinct", () => {
  const app = read("src/App.tsx");
  const surface = read("src/features/ManagedAppsSurface.tsx");

  assert.match(app, /language === "zh-TW"\s*\?\s*"受管理應用程式"/);
  assert.match(app, /language === "zh-CN"\s*\?\s*"托管应用"/);
  assert.match(app, /language === "ja"\s*\?\s*"管理対象アプリ"/);
  assert.match(app, /:\s*"Managed Apps"/);
  assert.match(surface, /if \(language === "zh-CN"\) return simplifiedChinese/);
  assert.match(surface, /if \(language === "zh-TW"\) return traditionalChinese/);
  assert.match(surface, /if \(language === "ja"\) return japanese/);
  assert.match(surface, /return english/);
});
