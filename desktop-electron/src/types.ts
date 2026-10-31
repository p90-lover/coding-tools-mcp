export type Language = "en" | "zh-CN" | "zh-TW" | "ja";
export type RefreshPart = "ui" | "bridge" | "mcp" | "agent-orchestrator" | "cpa" | "headless" | "backend" | "all" | "app";
export type LauncherProfile = "production" | "development";
export type BrowserInteractionMode = "automatic" | "manual";
export type Surface = "browser" | "chatgpt-browser-management" | "gpt-browser" | "chatgpt-desktop" | "email" | "register" | "setup" | "mcp" | "instant-mcp" | "workspace-auth" | "native-codex" | "oauth" | "api-models" | "orchestrator" | "agent-orchestrator" | "agent-orchestrator-original" | "agent-orchestrator-teams" | "subagents" | "rtk" | "plugins" | "antigravity-cli" | "providers" | "integrations" | "cpa" | "paseo" | "anneal" | "network" | "activity" | "settings";

/** Plugins > MCPs (chat-mcp-servers.cjs): one of the person's own MCP servers for chat agents. */
export interface McpServerEntry {
  id: string;
  name: string;
  type: "stdio" | "http";
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
/** A server as the Add/Edit form saves it: no id adds a new one. */
export type McpServerInput = Omit<McpServerEntry, "id"> & { id?: string };

/** Runtime > RTK (rtk.cjs): the installed rtk, if any, and whether agents' commands use it. */
export interface RtkStatus {
  enabled: boolean;
  installed: boolean;
  /** A winget install is running (the app's automatic one at startup, or the button's). */
  installing?: boolean;
  path: string | null;
  version: string | null;
  minimum?: string;
  installCommand?: string;
}
/** rtk's own savings report: `rtk gain` as text, and its JSON export when rtk gives one. */
export interface RtkGain {
  available: boolean;
  text?: string;
  data?: unknown;
}

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
  /** Set on a ProxyBridge Nova proxy (or its gateway): read-only here, changed on the Proxy page. */
  source?: "nova";
  sourceKey?: string;
}

export type NovaRoutingState = "direct" | "starting" | "active" | "stopping" | "setupRequired" | "disabled" | "error";

export interface NovaStatus {
  product: string;
  version: string;
  managed: boolean;
  pid: number;
  apiPort: number;
  gateway: { host: string; port: number; running: boolean; error: string | null };
  routing: {
    state: NovaRoutingState;
    installed: boolean;
    runtimeReady: boolean;
    busy: boolean;
    services: Record<string, string>;
    error: string | null;
  };
  profile: { etag: string; proxyCount: number; ruleCount: number };
  decodo: { configured: boolean; autoSync: boolean; lastSyncAt: string | null; nextSyncAt: string | null; lastError: string | null };
}

export interface NovaState {
  running: boolean;
  executable: string;
  apiPort: number;
  status: NovaStatus | null;
  error: string | null;
  migratedAt: string | null;
}

export type NovaProxyProtocol = "http" | "https" | "socks5";

export interface NovaProxy {
  key: string;
  protocol: NovaProxyProtocol;
  host: string;
  port: number;
  username: string;
  /** Only sent when saving: a new password, or null to keep the saved one. */
  password?: string | null;
  hasPassword?: boolean;
  linked: boolean;
  upstreamEligible: boolean;
  provider: string | null;
}

export interface NovaRuleApplication {
  executablePath: string;
  packageFamily: string | null;
  packageSid: string | null;
  knownFamily: "none" | "chatGptCodex" | "gptClassic" | "claude";
  requiresVerifiedLineage: boolean;
}

export interface NovaRule {
  ruleId: number;
  name: string;
  enabled: boolean;
  applications: NovaRuleApplication[];
  targetHosts: string;
  targetPorts: string;
  protocol: "any" | "tcp" | "udp";
  action: "proxy" | "direct" | "block";
  proxyKey: string | null;
  immutable: boolean;
}

export interface NovaProfile {
  etag: string;
  linkedProfilePath: string | null;
  proxies: NovaProxy[];
  rules: NovaRule[];
}

export interface NovaApp {
  ruleId: number;
  ruleName: string;
  enabled: boolean;
  state: "connected" | "idle" | "notRunning" | "disabled";
  pids: number[];
  tcpCount: number;
  executables: string[];
  proxyKey: string | null;
  proxyLabel: string;
}

