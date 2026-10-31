require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  UPDATE_SETTINGS,
  createStateStore,
  nextSessionRefreshReminderAt,
  resolveUpdateSettings,
  validateSidebarState,
  validateUpdateSettingsPatch,
} = require("../electron/state.cjs");

test("launcher state persists onboarding, language, and autostart atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), {
      version: 1,
      language: null,
      onboardingComplete: false,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      autoConnectExistingMcp: false,
      automaticUpdates: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      useSavedChats: true,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
    store.update({
      language: "zh-CN",
      onboardingComplete: true,
      keepRunningOnClose: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
    });
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: true,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      autoConnectExistingMcp: false,
      automaticUpdates: true,
      keepRunningOnClose: false,
      showBrowserDuringTurns: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      useSavedChats: true,
      zeroRiskProEnabled: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});

test("Japanese is preserved as a supported persisted launcher language", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-ja-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, language: "ja" }));
    assert.equal(createStateStore(file).read().language, "ja");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persisted sidebar corruption is repaired without changing the rest of launcher state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-sidebar-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "zh-CN",
      onboardingComplete: "yes",
      autoStart: "yes",
      bridgeEnabled: false,
      browserSmokePassed: "yes",
      browserSmokeVersion: { invalid: true },
      sidebarOpen: "yes",
      sidebarWidth: 900,
      mcpGuideStep: 99,
      sessionRefreshReminderAt: "not-a-date",
      coreSetupComplete: "yes",
    }));
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: false,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      autoConnectExistingMcp: false,
      automaticUpdates: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      useSavedChats: true,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("existing MCP auto-connect is opt-in and persists only booleans", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-auto-mcp-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().autoConnectExistingMcp, false);
    store.update({ autoConnectExistingMcp: true });
    assert.equal(createStateStore(file).read().autoConnectExistingMcp, true);
    fs.writeFileSync(file, JSON.stringify({ version: 1, autoConnectExistingMcp: "yes" }));
    assert.equal(createStateStore(file).read().autoConnectExistingMcp, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser interaction defaults to Automatic and preserves a completed onboarding choice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-interaction-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().browserInteractionMode, "automatic");
    store.update({ browserInteractionMode: "manual", onboardingComplete: true });
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    store.update({ coreSetupComplete: true, zeroRiskProEnabled: true });
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, true);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      browserInteractionMode: "manual",
      zeroRiskProEnabled: true,
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      onboardingComplete: true,
      browserInteractionMode: "manual",
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    fs.writeFileSync(file, JSON.stringify({ version: 1, browserInteractionMode: "unsafe" }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saved chats default on for new and older state and keep an explicit opt-out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-saved-chat-state-"));
  const file = path.join(root, "state.json");
  try {
    assert.equal(createStateStore(file).read().useSavedChats, true);
    // State written before the setting existed migrates to saved chats.
    fs.writeFileSync(file, JSON.stringify({ version: 1, onboardingComplete: true }));
    const store = createStateStore(file);
    assert.equal(store.read().useSavedChats, true);
    store.update({ useSavedChats: false });
    assert.equal(createStateStore(file).read().useSavedChats, false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, useSavedChats: "no" }));
    assert.equal(createStateStore(file).read().useSavedChats, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update settings default safe, keep valid choices, and drop invalid stored values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-update-settings-"));
  const file = path.join(root, "state.json");
  try {
    const defaults = {
      updateWaitForChats: true, updateIdleMinutes: 10, updateAutoRollback: true, updateHealthMinutes: 10, updateReuseMatchingOnly: true,
    };
    // Absent (older state) reads as the defaults, and nothing is written for them.
    assert.deepEqual(resolveUpdateSettings(createStateStore(file).read()), defaults);
    assert.equal(Object.hasOwn(createStateStore(file).read(), "updateIdleMinutes"), false);
    const store = createStateStore(file);
    store.update(validateUpdateSettingsPatch({ updateIdleMinutes: 0, updateAutoRollback: false }));
    assert.deepEqual(resolveUpdateSettings(createStateStore(file).read()),
      { ...defaults, updateIdleMinutes: 0, updateAutoRollback: false });
    // A hand-edited or torn value is dropped back to its default, not trusted.
    fs.writeFileSync(file, JSON.stringify({ version: 1, updateHealthMinutes: 1, updateWaitForChats: "yes", updateIdleMinutes: 5 }));
    const repaired = createStateStore(file).read();
    assert.equal(Object.hasOwn(repaired, "updateHealthMinutes"), false);
    assert.deepEqual(resolveUpdateSettings(repaired), { ...defaults, updateIdleMinutes: 5 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Settings change to update settings is checked key by key", () => {
  assert.deepEqual(validateUpdateSettingsPatch({ updateHealthMinutes: 60 }), { updateHealthMinutes: 60 });
  assert.throws(() => validateUpdateSettingsPatch({ updateHealthMinutes: 61 }), /from 2 to 60/);
  assert.throws(() => validateUpdateSettingsPatch({ updateIdleMinutes: 2.5 }), /whole number/);
  assert.throws(() => validateUpdateSettingsPatch({ updateWaitForChats: 1 }), /true or false/);
  assert.throws(() => validateUpdateSettingsPatch({ automaticUpdates: false }), /Unknown update setting/);
  assert.throws(() => validateUpdateSettingsPatch({}), /No update setting/);
  assert.throws(() => validateUpdateSettingsPatch(null), /must be an object/);
  assert.equal(UPDATE_SETTINGS.updateIdleMinutes.max, 120);
});

test("session refresh reminders are deferred by exactly 48 hours", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  assert.equal(SESSION_REFRESH_REMINDER_INTERVAL_MS, 48 * 60 * 60 * 1000);
  assert.equal(nextSessionRefreshReminderAt(now), "2026-08-07T12:00:00.000Z");
  assert.throws(() => nextSessionRefreshReminderAt(Number.NaN), /must be finite/);
});

test("an update that changes nothing is not written again; the first one always is", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-launcher-state-"));
  try {
    const file = path.join(root, "launcher-state.json");
    const store = createStateStore(file);
    store.update({ codexRestartRequired: false });
    assert.equal(fs.existsSync(file), true, "the session's first update writes");
    fs.rmSync(file);
    assert.equal(store.update({ codexRestartRequired: false }).codexRestartRequired, false);
    assert.equal(fs.existsSync(file), false, "nothing changed, nothing written");
    store.update({ codexRestartRequired: true });
    assert.equal(createStateStore(file).read().codexRestartRequired, true, "a change is written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
