export type Language = "en" | "zh-CN" | "zh-TW" | "ja";
export type LauncherProfile = "production" | "development";
export type BrowserInteractionMode = "automatic" | "manual";
export type Surface = "browser" | "setup" | "mcp" | "providers" | "integrations" | "cpa" | "codex-router" | "paseo" | "anneal" | "network" | "activity" | "settings";

export type ProviderAuth = "oauth" | "api_key" | "browser_session" | "local_proxy";
export type ProviderAccountStatus = "pending" | "connected" | "expired" | "error" | "disabled";
export type ProviderCredentialSource = "native_browser" | "cpa" | "commandcode" | "api_key" | "local_proxy";
export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";
export type ProxyScope =
  | "all"
  | "browser"
  | "provider"
  | "oauth"
  | "subagent"
  | "paseo"
  | "anneal"
  | "mcp"
  | "websocket"
  | "http"
  | "update";
export type ProxyPolicyMode = "inherit" | "global" | "direct" | "profile";

export interface ProviderAccountRecord {
  id: string;
  providerId: string;
  label: string;
  identity?: string;
  endpoint?: string;
  auth: ProviderAuth;
  status: ProviderAccountStatus;
  enabled: boolean;
  isDefault: boolean;
  hasCredential: boolean;
  models: string[];
  loginAdapterId?: string;
  credentialSource?: ProviderCredentialSource;
  proxyProfileId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  archivedAt?: string;
  error?: string;
}

export interface ProviderAccountInput {
  id?: string;
  providerId: string;
  label: string;
  identity?: string;
  endpoint?: string;
  auth: ProviderAuth;
  status?: ProviderAccountStatus;
  enabled?: boolean;
  isDefault?: boolean;
  models?: string[];
  loginAdapterId?: string;
  credentialSource?: ProviderCredentialSource;
  proxyProfileId?: string;
  secret?: Record<string, string>;
  error?: string;
}

