const { readStateFile, writeStateFile } = require("./durable-state.cjs");
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;

const DEFAULT_STATE = Object.freeze({
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
  // ChatGPT refuses connectors in Temporary Chat, so task chats are saved unless turned off.
  useSavedChats: true,
  zeroRiskProEnabled: false,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  sessionRefreshReminderAt: null,
});

// Settings → Updates. Stored only once changed: absent means the default here, so state written
// before these existed reads the same. Numbers are whole minutes within [min, max].
const UPDATE_SETTINGS = Object.freeze({
  // An automatic update waits until no chat, browser turn or bridge work is running.
  updateWaitForChats: Object.freeze({ type: "boolean", default: true }),
  // ... and until nobody has used the keyboard or mouse for this long.
  updateIdleMinutes: Object.freeze({ type: "minutes", default: 10, min: 0, max: 120 }),
  // A new version that is not healthy within the health window goes back to the previous one.
  updateAutoRollback: Object.freeze({ type: "boolean", default: true }),
  updateHealthMinutes: Object.freeze({ type: "minutes", default: 10, min: 2, max: 60 }),
  // A background service left running by the previous version (the MCP tunnel) is reused only when
  // it runs the same program this version ships; otherwise it is restarted.
  updateReuseMatchingOnly: Object.freeze({ type: "boolean", default: true }),
});

function validUpdateSetting(key, value) {
  const spec = UPDATE_SETTINGS[key];
  if (!spec) return false;
  if (spec.type === "boolean") return typeof value === "boolean";
  return Number.isInteger(value) && value >= spec.min && value <= spec.max;
}

/** Every update setting's effective value. */
function resolveUpdateSettings(state) {
  return Object.fromEntries(Object.entries(UPDATE_SETTINGS).map(([key, spec]) => [
    key, validUpdateSetting(key, state?.[key]) ? state[key] : spec.default,
  ]));
}

/** A Settings change, checked: throws on an unknown key or a value out of range. */
function validateUpdateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Update settings must be an object");
  const entries = Object.entries(patch);
  if (!entries.length) throw new Error("No update setting was given");
  for (const [key, value] of entries) {
    const spec = UPDATE_SETTINGS[key];
    if (!spec) throw new Error(`Unknown update setting: ${key}`);
    if (!validUpdateSetting(key, value)) {
      throw new Error(spec.type === "boolean"
        ? `${key} must be true or false`
        : `${key} must be a whole number of minutes from ${spec.min} to ${spec.max}`);
    }
  }
  return Object.fromEntries(entries);
}

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

/**
 * The saved settings, from the file or, when it is torn, its last good copy (durable-state.cjs). A
 * torn file used to read as a first start: onboarding came back and every setting was reset.
 * Returns `{ state, recovery }`; `recovery` is null when the file read cleanly or did not exist.
 */
function readState(filePath) {
  const read = readStateFile(filePath, (text) => JSON.parse(text));
  const state = read.value === undefined ? { ...DEFAULT_STATE } : normalizeState(read.value);
  const recovery = read.source === "backup" || read.source === "unreadable"
    ? { source: read.source, setAside: read.setAside, message: read.error instanceof Error ? read.error.message : String(read.error ?? "missing") }
    : null;
  return { state, recovery };
}

