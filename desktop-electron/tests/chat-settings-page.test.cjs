"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { UPDATE_SETTINGS } = require("../electron/state.cjs");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("the chat sidebar's footer opens Settings, and Ctrl+, toggles it, as in Codex", () => {
  const list = read("src/features/ChatThreadList.tsx");
  assert.match(list, /openSettings\?: \(\) => void;/);
  assert.match(list, /\{actions\.openSettings \? <div className="cx-threads-foot">/);
  assert.match(list, /aria-label="Open settings"[^>]*onClick=\{actions\.openSettings\}/);
  assert.match(list, /<ChatGlyph name="gear" size=\{16\} \/>/);

  const surface = read("src/features/AgentOrchestratorSurface.tsx");
  assert.match(surface, /openSettings: \(\) => setSettingsOpen\(true\)/);
  assert.match(surface, /event\.key === ","[\s\S]{0,80}setSettingsOpen\(\(open\) => !open\)/);
  assert.match(surface, /\{settingsOpen && !pane \? <ChatSettingsPage onClose=\{\(\) => setSettingsOpen\(false\)\} \/> : null\}/);
});

test("the gear and the back arrow are Codex's own icons", () => {
  const menu = read("src/features/ChatMenu.tsx");
  assert.match(menu, /"gear": <><path fillRule="evenodd" clipRule="evenodd" d="M8\.00062 5\.27979/);
  assert.match(menu, /"back": <path d="M6\.96231 2\.96214/);
});

test("Settings changes go through main's checked IPC, within main's own limits", () => {
  const page = read("src/features/ChatSettingsPage.tsx");
  const choices = (name) => JSON.parse(page.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1]);
  for (const minutes of choices("IDLE_CHOICES")) {
    assert.ok(minutes >= UPDATE_SETTINGS.updateIdleMinutes.min && minutes <= UPDATE_SETTINGS.updateIdleMinutes.max, `idle ${minutes}`);
  }
  for (const minutes of choices("HEALTH_CHOICES")) {
    assert.ok(minutes >= UPDATE_SETTINGS.updateHealthMinutes.min && minutes <= UPDATE_SETTINGS.updateHealthMinutes.max, `health ${minutes}`);
  }
  for (const key of page.matchAll(/setUpdateSetting\("(\w+)"/g)) {
    assert.ok(Object.hasOwn(UPDATE_SETTINGS, key[1]), `${key[1]} is a known update setting`);
  }
  assert.equal(new Set([...page.matchAll(/setUpdateSetting\("(\w+)"/g)].map((match) => match[1])).size, Object.keys(UPDATE_SETTINGS).length,
    "every update setting has a control");

  assert.match(read("electron/preload.cjs"), /updateSettings: \(patch\) => ipcRenderer\.invoke\("launcher:update-settings", patch \?\? null\)/);
  const main = read("electron/main.cjs");
  assert.match(main, /handle\("launcher:update-settings", \(_event, patch\) => \{[\s\S]{0,200}validateUpdateSettingsPatch\(patch\)/);
});

test("Settings › Chat holds Claude Code's auto-compact and the chat's own switches, read from and saved by the bridge", () => {
  const page = read("src/features/ChatSettingsPage.tsx");
  assert.match(page, /\{ id: "chat", label: "Chat" \}/);
  for (const operation of ["chat_auto_compact", "chat_auto_retry", "chat_model_judges"]) {
    assert.ok(page.includes(`chatCall("${operation}")`), `${operation} is read`);
    assert.ok(page.includes(`setChatPreference("${operation}"`), `${operation} is set`);
  }
  // The shares offered are the ones the bridge takes (chatAutoCompact: 20 to 100).
  for (const percent of JSON.parse(page.match(/const COMPACT_CHOICES = (\[[^\]]*\]);/)[1])) assert.ok(percent >= 20 && percent <= 100, `${percent}%`);
  // Reading them is passive (no focus needed), as the other chat switches; changing them is not.
  assert.match(read("electron/main.cjs"), /\["chat_auto_retry", "chat_model_judges", "chat_auto_compact"\]\.includes\(input\.operation\) && input\.arguments\?\.enabled === undefined && input\.arguments\?\.percent === undefined/);
});
