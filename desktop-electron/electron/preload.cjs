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
  setManagedAppTab: (tab) => ipcRenderer.invoke("launcher:managed-app-tab", tab),
  externalServicesSnapshot: () => ipcRenderer.invoke("launcher:external-services-snapshot"),
  managedComponentsSnapshot: () => ipcRenderer.invoke("launcher:managed-components-snapshot"),
  installManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-install", serviceId),
  repairManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-repair", serviceId),
  setManagedComponentCredential: (serviceId, key, value) => ipcRenderer.invoke(
    "launcher:managed-component-credential",
    serviceId,
    key,
    value,
  ),
  configureExternalService: (serviceId, input) => ipcRenderer.invoke(
    "launcher:external-service-configure",
    serviceId,
    input,
  ),
  inspectExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-inspect", serviceId),
  startExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-start", serviceId),
  stopExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-stop", serviceId),
  restartExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-restart", serviceId),
  syncCodexRouter: () => ipcRenderer.invoke("launcher:codex-router-sync"),
  upstreamToolsSnapshot: () => ipcRenderer.invoke("launcher:upstream-tools-snapshot"),
  inspectUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-inspect", toolId),
  setUpstreamToolEndpoint: (toolId, endpoint) => ipcRenderer.invoke(
    "launcher:upstream-tool-endpoint",
    toolId,
    endpoint,
  ),
  startUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-start", toolId),
  stopUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-stop", toolId),
  restartUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-restart", toolId),
  openEmbeddedTool: (toolId, section) => ipcRenderer.invoke(
    "launcher:upstream-tool-open-embedded",
    toolId,
    section,
  ),
  openUpstreamToolExternal: (toolId, section) => ipcRenderer.invoke(
    "launcher:upstream-tool-open-external",
    toolId,
    section,
  ),
  providerSnapshot: () => ipcRenderer.invoke("launcher:provider-snapshot"),
  providerExecutionPlan: (input) => ipcRenderer.invoke("launcher:provider-execution-plan", input),
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
  beginProviderLogin: (accountId, adapterId) => ipcRenderer.invoke("launcher:provider-login", accountId, adapterId),
  importProviderSession: (accountId) => ipcRenderer.invoke("launcher:provider-session-import", accountId),
  probeProviderAccount: (accountId) => ipcRenderer.invoke("launcher:provider-account-probe", accountId),
  saveProxyProfile: (input) => ipcRenderer.invoke("launcher:proxy-profile-save", input),
  archiveProxyProfile: (profileId) => ipcRenderer.invoke("launcher:proxy-profile-archive", profileId),
  testProxyProfile: (profileId) => ipcRenderer.invoke("launcher:proxy-profile-test", profileId),
  setGlobalProxyRouting: (input) => ipcRenderer.invoke("launcher:proxy-global-routing", input),
  setProviderProxyPolicy: (input) => ipcRenderer.invoke("launcher:proxy-provider-policy", input),
  setAccountProxyPolicy: (input) => ipcRenderer.invoke("launcher:proxy-account-policy", input),
  logs: (limit) => ipcRenderer.invoke("launcher:logs", limit),
  exportLogs: () => ipcRenderer.invoke("launcher:export-logs"),
  checkForUpdates: () => ipcRenderer.invoke("launcher:update-check"),
  setAutomaticUpdates: (enabled) => ipcRenderer.invoke("launcher:update-automatic", enabled),
  installUpdate: () => ipcRenderer.invoke("launcher:update-install"),
  windowState: () => ipcRenderer.invoke("launcher:window-state"),
  windowControl: (action) => ipcRenderer.send("launcher:window-control", action),
  onWindowStateChanged: (listener) => subscription("launcher:window-state-changed", listener),
  onStateChanged: (listener) => subscription("launcher:state-changed", listener),
  onBrowserState: (listener) => subscription("launcher:browser-state", listener),
  onOperation: (listener) => subscription("launcher:operation", listener),
  onLog: (listener) => subscription("launcher:log", listener),
  onUpdateState: (listener) => subscription("launcher:update-state", listener),
  onExternalServicesChanged: (listener) => subscription("launcher:external-services-changed", listener),
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
  apps: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "apps.snapshot"),
    invoke: (input) => invokeContract(ipcRenderer, "apps.invoke", input),
  }),
  execution: Object.freeze({
    read: (input) => invokeContract(ipcRenderer, "execution.read", input),
    provider: (input) => invokeContract(ipcRenderer, "execution.provider", input),
    update: (input) => invokeContract(ipcRenderer, "execution.update", input),
  }),
  updates: Object.freeze({
    status: () => invokeContract(ipcRenderer, "updates.status"),
  }),
  diagnostics: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "diagnostics.snapshot"),
  }),
  tools: Object.freeze({
    catalog: (input) => invokeContract(ipcRenderer, "tools.catalog", input),
    call: (input) => invokeContract(ipcRenderer, "tools.call", input),
  }),
});

contextBridge.exposeInMainWorld("codingTools", codingToolsApi);