export interface ProxyEndpointRecord {
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

export interface ProxyProfileRecord {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: ProxyEndpointRecord;
  scopes: ProxyScope[];
  bypass: string[];
  hasAuthentication: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  latencyMs?: number;
  lastError?: string;
  archivedAt?: string;
}

export interface ProxyProfileInput {
  id?: string;
  name: string;
  enabled?: boolean;
  endpoint: ProxyEndpointRecord;
  scopes?: ProxyScope[];
  bypass?: string[];
  username?: string;
  password?: string;
}

export interface ProviderProxyPolicyRecord {
  providerId: string;
  inheritGlobal: boolean;
  profileId?: string;
}

export interface AccountProxyPolicyRecord {
  accountId: string;
  providerId: string;
  inheritProvider: boolean;
  inheritGlobal: boolean;
  profileId?: string;
}

export interface ProviderNetworkSnapshot {
  version: 1;
  accounts: ProviderAccountRecord[];
  proxyProfiles: ProxyProfileRecord[];
  routing: {
    globalEnabled: boolean;
    globalProfileId: string | null;
    providers: ProviderProxyPolicyRecord[];
    accounts: AccountProxyPolicyRecord[];
  };
}

export type ProviderExecutionWorkload = "subagent" | "paseo" | "anneal";
export type ProviderExecutionProtocol =
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_native";

export interface ProviderExecutionPlanInput {
  workload: ProviderExecutionWorkload;
  providerId?: string;
  accountId?: string;
  model?: string;
  allowFallback?: boolean;
}

export interface ProviderExecutionProxyProfile {
  id: string;
  name: string;
  endpoint: ProxyEndpointRecord;
  scopes: ProxyScope[];
  bypass: string[];
}

export interface ProviderExecutionPlan {
  version: 1;
  workload: ProviderExecutionWorkload;
  provider: {
    id: string;
    name: string;
    protocol: ProviderExecutionProtocol;
  };
  account: {
    id: string;
    label: string;
    identity: string | null;
    auth: ProviderAuth;
  };
  model: string | null;
  proxy: {
    mode: "direct" | "profile";
    source: "account" | "provider" | "global" | "default";
    profile: ProviderExecutionProxyProfile | null;
  };
  fallbackUsed: boolean;
  credentialHandle: {
    providerId: string;
    accountId: string;
  };
}

export type ExternalServiceId = "codex-router" | "commandcode-proxy" | "cpa" | "paseo" | "anneal";
export type ExternalServiceStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";
export type ManagedComponentInstallState =
  | "not-installed"
  | "installing"
  | "installed"
  | "repair-required"
  | "external"
  | "error";

export interface ManagedComponentProcessSnapshot {
  id: string;
  pid: number | null;
  running: boolean;
}

export interface ManagedComponentInstallSnapshot {
  state: ManagedComponentInstallState;
  version: string;
  commit: string | null;
  strategy: "release-binary" | "git-source" | "bundled-source";
  home: string;
  installedAt: string | null;
  currentStep: string | null;
  error: string | null;
  platformMode: "native" | "wsl2" | string;
  processes: ManagedComponentProcessSnapshot[];
  missingCredentials: string[];
  bundledRuntime?: boolean;
}

export interface ManagedComponentsSnapshot {
  version: 1;
  components: Array<{
    id: ExternalServiceId;
    name: string;
    version: string;
    commit: string | null;
    strategy: "release-binary" | "git-source" | "bundled-source";
    installState: ManagedComponentInstallState;
    managedHome: string;
    installedAt: string | null;
    currentStep: string | null;
    error: string | null;
    platformMode: "native" | "wsl2" | string;
    processes: ManagedComponentProcessSnapshot[];
    secretConfigured: boolean;
  }>;
}

export type ManagedBootstrapStatus = "idle" | "running" | "ready" | "blocked" | "error";
export type ManagedBootstrapComponentStatus =
  | "pending"
  | "installing"
  | "repairing"
  | "starting"
  | "ready"
  | "blocked"
  | "error";

export interface ManagedBootstrapComponentSnapshot {
  id: ExternalServiceId;
  status: ManagedBootstrapComponentStatus;
  action: string | null;
  missingCredentials: string[];
  message: string | null;
}

export interface ManagedBootstrapSnapshot {
  status: ManagedBootstrapStatus;
  reason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  components: ManagedBootstrapComponentSnapshot[];
}

export interface CommandCodeProxyHealth {
  status?: string;
  proxy?: string;
  version?: string;
  endpoints?: Record<string, string>;
  user?: {
    id?: string;
    email?: string;
  };
  credits?: number;
  models?: string[];
}

export interface ExternalServiceSnapshot {
  id: ExternalServiceId;
  name: string;
  endpoint: string;
  executionEndpoint?: string;
  home: string;
  stateDir?: string;
  executable: string;
  arguments: string[];
  enabled: boolean;
  autoStart: boolean;
  keepAlive?: boolean;
  status: ExternalServiceStatus;
  pid: number | null;
  owned: boolean;
  startedAt: string | null;
  checkedAt: string | null;
  latencyMs: number | null;
  statusCode: number | null;
  modelCount: number | null;
  error: string | null;
  secretConfigured: boolean;
  sourceConfigured: boolean;
  routerCli?: string;
  curateCli?: string;
  webBaseUrl?: string;
  accountCount?: number;
  connectedAccountCount?: number;
  providerModelCount?: number;
  health?: CommandCodeProxyHealth;
  banner?: {
    version: string | null;
    listen: string;
    cursor_base_url: string;
    anthropic_base_url: string;
  } | null;
  alternateEndpoint?: string | null;
  stale?: boolean;
  reconnectAttempts?: number;
  managedInstall: ManagedComponentInstallSnapshot;
}

export interface ExternalServicesSnapshot {
  version: 1;
  services: ExternalServiceSnapshot[];
}

export interface ExternalServiceConfigurationInput {
  endpoint?: string;
  executionEndpoint?: string;
  home?: string;
  executable?: string;
  arguments?: string[];
  enabled?: boolean;
  autoStart?: boolean;
  keepAlive?: boolean;
  callerKey?: string;
  routerCli?: string;
  curateCli?: string;
  webBaseUrl?: string;
}

export interface CodexRouterSyncResult {
  ok: boolean;
  args: string[];
  stdout: string;
  stderr: string;
}

export interface CommandCodeProxyPlanResult {
  text: string;
  credentialPromptRequired: true;
  provider: {
    id: "commandcode-proxy";
    name: string;
    baseUrl: string;
    adapter: string;
    modelEndpoint: string;
  };
}

export interface CommandCodeProxyApplyResult {
  endpoint: string;
  credentialPromptRequired: true;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
  planText?: string;
}

export interface UpstreamToolActInput {
  toolId: UpstreamToolId;
  op: string;
  endpoint?: string;
  credential?: string;
  agentId?: string;
  taskId?: string;
  messageId?: string;
  text?: string;
  provider?: string;
  sessionId?: string;
  cwd?: string;
  requestId?: string;
  behavior?: "allow" | "deny";
}

export interface UpstreamToolActResult {
  ok: boolean;
  op: string;
  detail: string;
}

export type UpstreamToolId = "anneal" | "paseo";
export type OriginalUiId = "cpa" | "codex-router";
export type UpstreamToolStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";

export interface UpstreamToolSnapshot {
  id: UpstreamToolId;
  name: string;
  repository: string;
  commit: string;
  version: string | null;
  license: string;
  sections: string[];
  endpoint: string;
  status: UpstreamToolStatus;
  pid: number | null;
  startedAt: string | null;
  checkedAt: string | null;
  latencyMs: number | null;
  error: string | null;
  sourceConfigured: boolean;
  sourceAvailable: boolean;
}

export interface UpstreamToolsSnapshot {
  version: 1;
  tools: UpstreamToolSnapshot[];
}

export interface UpstreamToolOpenResult {
  tool: UpstreamToolSnapshot;
  section: string;
  url: string;
  embedded: boolean;
}

export interface OriginalUiLongRun {
  desiredRunning: boolean;
  reconnectGeneration: number;
  lastEvent: string | null;
  lastError: string | null;
  backoffMs: number;
  keptAliveAt: string | null;
}

export interface OriginalUiSnapshot {
  id: OriginalUiId;
  name: string;
  repository: string;
  commit: string;
  version: string | null;
  license: string;
  sections: string[];
  endpoint: string;
  status: UpstreamToolStatus;
  pid: number | null;
  error: string | null;
  sourceConfigured: boolean;
  installState: ManagedComponentInstallState;
  originalChrome: boolean;
  longRun?: OriginalUiLongRun;
}

export interface OriginalUiCatalog {
  version: 1;
  tools: OriginalUiSnapshot[];
}

export interface OriginalUiOpenResult {
  tool: OriginalUiSnapshot;
  section: string;
  url: string;
  embedded: boolean;
  originalWindow: boolean;
  pid?: number | null;
}

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  automaticUpdates: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  browserInteractionMode: BrowserInteractionMode;
  experimentalBiggerContext: boolean;
  zeroRiskProEnabled: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  mcpSetupComplete?: boolean;
  mcpRuntimeInstalled?: boolean;
  codexRestartRequired?: boolean;
  mcpGuideStep: number;
  sessionRefreshReminderAt: string | null;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  activeTabId: string;
  maxTabs: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
  interactionMode?: BrowserInteractionMode;
  manualState?: "awaiting-user" | "sent" | "running" | "completed" | "timed-out" | "cancelled" | "failed";
  manualDeadlineAt?: string;
  canCopyPrompt?: boolean;
  canConfirmSent?: boolean;
}

