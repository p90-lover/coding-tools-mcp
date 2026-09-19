"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

test("the launcher persists one of the five fixed managed-app tabs through focused IPC", () => {
  const state = read("electron/state.cjs");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");

  assert.match(types, /export type ManagedAppTabId = "cpa" \| "codex-router" \| "commandcode-proxy" \| "paseo" \| "anneal"/);
  assert.match(types, /managedAppTab: ManagedAppTabId/);
  assert.match(types, /setManagedAppTab\(tab: ManagedAppTabId\): Promise<LauncherState>/);
  assert.match(state, /const MANAGED_APP_TAB_SET = new Set\(\[/);
  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(state, new RegExp(`"${id}"`));
  }
  assert.match(state, /managedAppTab: "cpa"/);
  assert.match(state, /function validateManagedAppTab\(value\)/);
  assert.match(main, /handle\("launcher:managed-app-tab", \(event, tab\) => \{/);
  assert.match(main, /assertFocusedMainWindow\(event, true\)/);
  assert.match(main, /validateManagedAppTab\(tab\)/);
  assert.match(preload, /setManagedAppTab: \(tab\) => ipcRenderer\.invoke\("launcher:managed-app-tab", tab\)/);
});

test("the product shell exposes one Managed Apps destination instead of six fragmented engine destinations", () => {
  const app = read("src/App.tsx");
  const managedApps = read("src/features/ManagedAppsSurface.tsx");
  assert.match(app, /import \{ ManagedAppsSurface \} from "\.\/features\/ManagedAppsSurface"/);
  assert.match(app, /useState<ManagedAppTabId>\(snapshot\.state\.managedAppTab\)/);
  assert.match(app, /selectManagedAppTab\("cpa"\)/);
  assert.match(app, /selectManagedAppTab\("codex-router"\)/);
  assert.match(app, /selectManagedAppTab\("paseo"\)/);
  assert.match(app, /selectManagedAppTab\("anneal"\)/);
  assert.match(managedApps, /id: "commandcode-proxy"/);
  assert.match(managedApps, /onSelectedTabChange\(tab\)/);
  assert.match(app, /language === "zh-TW" \? "受管理應用程式"/);
  assert.match(app, /language === "zh-CN" \? "托管应用"/);
  assert.match(app, /language === "ja" \? "管理対象アプリ"/);
  assert.match(app, /: "Managed Apps"/);
  assert.match(app, /surface === "apps"/);
  assert.match(app, /<ManagedAppsSurface/);
});

test("Managed Apps copy keeps Simplified Chinese, Traditional Chinese, and Japanese distinct", () => {
  const managedApps = read("src/features/ManagedAppsSurface.tsx");
  assert.doesNotMatch(managedApps, /language === "zh-TW" \|\| language === "zh-CN"/);
  assert.match(managedApps, /simplifiedChinese: string/);
  assert.match(managedApps, /traditionalChinese: string/);
  assert.match(managedApps, /japanese: string/);
  assert.match(managedApps, /language === "zh-CN"/);
  assert.match(managedApps, /language === "zh-TW"/);
  assert.match(managedApps, /language === "ja"/);
  assert.match(managedApps, /托管应用/);
  assert.match(managedApps, /受管理應用程式/);
  assert.match(managedApps, /管理対象アプリ/);
});

test("each managed-app tab reuses the real current runtime surface without storing secrets in tab state", () => {
  const surface = read("src/features/ManagedAppsSurface.tsx");
  const external = read("src/features/ExternalServicesSurface.tsx");

  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(surface, new RegExp(`id: "${id}"`));
  }
  assert.match(surface, /<ProviderCenterSurface/);
  assert.match(surface, /<OriginalUiSurface[^>]*toolId="cpa"/);
  assert.match(surface, /preferredServiceId="codex-router"/);
  assert.match(surface, /preferredServiceId="commandcode-proxy"/);
  assert.match(surface, /toolId="paseo"/);
  assert.match(surface, /toolId="anneal"/);
  assert.match(external, /preferredServiceId\?: ExternalServiceId/);
  assert.doesNotMatch(surface, /credential|apiKey|managementKey|token|password/i);
});

test("the current-main lane retains every tracked file", () => {
  const workflow = read("../.github/workflows/rc11-managed-apps-shell.yml");
  assert.match(workflow, /git diff --diff-filter=D/);
  assert.match(workflow, /test -z/);
  assert.match(workflow, /rc11-managed-apps-shell\.test\.cjs/);
});