export interface NovaConnection {
  id: string;
  pid: number;
  application: string;
  target: string;
  state: string;
  ruleId: number | null;
  local: boolean;
  route: string;
}

export interface NovaLogEntry {
  seq: number;
  at: string;
  level: "info" | "error";
  text: string;
}

export interface NovaDecodo {
  username: string;
  hasPassword: boolean;
  password?: string | null;
  country: string;
  count: number;
  sessionMinutes: number;
  refreshMinutes: number;
  protocol: NovaProxyProtocol;
  autoSync: boolean;
  lastSyncAt?: string | null;
  lastError?: string | null;
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
  decodo?: DecodoSettings;
}

/** Decodo's sticky proxy list, read in-app (decodo-proxies.cjs); the password never comes back. */
export interface DecodoSettings {
  username: string;
  country: string;
  count: number;
  sessionMinutes: number;
  hasPassword: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export type ProviderExecutionWorkload ="subagent" | "paseo" | "anneal";
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

export type ExternalServiceId = "cpa" | "paseo" | "anneal";
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
  accountCount?: number;
  connectedAccountCount?: number;
  providerModelCount?: number;
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
  outboundProxy?: {
    profileId: string | null;
    configMatches: boolean;
    error: string | null;
  };
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
export type OriginalUiId = "cpa" | "paseo" | "anneal";
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
  api?: {
    moduleId: string;
    origin?: string;
    via?: string;
  };
  unavailable?: boolean;
  dependency?: "postgres" | null;
  error?: string | null;
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
  api?: {
    moduleId: string;
    origin?: string;
    via?: string;
  };
  unavailable?: boolean;
  dependency?: "postgres" | null;
  error?: string | null;
}

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  autoConnectExistingMcp: boolean;
  automaticUpdates: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  /** AO chat agents get the app's own tools over MCP; absent means on. */
  chatAgentTools?: boolean;
  /** Codex's model route goes through the app's bridge ("Use Coding Tools in Codex") unless false. */
  codexRoute?: boolean;
  /** Those agents may also capture the screen and control the computer; absent means off. */
  chatAgentDesktopTools?: boolean;
  /** Those agents may also run commands through the app's terminal; absent means off. */
  chatAgentTerminalTools?: boolean;
  /** Those agents get their own preview browser for pages served on this machine; absent means on. */
  chatAgentPreviewTools?: boolean;
  /** Those agents may hide secrets in the user's chat messages (redact_message); absent means off. */
  chatAgentRedactSecrets?: boolean;
  /** What they hide, one kind per line; absent means the defaults (snapshot.chatAgentRedactDefaults). */
  chatAgentRedactList?: string[];
  /** An agent's tool request answered in the chat is confirmed again in a dialog unless false. */
  confirmAgentToolRequests?: boolean;
  /** Runtime > RTK: agents' commands go through the installed rtk unless false. */
  rtkEnabled?: boolean;
  browserInteractionMode: BrowserInteractionMode;
  experimentalBiggerContext: boolean;
  /** Task chats are saved in ChatGPT history (default); false uses Temporary Chat. */
  useSavedChats: boolean;
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
  /** The shown account's tab limit, and the tabs it holds (tabs of sessions on other accounts show too). */
  maxTabs: number;
  accountTabs?: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  threadId?: string;
  /** The ChatGPT account the tab's Codex session runs on (absent: the shown account). */
  accountId?: string;
  conversationUrl?: string;
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

/** Settings → Updates (electron/state.cjs UPDATE_SETTINGS). */
export interface UpdateSettingValues {
  updateWaitForChats: boolean;
  updateIdleMinutes: number;
  updateAutoRollback: boolean;
  updateHealthMinutes: number;
  updateReuseMatchingOnly: boolean;
}

export type UpdateSettingLimit =
  | { type: "boolean"; default: boolean }
  | { type: "minutes"; default: number; min: number; max: number };

