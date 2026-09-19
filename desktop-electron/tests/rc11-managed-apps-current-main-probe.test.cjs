"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const managedAppsPath = path.join(desktopRoot, "src", "features", "ManagedAppsSurface.tsx");
const managedAppsCssPath = path.join(desktopRoot, "src", "features", "managed-apps.css");

function readRequiredFile(filePath, label) {
  assert.equal(
    fs.existsSync(filePath),
    true,
    `${label} must exist on the current-main integration lane`,
  );
  return fs.readFileSync(filePath, "utf8");
}

function readManagedAppsSurface() {
  return readRequiredFile(managedAppsPath, "ManagedAppsSurface.tsx");
}

test("current main exposes one persisted five-tab Managed Apps workspace", () => {
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const state = read("electron/state.cjs");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const surface = readManagedAppsSurface();

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
  const surface = readManagedAppsSurface();

  assert.match(app, /language === "zh-TW"\s*\?\s*"受管理應用程式"/);
  assert.match(app, /language === "zh-CN"\s*\?\s*"托管应用"/);
  assert.match(app, /language === "ja"\s*\?\s*"管理対象アプリ"/);
  assert.match(app, /:\s*"Managed Apps"/);
  assert.match(surface, /if \(language === "zh-CN"\) return simplifiedChinese/);
  assert.match(surface, /if \(language === "zh-TW"\) return traditionalChinese/);
  assert.match(surface, /if \(language === "ja"\) return japanese/);
  assert.match(surface, /return english/);
});

test("current main packages the stylesheet imported by the Managed Apps surface", () => {
  const surface = readManagedAppsSurface();
  const css = readRequiredFile(managedAppsCssPath, "managed-apps.css");

  assert.match(surface, /import "\.\/managed-apps\.css"/);
  assert.match(css, /\.managed-apps-surface\s*\{/);
  assert.match(css, /\.managed-apps-tabs\s*\{/);
  assert.match(css, /\.managed-apps-content\s*\{/);
});
