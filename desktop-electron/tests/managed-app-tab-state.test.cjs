"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(desktopRoot, "electron", "main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(desktopRoot, "electron", "preload.cjs"), "utf8");
const appSource = fs.readFileSync(path.join(desktopRoot, "src", "App.tsx"), "utf8");
const typesSource = fs.readFileSync(path.join(desktopRoot, "src", "types.ts"), "utf8");
const {
  createStateStore,
  validateManagedAppTab,
} = require("../electron/state.cjs");

const TABS = ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"];

test("managed app tab validation accepts only the five product tabs", () => {
  for (const tab of TABS) assert.equal(validateManagedAppTab(tab), tab);
  for (const invalid of [null, "", "providers", "settings", "CPA", 7, {}]) {
    assert.throws(() => validateManagedAppTab(invalid), /managed app tab/i);
  }
});

test("launcher state persists the selected managed app tab and repairs corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-managed-tab-"));
  const file = path.join(root, "launcher-state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().managedAppTab, "cpa");
    store.update({ managedAppTab: "anneal" });
    assert.equal(createStateStore(file).read().managedAppTab, "anneal");

    fs.writeFileSync(file, JSON.stringify({ version: 1, managedAppTab: "outside-app" }));
    assert.equal(createStateStore(file).read().managedAppTab, "cpa");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("focused IPC and preload expose persistent tab selection", () => {
  assert.match(mainSource, /validateManagedAppTab/);
  assert.match(mainSource, /handle\("launcher:managed-app-tab"/);
  assert.match(mainSource, /assertFocusedMainWindow\(event, true\)/);
  assert.match(mainSource, /managedAppTab:\s*validateManagedAppTab\(tab\)/);
  assert.match(mainSource, /send\("launcher:state-changed", state\)/);
  assert.match(preloadSource, /setManagedAppTab:\s*\(tab\)\s*=>\s*ipcRenderer\.invoke\("launcher:managed-app-tab", tab\)/);
});

test("renderer initializes from persisted state and writes tab changes through IPC", () => {
  assert.match(typesSource, /export type ManagedAppTabId\s*=/);
  assert.match(typesSource, /managedAppTab:\s*ManagedAppTabId/);
  assert.match(typesSource, /setManagedAppTab\(tab:\s*ManagedAppTabId\):\s*Promise<LauncherState>/);
  assert.match(appSource, /useState<ManagedAppTabId>\(snapshot\.state\.managedAppTab\)/);
  assert.match(appSource, /api!\.setManagedAppTab\(tab\)/);
  assert.match(appSource, /onSelectedTabChange=\{selectManagedAppTab\}/);
});