export interface UpdateSettings {
  values: UpdateSettingValues;
  limits: Record<keyof UpdateSettingValues, UpdateSettingLimit>;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  // kind "app": a whole-app update that restarts the app; otherwise a GUI-only reload.
  | { status: "available" | "downloading" | "installing"; version: string; kind?: "app"; progress?: number }
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
  /** Tunnels beside the main one, one per further ChatGPT account. */
  mcpTunnels?: McpTunnel[];
  /** Agents' commands run in Codex's Windows sandbox (installed), so the terminal tools default on. */
  chatAgentSandbox?: boolean;
  /** What chat agents hide when the user has no list of their own (state.chatAgentRedactList). */
  chatAgentRedactDefaults?: string[] | null;
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

export interface ChatGptDesktopAccount {
  slotId: string;
  source: "cpa" | "local";
  email: string | null;
  plan: string | null;
  disabled: boolean;
  signedIn: boolean;
  active: boolean;
}

export interface RegisterStatus {
  projectRoot: string;
  origin: string;
  ready: boolean;
  owned: boolean;
  starting: boolean;
  error: string | null;
  pid?: number | null;
}

export interface GptBrowserAccount {
  id: string;
  label: string;
  email: string | null;
}

export interface GptBrowserStatus {
  accounts: GptBrowserAccount[];
  activeId: string | null;
  page: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } | null;
}

/** A Browser-tab account: its own sign-in, and optionally its own proxy (one proxy per account). */
export interface BrowserAccount extends GptBrowserAccount {
  proxyProfileId: string | null;
  /** Tabs this account may hold at once (1 to maxTabsPerAccount). */
  maxTabs: number;
  /** Whether new Codex sessions may start on it when they are spread across accounts. */
  acceptsNewSessions: boolean;
  /** The last inspection of its ChatGPT session: Plus stops at 6 High; Team and Pro add Extra High and Pro. */
  plan: { solAvailable: boolean; proAvailable: boolean; checkedAt: number | null } | null;
  /** What its Codex turns showed about its ChatGPT connector. */
  connector: { okAt: number | null; error: string | null; errorAt: number | null } | null;
  /** Its own partition holds a ChatGPT sign-in (read locally); null until first read. */
  signedIn: boolean | null;
}

export interface BrowserAccountsSettings {
  /** Where a new Codex session starts: the account in use, the least busy one, or an account id. */
  newSessions: "active" | "balance" | string;
  keepFinishedTabsMinutes: number;
}

/** The Browser tab's ChatGPT accounts; the active one is also the Codex bridge's (WebGPT turns). */
export interface BrowserAccountsStatus {
  accounts: BrowserAccount[];
  activeId: string;
  maxAccounts: number;
  maxTabsPerAccount: number;
  settings: BrowserAccountsSettings;
  switching: boolean;
}

/**
 * An MCP tunnel beside the main one: its own OpenAI tunnel and MCP process, for the ChatGPT account
 * that owns the tunnel. Every tunnel reaches the same bridge, so each account's connector works.
 */
export interface McpTunnel {
  id: string;
  label: string;
  tunnelId: string;
  /** The Browser-tab account whose ChatGPT holds this tunnel's connector. */
  accountId: string | null;
  connectorHref: string | null;
  state: "stopped" | "starting" | "ready" | "failed";
  detail: string;
  pid: number | null;
}

/** A Codex thread bound to the ChatGPT account its turns run on, with the saved chats it wrote there. */
export interface CodexThreadBinding {
  threadId: string;
  accountId: string;
  boundAt: number;
  lastUsedAt: number;
  title: string | null;
  running: boolean;
  chats: Array<{ url: string; archived: boolean }>;
}

export type CodexThreadAction =
  | { threadId: string; action: "archive" | "unarchive" | "delete" | "forget" }
  | { threadId: string; action: "move"; accountId: string };

export interface ChatGptDesktopStatus {
  supported: boolean;
  installed: boolean;
  version: string | null;
  running: boolean;
  activeSlotId: string | null;
  runningSlotId: string | null;
  /** Every account whose instance is running, including hidden background ones. */
  runningSlotIds?: string[];
  busy: "launching" | "switching" | "clearing" | "stopping" | null;
  error: string | null;
  accounts: ChatGptDesktopAccount[];
}

/** A still capture of the user's own ChatGPT desktop window (not a copy Coding Tools runs). */
export interface ChatGptLocalPreview {
  state: "ok" | "not-running" | "minimized" | "hidden" | "blank" | "unsupported";
  title: string | null;
  /** JPEG data URL when `state` is "ok". */
  image: string | null;
  width: number;
  height: number;
  capturedAt: number;
}

export interface EmailStatus {
  configured: boolean;
  origin: string | null;
  encryptionAvailable: boolean;
  capabilities: { version: string | null; domains: string[]; sendEnabled: boolean } | null;
  lastRefresh: string | null;
  error: string | null;
}

export interface EmailMailbox {
  id: number;
  address: string;
  createdAt: string | null;
  updatedAt: string | null;
  mailCount: number | null;
}

