const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
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
  zeroRiskProEnabled: false,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  sessionRefreshReminderAt: null,
});

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
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
    // An agent's tool request answered in the chat is confirmed again in a dialog unless this is
    // false (the dialog's "Don't ask again"); absent means it asks.
    if (Object.hasOwn(state, "confirmAgentToolRequests") && state.confirmAgentToolRequests !== false) delete state.confirmAgentToolRequests;
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
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
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
  let state = readState(filePath);
  return {
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const next = { ...state, ...patch, version: 1 };
      writeState(filePath, next);
      state = next;
      return structuredClone(next);
    },
  };
}

module.exports = {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
};
