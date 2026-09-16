const { contextBridge, ipcRenderer } = require("electron");

function subscription(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("codexWebLauncher", {
  snapshot: () => ipcRenderer.invoke("launcher:snapshot"),
  setLanguage: (language) => ipcRenderer.invoke("launcher:set-language", language),
  openSocial: (target) => ipcRenderer.invoke("launcher:open-social", target),
  completeOnboarding: (language, browserInteractionMode) => ipcRenderer.invoke(
    "launcher:complete-onboarding",
    language,
    browserInteractionMode,
  ),
  openExternal: (url) => ipcRenderer.invoke("launcher:open-external", url),
  setBrowserBounds: (bounds) => ipcRenderer.invoke("launcher:browser-bounds", bounds),
  setBrowserSurfaceActive: (active) => ipcRenderer.invoke("launcher:browser-surface-active", active),
  showBrowser: () => ipcRenderer.invoke("launcher:browser-show"),
  hideBrowser: () => ipcRenderer.invoke("launcher:browser-hide"),
  navigateBrowser: (action) => ipcRenderer.invoke("launcher:browser-navigate", action),
  zoomBrowser: (action) => ipcRenderer.invoke("launcher:browser-zoom", action),
  selectBrowserTab: (tabId) => ipcRenderer.invoke("launcher:browser-tab-select", tabId),
  closeBrowserTab: (tabId) => ipcRenderer.invoke("launcher:browser-tab-close", tabId),
  copyManualPrompt: (tabId) => ipcRenderer.invoke("launcher:manual-prompt-copy", tabId),
  confirmManualSent: (tabId) => ipcRenderer.invoke("launcher:manual-prompt-sent", tabId),
  openLogin: () => ipcRenderer.invoke("launcher:browser-login"),
  openPasskeyLogin: () => ipcRenderer.invoke("launcher:browser-passkey-login"),
  continuePasskeyLogin: () => ipcRenderer.invoke("launcher:browser-passkey-login-continue"),
  logoutChatGpt: () => ipcRenderer.invoke("launcher:browser-logout"),
  dismissSessionReminder: () => ipcRenderer.invoke("launcher:session-reminder-dismiss"),
  smokeTest: () => ipcRenderer.invoke("launcher:browser-smoke"),
  verifyMcp: () => ipcRenderer.invoke("launcher:mcp-verify"),
  doctor: () => ipcRenderer.invoke("launcher:doctor"),
  cancelTurns: () => ipcRenderer.invoke("launcher:cancel-turns"),
  uninstallIntegration: () => ipcRenderer.invoke("launcher:uninstall-integration"),
  setupCore: () => ipcRenderer.invoke("launcher:setup-core"),
  setupMcp: (input) => ipcRenderer.invoke("launcher:setup-mcp", input),
  setMcpStep: (step) => ipcRenderer.invoke("launcher:set-mcp-step", step),
  setAutostart: (enabled) => ipcRenderer.invoke("launcher:autostart", enabled),
  setBiggerContext: (enabled) => ipcRenderer.invoke("launcher:bigger-context", enabled),
  setZeroRiskPro: (enabled) => ipcRenderer.invoke("launcher:zero-risk-pro", enabled),
  setBrowserInteractionMode: (mode) => ipcRenderer.invoke("launcher:browser-interaction-mode", mode),
  setPreference: (key, value) => ipcRenderer.invoke("launcher:set-preference", key, value),
  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),
  providerSnapshot: () => ipcRenderer.invoke("launcher:provider-snapshot"),
  saveProviderAccount: (input) => ipcRenderer.invoke("launcher:provider-account-save", input),
  setDefaultProviderAccount: (providerId, accountId) => ipcRenderer.invoke(
    "launcher:provider-account-default",
    providerId,
    accountId,
  ),
  setProviderAccountEnabled: (accountId, enabled) => ipcRenderer.invoke(
    "launcher:provider-account-enabled",
    accountId,
    enabled,
  ),
  archiveProviderAccount: (accountId) => ipcRenderer.invoke(
    "launcher:provider-account-archive",
    accountId,
  ),
  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),
  saveProxyProfile: (input) => ipcRenderer.invoke("launcher:proxy-profile-save", input),
  archiveProxyProfile: (profileId) => ipcRenderer.invoke("launcher:proxy-profile-archive", profileId),
  testProxyProfile: (profileId) => ipcRenderer.invoke("launcher:proxy-profile-test", profileId),
  setGlobalProxyRouting: (input) => ipcRenderer.invoke("launcher:proxy-global-routing", input),
  setProviderProxyPolicy: (input) => ipcRenderer.invoke("launcher:proxy-provider-policy", input),
  setAccountProxyPolicy: (input) => ipcRenderer.invoke("launcher:proxy-account-policy", input),
  logs: (limit) => ipcRenderer.invoke("launcher:logs", limit),
  exportLogs: () => ipcRenderer.invoke("launcher:export-logs"),
  installUpdate: () => ipcRenderer.invoke("launcher:update-install"),
  windowState: () => ipcRenderer.invoke("launcher:window-state"),
  windowControl: (action) => ipcRenderer.send("launcher:window-control", action),
  onWindowStateChanged: (listener) => subscription("launcher:window-state-changed", listener),
  onStateChanged: (listener) => subscription("launcher:state-changed", listener),
  onBrowserState: (listener) => subscription("launcher:browser-state", listener),
  onOperation: (listener) => subscription("launcher:operation", listener),
  onLog: (listener) => subscription("launcher:log", listener),
  onUpdateState: (listener) => subscription("launcher:update-state", listener),
  onProviderNetworkChanged: (listener) => subscription("launcher:provider-network-changed", listener),
});

const { invokeContract } = require("./ipc-schema.cjs");

const codingToolsApi = Object.freeze({
  runtime: Object.freeze({
    status: () => invokeContract(ipcRenderer, "runtime.status"),
  }),
  workspaces: Object.freeze({
    list: (input = {}) => invokeContract(ipcRenderer, "workspaces.list", input),
  }),
  permissions: Object.freeze({
    snapshot: (input) => invokeContract(ipcRenderer, "permissions.snapshot", input),
  }),
  computer: Object.freeze({
    status: () => invokeContract(ipcRenderer, "computer.status"),
  }),
  tasks: Object.freeze({
    list: (input = {}) => invokeContract(ipcRenderer, "tasks.list", input),
  }),
  history: Object.freeze({
    search: (input) => invokeContract(ipcRenderer, "history.search", input),
  }),
  nativeCodex: Object.freeze({
    status: () => invokeContract(ipcRenderer, "nativeCodex.status"),
  }),
  integrations: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "integrations.snapshot"),
  }),
  updates: Object.freeze({
    status: () => invokeContract(ipcRenderer, "updates.status"),
  }),
  diagnostics: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "diagnostics.snapshot"),
  }),
});

contextBridge.exposeInMainWorld("codingTools", codingToolsApi);