function normalizeState(parsed) {
  try {
    if (!parsed || parsed.version !== 1) return { ...DEFAULT_STATE };
    const state = { ...DEFAULT_STATE, ...parsed };
    delete state.bridgeEnabled;
    if (state.language !== null && state.language !== "en" && state.language !== "zh-CN" && state.language !== "zh-TW" && state.language !== "ja") {
      state.language = DEFAULT_STATE.language;
    }
    for (const key of [
      "onboardingComplete",
      "githubOpened",
      "xOpened",
      "autoStart",
      "autoConnectExistingMcp",
      "automaticUpdates",
      "keepRunningOnClose",
      "showBrowserDuringTurns",
      "experimentalBiggerContext",
      // Absent (state written before the setting existed) or invalid means on; an explicit
      // false is the user's own choice and is kept.
      "useSavedChats",
      "zeroRiskProEnabled",
      "browserSmokePassed",
      "sidebarOpen",
    ]) {
      if (typeof state[key] !== "boolean") state[key] = DEFAULT_STATE[key];
    }
    // Codex's model route goes through the bridge unless this is false ("Use Coding Tools in
    // Codex"); absent means on, as every install was before the switch existed.
    if (Object.hasOwn(state, "codexRoute") && typeof state.codexRoute !== "boolean") delete state.codexRoute;
    // AO chat agents get the app's own tools unless this is false; absent means on.
    if (Object.hasOwn(state, "chatAgentTools") && typeof state.chatAgentTools !== "boolean") delete state.chatAgentTools;
    // Their screen capture and computer control only when this is true; absent means off.
    if (Object.hasOwn(state, "chatAgentDesktopTools") && state.chatAgentDesktopTools !== true) delete state.chatAgentDesktopTools;
    // Their commands through the app's terminal: false is off; absent is on when Codex's sandbox runs
    // them, otherwise off; true is on (unsandboxed, each command asked, when there is no sandbox).
    if (Object.hasOwn(state, "chatAgentTerminalTools") && typeof state.chatAgentTerminalTools !== "boolean") delete state.chatAgentTerminalTools;
    // Their own preview browser unless this is false; absent means on.
    if (Object.hasOwn(state, "chatAgentPreviewTools") && typeof state.chatAgentPreviewTools !== "boolean") delete state.chatAgentPreviewTools;
    // They hide secrets in the user's messages only when this is true; absent means off. The list
    // of what to hide is the user's lines; absent means the defaults (chat-redaction.cjs).
    if (Object.hasOwn(state, "chatAgentRedactSecrets") && state.chatAgentRedactSecrets !== true) delete state.chatAgentRedactSecrets;
    if (Object.hasOwn(state, "chatAgentRedactList")
      && !(Array.isArray(state.chatAgentRedactList) && state.chatAgentRedactList.every((line) => typeof line === "string"))) {
      delete state.chatAgentRedactList;
    }
    // An agent's tool request answered in the chat is confirmed again in a dialog unless this is
    // false (the dialog's "Don't ask again"); absent means it asks.
    if (Object.hasOwn(state, "confirmAgentToolRequests") && state.confirmAgentToolRequests !== false) delete state.confirmAgentToolRequests;
    for (const key of Object.keys(UPDATE_SETTINGS)) {
      if (Object.hasOwn(state, key) && !validUpdateSetting(key, state[key])) delete state[key];
    }
    if (state.browserInteractionMode !== "automatic" && state.browserInteractionMode !== "manual") {
      state.browserInteractionMode = DEFAULT_STATE.browserInteractionMode;
    }
    if (state.coreSetupComplete !== true) {
      if (state.onboardingComplete !== true) state.browserInteractionMode = "automatic";
      state.zeroRiskProEnabled = false;
    }
    if (state.browserSmokeVersion !== null
      && (typeof state.browserSmokeVersion !== "string" || state.browserSmokeVersion.length > 128)) {
      state.browserSmokeVersion = DEFAULT_STATE.browserSmokeVersion;
    }
    if (!Number.isFinite(state.sidebarWidth)
      || state.sidebarWidth < SIDEBAR_MIN_WIDTH
      || state.sidebarWidth > SIDEBAR_MAX_WIDTH) {
      state.sidebarWidth = DEFAULT_STATE.sidebarWidth;
    }
    if (!Number.isInteger(state.mcpGuideStep) || state.mcpGuideStep < 0 || state.mcpGuideStep > 2) {
      state.mcpGuideStep = DEFAULT_STATE.mcpGuideStep;
    }
    if (state.sessionRefreshReminderAt !== null
      && (typeof state.sessionRefreshReminderAt !== "string"
        || !Number.isFinite(Date.parse(state.sessionRefreshReminderAt)))) {
      state.sessionRefreshReminderAt = DEFAULT_STATE.sessionRefreshReminderAt;
    }
    for (const key of [
      "coreSetupComplete",
      "codexCatalogVerified",
      "mcpSetupComplete",
      "mcpRuntimeInstalled",
      "codexRestartRequired",
    ]) {
      if (state[key] !== undefined && typeof state[key] !== "boolean") delete state[key];
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(filePath, state) {
  writeStateFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new Error("Sidebar state is invalid");
  }
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error(`Sidebar width must be between ${SIDEBAR_MIN_WIDTH} and ${SIDEBAR_MAX_WIDTH}`);
  }
  return { sidebarOpen: value.open, sidebarWidth: Math.round(value.width) };
}

function createStateStore(filePath) {
  const loaded = readState(filePath);
  let state = loaded.state;
  // What this store last wrote. A patch that changes nothing is not written again: each write is an
  // fsync'd atomic write plus its .bak on the main thread, up to 2.4 s on the busy hard disk, and
  // callers often set what is already set (codexRestartRequired: false on each catalog failure).
  // The session's first update always writes, so settings recovered from a torn file reach the disk.
  let written = null;
  return {
    /** How the settings were recovered from a torn file at startup, for the log; null if they were not. */
    recovery: loaded.recovery,
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const next = { ...state, ...patch, version: 1 };
      const text = JSON.stringify(next);
      if (text !== written) {
        writeState(filePath, next);
        written = text;
      }
      state = next;
      return structuredClone(next);
    },
  };
}

module.exports = {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  UPDATE_SETTINGS,
  createStateStore,
  nextSessionRefreshReminderAt,
  resolveUpdateSettings,
  validateSidebarState,
  validateUpdateSettingsPatch,
};
