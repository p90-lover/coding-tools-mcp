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
  assert.match(surface, /\{settingsOpen && !pane \? <ChatSettingsPage onClose=\{\(\) => setSettingsOpen\(false\)\} onArchiveChanged=\{\(\) => void loadArchived\(\)\} workspaceId=\{workspaceId\} \/> : null\}/);
});

test("Settings › Instructions edits the global and the open project's AGENTS.md through main", () => {
  const page = read("src/features/ChatSettingsPage.tsx");
  assert.match(page, /\{ id: "instructions", label: "Instructions" \}/);
  assert.match(page, /<InstructionsSection workspaceId=\{workspaceId\} onError=\{setError\} \/>/);
  // Read and saved by the bridge's agent_instructions, never by the page itself.
  assert.match(page, /chatCall\("agent_instructions", project \? \{ workspaceId: project \} : \{\}\)/);
  assert.match(page, /chatCall\("agent_instructions", \{ scope, text: scope === "global" \? global : workspace/);
  assert.match(page, /<InstructionEditor label="Global AGENTS\.md"/);
  assert.match(page, /<InstructionEditor label="Workspace AGENTS\.md"/);
  // Switching project never drops unsaved text silently.
  assert.match(page, /window\.confirm\("Discard the unsaved changes to this project's AGENTS\.md\?"\)/);
  const handler = read("../app-handler/agent-orchestrator/handler.cjs");
  assert.match(handler, /agent_instructions: \{ readOnly: false,/);
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
  for (const operation of ["chat_auto_compact", "chat_auto_retry", "chat_model_judges", "chat_question_timeout"]) {
    assert.ok(page.includes(`chatCall("${operation}")`), `${operation} is read`);
    assert.ok(page.includes(`setChatPreference("${operation}"`), `${operation} is set`);
  }
  // The shares offered are the ones the bridge takes (chatAutoCompact: 20 to 100).
  for (const percent of JSON.parse(page.match(/const COMPACT_CHOICES = (\[[^\]]*\]);/)[1])) assert.ok(percent >= 20 && percent <= 100, `${percent}%`);
  // Reading them is passive (no focus needed), as the other chat switches; changing them is not.
  assert.match(read("electron/main.cjs"), /\["chat_auto_retry", "chat_model_judges", "chat_auto_compact", "chat_question_timeout"\]\.includes\(input\.operation\) && input\.arguments\?\.enabled === undefined && input\.arguments\?\.percent === undefined && input\.arguments\?\.seconds === undefined/);
});

test("Settings › Chat › Agent questions: wait for the answer (the agent pauses) or answer for me after N seconds, 30 by default", () => {
  const page = read("src/features/ChatSettingsPage.tsx");
  assert.match(page, /const QUESTION_TIMEOUT_DEFAULT = 30;/);
  assert.match(page, /<option value="wait">Wait for my answer<\/option>/);
  assert.match(page, /<option value="timeout">Answer for me after<\/option>/);
  assert.match(page, /seconds: event\.target\.value === "wait" \? 0 : QUESTION_TIMEOUT_DEFAULT/);
  // The question's card counts down to that answer, and says nothing when it waits for the person.
  const card = read("src/features/AgentOrchestratorApproval.tsx");
  assert.match(card, /<QuestionCountdown at=\{approval\.auto_answer_at\} \/>/);
  assert.match(card, /Answers itself in \$\{seconds\}s/);
});

test("Settings › Chat's mission switch is kept on this computer, on by default, and every open chat follows it at once", () => {
  const page = read("src/features/ChatSettingsPage.tsx");
  assert.match(page, /<Row label="Keep work expanded on a mission" description="[^"]+">\s*<Toggle label="Keep work expanded on a mission" checked=\{missionWork\} onChange=\{\(next\) => setMissionWork\(saveMissionWork\(next\)\)\} \/>/);
  assert.match(page, /useEffect\(\(\) => onMissionWork\(setMissionWork\), \[\]\)/, "the page follows a change made in another window");
  assert.match(read("src/features/AgentOrchestratorChat.tsx"), /useEffect\(\(\) => onMissionWork\(setMissionWork\), \[\]\)/, "so does every chat");

  const ts = require("typescript");
  const vm = require("node:vm");
  const stored = new Map();
  const listeners = new Map();
  const window = {
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener)),
    dispatchEvent: (event) => { for (const listener of listeners.get(event.type) ?? []) listener(event); },
  };
  const settings = {};
  vm.runInNewContext(ts.transpileModule(read("src/features/chat-view-settings.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: settings, window, Event: class { constructor(type) { this.type = type; } },
      localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } });
  assert.equal(settings.readMissionWork(), true, "on until turned off");
  const seen = [];
  const stop = settings.onMissionWork((on) => seen.push(on));
  assert.equal(settings.saveMissionWork(false), false);
  assert.equal(stored.get(settings.MISSION_WORK_KEY), "off");
  assert.equal(settings.readMissionWork(), false);
  // Another window turned it back on.
  stored.set(settings.MISSION_WORK_KEY, "on");
  window.dispatchEvent({ type: "storage", key: settings.MISSION_WORK_KEY });
  assert.deepEqual(seen, [false, true]);
  stop();
  settings.saveMissionWork(false);
  assert.deepEqual(seen, [false, true], "an unsubscribed chat hears nothing more");
});