export interface LogRecord {
  at: string;
  level: "debug" | "info" | "warning" | "error";
  event: string;
  detail: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  profile: LauncherProfile;
  profilePaths: {
    coreHome: string;
    codexHome: string;
    userData: string;
  };
  state: LauncherState;
  browser: BrowserState | null;
  connectorName: string;
  connectorNames: Record<BrowserInteractionMode, string>;
  mcpCredentialsConfigured: boolean;
  logs: LogRecord[];
  urls: {
    github: string;
    x: string;
    connectors: string;
    tunnels: string;
    keys: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  operation: OperationState | null;
  upstreamTools: UpstreamToolsSnapshot;
  externalServices: ExternalServicesSnapshot;
  update: UpdateState;
}

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language, browserInteractionMode: BrowserInteractionMode): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  copyManualPrompt(tabId: string): Promise<BrowserState>;
  confirmManualSent(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  openPasskeyLogin(): Promise<BrowserState>;
  continuePasskeyLogin(): Promise<boolean>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  doctor(): Promise<DoctorReport>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setupMcp(input: {
    tunnelId?: string;
    runtimeKey?: string;
    replace?: boolean;
    interactionMode?: BrowserInteractionMode;
  }): Promise<{ ok: boolean; stdout: string }>;
  setMcpStep(step: number): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setBiggerContext(enabled: boolean): Promise<LauncherState>;
  setZeroRiskPro(enabled: boolean): Promise<LauncherState>;
  setBrowserInteractionMode(mode: BrowserInteractionMode): Promise<{
    state: LauncherState;
    credentialsRequired: boolean;
    targetMode: BrowserInteractionMode;
  }>;
  setPreference(
    key: "keepRunningOnClose" | "showBrowserDuringTurns",
    value: boolean,
  ): Promise<LauncherState>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  externalServicesSnapshot(): Promise<ExternalServicesSnapshot>;
  managedComponentsSnapshot(): Promise<ManagedComponentsSnapshot>;
  installManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  repairManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  setManagedComponentCredential(
    serviceId: ExternalServiceId,
    key: string,
    value: string,
  ): Promise<ExternalServiceSnapshot>;
  configureExternalService(serviceId: ExternalServiceId, input: ExternalServiceConfigurationInput): Promise<ExternalServiceSnapshot>;
  inspectExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  startExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  stopExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  restartExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  syncCodexRouter(): Promise<CodexRouterSyncResult>;
  commandCodeProxyPlan(input?: {
    baseUrl?: string;
    routerCli?: string;
    curateCli?: string;
  }): Promise<CommandCodeProxyPlanResult>;
  applyCommandCodeProxyPlan(input?: {
    baseUrl?: string;
    routerCli?: string;
    curateCli?: string;
  }): Promise<CommandCodeProxyApplyResult>;
  managedBootstrapSnapshot(): Promise<ManagedBootstrapSnapshot>;
  reconcileManagedBootstrap(input?: {
    reason?: string;
    componentIds?: ExternalServiceId[] | null;
  }): Promise<ManagedBootstrapSnapshot>;
  upstreamToolsSnapshot(): Promise<UpstreamToolsSnapshot>;
  inspectUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  setUpstreamToolEndpoint(toolId: UpstreamToolId, endpoint: string): Promise<UpstreamToolSnapshot>;
  startUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  stopUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  restartUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  openEmbeddedTool(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  openUpstreamToolExternal(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  actUpstreamTool(input: UpstreamToolActInput): Promise<UpstreamToolActResult>;
  originalUiSnapshot(): Promise<OriginalUiCatalog>;
  inspectOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  startOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  stopOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  restartOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  openOriginalUi(toolId: OriginalUiId, section: string): Promise<OriginalUiOpenResult>;
  openOriginalUiExternal(toolId: OriginalUiId, section: string): Promise<OriginalUiOpenResult>;
  copyCpaManagementKey(): Promise<{ copied: boolean; length: number }>;
  providerSnapshot(): Promise<ProviderNetworkSnapshot>;
  providerExecutionPlan(input: ProviderExecutionPlanInput): Promise<ProviderExecutionPlan>;
  saveProviderAccount(input: ProviderAccountInput): Promise<ProviderNetworkSnapshot>;
  setDefaultProviderAccount(providerId: string, accountId: string): Promise<ProviderNetworkSnapshot>;
  setProviderAccountEnabled(accountId: string, enabled: boolean): Promise<ProviderNetworkSnapshot>;
  archiveProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;
  beginProviderLogin(accountId: string, adapterId?: string): Promise<{
    opened: boolean;
    mode: "embedded" | "external" | "import";
    state?: string | null;
    adapterId?: string;
    snapshot?: ProviderNetworkSnapshot;
  }>;
  importProviderSession(accountId: string): Promise<ProviderNetworkSnapshot>;
  probeProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;
  saveProxyProfile(input: ProxyProfileInput): Promise<ProviderNetworkSnapshot>;
  archiveProxyProfile(profileId: string): Promise<ProviderNetworkSnapshot>;
  testProxyProfile(profileId: string): Promise<{
    reachable: boolean;
    latencyMs?: number;
    error?: string;
    snapshot: ProviderNetworkSnapshot;
  }>;
  setGlobalProxyRouting(input: {
    enabled: boolean;
    profileId?: string | null;
  }): Promise<ProviderNetworkSnapshot>;
  setProviderProxyPolicy(input: {
    providerId: string;
    mode: ProxyPolicyMode;
    profileId?: string;
  }): Promise<ProviderNetworkSnapshot>;
  setAccountProxyPolicy(input: {
    accountId: string;
    mode: ProxyPolicyMode;
    profileId?: string;
  }): Promise<ProviderNetworkSnapshot>;
  logs(limit?: number): Promise<LogRecord[]>;
  exportLogs(): Promise<string | null>;
  checkForUpdates(): Promise<UpdateState>;
  setAutomaticUpdates(enabled: boolean): Promise<LauncherState>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onLog(listener: (record: LogRecord) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onExternalServicesChanged(listener: (state: ExternalServicesSnapshot) => void): () => void;
  onManagedBootstrapChanged(listener: (state: ManagedBootstrapSnapshot) => void): () => void;
  onProviderNetworkChanged(listener: (state: ProviderNetworkSnapshot) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