export interface EmailMessageSummary {
  id: number;
  mailbox: string | null;
  from: string | null;
  subject: string | null;
  receivedAt: string | null;
  preview: string | null;
}

export interface EmailAttachment {
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface EmailMessage {
  id: number;
  from: string | null;
  to: string | null;
  subject: string | null;
  receivedAt: string | null;
  text: string | null;
  html: string | null;
  attachments: EmailAttachment[];
}

export interface KeysmithCommandResult {
  ok: boolean;
  installed?: boolean;
  managedByCodingTools?: boolean;
  state?: string;
  pythonVersion?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  fileSha256?: string;
  cancelled?: boolean;
  error?: string;
}

export interface KeysmithSelectedFile {
  path: string;
  name: string;
  content: string;
  sha256: string;
}

/** A project folder in git (git-remote.cjs readGitInfo). */
export type ProjectGit = {
  kind: "repo" | "worktree" | "inside" | "none" | "missing";
  /** The repository's root (for "inside", the repository the folder is in). */
  root: string | null;
  /** For a worktree, the repository it belongs to. */
  mainRepo: string | null;
  branch: string | null;
};

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  registerStatus(): Promise<RegisterStatus>;
  configureRegister(projectRoot: string): Promise<RegisterStatus>;
  startRegister(): Promise<RegisterStatus>;
  stopRegister(): Promise<RegisterStatus>;
  reloadRegister(): Promise<RegisterStatus>;
  setRegisterSurfaceActive(active: boolean): Promise<RegisterStatus>;
  setRegisterBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  onRegisterChanged(listener: (status: RegisterStatus) => void): () => void;
  gptBrowserStatus(): Promise<GptBrowserStatus>;
  addGptBrowserAccount(): Promise<GptBrowserStatus>;
  switchGptBrowserAccount(id: string): Promise<GptBrowserStatus>;
  openGptBrowserUrl(url: string): Promise<GptBrowserStatus>;
  navigateGptBrowser(action: "back" | "forward" | "reload" | "home"): Promise<GptBrowserStatus>;
  renameGptBrowserAccount(id: string, label: string): Promise<GptBrowserStatus>;
  removeGptBrowserAccount(id: string): Promise<GptBrowserStatus>;
  setGptBrowserSurfaceActive(active: boolean): Promise<GptBrowserStatus>;
  setGptBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  onGptBrowserChanged(listener: (status: GptBrowserStatus) => void): () => void;
  /** AO pushed a change: session ids whose conversation or state moved, "<workspace>:<run>" run keys. */
  onAoChanged?(listener: (change: { sessions: string[]; runs: string[]; moved?: { from: string; to: string; taskId: string }[] }) => void): () => void;
  chatGptDesktopStatus(): Promise<ChatGptDesktopStatus>;
  openChatGptDesktop(slotId: string): Promise<ChatGptDesktopStatus>;
  newChatGptDesktopSignIn(): Promise<ChatGptDesktopStatus>;
  clearChatGptDesktopAccount(): Promise<ChatGptDesktopStatus>;
  stopChatGptDesktop(): Promise<ChatGptDesktopStatus>;
  setChatGptDesktopSurfaceActive(active: boolean): Promise<boolean>;
  chatGptLocalPreview(): Promise<ChatGptLocalPreview>;
  sendChatGptLocalMessage(text: string): Promise<{ ok: true; sentAt: number }>;
  setChatGptDesktopBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  onChatGptDesktopChanged(listener: (status: ChatGptDesktopStatus) => void): () => void;
  onChatGptDesktopRemeasure(listener: () => void): () => void;
  emailStatus(): Promise<EmailStatus>;
  connectEmail(input: { origin: string; adminAuth: string }): Promise<EmailStatus>;
  disconnectEmail(): Promise<EmailStatus>;
  listEmailMailboxes(input: { limit?: number; offset?: number; query?: string }): Promise<{ mailboxes: EmailMailbox[]; count: number }>;
  listEmailMessages(input: { address?: string; limit?: number; offset?: number }): Promise<{ messages: EmailMessageSummary[]; count: number }>;
  getEmailMessage(input: { id: number }): Promise<{ message: EmailMessage | null }>;
  createEmailAddress(input: { name: string; domain: string }): Promise<{ address: string }>;
  deleteEmailMessage(input: { id: number }): Promise<{ deleted: number }>;
  clearEmailInbox(input: { id: number }): Promise<{ clearedMailboxId: number }>;
  removeEmailMailbox(input: { id: number }): Promise<{ removedMailboxId: number }>;
  keysmithStatus(): Promise<KeysmithCommandResult>;
  keysmithInstall?(): Promise<KeysmithCommandResult>;
  keysmithSelectFile(): Promise<KeysmithSelectedFile | null>;
  keysmithPreview(useBundled?: boolean): Promise<KeysmithCommandResult>;
  keysmithApply(): Promise<KeysmithCommandResult>;
  keysmithPreviewRemoval(): Promise<KeysmithCommandResult>;
  keysmithRemove(): Promise<KeysmithCommandResult>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language, browserInteractionMode: BrowserInteractionMode): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  /** The file system path of a dropped or picked file, or "" when unknown. */
  filePath?(file: File): string;
  /** Opens an existing folder in the system file manager. */
  openFolder?(folder: string): Promise<boolean>;
  /** Saves a chat attachment that has no path (a pasted screenshot) for the agent to open by path. */
  saveAttachment?(input: { name: string; type: string; bytes: Uint8Array }): Promise<{ path: string }>;
  /** Selects an existing file in the system file manager. */
  revealFile?(file: string): Promise<boolean>;
  /** An attached image as a data: URL, for its thumbnail in a sent message. */
  attachmentPreview?(file: string): Promise<string>;
  /** Opens or refreshes a chat's read-only window; `open: false` once the user has closed it. */
  showChatWindow?(input: { key: string; title: string; page: string; body: string; mode: "open" | "update" }): Promise<{ open: boolean }>;
  /** A project folder's git origin as "owner/repo", or null. */
  projectRemote?(folder: string): Promise<string | null>;
  projectBranch?(folder: string): Promise<string | null>;
  /** What a project folder is in git: a repository, a worktree of one, a folder inside one, not git, or gone. */
  projectGit?(folder: string): Promise<ProjectGit | null>;
  /** The system folder picker; the chosen absolute path, or null when cancelled. */
  chooseFolder?(): Promise<string | null>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState | true>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  createBrowserTab(): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  browserAccounts(): Promise<BrowserAccountsStatus>;
  addBrowserAccount(): Promise<BrowserAccountsStatus>;
  switchBrowserAccount(id: string): Promise<BrowserAccountsStatus>;
  renameBrowserAccount(id: string, label: string): Promise<BrowserAccountsStatus>;
  removeBrowserAccount(id: string): Promise<BrowserAccountsStatus>;
  /** Bulk delete: removes each listed account; one that could not go is in `failed` with its reason. */
  removeBrowserAccounts(ids: string[]): Promise<BrowserAccountsStatus & { removed: string[]; failed: { id: string; message: string }[] }>;
  onBrowserAccountsChanged(listener: (status: BrowserAccountsStatus) => void): () => void;
  setBrowserAccountProxy(id: string, profileId: string | null): Promise<BrowserAccountsStatus>;
  assignBrowserAccountProxies(): Promise<BrowserAccountsStatus & { assigned: number }>;
  setBrowserAccountSettings(id: string, input: { maxTabs?: number; acceptsNewSessions?: boolean }): Promise<BrowserAccountsStatus>;
  setBrowserAccountsSettings(input: Partial<BrowserAccountsSettings>): Promise<BrowserAccountsStatus>;
  inspectBrowserAccount(): Promise<BrowserAccountsStatus>;
  codexThreads(): Promise<{ threads: CodexThreadBinding[] }>;
  codexThreadAction(input: CodexThreadAction): Promise<{ threads: CodexThreadBinding[] }>;
  saveDecodo(input: Partial<DecodoSettings> & { password?: string }): Promise<ProviderNetworkSnapshot>;
  syncDecodo(): Promise<{ added: number; updated: number; snapshot: ProviderNetworkSnapshot }>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  copyManualPrompt(tabId: string): Promise<BrowserState>;
  confirmManualSent(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  /** Checks the saved ChatGPT sign-in without leaving a login in progress; refreshes it when signed in. */
  checkSignIn(): Promise<BrowserState>;
  openPasskeyLogin(): Promise<BrowserState>;
  continuePasskeyLogin(): Promise<boolean>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  createMcpConnector(): Promise<{ created: boolean; name: string; href: string }>;
  doctor(): Promise<DoctorReport>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  /** Settings → "Use Coding Tools in Codex": on routes Codex's models through the bridge, off restores its own route. */
  setCodexRoute?(enabled: boolean): Promise<{ state: LauncherState; route: { changed: boolean; setupRequired: boolean; codexRestartRequired: boolean } }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  refreshPart(part: RefreshPart): Promise<{ ok: boolean; results: { part: string; ok: boolean; status?: string; message?: string }[] }>;
  setupMcp(input: {
    tunnelId?: string;
    runtimeKey?: string;
    replace?: boolean;
    interactionMode?: BrowserInteractionMode;
  }): Promise<{ ok: boolean; stdout: string }>;
  setMcpStep(step: number): Promise<LauncherState>;
  mcpTunnels(): Promise<McpTunnel[]>;
  addMcpTunnel(input: { label: string; tunnelId: string; runtimeKey: string; accountId: string | null }): Promise<McpTunnel>;
  removeMcpTunnel(id: string): Promise<{ removed: boolean }>;
  reconnectMcpTunnel(id: string): Promise<McpTunnel>;
  createMcpTunnelConnector(id: string): Promise<{ created: boolean; name: string; href: string }>;
  onMcpTunnelsChanged(listener: (tunnels: McpTunnel[]) => void): () => void;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setBiggerContext(enabled: boolean): Promise<LauncherState>;
  setUseSavedChats(enabled: boolean): Promise<LauncherState>;
  setZeroRiskPro(enabled: boolean): Promise<LauncherState>;
  setBrowserInteractionMode(mode: BrowserInteractionMode): Promise<{
    state: LauncherState;
    credentialsRequired: boolean;
    targetMode: BrowserInteractionMode;
  }>;
  setPreference(
    key: "keepRunningOnClose" | "showBrowserDuringTurns" | "autoConnectExistingMcp" | "chatAgentTools" | "chatAgentDesktopTools" | "chatAgentTerminalTools" | "chatAgentPreviewTools" | "confirmAgentToolRequests" | "rtkEnabled" | "chatAgentRedactSecrets",
    value: boolean,
  ): Promise<LauncherState>;
  /** What chat agents hide in the user's messages, one kind per line; empty restores the defaults. */
  setRedactList?(lines: string[]): Promise<LauncherState>;
  rtkStatus(): Promise<RtkStatus>;
  rtkGain(): Promise<RtkGain>;
  rtkInstall(): Promise<{ code: number | null; output: string; status: RtkStatus }>;
  mcpServers(): Promise<McpServerEntry[]>;
  saveMcpServer(server: McpServerInput): Promise<McpServerEntry[]>;
  removeMcpServer(id: string): Promise<McpServerEntry[]>;
  setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerEntry[]>;
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
  novaState(): Promise<NovaState>;
  novaStart(): Promise<NovaState>;
  novaShutdown(): Promise<NovaState>;
  novaSetExecutable(exePath: string): Promise<NovaState>;
  novaProfile(): Promise<NovaProfile>;
  novaSaveProxies(input: { etag: string; proxies: NovaProxy[] }): Promise<NovaProfile>;
  novaSaveRules(input: { etag: string; rules: NovaRule[] }): Promise<NovaProfile>;
  novaCheckProxy(key: string): Promise<{ key: string; ok: boolean; latencyMs: number | null; error: string | null }>;
  novaApps(): Promise<{ capturedAt: string; error: string | null; apps: NovaApp[] }>;
  novaConnections(): Promise<{ capturedAt: string; error: string | null; connections: NovaConnection[] }>;
  novaLog(after?: number): Promise<{ entries: NovaLogEntry[] }>;
  novaRouting(action: "start" | "stop" | "reload" | "install"): Promise<{ routing: NovaStatus["routing"] }>;
  novaDecodo(): Promise<NovaDecodo>;
  novaSaveDecodo(input: NovaDecodo): Promise<NovaDecodo>;
  novaSyncDecodo(): Promise<{ added: number; updated: number; removed: number; profile: NovaProfile }>;
  onNovaChanged(listener: (state: NovaState) => void): () => void;
  logs(limit?: number): Promise<LogRecord[]>;
  exportLogs(): Promise<string | null>;
  checkForUpdates(): Promise<UpdateState>;
  setAutomaticUpdates(enabled: boolean): Promise<LauncherState>;
  /** Settings → Updates: reads them, or changes the given ones (main checks every value). */
  updateSettings(patch?: Partial<UpdateSettingValues> | null): Promise<UpdateSettings>;
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
