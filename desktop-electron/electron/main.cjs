const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net: electronNet,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  safeStorage,
  session,
  shell,
  Tray,
  webFrameMain,
  powerMonitor,
  powerSaveBlocker,
} = require("electron");
const { BrowserHost, navigationErrorForLog, writeRestartMarker } = require("./browser-host.cjs");
const { createChatGptDesktopHost, proxyRouteFromEnvironment } = require("./chatgpt-desktop.cjs");
const { createGptBrowserHost, cleanUserAgent } = require("./gpt-browser.cjs");
const { createEmailHost } = require("./email-host.cjs");
const { createRegisterHost } = require("./register-host.cjs");
const { createChatWindows } = require("./chat-windows.cjs");
const { readBranch, readGitInfo, readRemote } = require("./git-remote.cjs");
const { boundedQuitStep } = require("./quit-steps.cjs");
const { installKeysmithIpc } = require("./keysmith-ipc.cjs");
const { parseMessage, sanitizeHtml } = require("./email-mime.cjs");
const { createConfiguredConnector } = require("./mcp-connector-setup.cjs");
const { BrowserControlServer, fetchNativeWithProxyAuth } = require("./control-server.cjs");
const { createMcpEventMonitor } = require("./mcp-events-monitor.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { createCodingToolsShellBridge } = require("./coding-tools-shell-bridge.cjs");
const { ensurePackagedRuntime, pruneOldRuntimes, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { assertLauncherRuntimeVersion, terminateLauncherSmoke } = require("./smoke-exit.cjs");
const { DEVELOPMENT_PROFILE, resolveLauncherProfile } = require("./profile.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createGuiUpdateController, guiShellHash } = require("./gui-update.cjs");
const { combineUpdateControllers, createAppUpdateController, createAutoInstaller, sweepUpdateLeftovers, waitForUpdateApply } = require("./app-update.cjs");
const { readImagePreview, saveChatAttachment } = require("./chat-attachments.cjs");
const { useNativeUpdateTransport } = require("./update.cjs");
const {
  providerNetworkReady,
  setProviderBrowserHost,
  setProviderCpaConnection,
  setProviderLogger,
} = require("./provider-bootstrap.cjs");

const { createManagedExternalServicesController, resolveManagedProxyEnvironment } = require("./managed-external-services.cjs");
const { createManagedBootstrap } = require("./managed-bootstrap.cjs");
const { createUpstreamToolController } = require("./upstream-tools.cjs");
const { createOriginalUiController } = require("./original-ui.cjs");
const { installCpaPanelSession } = require("./cpa-panel-session.cjs");
const { resolveAppHandlerRoot } = require("./app-handler-paths.cjs");
const { createBackendBundles } = require("./backend-bundle.cjs");
function loadCreateCodingToolsAppsHost(appHandlerRoot) {
  try {
    return require(path.join(appHandlerRoot || resolveAppHandlerRoot(), "host.cjs")).createCodingToolsAppsHost;
  } catch (error) {
    const failed = error;
    return function createCodingToolsAppsHostUnavailable() {
      throw failed;
    };
  }
}
const { createAppsProviderServices } = require("./apps-provider-services.cjs");
const { createCodingToolsAppsMcp, mergeAppsCatalog } = require("./coding-tools-apps-mcp.cjs");
const {
  KEEP_UI_RESPONSIVE_SKIP_REASON,
  createIpcRegistrar,
  createRendererLoader,
  deferUiWork,
  safeRead,
  scheduleFullIpcAfterPaint,
} = require("./launcher-ready-path.cjs");
const { createRendererWatchdog } = require("./renderer-watchdog.cjs");
const { createMainStallMonitor } = require("./main-stall-monitor.cjs");
const { actUpstream } = require("./upstream-actions.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const LAUNCHER_SMOKE_TEST = process.argv.includes("--launcher-smoke-test");
const SOURCE_ROOT = path.resolve(__dirname, "../..");
// The bridge runtime (codex-chatgpt-web, src/cli.ts) lives in runtime-web, not at the repo root.
const RUNTIME_SOURCE_ROOT = path.join(SOURCE_ROOT, "runtime-web");
const LAUNCHER_PROFILE = resolveLauncherProfile({ appData: app.getPath("appData") });
const IS_DEV_PROFILE = LAUNCHER_PROFILE.kind === DEVELOPMENT_PROFILE;
const CORE_HOME = LAUNCHER_PROFILE.coreHome;
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const GITHUB_URL = "https://github.com/p90-lover/coding-tools-mcp";
const X_URL = "https://x.com/GIBUSHAT";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, X_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL]);
const PACKAGED_RENDERER_PATH = path.join(__dirname, "..", "dist", "index.html");
const PACKAGED_RENDERER_URL = pathToFileURL(PACKAGED_RENDERER_PATH).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.codexwebgpt.launcher.dev" : "dev.codexwebgpt.launcher");
}
fs.mkdirSync(LAUNCHER_PROFILE.userData, { recursive: true, mode: 0o700 });
// Native child processes must use the physical profile path across Windows junctions.
const launcherUserData = fs.realpathSync.native(LAUNCHER_PROFILE.userData);
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
// Certificate authorities the app no longer trusts (ca-distrust.cjs: the leaked eMudhra/emSign CA
// keys). Requiring it takes them out of this process's CA list; the Node runtimes it starts (AO's
// agents) preload it; every Chromium session refuses a chain through them. Still at startup, before
// any window, session or connection exists.
const caDistrust = require("./ca-distrust.cjs");
process.env.NODE_OPTIONS = caDistrust.childNodeOptions(path.join(launcherUserData, "runtime-preload"), process.env.NODE_OPTIONS);
app.on("session-created", (created) => created.setCertificateVerifyProc(caDistrust.verifyCertificate));
let mainWindowReadyToShow = false;
let mainWindowShowRequested = false;
let browserHost = null;
let chatgptDesktop = null;
let gptBrowser = null;
let emailHost = null;
let registerHost = null;
const chatgptDesktopOwners = new WeakSet();
let runtimeHost = null;
let headlessHost = null;
let browserControl = null;
let runtimeSupervisor = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
/** The launcher's logger, for the quit path (which runs outside start's scope). */
let quitLogger = null;
// Runtime > RTK (rtk.cjs), made once the logger exists; IPC reads it from here.
let rtkService = null;
/** How long Electron may linger after app.quit() once every stop has run (app.relaunch still applies). */
const QUIT_EXIT_GRACE_MS = 10_000;
let codexBridgeConnectInFlight = null;
let runtimeStartupInFlight = null;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let automaticMcpAttemptPid = null;
let mcpVerificationInFlight = null;
let verifyMcpConnection = null;
let updateController = null;
let autoInstaller = null;
let externalServicesController = null;
let managedBootstrapController = null;
let upstreamToolController = null;
let originalUiController = null;
let appsHost = null;
let agentOrchestratorUpstream = null;
/** Stops the AO change push wired up with the current upstream module. */
let aoChangeWatch = null;
let missionWorkflowRuntime = null;
/** The app's tool server for AO chat agents; one per app run, kept across backend restarts. */
let chatAgentTools = null;
// Runtime > Subagents (subagents.cjs): created once, like the chat agents' tools it serves.
let subagentsService = null;
let antigravityReauth = null;
let antigravityAuthBrowser = null;
// The swappable backend tier (see backend-bundle.cjs): restarted in place, never with the core.
let backendBundles = null;
let backendControl = null;
let activeBackend = null;
let getFiveStack = () => ({ ok: false });
const appsMcp = createCodingToolsAppsMcp({
  getHost: () => appsHost,
});
const ipcRegistrar = createIpcRegistrar();
const registeredIpcChannels = new Set();

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function cpaAuthDirectory() {
  const stateDirectory = path.join(app.getPath("userData"), "integrations", "state", "cpa");
  try {
    const line = fs.readFileSync(path.join(stateDirectory, "config.yaml"), "utf8").match(/^auth-dir:\s*(.+)$/m);
    if (line) return path.resolve(JSON.parse(line[1]));
  } catch {}
  return path.join(stateDirectory, "auth");
}

// The docked ChatGPT desktop window follows the main window; it must hide whenever the main
// window is minimized or hidden, and re-pin after every move or resize.
function watchChatGptDesktopOwner(window) {
  if (!chatgptDesktop || !window || window.isDestroyed() || chatgptDesktopOwners.has(window)) return;
  chatgptDesktopOwners.add(window);
  const handle = window.getNativeWindowHandle();
  chatgptDesktop.setOwner(Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0)));
  const visibility = () => {
    if (!window.isDestroyed()) chatgptDesktop?.setOwnerVisible(window.isVisible() && !window.isMinimized());
  };
  for (const name of ["minimize", "restore", "hide", "show"]) window.on(name, visibility);
  for (const name of ["move", "resize", "maximize", "unmaximize"]) {
    window.on(name, () => mainWindow?.webContents.send("launcher:chatgpt-desktop-remeasure"));
  }
  visibility();
}

function getChatGptDesktop(logger) {
  if (!chatgptDesktop) {
    chatgptDesktop = createChatGptDesktopHost({
      logger,
      dataRoot: path.join(CORE_HOME, "chatgpt-desktop"),
      resolveCpaAuthDir: cpaAuthDirectory,
      getProxyRoute: async () => proxyRouteFromEnvironment(),
      onChange: (status) => send("launcher:chatgpt-desktop-changed", status),
    });
    chatgptDesktop.ready = chatgptDesktop.initialize().catch((error) => {
      logger.warn("chatgpt_desktop.initialize_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  }
  watchChatGptDesktopOwner(mainWindow);
  return chatgptDesktop;
}

// GPT Browser account partitions take the same route as the main browser (Global Routing
// publishes it in HTTPS_PROXY/NO_PROXY); chatgpt.com refuses this machine's direct route.
async function routeGptBrowserSession(browserSession) {
  let route = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  if (!route) {
    await browserSession.setProxy({ mode: "direct" });
    return;
  }
  // The built-in gateway's env route carries its local token; Chromium takes the bare proxy and
  // answers the proxy's 407 through the app's login handler instead.
  try {
    const parsed = new URL(route);
    if (parsed.username || parsed.password) route = `${parsed.protocol}//${parsed.host}`;
  } catch {}
  await browserSession.setProxy({ mode: "fixed_servers", proxyRules: route, proxyBypassRules: process.env.NO_PROXY || "" });
}

function getGptBrowser(logger) {
  if (gptBrowser) return gptBrowser;
  gptBrowser = createGptBrowserHost({
    logger,
    dataRoot: path.join(CORE_HOME, "gpt-browser"),
    sessionFor: (partition) => session.fromPartition(partition),
    prepareSession: routeGptBrowserSession,
    createView: (partition) => new WebContentsView({
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
    }),
    attachView: (view) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.addChildView(view); },
    detachView: (view) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view); },
    // The pane hands only mailto: links out (to the mail app); openWebUrl refuses them, so every
    // mailto click failed as an unhandled rejection and the mail app never opened.
    openExternal: (url) => (/^mailto:/i.test(String(url)) ? shell.openExternal(String(url)) : openWebUrl(url)),
    onChange: (status) => send("launcher:gpt-browser-changed", status),
  });
  return gptBrowser;
}

// The launcher's own network for a cookie-less native fetch: its browser session (Global Routing's
// proxy, else the system's) with that proxy's credentials, as the browser control server uses (NFR-2).
async function fetchThroughLauncherNetwork(url, options) {
  const network = await providerNetworkReady();
  const routing = network.store.snapshot().routing;
  const profile = routing.globalEnabled ? network.store.activeProxy(routing.globalProfileId) : null;
  const credentials = profile ? network.store.proxySecret(profile.id) : null;
  return fetchNativeWithProxyAuth({
    electronNet, browserSession: session.fromPartition(LAUNCHER_PROFILE.browserPartition), url, options,
    getProxyCredentials: (authInfo) => (
      profile && authInfo.port === profile.endpoint.port
      && String(authInfo.host).replace(/^\[|\]$/g, "").toLowerCase()
        === String(profile.endpoint.host).replace(/^\[|\]$/g, "").toLowerCase()
        ? credentials : null
    ),
  });
}

function getRegisterHost(logger) {
  if (registerHost) return registerHost;
  registerHost = createRegisterHost({
    projectRoot: path.join(app.getPath("documents"), "ChatGPT", "reg-machine"),
    configPath: path.join(app.getPath("userData"), "runtime-register.json"),
    isQuitting: () => quitting,
    createView: (partition) => new WebContentsView({
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    }),
    prepareSession: (browserSession) => browserSession.setProxy({ mode: "direct" }),
    attachView: (view) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.addChildView(view); },
    detachView: (view) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view); },
    openExternal: (url) => openWebUrl(url),
    onChange: (status) => send("launcher:register-changed", status),
  });
  return registerHost;
}

function getEmailHost(logger) {
  if (emailHost) return emailHost;
  const fetchNative = fetchThroughLauncherNetwork;
  emailHost = createEmailHost({
    logger,
    filePath: path.join(app.getPath("userData"), "runtime-email.json"),
    keyPath: path.join(app.getPath("userData"), "runtime-email.key"),
    safeStorage,
    fetchNative,
    parseMessage,
    sanitizeHtml,
  });
  return emailHost;
}

/** Identifies one installation, so a fresh install's own backend takes over from older bundles. */
function packagedInstallId() {
  try {
    const asar = fs.statSync(path.join(process.resourcesPath, "app.asar"));
    return `${app.getVersion()}:${Math.round(asar.mtimeMs)}:${asar.size}`;
  } catch {
    return app.getVersion();
  }
}

// While Coding Tools is open, keep the Codex bridge and MCP tunnel running.
const BRIDGE_WATCHDOG_INTERVAL_MS = 60_000;
// One missed health check is usually a stalled machine, not a dead bridge; restarting then kills
// the Codex turns in flight. Restart only after this many misses in a row.
const BRIDGE_WATCHDOG_MISSES_BEFORE_RESTART = 2;
let bridgeWatchdogTimer = null;
let bridgeWatchdogBusy = false;
let bridgeWatchdogMisses = 0;
function startBridgeWatchdog(logger, stateStore) {
  if (IS_DEV_PROFILE || bridgeWatchdogTimer) return;
  bridgeWatchdogTimer = setInterval(async () => {
    if (quitting || shutdownInProgress || bridgeWatchdogBusy || !runtimeSupervisor || !runtimeHost) return;
    // A config file mid-write or unreadable is skipped this minute, not thrown from the timer.
    let config;
    try {
      if (!runtimeHost.runtimeConfigSnapshot().configured || runtimeHost.currentOperation()) return;
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      logger.warn("runtime.watchdog_config_unreadable", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!config) return;
    bridgeWatchdogBusy = true;
    try {
      const checkStarted = Date.now();
      const check = await runtimeSupervisor.ownedRuntimeCheck(config);
      if (check.ready) {
        bridgeWatchdogMisses = 0;
        return;
      }
      bridgeWatchdogMisses += 1;
      // Which part failed and how long the check took: a slow daemon_health on a stalled machine
      // reads differently from a tunnel that is down.
      const miss = { mode: config.mode, misses: bridgeWatchdogMisses, failed: check.failed, checkMs: Date.now() - checkStarted };
      if (bridgeWatchdogMisses < BRIDGE_WATCHDOG_MISSES_BEFORE_RESTART) {
        logger.warn("runtime.watchdog_miss", miss);
        return;
      }
      bridgeWatchdogMisses = 0;
      logger.warn("runtime.watchdog_restart", miss);
      const result = await runtimeSupervisor.startIfConfigured();
      logger.info("runtime.watchdog_result", { status: result?.status });
      // Point Codex back at the bridge once it is running again (a failed launch restores the old route).
      if (result?.status === "ready" || result?.status === "degraded") {
        scheduleCodexBridgeAutoConnect({ logger, stateStore, reason: "watchdog" });
      }
    } catch (error) {
      logger.warn("runtime.watchdog_failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      bridgeWatchdogBusy = false;
    }
  }, BRIDGE_WATCHDOG_INTERVAL_MS);
  bridgeWatchdogTimer.unref?.();
}
function stopBridgeWatchdog() {
  if (bridgeWatchdogTimer) clearInterval(bridgeWatchdogTimer);
  bridgeWatchdogTimer = null;
}

const REFRESH_PARTS = Object.freeze(["ui", "bridge", "mcp", "agent-orchestrator", "cpa", "headless", "backend", "all", "app"]);
async function refreshPart(part, logger) {
  if (!REFRESH_PARTS.includes(part)) throw new Error("Choose a part to refresh");
  const run = async (name, action) => {
    try {
      const result = await action();
      logger.info("launcher.part_refreshed", { part: name });
      return { part: name, ok: true, ...(result && typeof result === "object" ? { status: result.status } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("launcher.part_refresh_failed", { part: name, message });
      return { part: name, ok: false, message: message.slice(0, 300) };
    }
  };
  const actions = {
    bridge: () => runtimeSupervisor.restartDaemonOnly(),
    mcp: () => runtimeSupervisor.restartTunnelOnly(),
    "agent-orchestrator": async () => { await agentOrchestratorUpstream?.stop(); return agentOrchestratorUpstream?.start(); },
    cpa: () => externalServicesController.restart("cpa"),
    headless: async () => { await headlessHost?.shutdown("part-refresh"); return headlessHost?.ensureStarted(); },
    // Reload the whole backend tier from the active bundle; the core keeps running.
    backend: () => backendControl.restart("part-refresh"),
  };
  if (part === "app") {
    // Restart the app shell only; the bridge and MCP tunnel stay up and are adopted on relaunch.
    setTimeout(() => { void requestQuit({ keepBridge: true, relaunch: true }); }, 100);
    return { ok: true, results: [{ part: "app", ok: true, status: "restarting" }] };
  }
  const names = part === "all" ? ["bridge", "mcp", "agent-orchestrator", "cpa", "headless"] : part === "ui" ? [] : [part];
  const results = [];
  for (const name of names) results.push(await run(name, actions[name]));
  if (part === "ui" || part === "all") {
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache(); }, 150);
    results.push({ part: "ui", ok: true, status: "reloading" });
  }
  return { ok: results.every((result) => result.ok), results };
}

const AUTHENTICATION_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const STARTUP_AUTH_WAIT_MS = 20_000;
const PROXY_STARTUP_WAIT_MS = 10_000;
/**
 * Resolves once the proxy in HTTPS_PROXY/HTTP_PROXY accepts a connection, or after `timeoutMs`
 * (the caller's navigation then reports the real error). No proxy, or a malformed one: at once.
 */
async function waitForProxyRoute(timeoutMs) {
  let target;
  try {
    const route = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    if (!route) return;
    target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(route) ? route : `http://${route}`);
  } catch { return; }
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(1_000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (open) return;
    await delay(500);
  }
}
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
function scheduleAuthenticationRetry(logger, attempt = 0) {
  if (attempt >= AUTHENTICATION_RETRY_DELAYS_MS.length) return;
  const timer = setTimeout(() => {
    if (quitting || shutdownInProgress || !browserHost) return;
    if (browserHost.snapshot()?.authenticated === true) return;
    // Never navigate the embedded browser under a running login, smoke test or turn.
    if (browserHost.currentOperation?.() || browserHost.activeTraceId) {
      scheduleAuthenticationRetry(logger, attempt);
      return;
    }
    void browserHost.refreshAuthentication().then((state) => {
      logger.info("browser.session_refresh_retried", { attempt: attempt + 1, authenticated: state?.authenticated === true });
    }).catch((error) => {
      logger.warn("browser.session_refresh_failed", { ...navigationErrorForLog(error), attempt: attempt + 1 });
      scheduleAuthenticationRetry(logger, attempt + 1);
    });
  }, AUTHENTICATION_RETRY_DELAYS_MS[attempt]);
  timer.unref?.();
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

async function autoConnectExistingMcpIfReady({ logger, stateStore, health }) {
  const state = stateStore.read();
  if (IS_DEV_PROFILE || quitting || shutdownInProgress || !state.autoConnectExistingMcp
    || state.browserInteractionMode !== "automatic" || !runtimeHost?.mcpCredentialsConfigured()) return false;
  const config = runtimeSupervisor?.readConfig();
  if (config?.mode !== "full") return false;
  if (!health || health.service !== "codex-chatgpt-web" || health.status !== "ok"
    || health.mode !== "full" || health.version !== config.releaseVersion || health.accepting_turns !== true
    || !Number.isInteger(health.pid) || health.pid !== runtimeSupervisor.readState()?.daemonPid
    || !(health.successful_model_catalog_requests > 0)) return true;
  if (automaticMcpAttemptPid === health.pid) return false;
  const browser = browserHost?.snapshot();
  if (!verifyMcpConnection || browser?.authenticated !== true || browser.surfaceActive
    || health.active_http_turns !== 0 || health.active_browser_turns !== 0
    || browserHost.activeTraceId || browserHost.currentOperation() || runtimeHost.currentOperation()) return true;
  const contents = browserHost.view?.webContents;
  if (!contents || contents.isDestroyed()) return true;
  const hasDraft = await contents.executeJavaScript(`(() => {
    const composer = document.querySelector('#prompt-textarea');
    return !composer || Boolean((composer.innerText || composer.value || '').trim())
      || [...document.querySelectorAll('input[type="file"]')].some(input => input.files.length > 0)
      || [...document.querySelectorAll('button[aria-label]')].some(button => /^Remove\\b/i.test(button.getAttribute('aria-label')));
  })()`);
  if (hasDraft || browserHost.currentOperation() || browserHost.activeTraceId) return true;
  automaticMcpAttemptPid = health.pid;
  await verifyMcpConnection();
  logger.info("mcp.automatic_verification_finished", { ready: stateStore.read().mcpSetupComplete === true });
  return false;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  let reportedFailure = null;
  // Once the catalog is verified, the monitor only waits for an idle, signed-in browser to connect
  // MCP. That can take as long as the browser is in use, and asking the bridge's health every 2 s
  // the whole time cost the main process a connection and a config read each time; it asks every
  // 15 s while waiting.
  let nextCheckAt = 0;
  const check = async () => {
    if (Date.now() < nextCheckAt) return;
    const current = stateStore.read();
    if (current.coreSetupComplete !== true || (current.codexCatalogVerified === true && !current.autoConnectExistingMcp)) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) {
        const result = health?.last_model_catalog_result;
        if (!result || !Number.isInteger(result.status) || result.status < 400 || result.status > 599
          || !Number.isInteger(result.request) || result.request < 1 || lastOperation?.status === "running") return;
        const identity = `${health.pid}:${result.request}:${result.at}`;
        if (identity === reportedFailure) return;
        reportedFailure = identity;
        const reason = typeof result.failure?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(result.failure.code)
          ? result.failure.code
          : ["config", "request", "transport", "upstream", "catalog"].includes(result.failure?.stage)
            ? result.failure.stage
            : "catalog";
        const state = stateStore.update({ codexRestartRequired: false });
        send("launcher:state-changed", state);
        logger.warn("codex.model_catalog_failed", { status: result.status, reason, request: result.request });
        publishOperation({
          name: "catalog-verification",
          status: "failed",
          message: nativeCopyFor(current.language).catalogFailure
            .replace("{status}", String(result.status)).replace("{reason}", reason),
        });
        return;
      }
      if (!current.codexCatalogVerified) {
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
      // A failure reported before the catalog came up (for example while the proxy was
      // restarting) is kept as lastOperation and re-raised as an error on every renderer load;
      // it must not outlive the recovery.
      if (lastOperation?.name === "catalog-verification" && lastOperation.status === "failed") {
        publishOperation({ name: "catalog-verification", status: "completed", message: "Codex model catalog loaded" });
      }
      }
      if (await autoConnectExistingMcpIfReady({ logger, stateStore, health })) {
        nextCheckAt = Date.now() + 15_000;
        return;
      }
      stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

async function restoreCodexRouteAfterRuntimeFailure({ logger, stateStore }) {
  try {
    const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
    if (!route.installed || route.active) return { restored: false };
    const state = stateStore.update({
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    logger.warn("bridge.route_restored_after_runtime_failure", {
      changed: route.changed === true,
    });
    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
    return { restored: false, error: message };
  }
}

async function waitForRuntimeHostIdle(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (runtimeHost?.currentOperation()) {
    if (Date.now() >= deadline) {
      throw new Error(`Codex bridge connect waited for ${runtimeHost.currentOperation()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Runs a startup step on the runtime host once it is idle. Waiting alone is not enough: a
 * sign-in's route check can begin between the wait and the step (seen live at launch, ~400 ms
 * apart), and the host then refuses the step as "Another launcher operation is active". That
 * left the bridge down and setup marked incomplete until the watchdog noticed. A step refused
 * for it waits for idle again and retries, up to three attempts; any other error is thrown.
 */
async function whenRuntimeHostIdle(logger, step, run) {
  for (let attempt = 1; ; attempt += 1) {
    await waitForRuntimeHostIdle(120_000).catch((error) => logger.warn("runtime.startup_wait_idle", {
      step, message: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !message.startsWith("Another launcher operation is active")) throw error;
      logger.warn("runtime.startup_retry_busy", { step, attempt, message: message.slice(0, 200) });
    }
  }
}

function applyReadyRuntimeAfterBridge({ logger, stateStore, bridgeRouteChanged = false }) {
  const config = runtimeSupervisor.readConfig();
  const current = stateStore.read();
  const patch = {
    coreSetupComplete: true,
    mcpRuntimeInstalled: config.mode === "full",
    experimentalBiggerContext: config.experimentalBiggerContext === true,
    useSavedChats: config.useSavedChats !== false,
    zeroRiskProEnabled: config.zeroRiskProEnabled === true,
    ...(bridgeRouteChanged ? {
      codexCatalogVerified: false,
      codexRestartRequired: true,
    } : {}),
    ...(config.mode === "browser-only" ? {
      mcpSetupComplete: false,
      mcpGuideStep: 0,
    } : {}),
  };
  if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
    const state = stateStore.update(patch);
    send("launcher:state-changed", state);
  }
  startCatalogVerificationMonitor({ logger, stateStore });
}

async function connectCodexBridgeAfterAuthentication({ logger, stateStore, reason = "auth" }) {
  if (quitting || shutdownInProgress) return { skipped: true, reason: "shutting-down" };
  if (IS_DEV_PROFILE || !runtimeHost || !runtimeSupervisor) return { skipped: true, reason: "unavailable" };
  // The user took Codex off the bridge: nothing (startup, sign-in, a bridge restart) puts it back,
  // and a route something else left behind (an older build reconnecting it at startup) is removed,
  // as switching it off would. Seen live: the switch off, yet Codex's config still pointed at 17841.
  if (stateStore.read().codexRoute === false) {
    if (runtimeHost.runtimeConfigSnapshot().configured) {
      try {
        await waitForRuntimeHostIdle();
        const route = await runtimeHost.setCodexRoute(false);
        if (route.changed) logger.info("codex_route.reconciled_off", { reason });
      } catch (error) {
        logger.warn("codex_route.reconcile_failed", { reason, message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    }
    return { skipped: true, reason: "codex-route-off" };
  }
  if (stateStore.read().browserInteractionMode === "automatic"
    && browserHost?.snapshot()?.authenticated !== true) {
    return { skipped: true, reason: "unauthenticated" };
  }
  if (!runtimeHost.runtimeConfigSnapshot().configured) return { skipped: true, reason: "not-configured" };
  if (codexBridgeConnectInFlight) return codexBridgeConnectInFlight;
  const work = (async () => {
    await waitForRuntimeHostIdle();
    const runtime = await runtimeSupervisor.startIfConfigured();
    if (runtime.status !== "ready" && runtime.status !== "degraded") return { skipped: true, reason: runtime.status, runtime };
    const route = await runtimeHost.connectBridgeRoute();
    applyReadyRuntimeAfterBridge({ logger, stateStore, bridgeRouteChanged: route.changed === true });
    logger.info("bridge.auto_connected", { reason, changed: route.changed === true });
    return { connected: true, changed: route.changed === true, runtime };
  })();
  codexBridgeConnectInFlight = work;
  try {
    return await work;
  } finally {
    if (codexBridgeConnectInFlight === work) codexBridgeConnectInFlight = null;
  }
}

function scheduleCodexBridgeAutoConnect({ logger, stateStore, reason }) {
  void connectCodexBridgeAfterAuthentication({ logger, stateStore, reason }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("bridge.auto_connect_failed", { reason, message });
    publishOperation({ name: "bridge-connect", status: "failed", message });
  });
}

function trayImage() {
  if (process.platform !== "darwin") {
    return nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M4.1 3.4h6.4l3.4 3.4v7.8H7.5l-3.4-3.4V3.4Z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><path d="m7 7 2-2 2 2M7 11l2 2 2-2" fill="none" stroke="white" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
}

const NATIVE_COPY = Object.freeze({
  en: Object.freeze({
    openLauncher: "Open Codex Web GPT",
    quit: "Quit",
    exportDiagnostics: "Export privacy-safe diagnostics",
    cancel: "Cancel",
    remove: "Remove",
    removeTitle: "Remove Codex Web GPT",
    removeMessage: "Remove the ChatGPT Web models from Codex and restore the previous model route?",
    removeDetail: "Your ChatGPT sign-in in the launcher stays. Restart Codex once.",
    catalogFailure: "Codex reached the launcher, but its model catalog didn't load: HTTP {status}, {reason}. Check Activity, and export a safe log if it keeps failing.",
  }),
  "zh-CN": Object.freeze({
    openLauncher: "打开 Codex Web GPT",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
    catalogFailure: "Codex 已连接到启动器，但模型列表加载失败（HTTP {status}；{reason}）。请查看“活动”了解详情；若问题持续，请导出安全日志。",
  }),
  "zh-TW": Object.freeze({
    openLauncher: "開啟 Codex Web GPT",
    quit: "結束",
    exportDiagnostics: "匯出已保護私隱的診斷資料",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "從 Codex 移除 ChatGPT Web 模型並還原先前的模型路由？",
    removeDetail: "啟動器中的 ChatGPT 登入 profile 會保留。Codex 需要重新啟動一次。",
    catalogFailure: "Codex 已連線到啟動器，但模型清單載入失敗（HTTP {status}；{reason}）。請查看「活動」了解詳情；若問題持續，請匯出安全日誌。",
  }),
  ja: Object.freeze({
    openLauncher: "Codex Web GPT を開く",
    quit: "終了",
    exportDiagnostics: "プライバシー保護済みの診断情報をエクスポート",
    cancel: "キャンセル",
    remove: "削除",
    removeTitle: "Codex Web GPT を削除",
    removeMessage: "Codex から ChatGPT Web モデルを削除し、以前のモデルルートを復元しますか？",
    removeDetail: "ランチャーの ChatGPT ログインプロファイルは保持されます。Codex を一度再起動する必要があります。",
    catalogFailure: "Codex はランチャーに接続しましたが、モデル一覧を読み込めませんでした（HTTP {status}、{reason}）。「アクティビティ」で詳細を確認し、問題が続く場合は安全なログをエクスポートしてください。",
  }),
});

function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

function updateTrayMenu(language) {
  if (!tray) return;
  const copy = nativeCopyFor(language);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.openLauncher, click: () => showMainWindow() },
    { type: "separator" },
    { label: copy.restartKeepBridge || "Restart app (keep Codex bridge, MCP, CPA)", click: () => { void requestQuit({ keepBridge: true, relaunch: true }); } },
    { label: copy.quit, click: () => { void requestQuit(); } },
  ]));
}

function createTray(logger, language) {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(LAUNCHER_PROFILE.displayName);
    updateTrayMenu(language);
    tray.on("click", () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  // A Windows login launch may still be materializing the packaged runtime when the user opens
  // the desktop shortcut. Electron delivers `second-instance` immediately, before `createWindow`
  // has produced anything to show. Preserve that foreground request until the real window reaches
  // `ready-to-show`; otherwise the already-running `--hidden` instance silently consumes it.
  mainWindowShowRequested = true;
  if (!mainWindowReadyToShow || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShowRequested = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === (updateController
    ? pathToFileURL(updateController.getRendererPath()).href
    : PACKAGED_RENDERER_URL);
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: LAUNCHER_PROFILE.displayName,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "..", "build", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  installCpaPanelSession({
    webContents: window.webContents,
    webFrameMain,
    getConnection: () => externalServicesController?.cpaConnection(),
    logger,
  });
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (mainWindow === window && isMainFrame && !inPlace && rendererNavigationAllowed(url)) {
      registerHost?.setSurfaceActive(false);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && tray) window.hide();
    else void requestQuit();
  });
  // A crashed renderer left a blank window while this process kept the single-instance lock, so
  // launching the app again only woke the dead window: it "could not be launched back". The page
  // is reloaded instead; after three crashes in two minutes the whole app restarts.
  // The same recovery serves a page that went blank or hung without its renderer dying
  // (renderer-watchdog.cjs): those left the window black until the app was restarted by hand.
  const rendererCrashes = [];
  const recoverRenderer = (reason) => {
    if (quitting || window.isDestroyed()) return;
    const at = Date.now();
    while (rendererCrashes.length && at - rendererCrashes[0] > 120_000) rendererCrashes.shift();
    rendererCrashes.push(at);
    logger.info("launcher.renderer_recovering", { reason, recent: rendererCrashes.length });
    const reload = () => {
      if (window.isDestroyed() || quitting) return;
      void loadRenderer(window).catch((error) => logger.warn("launcher.renderer_reload_failed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    };
    // A page that twice in a row never finished loading is no page fault: Chromium itself is stuck
    // (seen after a Windows restart with no network service), and only a fresh process loads again.
    if (rendererCrashes.length >= 3 || reason === "stalled-again") {
      // A restart the app refuses (a browser operation still running) leaves the window reloaded instead.
      void requestQuit({ keepBridge: true, relaunch: true }).catch(() => undefined).finally(() => setTimeout(reload, 500));
      return;
    }
    setTimeout(reload, 500);
  };
  window.webContents.on("render-process-gone", (_event, details) => {
    if (mainWindow === window) registerHost?.setSurfaceActive(false);
    logger.warn("launcher.renderer_gone", { reason: details?.reason, exitCode: details?.exitCode });
    if (details?.reason === "clean-exit") return;
    recoverRenderer("gone");
  });
  // A blank page (#root left empty by a render error), a hung renderer, and the page's console
  // errors (logged, so a blank window says why).
  const watchdog = createRendererWatchdog({ window, logger, recover: recoverRenderer });
  window.on("closed", () => watchdog.dispose());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainWindowReadyToShow = false;
    }
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (mainWindow === window) mainWindowReadyToShow = true;
    if (mainWindowShowRequested) showMainWindow();
    else if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }, { quitting: () => quitting });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (mainWindow === window) registerHost?.setSurfaceActive(false);
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(updateController?.getRendererPath() ?? PACKAGED_RENDERER_PATH);
}

async function ensureRendererLoaded(window, logger) {
  const packagedRendererUrl = isDev ? process.env.VITE_DEV_SERVER_URL
    : pathToFileURL(updateController?.getRendererPath() ?? PACKAGED_RENDERER_PATH).href;
  const loader = createRendererLoader({
    getUrl: () => {
      try {
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return "";
        return window.webContents.getURL();
      } catch {
        return "";
      }
    },
    load: () => loadRenderer(window),
    packagedRendererUrl,
  });
  try {
    await loader.loadOnce();
    logger.info("launcher.renderer_loaded", {
      url: window.isDestroyed() ? "" : window.webContents.getURL(),
    });
  } catch (error) {
    logger.warn("launcher.early_renderer_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  loader.startRetries({
    onLoad: () => logger.info("launcher.renderer_loaded", {
      retry: true,
      url: window.isDestroyed() ? "" : window.webContents.getURL(),
    }),
    onError: (error) => logger.warn("launcher.early_renderer_failed", {
      retry: true,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

function validateLanguage(value) {
  if (value !== "en" && value !== "zh-CN" && value !== "zh-TW" && value !== "ja") {
    throw new Error("Language must be en, zh-CN, zh-TW, or ja");
  }
  return value;
}

function validateBrowserInteractionMode(value) {
  if (value !== "automatic" && value !== "manual") {
    throw new Error("Browser interaction mode must be automatic or manual");
  }
  return value;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}


// An agent waiting on a tool approval stops until it is answered (AO gives up after 30 minutes and
// the agent reports it was blocked). When a run starts waiting and the app is not in front, say so:
// a notification and a flashing taskbar button. Once per wait, not on every observation.
const aoApprovalWaits = new Set();
function noticeAoApproval(update) {
  const key = `${update?.workspaceId}:${update?.runId}`;
  if (update?.attention !== "pending_approval") { aoApprovalWaits.delete(key); return; }
  if (aoApprovalWaits.has(key)) return;
  aoApprovalWaits.add(key);
  if (aoApprovalWaits.size > 200) aoApprovalWaits.delete(aoApprovalWaits.values().next().value);
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (window?.isFocused()) return;
  window?.flashFrame(true);
  if (Notification.isSupported()) {
    const notice = new Notification({ title: "An agent is waiting for your approval",
      body: "Open Coding Tools to allow or deny its request. Unanswered requests expire after 30 minutes." });
    notice.on("click", () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    notice.show();
  }
}

function assertFocusedMainWindow(event, write = false) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const valid = window
    && window === mainWindow
    && !window.isDestroyed()
    && window.isVisible()
    && !window.isMinimized()
    && (!write || (window.isFocused() && event.sender.isFocused()));
  if (!valid) {
    // Said in the user's terms: this refused chat sends and starts too, and the old wording
    // ("provider consent") left them guessing why their message did not go.
    throw new Error(write
      ? "Click into the Coding Tools window and try again: this action runs only from the focused app window"
      : "Open the Coding Tools window (not minimized) to do this");
  }
}

function launcherSnapshotPayload(stateStore, logger) {
  return {
    profile: LAUNCHER_PROFILE.kind,
    profilePaths: {
      coreHome: CORE_HOME,
      codexHome: LAUNCHER_PROFILE.codexHome,
      userData: launcherUserData,
    },
    state: stateStore.read(),
    browser: safeRead(
      "launcher.browser_snapshot",
      () => browserHost?.snapshot() ?? null,
      null,
      logger,
    ),
    connectorName: runtimeHost?.browserConnectorName?.() ?? "",
    connectorNames: {
      automatic: runtimeHost?.setupConnectorName?.() ?? "",
      manual: "Codex Zero Risk",
    },
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured?.() ?? false,
    chatAgentSandbox: safeRead("launcher.chat_sandbox_snapshot", () => chatAgentTools?.sandboxed?.() ?? false, false, logger),
    logs: logger.recent(),
    urls: { github: GITHUB_URL, x: X_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    upstreamTools: safeRead(
      "launcher.upstream_tools_snapshot",
      () => upstreamToolController?.snapshot() ?? { version: 1, tools: [] },
      { version: 1, tools: [] },
      logger,
    ),
    externalServices: safeRead(
      "launcher.external_services_snapshot",
      () => externalServicesController?.snapshot() ?? { version: 1, services: [] },
      { version: 1, services: [] },
      logger,
    ),
    update: updateController?.getState() ?? { status: "disabled" },
  };
}

function installWindowControlIpc() {
  if (registeredIpcChannels.has("launcher:window-control")) return;
  registeredIpcChannels.add("launcher:window-control");
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

function registerMinimalPreRendererIpc({ logger, stateStore }) {
  const handle = (channel, handler) => {
    if (registeredIpcChannels.has(channel)) return;
    registeredIpcChannels.add(channel);
    registerLoggedIpc(ipcMain, logger, channel, handler);
  };
  handle("launcher:snapshot", async () => launcherSnapshotPayload(stateStore, logger));
  installWindowControlIpc();
  ipcRegistrar.markMinimal();
  logger.info("launcher.ipc_minimal_registered", { reason: "pre-renderer" });
}

function registerIpc({ logger, stateStore }) {
  // Runtime > RTK's handlers read the service the startup made (set below, after the logger).
  const rtk = { status: () => rtkService?.status(), gain: () => rtkService?.gain(), install: () => rtkService?.install() };
  if (ipcRegistrar.isFull()) {
    logger.info("launcher.ipc_already_registered", { reason: "idempotent" });
    return;
  }
  const handle = (channel, handler) => {
    if (registeredIpcChannels.has(channel)) return;
    registeredIpcChannels.add(channel);
    registerLoggedIpc(ipcMain, logger, channel, handler);
  };
  const codingTools = createCodingToolsShellBridge({
    assertFocusedMainWindow,
    getHeadlessHost: () => headlessHost,
    getUpdateController: () => updateController,
  });
  handle("coding-tools:runtime:status", (event) => codingTools.runtimeStatus(event));
  handle("coding-tools:workspaces:list", (event, input) => codingTools.listWorkspaces(event, input));
  handle("coding-tools:workspaces:create", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost || !input || Object.keys(input).some((key) => !["path", "name", "confirm"].includes(key))
      || input.confirm !== true || typeof input.path !== "string" || input.path.length > 4096
      || !path.isAbsolute(input.path) || input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128)) {
      throw new Error("Select an absolute workspace directory and confirm creation");
    }
    const canonical = await fs.promises.realpath(input.path);
    if (!(await fs.promises.stat(canonical)).isDirectory()) throw new Error("Workspace must be a directory");
    const created = await headlessHost.request("/api/v1/workspaces", {
      path: canonical, ...(input.name ? { name: input.name.trim() } : {}), confirm: true,
    }, { localConfirmation: true });
    return { cancelled: false, id: created.id, name: created.name, path: created.path };
  });
  // The chat's Edit project dialog. Its Save is the user's confirmation; the folders were picked
  // with the system folder dialog, and the service validates them like a new project's.
  handle("coding-tools:workspaces:update", async (event, input) => {
    assertFocusedMainWindow(event, true);
    const folderText = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value);
    if (!headlessHost || !input || Object.keys(input).some((key) => !["workspaceId", "name", "path", "linkedPaths", "confirm"].includes(key))
      || input.confirm !== true || typeof input.workspaceId !== "string" || !input.workspaceId || input.workspaceId.length > 128
      || typeof input.name !== "string" || !input.name.trim() || input.name.length > 128 || !folderText(input.path)
      || !Array.isArray(input.linkedPaths) || input.linkedPaths.length > 32 || !input.linkedPaths.every(folderText)) {
      throw new Error("Give the project a name and absolute folders, then save");
    }
    const folders = [input.path, ...input.linkedPaths];
    const canonical = [];
    for (const folder of folders) {
      const resolved = await fs.promises.realpath(folder).catch(() => null);
      if (!resolved || !(await fs.promises.stat(resolved)).isDirectory()) throw new Error(`This folder no longer exists: ${folder}`);
      canonical.push(resolved);
    }
    return headlessHost.request("/api/v1/workspaces/update", {
      workspace_id: input.workspaceId,
      name: input.name.trim(),
      path: canonical[0],
      linked_paths: canonical.slice(1),
      confirm: true,
    }, { localConfirmation: true });
  });
  // "Remove local project": drops the project from the list only. The dialog asks first; the
  // service refuses while the project's missions or listeners are running.
  handle("coding-tools:workspaces:remove", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost || !input || Object.keys(input).some((key) => !["workspaceId", "confirm"].includes(key))
      || input.confirm !== true || typeof input.workspaceId !== "string" || !input.workspaceId || input.workspaceId.length > 128) {
      throw new Error("Confirm removing the project");
    }
    return headlessHost.request("/api/v1/workspaces/remove", {
      workspace_id: input.workspaceId,
      confirm: true,
    }, { localConfirmation: true });
  });
  handle("coding-tools:workspaces:auth-update", async (event, input) => {
    assertFocusedMainWindow(event, true);
    const catalog = await headlessHost.request("/api/v1/workspaces", null, { method: "GET" });
    const workspace = Array.isArray(catalog.workspaces)
      ? catalog.workspaces.find((item) => item.id === input.workspaceId)
      : null;
    if (!workspace) throw new Error("Workspace was not found");
    const name = String(workspace.name || workspace.id).replace(/[\r\n]/g, " ");
    const location = String(workspace.path || "").replace(/[\r\n]/g, " ");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Coding Tools",
      message: "Save workspace authentication settings?",
      detail: `${name}\n${location}\n${input.service}: ${input.authType}\nRestart a running listener to apply this change.`,
      buttons: ["Cancel", "Save settings"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { ok: false, cancelled: true };
    return headlessHost.request("/api/v1/workspaces/auth", {
      workspace_id: input.workspaceId,
      service: input.service,
      auth_type: input.authType,
      oauth_client_id: input.oauthClientId,
      oauth_redirect_uris: input.oauthRedirectUris,
      oauth_scopes: input.oauthScopes,
      use_shared_secrets: input.useSharedSecrets,
      confirm: true,
    });
  });
  handle("coding-tools:workspaces:policy-update", async (event, input) => {
    assertFocusedMainWindow(event, true);
    const catalog = await headlessHost.request("/api/v1/workspaces", null, { method: "GET" });
    const workspace = Array.isArray(catalog.workspaces)
      ? catalog.workspaces.find((item) => item.id === input.workspaceId)
      : null;
    if (!workspace) throw new Error("Workspace was not found");
    const name = String(workspace.name || workspace.id).replace(/[\r\n]/g, " ");
    const location = String(workspace.path || "").replace(/[\r\n]/g, " ");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Coding Tools",
      message: "Save workspace MCP permissions?",
      detail: `${name}\n${location}\n${input.permissionMode}, ${input.approvalMode}, ${input.toolProfile}\nScreen capture: ${input.screenCaptureEnabled ? "enabled" : "disabled"}\nRestart the MCP listener to apply this change.`,
      buttons: ["Cancel", "Save permissions"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { ok: false, cancelled: true };
    return headlessHost.request("/api/v1/workspaces/policy", {
      workspace_id: input.workspaceId,
      permission_mode: input.permissionMode,
      approval_mode: input.approvalMode,
      tool_profile: input.toolProfile,
      screen_capture_enabled: input.screenCaptureEnabled,
      confirm: true,
    });
  });
  handle("coding-tools:workspaces:service", async (event, input) => {
    const changing = input.operation !== "status";
    assertFocusedMainWindow(event, changing);
    if (changing) {
      const catalog = await headlessHost.request("/api/v1/workspaces", null, { method: "GET" });
      const workspace = Array.isArray(catalog.workspaces)
        ? catalog.workspaces.find((item) => item.id === input.workspaceId)
        : null;
      if (!workspace) throw new Error("Workspace was not found");
      const name = String(workspace.name || workspace.id).replace(/[\r\n]/g, " ");
      const location = String(workspace.path || "").replace(/[\r\n]/g, " ");
      const action = String(input.operation).replace(/[\r\n]/g, " ");
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Coding Tools",
        message: `${action} the ${input.service} listener?`,
        detail: `${name}\n${location}\nOnly the local listener changes. The tunnel settings stay as saved.`,
        buttons: ["Cancel", "Continue"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return { ok: false, cancelled: true };
    }
    return headlessHost.request("/api/v1/workspaces/service", {
      workspace_id: input.workspaceId,
      service: input.service,
      operation: input.operation,
      confirm: changing,
    });
  });
  handle("coding-tools:workspaces:copy-secret", async (event, input) => {
    assertFocusedMainWindow(event, true);
    const catalog = await headlessHost.request("/api/v1/workspaces", null, { method: "GET" });
    const workspace = Array.isArray(catalog.workspaces)
      ? catalog.workspaces.find((item) => item.id === input.workspaceId)
      : null;
    if (!workspace) throw new Error("Workspace was not found");
    const name = String(workspace.name || workspace.id).replace(/[\r\n]/g, " ");
    const location = String(workspace.path || "").replace(/[\r\n]/g, " ");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Coding Tools",
      message: "Copy this workspace credential?",
      detail: `${name}\n${location}\n${input.key}\nIf it's missing, Coding Tools creates one locally.`,
      buttons: ["Cancel", "Copy credential"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { ok: false, cancelled: true };
    const credential = await headlessHost.request("/api/v1/workspaces/secret", {
      workspace_id: input.workspaceId,
      key: input.key,
      confirm: true,
    });
    if (credential.ok !== true || typeof credential.value !== "string" || !credential.value) {
      throw new Error("Workspace credential is unavailable");
    }
    // Electron 44+ writes the clipboard asynchronously; report "copied" only after it lands.
    await clipboard.writeText(credential.value);
    return { ok: true, copied: true, key: input.key };
  });
  handle("coding-tools:permissions:snapshot", (event, input) => codingTools.permissionsSnapshot(event, input));
  handle("coding-tools:computer:status", (event) => codingTools.computerStatus(event));
  handle("coding-tools:tasks:list", (event, input) => codingTools.listTasks(event, input));
  handle("coding-tools:history:search", (event, input) => codingTools.searchHistory(event, input));
  let nativeApprovalPromptInFlight = false;
  handle("coding-tools:native-codex:status", async (event, input) => {
    const snapshot = await codingTools.nativeCodexStatus(event, input);
    if (!input.workspaceId || !mainWindow?.isFocused() || nativeApprovalPromptInFlight
      || !Array.isArray(snapshot.pending_approvals)) return snapshot;
    const pending = snapshot.pending_approvals.find((item) => item
      && typeof item.approval_id === "string" && typeof item.path === "string");
    if (!pending) return snapshot;
    nativeApprovalPromptInFlight = true;
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Coding Tools",
        message: "Allow native Codex to edit this outside file for the current turn?",
        detail: [
          pending.path,
          String(pending.reason || "").replace(/[\r\n]/g, " ").slice(0, 500),
          "The grant covers this exact existing file for this turn only.",
        ].join("\n"),
        buttons: ["Deny", "Allow this file once"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      await headlessHost.request("/api/v1/native-codex/approval", {
        workspace_id: input.workspaceId,
        approval_id: pending.approval_id,
        allow: response === 1,
      }, { localConfirmation: true });
      return codingTools.nativeCodexStatus(event, input);
    } finally {
      nativeApprovalPromptInFlight = false;
    }
  });
  handle("coding-tools:native-codex:connect", async (event, input) => {
    assertFocusedMainWindow(event, true);
    const reviewer = input.approvalsReviewer ?? "user";
    if (reviewer !== "user" && reviewer !== "auto_review") {
      throw new Error("Unsupported native Codex approval reviewer");
    }
    if (reviewer === "auto_review" && (input.permissionProfile !== ":workspace" || input.allowModelUsage !== true)) {
      throw new Error("Codex Auto-review requires workspace permissions and explicit model-use consent");
    }
    if (!path.isAbsolute(input.executable) || !path.isAbsolute(input.codexHome)) {
      throw new Error("Select absolute native Codex executable and home paths");
    }
    const executable = await fs.promises.realpath(input.executable);
    const metadata = await fs.promises.stat(executable);
    if (!metadata.isFile() || metadata.size > 512 * 1024 * 1024 || !executable.toLowerCase().endsWith(".exe")) {
      throw new Error("Select a native codex.exe within the 512 MiB inspection limit");
    }
    const hash = require("node:crypto").createHash("sha256");
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(executable);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const digest = hash.digest("hex");
    const catalog = await headlessHost.request("/api/v1/workspaces", null, { method: "GET" });
    const workspace = Array.isArray(catalog.workspaces)
      ? catalog.workspaces.find((item) => item.id === input.workspaceId)
      : null;
    if (!workspace) throw new Error("Workspace was not found");
    const name = String(workspace.name || workspace.id).replace(/[\r\n]/g, " ");
    const location = String(workspace.path || "").replace(/[\r\n]/g, " ");
    const home = String(input.codexHome).replace(/[\r\n]/g, " ");
    const model = String(input.model).replace(/[\r\n]/g, " ");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Coding Tools",
      message: "Connect this native Codex App Server?",
      detail: [
        name, location, "Executable: " + executable, "SHA-256: " + digest,
        "Dedicated home: " + home, "Model: " + model,
        "Permission profile: " + input.permissionProfile,
        "Approval reviewer: " + (input.permissionProfile === ":workspace" ? reviewer : "native read-only default") + "; native runtime must acknowledge this selection",
        "Model use: " + (input.allowModelUsage ? "allowed" : "off")
          + "; standalone commands: " + (input.allowCommandExecution ? "allowed" : "off"),
        "Limit: " + (input.requestLimit || "unbounded") + " requests; duration: "
          + (input.lifetimeSeconds || "until stopped") + " seconds.",
        "All authenticated clients of this workspace MCP listener share this grant.",
        "An exact existing outside-file write can be approved in the Native Codex panel for the current turn. Other extra requests are declined; no unsandboxed fallback is used.",
      ].join("\n"),
      buttons: ["Cancel", "Connect"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { ok: false, cancelled: true };
    return headlessHost.request("/api/v1/native-codex/connect", {
      workspace_id: input.workspaceId,
      connection: {
        executable,
        expected_sha256: digest,
        codex_home: input.codexHome,
        allow_model_usage: input.allowModelUsage,
        allow_command_execution: input.allowCommandExecution,
        permission_profile: input.permissionProfile,
        // Explicit reviewer is submitted only for workspace mode; read-only retains its
        // native defaults. Rust requires the exact App Server policy to be acknowledged.
        ...(input.permissionProfile === ":workspace"
          ? { approval_policy: "on-request", approvals_reviewer: reviewer } : {}),
        model: input.model,
        request_limit: input.requestLimit,
        lifetime_seconds: input.lifetimeSeconds,
      },
      confirm: true,
    }, { localConfirmation: true });
  });
  handle("coding-tools:native-codex:disconnect", async (event, input) => {
    assertFocusedMainWindow(event, false);
    return headlessHost.request("/api/v1/native-codex/disconnect", {
      workspace_id: input.workspaceId,
    });
  });
  handle("coding-tools:integrations:snapshot", async (event) => {
    const snapshot = await codingTools.integrationsSnapshot(event);
    return { ...snapshot, available: true, five_stack: null };
  });
  handle("coding-tools:updates:status", (event) => codingTools.updatesStatus(event));
  handle("coding-tools:diagnostics:snapshot", (event) => codingTools.diagnosticsSnapshot(event));
  handle("coding-tools:tools:catalog", async (event, input) => {
    assertFocusedMainWindow(event, false);
    let headless = { tools: [], unavailable: true };
    try {
      headless = await codingTools.toolsCatalog(event, input);
    } catch {
      headless = { tools: [], unavailable: true };
    }
    return mergeAppsCatalog({
      ...headless,
      tools: (headless.tools || []).filter((tool) => !/^(five_stack_|paseo_|anneal_)/.test(tool.name)),
    });
  });
  handle("coding-tools:tools:call", async (event, input) => {
    if (/^(five_stack_|paseo_|anneal_)/.test(input.tool)) {
      throw new Error(`Retired Coding Tools tool: ${input.tool}`);
    }
    if (appsMcp.hasTool(input.tool)) {
      assertFocusedMainWindow(event, !appsMcp.isReadOnly(input.tool, input.arguments ?? {}));
      return appsMcp.callTool(input.tool, input.arguments ?? {}, {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
      });
    }
    return codingTools.toolsCall(event, input);
  });
  handle("coding-tools:execution:read", async (event, input) => {
    assertFocusedMainWindow(event, false);
    if (!headlessHost) throw new Error("Local execution service is unavailable");
    return headlessHost.request("/api/v1/execution/read", {
      workspace_id: input.workspaceId,
      mission_id: input.missionId ?? null,
      refresh_source: false,
    });
  });
  handle("coding-tools:execution:provider", async () => {
    throw new Error("Retired legacy execution mutation: provider");
  });
  handle("coding-tools:execution:update", async () => {
    throw new Error("Retired legacy execution mutation: update");
  });

  handle("launcher:snapshot", async () => launcherSnapshotPayload(stateStore, logger));

  handle("launcher:set-language", (_event, language) => {
    const state = stateStore.update({ language: validateLanguage(language) });
    updateTrayMenu(state.language);
    return state;
  });
  handle("launcher:open-social", async (_event, target) => {
    const url = target === "github" ? GITHUB_URL : target === "x" ? X_URL : null;
    if (!url) throw new Error("Unknown social target");
    await openWebUrl(url);
    const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
    return stateStore.update(patch);
  });
  handle("launcher:complete-onboarding", (_event, language, rawInteractionMode) => {
    const current = stateStore.read();
    if (current.autoStart) setAutostart(app, true);
    const next = stateStore.update({
      language: validateLanguage(language),
      browserInteractionMode: validateBrowserInteractionMode(rawInteractionMode),
      onboardingComplete: true,
    });
    updateTrayMenu(next.language);
    logger.info("launcher.onboarding_completed", {
      language: next.language,
      browserInteractionMode: next.browserInteractionMode,
    });
    return next;
  });

  // Opens a workspace folder in the system file manager (chat list "Open in Explorer"). Only an
  // existing directory is accepted, so nothing can be launched through it.
  handle("launcher:open-folder", async (event, folder) => {
    assertFocusedMainWindow(event, false);
    if (typeof folder !== "string" || folder.length > 4096 || !path.isAbsolute(folder)) {
      throw new Error("Choose an absolute folder path");
    }
    const resolved = path.resolve(folder);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) throw new Error("This folder no longer exists");
    const failure = await shell.openPath(resolved);
    if (failure) throw new Error(failure);
    return true;
  });

  // A chat attachment with no path of its own (a pasted screenshot): saved for the agent to open by
  // path (chat-attachments.cjs). Only from the focused window.
  handle("launcher:save-attachment", async (event, input) => {
    assertFocusedMainWindow(event, false);
    return { path: await saveChatAttachment(path.join(app.getPath("userData"), "chat-attachments"), input) };
  });

  // An attached image's thumbnail in a sent message, as Claude Code shows one (chat-attachments.cjs:
  // an image file up to 20 MB, read only).
  handle("launcher:attachment-preview", async (event, file) => {
    assertFocusedMainWindow(event, false);
    return readImagePreview(file);
  });

  // Shows an attached file in the system file manager (its card in the chat box). Only an existing
  // file is accepted, and it is only selected in its folder, never opened or run.
  handle("launcher:reveal-file", async (event, file) => {
    assertFocusedMainWindow(event, false);
    if (typeof file !== "string" || file.length > 4096 || !path.isAbsolute(file)) throw new Error("Choose an absolute file path");
    const resolved = path.resolve(file);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error("This file no longer exists");
    shell.showItemInFolder(resolved);
    return true;
  });

  // The chat's project picker ("+ New project"): the system folder dialog, over the main window.
  // It only returns the chosen path; registering it as a workspace still asks for confirmation.
  handle("launcher:choose-folder", async (event) => {
    assertFocusedMainWindow(event, true);
    const picked = await dialog.showOpenDialog(mainWindow, { title: "Add a project", properties: ["openDirectory"] });
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
  });

  // The chat list's project card shows a project's git remote as "owner/repo" (read-only; the
  // remote URL itself, which can hold credentials, never leaves the main process).
  handle("launcher:project-remote", async (event, folder) => {
    assertFocusedMainWindow(event, false);
    return readRemote(folder);
  });
  handle("launcher:project-branch", async (event, folder) => {
    assertFocusedMainWindow(event, false);
    return readBranch(folder);
  });
  // What each project's folder is in git (a repository, a worktree of one, a folder inside one,
  // not git at all, or gone), for the chat list's project labels. Read-only.
  handle("launcher:project-git", async (event, folder) => {
    assertFocusedMainWindow(event, false);
    return readGitInfo(folder);
  });

  // "Open in new window" for a Mission chat. Only the main window sends content; the chat
  // window itself is a script-free viewer with no preload (see chat-windows.cjs).
  let chatWindows = null;
  handle("launcher:chat-window", async (event, input) => {
    assertFocusedMainWindow(event, false);
    chatWindows ||= createChatWindows({ BrowserWindow, logger });
    return chatWindows.show(input);
  });

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:managed-components-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.managedComponentsSnapshot();
  });
  handle("launcher:managed-component-install", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.installManagedComponent(serviceId);
  });
  handle("launcher:managed-component-repair", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.repairManagedComponent(serviceId);
  });
  handle("launcher:managed-component-credential", (event, serviceId, key, value) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.setManagedComponentCredential(serviceId, key, value);
  });
  handle("launcher:external-services-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.snapshot();
  });
  handle("launcher:external-service-configure", (event, serviceId, input) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.configure(serviceId, input);
  });
  handle("launcher:external-service-inspect", (event, serviceId) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.inspect(serviceId);
  });
  handle("launcher:external-service-start", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.start(serviceId);
  });
  handle("launcher:external-service-stop", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.stop(serviceId);
  });
  handle("launcher:external-service-restart", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.restart(serviceId);
  });
  handle("launcher:managed-bootstrap-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!managedBootstrapController) throw new Error("Managed bootstrap controller is unavailable");
    return managedBootstrapController.getSnapshot();
  });
  handle("launcher:managed-bootstrap-reconcile", (event, input = {}) => {
    assertFocusedMainWindow(event, true);
    if (!managedBootstrapController) throw new Error("Managed bootstrap controller is unavailable");
    return managedBootstrapController.reconcile({
      reason: typeof input?.reason === "string" ? input.reason : "manual",
      componentIds: Array.isArray(input?.componentIds) ? input.componentIds : null,
    });
  });

  handle("launcher:upstream-tools-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.snapshot();
  });
  handle("launcher:upstream-tool-inspect", (event, toolId) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.inspect(toolId);
  });
  handle("launcher:upstream-tool-endpoint", (event, toolId, endpoint) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.setEndpoint(toolId, endpoint);
  });
  handle("launcher:upstream-tool-start", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.start(toolId);
  });
  handle("launcher:upstream-tool-stop", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.stop(toolId);
  });
  handle("launcher:upstream-tool-restart", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.restart(toolId);
  });
  handle("launcher:upstream-tool-open-embedded", (event, toolId, section) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.openEmbeddedTool(toolId, section);
  });
  handle("launcher:upstream-tool-open-external", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.openExternalTool(toolId, section);
  });
  handle("launcher:upstream-tool-act", (event, input = {}) => {
    const toolId = String(input.toolId || "").trim();
    if (["paseo", "anneal", "codex-router", "commandcode-proxy"].includes(toolId)) {
      throw new Error(`Retired upstream integration: ${toolId}`);
    }
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    const config = externalServicesController.upstreamConfiguration(toolId);
    const annealConnection = toolId === "anneal" ? externalServicesController.loopbackRequest("anneal") : null;
    return actUpstream({
      ...input,
      toolId,
      endpoint: annealConnection?.origin || input.endpoint || config.executionEndpoint,
      credential: toolId === "anneal" ? "" : input.credential,
    });
  });
  handle("launcher:original-ui-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.snapshot();
  });
  handle("launcher:original-ui-inspect", (event, toolId) => {
    assertFocusedMainWindow(event, false);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.inspect(toolId);
  });
  handle("launcher:original-ui-start", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.start(toolId);
  });
  handle("launcher:original-ui-stop", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.stop(toolId);
  });
  handle("launcher:original-ui-restart", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.restart(toolId);
  });
  handle("launcher:original-ui-open", (event, toolId, section) => {
    assertFocusedMainWindow(event, false);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.openEmbedded(toolId, section);
  });
  handle("launcher:original-ui-open-external", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.openExternalTool(toolId, section);
  });
  handle("launcher:original-ui-copy-cpa-key", (event) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.copyCpaManagementKey(clipboard);
  });

  handle("coding-tools:apps:list", (event) => {
    assertFocusedMainWindow(event, false);
    if (!appsHost) throw new Error("Apps host is unavailable");
    return appsHost.list();
  });
  handle("coding-tools:apps:catalog", (event) => {
    assertFocusedMainWindow(event, false);
    if (!appsHost) throw new Error("Apps host is unavailable");
    return appsHost.catalog();
  });
  handle("coding-tools:apps:call", (event, input = {}) => {
    if (!appsHost) throw new Error("Apps host is unavailable");
    // The chat surface's own background calls run on load, on a timer or when a chat opens, often
    // while focus sits in an embedded view or another app; refused there, they only filled the
    // Activity log ("Click into the Coding Tools window", 22 a night) and left the archived list,
    // the agent pre-warm and the Retry automatically switch unset. They still need a visible window.
    const passiveAoLayout = input.moduleId === "agent-orchestrator"
      && (["upstream_bounds", "upstream_hide", "chat_preview_show", "chat_preview_hide", "archived_chats", "chat_prewarm"].includes(input.operation)
        || (input.operation === "chat_auto_retry" && input.arguments?.enabled === undefined));
    assertFocusedMainWindow(event, !passiveAoLayout && !appsHost.isReadOnly(input.moduleId, input.operation));
    // A chat's preview is drawn at the pane's CSS bounds, scaled by the page's own zoom.
    if (input.moduleId === "agent-orchestrator" && input.operation === "chat_preview_show") {
      input = { ...input, arguments: { ...(input.arguments || {}), zoom: event.sender.getZoomFactor() } };
    }
    return appsHost.call(input.moduleId, input.operation, input.arguments || {});
  });

  handle("launcher:browser-bounds", (event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds), event.sender.getZoomFactor());
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => {
    const nextActive = active === true;
    return deferUiWork(() => {
      browserHost?.setSurfaceActive(nextActive);
    }, {
      onError: (error) => logger.warn("browser.surface_active_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  });
  handle("launcher:browser-show", () => browserHost.reveal(
    stateStore.read().browserInteractionMode === "automatic",
  ));
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-new", (event) => {
    assertFocusedMainWindow(event, false);
    return browserHost.createUserTab();
  });
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:manual-prompt-copy", (_event, tabId) => browserHost.copyManualPrompt(tabId));
  handle("launcher:manual-prompt-sent", (_event, tabId) => browserHost.confirmManualSent(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
      scheduleCodexBridgeAutoConnect({ logger, stateStore, reason: "browser-login" });
    }
    return browser;
  });
  // Each handler is whole by itself: module-host-parity.test.cjs runs them one at a time.
  handle("launcher:browser-refresh-auth", async () => {
    if (stateStore.read().browserInteractionMode === "manual") return browserHost.snapshot();
    const browser = await browserHost.refreshAuthentication();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
      scheduleCodexBridgeAutoConnect({ logger, stateStore, reason: "browser-refresh-auth" });
    }
    return browser;
  });
  // Setup checks the sign-in on its own while it shows "Sign in". The first look asks
  // /api/auth/session with the browser's cookies and does not navigate, so a sign-in in progress
  // in the ChatGPT view is never interrupted; only a session that is signed in is then refreshed
  // in the view. Nothing runs under a login, smoke test or turn.
  handle("launcher:browser-check-auth", async () => {
    const current = browserHost.snapshot();
    if (stateStore.read().browserInteractionMode === "manual" || current?.authenticated === true
      || browserHost.currentOperation?.() || browserHost.activeTraceId) return current;
    const readiness = await browserHost.authenticationReadiness().catch(() => null);
    if (readiness?.authenticated !== true) return browserHost.snapshot();
    logger.info("browser.setup_signin_detected", { recent: readiness.recent === true });
    const browser = await browserHost.refreshAuthentication();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
      scheduleCodexBridgeAutoConnect({ logger, stateStore, reason: "setup-signin-check" });
    }
    return browser;
  });
  handle("launcher:browser-passkey-login", async () => {
    const browser = await browserHost.openPasskeyLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
      scheduleCodexBridgeAutoConnect({ logger, stateStore, reason: "browser-passkey-login" });
    }
    return browser;
  });
  handle("launcher:browser-passkey-login-continue", () => runtimeHost.continuePasskeyLogin());
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:chatgpt-desktop-status", async () => {
    const host = getChatGptDesktop(logger);
    await host.ready;
    return host.status();
  });
  handle("launcher:chatgpt-desktop-open", async (event, slotId) => {
    assertFocusedMainWindow(event, true);
    const host = getChatGptDesktop(logger);
    await host.ready;
    return host.open(slotId);
  });
  handle("launcher:chatgpt-desktop-new-sign-in", async (event) => {
    assertFocusedMainWindow(event, true);
    const host = getChatGptDesktop(logger);
    await host.ready;
    return host.newSignIn();
  });
  handle("launcher:chatgpt-desktop-clear", async (event) => {
    assertFocusedMainWindow(event, true);
    const host = getChatGptDesktop(logger);
    await host.ready;
    return host.clearActive();
  });
  handle("launcher:chatgpt-desktop-stop", async (event) => {
    assertFocusedMainWindow(event, true);
    const host = getChatGptDesktop(logger);
    await host.ready;
    return host.stop();
  });
  // The user's own ChatGPT desktop app, shown in the ChatGPT Desktop page's preview panel. Its
  // window is a capture of another app, so only the trusted, visible main window may read it.
  handle("launcher:chatgpt-desktop-local-preview", async (event) => {
    assertFocusedMainWindow(event, false);
    return getChatGptDesktop(logger).localPreview();
  });
  // Types the panel's message into that app and sends it. Only the user's click or Enter in the
  // focused main window gets here; focus returns to Coding Tools afterwards.
  handle("launcher:chatgpt-desktop-local-send", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => key !== "text")) {
      throw new Error("A ChatGPT message needs only its text");
    }
    const native = mainWindow.getNativeWindowHandle();
    const returnTo = Number(native.length >= 8 ? native.readBigUInt64LE(0) : native.readUInt32LE(0));
    return getChatGptDesktop(logger).localSend(input.text, { returnTo });
  });
  // Workspace -> GPT Browser. Every change needs the focused main window; status is read-only.
  handle("launcher:gpt-browser-status", () => getGptBrowser(logger).status());
  handle("launcher:gpt-browser-add", (event) => {
    assertFocusedMainWindow(event, true);
    return getGptBrowser(logger).addAccount();
  });
  handle("launcher:gpt-browser-switch", (event, id) => {
    assertFocusedMainWindow(event, true);
    return getGptBrowser(logger).switchTo(id);
  });
  handle("launcher:gpt-browser-open-url", (event, url) => {
    assertFocusedMainWindow(event, true);
    return getGptBrowser(logger).openUrl(url);
  });
  handle("launcher:gpt-browser-navigate", (event, action) => {
    assertFocusedMainWindow(event, false);
    return getGptBrowser(logger).navigate(action);
  });
  handle("launcher:gpt-browser-rename", (event, input) => {
    assertFocusedMainWindow(event, true);
    return getGptBrowser(logger).rename(input?.id, input?.label);
  });
  handle("launcher:gpt-browser-remove", (event, id) => {
    assertFocusedMainWindow(event, true);
    return getGptBrowser(logger).remove(id);
  });
  handle("launcher:gpt-browser-surface-active", (_event, active) => getGptBrowser(logger).setSurfaceActive(active === true));
  handle("launcher:gpt-browser-bounds", (event, bounds) => {
    const rect = validateBounds(bounds);
    const zoom = event.sender.getZoomFactor();
    getGptBrowser(logger).setBounds({
      x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom),
    });
    return true;
  });
  handle("launcher:chatgpt-desktop-surface-active", (_event, active) => {
    getChatGptDesktop(logger).setSurfaceActive(active === true);
    return true;
  });

  // Register's page has no launcher preload; only the launcher's own frame controls its host.
  const registerFor = (event, write = false, hidden = false) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== event.sender.mainFrame) throw new Error("Register controls require the main launcher frame");
    if (!hidden) assertFocusedMainWindow(event, write);
    return getRegisterHost(logger);
  };
  handle("launcher:register-status", (event) => registerFor(event).status());
  handle("launcher:register-configure", (event, projectRoot) => registerFor(event, true).configure(projectRoot));
  handle("launcher:register-start", (event) => registerFor(event, true).start());
  handle("launcher:register-stop", (event) => registerFor(event, true).stop());
  handle("launcher:register-reload", (event) => registerFor(event, true).reload());
  handle("launcher:register-surface-active", (event, active) => registerFor(event, false, active !== true).setSurfaceActive(active === true));
  handle("launcher:register-bounds", (event, bounds) => {
    const host = registerFor(event);
    const rect = validateBounds(bounds);
    const zoom = event.sender.getZoomFactor();
    host.setBounds({
      x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom),
    });
    return true;
  });

  // Runtime -> Email. Reads require the trusted main renderer; mutations require it focused.
  handle("launcher:email-status", (event) => {
    assertFocusedMainWindow(event, false);
    return getEmailHost(logger).status();
  });
  handle("launcher:email-connect", (event, input) => {
    assertFocusedMainWindow(event, true);
    return getEmailHost(logger).connect(input);
  });
  handle("launcher:email-disconnect", (event) => {
    assertFocusedMainWindow(event, true);
    return getEmailHost(logger).disconnect();
  });
  handle("launcher:email-mailboxes", (event, input) => {
    assertFocusedMainWindow(event, false);
    return getEmailHost(logger).listMailboxes(input);
  });
  handle("launcher:email-messages", (event, input) => {
    assertFocusedMainWindow(event, false);
    return getEmailHost(logger).listMessages(input);
  });
  handle("launcher:email-message", (event, input) => {
    assertFocusedMainWindow(event, false);
    return getEmailHost(logger).getMessage(input);
  });
  handle("launcher:email-create-address", (event, input) => {
    assertFocusedMainWindow(event, true);
    return getEmailHost(logger).createAddress(input);
  });
  handle("launcher:email-delete-message", (event, input) => {
    assertFocusedMainWindow(event, true);
    return getEmailHost(logger).deleteMessage(input);
  });
  handle("launcher:email-clear-inbox", (event, input) => {
    assertFocusedMainWindow(event, true);
    return getEmailHost(logger).clearInbox(input);
  });
  handle("launcher:email-remove-mailbox", (event, input) => {
    assertFocusedMainWindow(event, true);
    return getEmailHost(logger).removeMailbox(input);
  });
  installKeysmithIpc({
    handle,
    assertFocusedMainWindow,
    dialog,
    mainWindow: () => mainWindow,
    scriptPath: app.isPackaged
      ? path.join(process.resourcesPath, "codex-keysmith", "codex-instruct-v0.6.0.py")
      : path.join(__dirname, "..", "assets", "keysmith", "codex-instruct-v0.6.0.py"),
    pythonExecutable: process.platform === "win32" ? "py" : "python3",
    codexDir: LAUNCHER_PROFILE.codexHome,
  });
  handle("launcher:chatgpt-desktop-bounds", (event, bounds) => {
    const rect = validateBounds(bounds);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    // Renderer CSS pixels -> window DIPs -> physical screen pixels for the Win32 helper.
    const zoom = event.sender.getZoomFactor();
    const content = window.getContentBounds();
    const dip = {
      x: Math.round(content.x + rect.x * zoom),
      y: Math.round(content.y + rect.y * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom),
    };
    getChatGptDesktop(logger).setBounds(process.platform === "win32" ? screen.dipToScreenRect(window, dip) : dip);
    return true;
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    if (stateStore.read().browserInteractionMode === "manual") {
      throw new Error("Browser smoke testing is disabled in Zero Risk mode");
    }
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  const performMcpVerification = async (event) => {
    const operationName = "mcp-verification";
    const activeTraceId = browserHost.activeTraceId;
    logger.info("mcp.verification_requested", {
      activeTraceId,
      launcherFocused: mainWindow?.isFocused() === true,
      rendererFocused: event?.sender?.isFocused?.() === true,
    });
    if (activeTraceId) {
      const report = {
        ok: false,
        checks: [{
          id: "connector",
          status: "error",
          message: "Finish the active Codex task before verifying the ChatGPT connector",
          detail: `Active browser turn: ${activeTraceId}`,
        }],
      };
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message: report.checks[0].message });
      return report;
    }
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = IS_DEV_PROFILE ? await runtimeHost.devDoctor() : await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    if (stateStore.read().browserInteractionMode === "manual") {
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = "Local Zero Risk runtime is healthy; connector selection remains a manual turn step";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          {
            id: "connector",
            status: "warning",
            message: `Select ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} manually for every Zero Risk turn`,
          },
        ],
      };
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = IS_DEV_PROFILE
        ? "DEV harness and connector verified"
        : "Runtime and connector verified";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: report.checks.map((check) => check.id === "connector"
          ? {
              id: "connector",
              status: "ok",
              message: `ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} is available`,
            }
          : check),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return {
        ...report,
        ok: false,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          { id: "connector", status: "error", message },
        ],
      };
    }
  };
  verifyMcpConnection = (event) => {
    if (mcpVerificationInFlight) return mcpVerificationInFlight;
    const work = performMcpVerification(event).catch(error => {
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: "mcp-verification", status: "failed", message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    }).finally(() => { if (mcpVerificationInFlight === work) mcpVerificationInFlight = null; });
    mcpVerificationInFlight = work;
    return work;
  };
  handle("launcher:mcp-verify", event => verifyMcpConnection(event));
  handle("launcher:mcp-create-connector", async event => {
    assertFocusedMainWindow(event, true);
    if (IS_DEV_PROFILE) throw new Error("Automatic connector creation is available in the production profile only");
    publishOperation({ name: "mcp-connector-create", status: "running", message: "Creating the ChatGPT connector" });
    try {
      const result = await createConfiguredConnector({ app, BrowserWindow, browserHost, runtimeHost });
      const state = stateStore.update({
        autoConnectExistingMcp: true,
        ...(result.created ? { mcpSetupComplete: false } : {}),
      });
      automaticMcpAttemptPid = null;
      send("launcher:state-changed", state);
      startCatalogVerificationMonitor({ logger, stateStore });
      publishOperation({ name: "mcp-connector-create", status: "completed", message: result.created ? "ChatGPT connector created" : "ChatGPT connector already exists" });
      return result;
    } catch (error) {
      publishOperation({ name: "mcp-connector-create", status: "failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  handle("launcher:doctor", () => IS_DEV_PROFILE ? runtimeHost.devDoctor() : runtimeHost.doctor());
  handle("launcher:cancel-turns", () => {
    if (IS_DEV_PROFILE) throw new Error("DEV chat turns are owned by the repository CLI process");
    return runtimeHost.cancelActiveTurns();
  });
  handle("launcher:uninstall-integration", async () => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex integration to remove");
    const copy = nativeCopyFor(stateStore.read().language);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [copy.cancel, copy.remove],
      defaultId: 0,
      cancelId: 0,
      title: copy.removeTitle,
      message: copy.removeMessage,
      detail: copy.removeDetail,
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    // Removal sticks even if the runtime can't stop cleanly (Codex turns in flight): the route was
    // put back already, and with the switch off nothing reconnects it.
    send("launcher:state-changed", stateStore.update({ codexRoute: false }));
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      // Never let re-publishing the descriptor replace the removal's own result or error.
      try { browserHost.writeDescriptor(); } catch (error) {
        logger.warn("browser.descriptor_write_failed", { message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    }
    const state = stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
      codexRestartRequired: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      zeroRiskProEnabled: false,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  // Settings → "Use Coding Tools in Codex". The choice is saved first, so even if restoring or
  // reconnecting the route fails now, no later setup or reconnect goes against it.
  handle("launcher:set-codex-route", async (event, enabled) => {
    assertFocusedMainWindow(event, true);
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex route");
    if (typeof enabled !== "boolean") throw new Error("Choose on or off");
    const state = stateStore.update({ codexRoute: enabled });
    send("launcher:state-changed", state);
    // A switch flipped while another launcher operation runs (seen: during Remove Codex
    // integration) waits for it instead of failing with "Another launcher operation is active".
    await waitForRuntimeHostIdle(120_000);
    const route = runtimeHost?.runtimeConfigSnapshot().configured
      ? await runtimeHost.setCodexRoute(enabled)
      : { changed: false, setupRequired: enabled, codexRestartRequired: false };
    logger.info("codex_route.set", { enabled, changed: route.changed === true, setupRequired: route.setupRequired === true });
    return { state, route: { changed: route.changed === true, setupRequired: route.setupRequired === true, codexRestartRequired: route.codexRestartRequired === true } };
  });
  handle("launcher:refresh-part", async (_event, part) => refreshPart(String(part || ""), logger));
  handle("launcher:setup-core", async () => {
    const setupState = stateStore.read();
    if (setupState.browserInteractionMode === "automatic") {
      const browser = await browserHost.probeAuthentication();
      if (!browser.authenticated) {
        throw new Error(
          IS_DEV_PROFILE
            ? "Sign in to the isolated DEV ChatGPT profile before configuring the harness"
            : "Sign in to ChatGPT before installing the Codex integration",
        );
      }
    }
    if (setupState.browserInteractionMode === "automatic"
      && !setupState.coreSetupComplete
      && !(smokePassedThisSession || smokePassedForCurrentVersion(setupState))) {
      throw new Error(
        IS_DEV_PROFILE
          ? "Run the browser smoke test before configuring the DEV harness"
          : "Run the browser smoke test before installing the Codex integration",
      );
    }
    // "Install models" is the explicit install into Codex: it opts back in to Codex's route.
    if (!IS_DEV_PROFILE && setupState.codexRoute === false) stateStore.update({ codexRoute: true });
    const result = IS_DEV_PROFILE ? await runtimeHost.setupDevCore() : await runtimeHost.setupCore();
    stateStore.update({
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      ...(result.mode === "full" ? {
        mcpRuntimeInstalled: true,
        mcpSetupComplete: false,
        mcpGuideStep: 2,
      } : {
        mcpSetupComplete: false,
        mcpRuntimeInstalled: false,
        mcpGuideStep: 0,
      }),
    });
    await browserHost.returnToIdle().catch((error) => {
      logger.warn("browser.idle_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout, restartRequired: !IS_DEV_PROFILE };
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    const currentMode = stateStore.read().browserInteractionMode;
    const interactionMode = input?.interactionMode === undefined
      ? currentMode
      : validateBrowserInteractionMode(input.interactionMode);
    const interactionModeChange = interactionMode !== currentMode;
    const setup = IS_DEV_PROFILE
      ? runtimeHost.setupDevMcp.bind(runtimeHost)
      : runtimeHost.setupMcp.bind(runtimeHost);
    const runSetup = afterRuntimeReady => setup({
      tunnelId: typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
      replace: input?.replace === true,
      interactionMode,
    }, afterRuntimeReady);
    if (!interactionModeChange && interactionMode === "automatic") await browserHost.reveal();
    const result = interactionModeChange
      ? await browserHost.withInteractionModeChange(interactionMode, runSetup)
      : await runSetup();
    const state = stateStore.update({
      browserInteractionMode: interactionMode,
      ...(interactionMode === "manual" ? { experimentalBiggerContext: false } : {}),
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE,
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (interactionModeChange) send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("The isolated DEV launcher is started explicitly from the repository CLI");
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: stateStore.update({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:bigger-context", async (_event, enabled) => {
    const result = await runtimeHost.setBiggerContext(enabled === true);
    const state = stateStore.update({
      experimentalBiggerContext: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:use-saved-chats", async (_event, enabled) => {
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      throw new Error("Finish or cancel active ChatGPT turns before changing saved chats");
    }
    // Retained tabs of the other chat kind are released on their next reuse (browser-host checks
    // the kind), so the setting needs no Codex restart.
    const result = await runtimeHost.setUseSavedChats(enabled === true);
    const state = stateStore.update({ useSavedChats: result.enabled });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:zero-risk-pro", async (_event, enabled) => {
    const browserOperation = browserHost.currentOperation();
    if (browserHost.activeTraceId || browserOperation) {
      throw new Error(
        browserHost.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing Zero Risk model profiles"
          : `Finish ${browserOperation} before changing Zero Risk model profiles`,
      );
    }
    const result = await runtimeHost.setZeroRiskPro(enabled === true);
    const state = stateStore.update({
      zeroRiskProEnabled: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE,
      codexRestartRequired: !IS_DEV_PROFILE,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:browser-interaction-mode", async (_event, rawMode) => {
    const mode = validateBrowserInteractionMode(rawMode);
    const current = stateStore.read();
    if (current.browserInteractionMode === mode) {
      return { state: current, credentialsRequired: false, targetMode: mode };
    }
    const browserOperation = browserHost.currentOperation();
    if (browserHost.activeTraceId || browserOperation) {
      throw new Error(
        browserHost.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing browser interaction mode"
          : `Finish ${browserOperation} before changing browser interaction mode`,
      );
    }
    if (!runtimeHost.mcpCredentialsConfigured(mode)) {
      return { state: current, credentialsRequired: true, targetMode: mode };
    }
    const result = await browserHost.withInteractionModeChange(
      mode,
      afterRuntimeReady => runtimeHost.setBrowserInteractionMode(mode, afterRuntimeReady),
    );
    const state = stateStore.update({
      browserInteractionMode: mode,
      ...(mode === "manual" ? { experimentalBiggerContext: false } : {}),
      ...(result.configured ? {
        codexCatalogVerified: IS_DEV_PROFILE,
        codexRestartRequired: !IS_DEV_PROFILE,
      } : {}),
    });
    send("launcher:state-changed", state);
    send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE && result.configured) startCatalogVerificationMonitor({ logger, stateStore });
    return { state, credentialsRequired: false, targetMode: mode };
  });
  // Runtime > RTK: whether rtk is installed and on, its savings, and installing it (winget).
  handle("rtk:status", async () => (await rtk.status()) ?? { enabled: false, installed: false, path: null, version: null });
  handle("rtk:gain", async () => (await rtk.gain()) ?? { available: false });
  handle("rtk:install", async (event) => {
    // Installing software is the person's own click in the visible app.
    assertFocusedMainWindow(event, true);
    if (!rtkService) throw new Error("RTK is unavailable in this build");
    return rtk.install();
  });
  handle("launcher:set-preference", (_event, key, value) => {
    const ordinary = key === "keepRunningOnClose" || key === "showBrowserDuringTurns" || key === "autoConnectExistingMcp"
      || key === "chatAgentTools" || key === "chatAgentDesktopTools" || key === "chatAgentTerminalTools" || key === "chatAgentPreviewTools"
      || key === "confirmAgentToolRequests" || key === "rtkEnabled";
    if (!ordinary) throw new Error("Unknown preference");
    // Consent: auto-connecting MCP, letting chat agents see and drive the screen or run commands,
    // and dropping the dialog that confirms their tool requests, are the user's.
    if (key === "autoConnectExistingMcp" || ((key === "chatAgentDesktopTools" || key === "chatAgentTerminalTools") && value === true)
      || (key === "confirmAgentToolRequests" && value === false)) {
      assertFocusedMainWindow(_event, true);
    }
    const state = stateStore.update({ [key]: value === true });
    if (key === "autoConnectExistingMcp") {
      automaticMcpAttemptPid = null;
      send("launcher:state-changed", state);
      if (state.autoConnectExistingMcp) startCatalogVerificationMonitor({ logger, stateStore });
    }
    return state;
  });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:export-logs", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const copy = nativeCopyFor(stateStore.read().language);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: copy.exportDiagnostics,
      defaultPath: path.join(app.getPath("documents"), `codex-web-gpt-diagnostics-${date}.jsonl`),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const recordCount = exportSanitizedLogs({
      filePath: logger.filePath,
      destinationPath: result.filePath,
    });
    logger.info("launcher.logs_exported", { recordCount });
    return result.filePath;
  });
  handle("launcher:update-check", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    return updateController.checkNow({ force: true });
  });
  handle("launcher:update-automatic", async (_event, enabled) => {
    const state = stateStore.update({ automaticUpdates: enabled === true });
    send("launcher:state-changed", state);
    updateController?.stopPeriodicChecks();
    if (state.automaticUpdates && updateController) {
      updateController.startPeriodicChecks();
      void updateController.checkNow({ force: true }).catch((error) => {
        logger.warn("launcher.update_check_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return state;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    return updateController.beginInstall();
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  installWindowControlIpc();
  ipcRegistrar.markFull();
  logger.info("launcher.ipc_full_registered", {
    reason: "ready-path",
    channels: registeredIpcChannels.size,
  });
}

async function requestQuit({ keepBridge = false, relaunch = false } = {}) {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const browserOperation = browserHost?.currentOperation();
    if (browserOperation) {
      throw new Error(`Wait for ${browserOperation} to finish before quitting Codex Web GPT`);
    }
    quitting = true;
    await Promise.allSettled([runtimeStartupInFlight, codexBridgeConnectInFlight].filter(Boolean));
    const runtimeOperation = runtimeHost?.currentOperation();
    if (runtimeOperation) {
      throw new Error(`Wait for ${runtimeOperation} to finish before quitting Codex Web GPT`);
    }
    try {
      // A keep-bridge restart leaves Codex pointed at the bridge, which stays running.
      if (!keepBridge) await runtimeHost?.restoreBridgeRoute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const decision = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        buttons: ["Cancel", "Quit anyway"],
        defaultId: 0,
        cancelId: 0,
        title: "Couldn't restore the Codex route",
        message: "Coding Tools couldn't restore Codex's previous model route.",
        detail: `${message}\n\nIf you quit now, Codex may point at a local bridge that isn't running.`,
      });
      if (decision.response !== 1) throw error;
      publishOperation({
        name: "launcher-quit",
        status: "warning",
        message: `Quitting without restoring the Codex route: ${message}`,
      });
    }
    managedBootstrapController?.dispose();
    originalUiController?.dispose();
    externalServicesController?.dispose({ keepPersistent: keepBridge });
    upstreamToolController?.dispose();
    const detached = keepBridge ? await runtimeSupervisor?.detach(relaunch ? "launcher-restart" : "launcher-quit").catch((error) => {
      publishOperation({ name: "launcher-quit", status: "warning", message: `Couldn't keep the Codex bridge running: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }) : null;
    if (detached?.status !== "detached") await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    else {
      // The bridge stays up without this app's browser until the next app starts (an update can take
      // minutes): a Codex turn that reaches it meanwhile waits for the new app instead of failing.
      try { writeRestartMarker(BROWSER_DESCRIPTOR_PATH, { reason: relaunch ? "relaunch" : "update" }); }
      catch (error) { quitLogger?.warn("launcher.restart_marker_failed", { message: error instanceof Error ? error.message : String(error) }); }
    }
    stopBridgeWatchdog();
    // Each awaited stop has a deadline: one that never settled left the app running after the
    // bridge was already detached, with nothing logged. An overrun is logged and the quit goes on.
    const step = (name, work, ms) => boundedQuitStep(name, work, { ms,
      onTimeout: (stepName, limit) => quitLogger?.warn("launcher.quit_step_timeout", { step: stepName, ms: limit }) });
    await step("headless", () => headlessHost?.shutdown("launcher-quit"));
    await step("register", () => registerHost?.shutdown());
    stopCatalogVerificationMonitor();
    updateController?.stopPeriodicChecks?.();
    autoInstaller?.stop();
    backendBundles?.stopWatching();
    await step("agent-orchestrator", () => agentOrchestratorUpstream?.stop(), 20_000);
    antigravityReauth?.stop();
    antigravityAuthBrowser?.closeAll();
    // The embedded ChatGPT instance belongs to this app; its own stop path logs failures.
    await step("chatgpt-desktop", () => chatgptDesktop?.shutdown().catch(() => {}));
    // Generous: closing views before the ChatGPT session is saved could cost the sign-in.
    await step("browser-session", () => browserHost?.persistSession(), 30_000);
    browserHost?.destroy();
    await step("browser-control", () => browserControl?.close(), 5_000);
    exitCommitted = true;
    if (relaunch) app.relaunch();
    app.quit();
    // Every stop above has run. Electron itself has still lingered after app.quit() (over a minute
    // on 2026-10-10, after browser-control overran), holding the install folder; end the process.
    setTimeout(() => {
      quitLogger?.warn("launcher.quit_forced_exit", { afterMs: QUIT_EXIT_GRACE_MS });
      app.exit(0);
    }, QUIT_EXIT_GRACE_MS).unref?.();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    try { await registerHost?.recoverAfterCancelledQuit(); }
    catch { quitLogger?.warn("launcher.register_recovery_failed", { reason: "cancelled-quit" }); }
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

async function start() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    // A window whose renderer died is reloaded before it is shown, so launching again recovers it.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isCrashed()) {
      void loadRenderer(mainWindow).catch(() => undefined);
    }
    showMainWindow();
  });

  // An update still swapping files in is waited out first (app-update-worker.cjs).
  if (app.isPackaged) await waitForUpdateApply(path.dirname(process.execPath)).catch(() => false);
  let runtimeSourceFallback = null;
  await waitForPackagedRuntimeSource({ app, resourcesPath: process.resourcesPath, coreHome: CORE_HOME,
    onFallback: (error) => { runtimeSourceFallback = error instanceof Error ? error.message : String(error); } });
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };
  installedRuntimeRoot = runtimeRootProvider();
  // Older versions' runtime copies (165 MB each) are removed in the background (pruneOldRuntimes).
  void pruneOldRuntimes({ app, coreHome: CORE_HOME }).catch(() => undefined);

  cdpPort = await findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
  // Chromium's GPU shader caches (GPUCache, DawnGraphiteCache and DawnWebGPUCache, in the app's
  // folder and in every session partition) were rewritten every few minutes. Shaders are compiled
  // again after a restart instead.
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

  await app.whenReady();
  session.defaultSession.setCertificateVerifyProc(caDistrust.verifyCertificate);
  // Remove agent executables an update set aside (in-use-files.cjs) once nothing runs them.
  if (process.platform === "win32" && app.isPackaged) {
    setImmediate(() => {
      try {
        const { sweepSetAside, agentRuntimeRoots } = require("./in-use-files.cjs");
        sweepSetAside(agentRuntimeRoots(process.resourcesPath));
        sweepUpdateLeftovers(path.dirname(process.execPath));
      } catch { /* best-effort cleanup */ }
    });
  }

  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  if (IS_DEV_PROFILE && !stateStore.read().onboardingComplete) {
    stateStore.update({
      language: stateStore.read().language || "en",
      onboardingComplete: true,
      autoStart: false,
    });
  }
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = IS_DEV_PROFILE ? { supported: false, enabled: false } : getAutostart(app);
  // Re-applying the saved autostart preference must never stop the app from starting: the
  // login item can be refused or removed by Windows policy or security software.
  let autostartStartupError = null;
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    try {
      setAutostart(app, stateStore.read().autoStart);
    } catch (error) {
      autostartStartupError = error instanceof Error ? error.message : String(error);
      // Reflect what Windows actually allows, so Settings shows the truth and launch does not
      // retry a refused login item every time; the user can turn it back on in Settings.
      stateStore.update({ autoStart: getAutostart(app).enabled });
    }
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  quitLogger = logger;
  // A throw in a timer or an event handler, or a promise nobody awaits, used to reach Electron's
  // default handler: a modal "A JavaScript error occurred in the main process" box that holds the
  // whole app until clicked (with the window in the tray it simply looked hung). It is logged
  // instead, once a minute per message, and the app goes on; start() still owns startup failures.
  const reportedFaults = new Map(); // message -> when last logged
  const reportFault = (event, error) => {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (now - (reportedFaults.get(message) ?? 0) < 60_000) return;
    reportedFaults.set(message, now);
    if (reportedFaults.size > 200) reportedFaults.delete(reportedFaults.keys().next().value);
    try {
      logger.error(event, { message: message.slice(0, 500), stack: error instanceof Error ? String(error.stack || "").slice(0, 2000) : undefined });
    } catch { /* a failing log must not become a second fault */ }
  };
  process.on("uncaughtException", (error) => reportFault("launcher.uncaught_exception", error));
  process.on("unhandledRejection", (reason) => reportFault("launcher.unhandled_rejection", reason));
  if (runtimeSourceFallback) logger.warn("runtime.packaged_source_damaged", { message: runtimeSourceFallback, using: "installed copy" });
  // Runtime > RTK: the person's installed rtk compacts the commands chat agents run (rtk.cjs).
  const rtk = require("./rtk.cjs").createRtk({ getEnabled: () => stateStore.read().rtkEnabled !== false, logger });
  rtkService = rtk;
  // Missing rtk is installed now, without a click (a failed try waits a day); AO's start waits for it.
  try {
    void rtk.autoInstall({ lastAttemptAt: stateStore.read().rtkAutoInstallAt,
      record: (at) => { stateStore.update({ rtkAutoInstallAt: at }); } });
  } catch (error) { logger.warn("rtk.auto_install_failed", { message: String(error?.message ?? error) }); }
  // The GPU process (or a utility process) dying is logged with its reason; Chromium restarts it.
  app.on("child-process-gone", (_event, details) => {
    logger.warn("launcher.child_process_gone", { type: details?.type, reason: details?.reason, exitCode: details?.exitCode, name: details?.name });
  });
  // Provider Network and the Proxy Gateway log here too (their launch events are kept until now).
  setProviderLogger(logger);
  if (autostartStartupError) logger.warn("launcher.autostart_unavailable", { message: autostartStartupError });
  // CPA outlives the app and reads a plugin's models only when it loads the plugin's auth file:
  // nudge it whenever the Cline Pass switcher's model list changes (cpa-plugin-models.cjs).
  const cpaPluginModels = require("./cpa-plugin-models.cjs").watchCpaPluginModels({
    stateRoot: path.join(app.getPath("userData"), "integrations", "state", "cpa"), logger,
  });
  app.on("will-quit", () => cpaPluginModels.stop());
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  // Updates install inside the app: a whole-app update (app-update.cjs) swaps the changed files
  // in after the app closes the way "Restart app (keep Codex bridge, MCP, CPA)" does; a GUI-only
  // update reloads the renderer in place. Neither runs an installer.
  const publishUpdateState = () => { if (updateController) send("launcher:update-state", updateController.getState()); };
  // Update checks and downloads use the launcher's network (proxy, Chromium's resolver), as the
  // ChatGPT browser does; Node's https alone failed with "getaddrinfo ENOTFOUND github.com".
  useNativeUpdateTransport(fetchThroughLauncherNetwork);
  updateController = combineUpdateControllers(
    createAppUpdateController({
      currentVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      packaged: app.isPackaged && !IS_DEV_PROFILE,
      executablePath: process.execPath,
      logsDirectory: app.getPath("logs"),
      publish: publishUpdateState,
      logger,
      closeForUpdate: () => requestQuit({ keepBridge: true }),
    }),
    createGuiUpdateController({
      currentVersion: app.getVersion(),
      shellHash: guiShellHash(__dirname),
      packaged: app.isPackaged && !IS_DEV_PROFILE,
      rendererPath: PACKAGED_RENDERER_PATH,
      updateRoot: path.join(app.getPath("userData"), "gui-updates"),
      reloadRenderer: (entry) => mainWindow.loadFile(entry),
      publish: publishUpdateState,
      logger,
    }),
  );
  // With automatic updates on, a found update installs itself while the user is away and no
  // browser, bridge or AO turn is running; the sidebar's "Update to" button still works any time.
  autoInstaller = createAutoInstaller({
    controller: updateController,
    enabled: () => stateStore.read().automaticUpdates === true,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    isBusy: async () => Boolean(browserHost?.currentOperation() || runtimeHost?.currentOperation()
      || runtimeStartupInFlight || codexBridgeConnectInFlight
      || await agentOrchestratorUpstream?.harness.anySessionWorking()),
    logger,
  });
  registerMinimalPreRendererIpc({ logger, stateStore });
  externalServicesController = createManagedExternalServicesController({
    dataRoot: path.join(app.getPath("userData"), "integrations"),
    resolveRuntimeExecutable: () => {
      const runtimeRoot = runtimeRootProvider();
      if (runtimeRoot) return runtimeBundlePaths(runtimeRoot, process.platform).executable;
      // A source run has no bundled runtime: use the same Bun the bridge runtime runs on.
      const sourceBun = !app.isPackaged
        && (process.env.CODEX_CHATGPT_WEB_BUN?.trim() || process.env.CODEX_WEB_GPT_BUN?.trim());
      if (sourceBun) return sourceBun;
      throw new Error("Packaged runtime is unavailable for managed components");
    },
    filePath: path.join(app.getPath("userData"), "external-services.json"),
    keyPath: path.join(app.getPath("userData"), "external-services.key"),
    safeStorage,
    env: process.env,
    logger,
    // CPA (the local model proxy) is core: it outlives launcher restarts and backend updates.
    persistentComponents: IS_DEV_PROFILE ? [] : ["cpa"],
    publish: (value) => send("launcher:external-services-changed", value),
  });
  setProviderCpaConnection(() => externalServicesController?.cpaConnection());
  managedBootstrapController = createManagedBootstrap({
    snapshot: () => externalServicesController.snapshot(),
    install: (serviceId) => externalServicesController.installManagedComponent(serviceId),
    repair: (serviceId) => externalServicesController.repairManagedComponent(serviceId),
    start: (serviceId) => externalServicesController.start(serviceId),
    inspect: (serviceId) => externalServicesController.inspect(serviceId),
    logger,
    publish: (value) => send("launcher:managed-bootstrap-changed", value),
  });
  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
    externalServices: externalServicesController,
  });
  originalUiController = createOriginalUiController({
    resumeOnCreate: false,
    externalServices: externalServicesController,
    openExternal: openWebUrl,
    electronExecutable: process.execPath,
    logger,
    powerSaveBlocker,
    longRun: {
      statePath: path.join(app.getPath("userData"), "cpa-codex-long-run.json"),
      powerSaveBlocker,
    },
  });
  const providerServices = createAppsProviderServices({ providerNetworkReady });
  // MCP Events: incidents detected here are delivered by the headless service's event hub
  // to the webhook subscriptions ChatGPT created on the workspace MCP listeners. Reports
  // wait for an already-running headless service; they never start one.
  let mcpEventProxyPushed = null;
  const runningHeadless = () => {
    if (!headlessHost?.control) throw new Error("Local execution service is not running");
    return headlessHost;
  };
  const mcpEventMonitor = createMcpEventMonitor({
    logger,
    report: (entry) => runningHeadless().request("/api/v1/events/emit", entry, { timeout: 10_000 }),
    configure: async (proxy) => {
      const service = runningHeadless();
      const pushed = `${service.control.endpoint}|${proxy ?? ""}`;
      if (pushed === mcpEventProxyPushed) return;
      await service.request("/api/v1/events/config", { proxy }, { timeout: 10_000 });
      mcpEventProxyPushed = pushed;
    },
    bridgeHealthUrl: () => {
      // Probe the Codex bridge only while this launcher owns or adopted it.
      if (!runtimeSupervisor?.daemon || !runtimeHost) return null;
      try {
        const snapshot = runtimeHost.runtimeConfigSnapshot();
        const config = snapshot.config;
        if (!snapshot.configured || config?.host !== "127.0.0.1" || !Number.isInteger(config.port)) return null;
        return `http://127.0.0.1:${config.port}/healthz`;
      } catch {
        return null;
      }
    },
  });
  if (!LAUNCHER_SMOKE_TEST) mcpEventMonitor.start();
  // `signal` closes the dialog unanswered (a chat agent's prompt "Approve for me" answers itself
  // after 20 seconds).
  const confirmAoAction = async ({ message, detail, signal }) => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || !mainWindow.isFocused()) {
      throw new Error("Use the focused Coding Tools window to approve workflow changes");
    }
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "Coding Tools: Agent Orchestrator",
      message: String(message).slice(0, 200), detail: String(detail).slice(0, 65_536),
      buttons: ["Cancel", "Continue"], defaultId: 0, cancelId: 0, noLink: true,
      ...(signal ? { signal } : {}),
      // Room for a 72-column line of the detail (chat-agent-tools DISPLAY_COLUMNS) without the
      // alert wrapping it again; macOS only, Windows sizes the box to its content.
      textWidth: 640,
    });
    return answer.response === 1;
  };
  // An agent's tool request the person answered on its card in the chat: confirmed once more in a
  // dialog, which offers "Don't ask again". Either way the answer must come from the visible,
  // focused window, so it is still the person's click.
  const confirmToolRequest = async ({ message, detail }) => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || !mainWindow.isFocused()) {
      throw new Error("Use the focused Coding Tools window to answer the agent's request");
    }
    if (stateStore.read().confirmAgentToolRequests === false) return true;
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "Coding Tools: Agent Orchestrator",
      message: String(message).slice(0, 200), detail: String(detail).slice(0, 65_536),
      buttons: ["Cancel", "Continue"], defaultId: 0, cancelId: 0, noLink: true, textWidth: 640,
      checkboxLabel: "Don't ask again (turn it back on in Settings)", checkboxChecked: false,
    });
    if (answer.response === 1 && answer.checkboxChecked === true) {
      stateStore.update({ confirmAgentToolRequests: false });
      logger.info("launcher.agent_tool_confirmation_off", {});
    }
    return answer.response === 1;
  };
  // Archiving or deleting a chat (both undone by Restore) follows the same setting: with the
  // dialogs turned off, the person's click in the chat is the answer.
  const confirmRecoverable = async (request) => {
    if (stateStore.read().confirmAgentToolRequests === false) return true;
    return confirmAoAction(request);
  };
  const listHeadlessWorkspaces = async () => {
    const catalog = await headlessHost.request("/api/v1/workspaces", null, { method: "GET" });
    if (!Array.isArray(catalog.workspaces)) throw new Error("Workspace catalog is unavailable");
    return catalog.workspaces;
  };
  // The Antigravity CLI always runs through the app's global network proxy (fail closed).
  const antigravityProxyEnvironment = () => {
    const env = resolveManagedProxyEnvironment("antigravity-cli", path.join(app.getPath("userData"), "integrations"), safeStorage);
    const allowed = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY"];
    return Object.fromEntries(allowed.filter(key => typeof env[key] === "string" && env[key]).map(key => [key, env[key]]));
  };
  // Backend tier: the headless service, Agent Orchestrator, Antigravity CLI and app modules load
  // from the active backend bundle and restart in place. The GUI, Codex bridge, MCP tunnel and
  // CPA proxy are not touched when the backend changes.
  backendBundles = createBackendBundles({
    userDataRoot: app.getPath("userData"),
    builtin: {
      codeRoot: path.join(__dirname, ".."),
      appHandlerRoot: (() => { try { return resolveAppHandlerRoot(); } catch { return null; } })(),
      resourcesRoot: null,
    },
    installId: app.isPackaged ? packagedInstallId() : null,
    logger,
  });
  const startBackendFrom = (backend) => {
    const { createAntigravityCli, shimProxyEnvironment, manualAuthEnvironment } = backendBundles.requireModule(backend, "antigravity-cli.cjs");
    const { createAntigravityReauth } = backendBundles.requireModule(backend, "cpa-antigravity-reauth.cjs");
    const { createAntigravityAuthBrowser } = backendBundles.requireModule(backend, "antigravity-auth-browser.cjs");
    const { createAgentOrchestratorUpstream } = backendBundles.requireModule(backend, "agent-orchestrator-upstream.cjs");
    const { createChangePulse, createRunChangeFilter } = backendBundles.requireModule(backend, "ao-session-events.cjs");
    const { createAgentOrchestratorWorkflow, resolveAoNativeConnection, aoWebCatalogForModel } = backendBundles.requireModule(backend, "agent-orchestrator-workflow.cjs");
    const { HeadlessHost } = backendBundles.requireModule(backend, "headless-host.cjs");
    const aoDataRoot = process.env.CODING_TOOLS_AO_DATA_DIR
      ? path.resolve(process.env.CODING_TOOLS_AO_DATA_DIR)
      : path.join(app.getPath("home"), ".ao", IS_DEV_PROFILE ? "coding-tools-development" : "coding-tools");
    // AO keeps every session's worktree here; a chat agent's tools are rooted only inside it.
    const aoWorktreesRoot = path.join(aoDataRoot, "worktrees");
    // Chat agents get tools over MCP, each session rooted at its own AO worktree: files, search,
    // patches and git (Settings > "Give chat agents the app's tools", on by default); commands
    // through the app's terminal only when the user opts in (Settings > "Let chat agents run
    // commands through the app's terminal"), each confirmed here unless the session bypasses
    // permissions; and screen capture and computer control only when the user opts in (Settings >
    // "Let chat agents see and control the screen"). Created once: a live session keeps its
    // server URL and credential across a backend restart.
    if (!subagentsService) {
      const { createSubagents } = backendBundles.requireModule(backend, "subagents.cjs");
      // Each subagent is an AO session started on its route the way a chat card is (the workflow's
      // launch arguments), and its requests are answered by the workflow's own rules.
      subagentsService = createSubagents({
        statePath: path.join(app.getPath("userData"), "subagents.json"),
        launchArgs: (workspaceId, route, name) => {
          if (!missionWorkflowRuntime?.subagentLaunchArgs) throw new Error("Agent Orchestrator is not ready yet");
          return missionWorkflowRuntime.subagentLaunchArgs(workspaceId, route, name);
        },
        harness: () => agentOrchestratorUpstream?.harness ?? null,
        blockedRequest: (text) => missionWorkflowRuntime?.blockedRequest?.(text) ?? true,
        recommendedAnswer: (approval) => missionWorkflowRuntime?.recommendedAnswer?.(approval) ?? { action: "decline" },
        // A model the chat agent picks runs on Claude Code and is checked against its catalog; a
        // saved team can run as one subagent.
        models: (workspaceId) => missionWorkflowRuntime?.call("models", { harness: "ao:claude-code", workspaceId }) ?? null,
        teams: () => missionWorkflowRuntime?.subagentTeams ?? null,
        logger,
      });
      app.on("will-quit", () => subagentsService?.dispose());
    }
    if (!chatAgentTools) {
      const { createChatAgentTools } = backendBundles.requireModule(backend, "chat-agent-tools.cjs");
      const { createNativeChatPreviews } = backendBundles.requireModule(backend, "chat-preview.cjs");
      // Each chat agent's own browser for previewing its dev server (Settings > "Let chat agents
      // preview their pages", on by default): loopback pages only, never the app's own services.
      const portOf = (url) => { try { return Number(new URL(url).port) || null; } catch { return null; } };
      const appServicePorts = () => [
        cdpPort, 17891, 17892, 17893, 17894, 17895, chatAgentTools?.servicePort?.(),
        portOf(headlessHost?.control?.endpoint),
        (() => { try { return runtimeHost.runtimeConfigSnapshot().config?.port; } catch { return null; } })(),
        (() => { try { return agentOrchestratorUpstream?.snapshot?.().port; } catch { return null; } })(),
        (() => { try { return portOf(externalServicesController.cpaConnection()?.baseUrl); } catch { return null; } })(),
      ].filter((port) => Number.isInteger(port) && port > 0);
      const chatPreviews = createNativeChatPreviews({
        BaseWindow, WebContentsView, Menu, clipboard, mainWindow: () => mainWindow, blockedPorts: appServicePorts, logger,
      });
      app.on("will-quit", () => chatPreviews.closeAll());
      // Agents' commands run in Codex's Windows sandbox when it is installed (its unelevated mode:
      // the worktree and package caches writable, the network on), as Codex runs its own.
      const { createSandboxRunner } = backendBundles.requireModule(backend, "chat-sandbox.cjs");
      // An agent's `ao` commands work in the app's terminal too, as in its own shell.
      const chatSandbox = createSandboxRunner({ logger, extraPath: () => [agentOrchestratorUpstream?.aoShimFolder?.(), rtk.binDir()].filter(Boolean) });
      app.on("will-quit", () => chatSandbox.killAll());
      chatAgentTools = createChatAgentTools({
        previews: chatPreviews,
        sandbox: chatSandbox,
        // "Approve for me" runs the same routine project commands through the app's terminal as it
        // allows from the agent's own shell (the workflow's list), without a dialog each.
        // The workflow running now: these tools outlive the backend start that created them, and
        // that start's own workflow is declared further down (unset if the start failed first).
        // A command RTK rewrote is judged as the command it wraps.
        routineCommand: (command) => missionWorkflowRuntime?.routineCommand?.(rtk.unwrap(command)) ?? null,
        rewriteCommand: (command) => rtk.rewrite(command),
        // ...and never answers for the user what the command approver's safety rules block.
        blockedCommand: (text) => missionWorkflowRuntime?.blockedRequest?.(text) ?? true,
        // The subagents a chat agent may start (Runtime > Subagents).
        subagents: subagentsService,
        // app_processes: the app's own processes and what they started, with CPU, memory and uptime.
        // Its own: under the install, profile or runtime folders, the app's services by name, and
        // Electron's processes (whose types it names: main, window, GPU).
        appProcesses: (options) => backendBundles.requireModule(backend, "app-processes.cjs").listAppProcesses({
          ...options,
          roots: [path.dirname(process.execPath), app.getPath("userData"), launcherUserData, installedRuntimeRoot].filter(Boolean),
          own: [process.pid],
          electron: app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type })),
        }),
        // chat_list / chat_read: the app's chats as the chat list reads them (the workflow's board
        // and runs), read-only; another project's only after the user allows it.
        chatHistory: backendBundles.requireModule(backend, "chat-history.cjs").createChatHistory({
          workspaces: listHeadlessWorkspaces,
          board: (workspaceId, taskId) => {
            if (!missionWorkflowRuntime?.call) throw new Error("Agent Orchestrator is not ready yet");
            return missionWorkflowRuntime.call("board", { workspaceId, ...(taskId ? { taskId } : {}) });
          },
          runs: (workspaceId) => {
            if (!missionWorkflowRuntime?.call) throw new Error("Agent Orchestrator is not ready yet");
            return missionWorkflowRuntime.call("runs", { workspaceId });
          },
        }),
        // schedule_wakeup: the chat is sent a follow-up after the minutes its agent chose.
        wakeups: {
          schedule: (request) => {
            if (!missionWorkflowRuntime?.scheduleWakeup) throw new Error("Agent Orchestrator is not ready yet");
            return missionWorkflowRuntime.scheduleWakeup(request);
          },
        },
        // get_goal, create_goal, update_goal: Codex's goal tools, on the chat's /goal.
        goals: {
          call: (request) => {
            if (!missionWorkflowRuntime?.goalTool) throw new Error("Agent Orchestrator is not ready yet");
            return missionWorkflowRuntime.goalTool(request);
          },
        },
        // Running agents keep their tools across app restarts (credential hashes and the port only).
        statePath: path.join(app.getPath("userData"), "chat-agent-tools.json"),
        previewEnabled: () => stateStore.read().chatAgentPreviewTools !== false,
        requestHeadless: (endpoint, body, options) => {
          if (!headlessHost) throw new Error("Local Coding Tools runtime is unavailable");
          return headlessHost.request(endpoint, body, options);
        },
        sessionWorkspace: (id, workspaceId) => {
          if (!agentOrchestratorUpstream) throw new Error("Agent Orchestrator is unavailable");
          return agentOrchestratorUpstream.harness.sessionWorkspace(id, workspaceId);
        },
        worktreesRoot: aoWorktreesRoot,
        // Every command, sensitive operation and screen or window observation is the user's call,
        // in the focused app window.
        confirm: confirmAoAction,
        enabled: () => stateStore.read().chatAgentTools !== false,
        // On by default when its commands run sandboxed (each still reviewed); without the sandbox
        // only when the user turned it on; off whenever the user turned it off.
        terminalEnabled: () => {
          const choice = stateStore.read().chatAgentTerminalTools;
          return choice === true || (choice !== false && chatSandbox.available());
        },
        desktopEnabled: () => stateStore.read().chatAgentDesktopTools === true,
        version: app.getVersion(),
        logger,
      });
      // Listening before the first launch keeps a pre-warmed session's tools identity stable.
      void chatAgentTools.listen().catch((error) => logger.warn("chat_agent_tools.listen_failed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    const createCodingToolsAppsHost = loadCreateCodingToolsAppsHost(backend.appHandlerRoot);
    const antigravityCli = createAntigravityCli({
      toolsRoot: path.join(app.getPath("userData"), "tools"),
      confirm: confirmAoAction, getWorkspaces: listHeadlessWorkspaces, logger,
    });
    antigravityAuthBrowser = createAntigravityAuthBrowser({
      BrowserWindow, sessionFor: partition => session.fromPartition(partition),
      proxyEnvironment: antigravityProxyEnvironment, cleanUserAgent,
    });
    antigravityReauth = createAntigravityReauth({
      cpaConnection: () => externalServicesController?.cpaConnection(),
      openExternal: (url, options) => antigravityAuthBrowser(url, options),
      notify: ({ title, body }) => { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); },
      statePath: path.join(app.getPath("userData"), "tools", "antigravity-reauth.json"),
      logger,
    });
    antigravityReauth.start();
    setTimeout(() => { void antigravityReauth?.sweep(); }, 90_000).unref?.();
    const antigravityCall = async (operation, args = {}) => {
      switch (operation) {
        case "status": {
          let proxy;
          try { proxy = { configured: Boolean(antigravityProxyEnvironment().HTTPS_PROXY) }; }
          catch (error) { proxy = { configured: false, error: String(error?.message || error).slice(0, 200) }; }
          return { ...antigravityCli.status(), proxy, cpa: await antigravityReauth.status() };
        }
        case "install": return antigravityCli.install();
        case "terminal_open": {
          const env = antigravityProxyEnvironment();
          if (!env.HTTPS_PROXY) throw new Error("Select an HTTP or HTTPS global proxy on the Proxy page first");
          const terminal = await agentOrchestratorUpstream.harness.openTerminal({
            executable: antigravityCli.executable(), env: manualAuthEnvironment(env), workspaceId: args.workspaceId || undefined,
          });
          return { ok: true, ...terminal, title: "agy" };
        }
        case "terminal_close":
          await agentOrchestratorUpstream.harness.closeTerminal(args.handle);
          return { ok: true };
        case "refresh": return antigravityReauth.refresh(args.name);
        case "sign_in": return antigravityReauth.signIn(args.name);
        case "cancel_sign_in": return antigravityReauth.cancelSignIn(args.name);
        case "sweep": return antigravityReauth.sweep();
        case "set_auto": return antigravityReauth.setAuto(args.auto);
        default: throw new Error("Unknown Antigravity CLI operation");
      }
    };
    const cpaQuota = backendBundles.requireModule(backend, "cpa-quota.cjs").createCpaQuota({
      getConnection: () => externalServicesController?.cpaConnection(), logger,
    });
    agentOrchestratorUpstream = createAgentOrchestratorUpstream({
      resourceRoot: backend.source === "bundle"
        ? path.join(backend.resourcesRoot, "agent-orchestrator")
        : app.isPackaged
          ? path.join(process.resourcesPath, "agent-orchestrator")
          : path.join(__dirname, "..", "build", "agent-orchestrator"),
      dataRoot: aoDataRoot,
      confirm: confirmAoAction, getWindow: () => mainWindow,
      getWorkspaces: listHeadlessWorkspaces,
      getCpaPricesPath: () => require("./cpa-managed.cjs").helperPricesPath(
        path.join(app.getPath("userData"), "integrations", "state", "cpa")),

      // rtk's folder too: a command RTK rewrote in an agent's own shell calls `rtk`.
      extraPath: () => [antigravityCli.binDir(), rtk.binDir()].filter(Boolean).join(path.delimiter),
      extraEnv: async () => {
        // An rtk install still running (the automatic one at startup) finishes first, up to 15 s:
        // the daemon's PATH and Claude's hook are fixed for its whole run.
        try { await rtk.ready(15_000); } catch { /* starts without waiting */ }
        let env = {};
        try { env = shimProxyEnvironment(antigravityProxyEnvironment()); } catch { /* no proxy for agy */ }
        // RTK's Claude Code hook, which AO puts in each Claude session's own settings (empty: off).
        try { env = { ...env, ...rtk.daemonEnvironment() }; } catch { /* runs without RTK */ }
        // Lets AO run any session's model through CPA; the daemon blanks it for the agents themselves.
        let cpaKey = null;
        try { cpaKey = externalServicesController?.cpaConnection()?.proxyApiKey; } catch { /* CPA not running */ }
        return typeof cpaKey === "string" && cpaKey ? { ...env, CODING_TOOLS_CPA_KEY: cpaKey } : env;
      },
      missionCall: (operation, args) => agentOrchestratorWorkflow.call(operation, args),
      openAuth: (url) => antigravityAuthBrowser(url),
      agentTools: chatAgentTools,
      // The context meter's plan usage limits for chats on CPA's Codex accounts (CPA Helper).
      cpaQuota,
      // Each CPA account's token use and estimated cost; Codex accounts carry those limits too.
      cpaUsage: backendBundles.requireModule(backend, "cpa-usage.cjs").createCpaUsage({
        getConnection: () => externalServicesController?.cpaConnection(), quota: cpaQuota, logger,
      }),
      WebContentsView, dialog, shell, logger,
    });
    // Push AO changes to the Mission chat instead of making it poll: AO's session feed (a role's
    // message, reasoning or tool call moved) and mission run state, batched per 150 ms.
    aoChangeWatch?.();
    const aoPulse = createChangePulse((payload) => send("launcher:ao-changed", payload));
    // Only a run whose shown state moved is pushed (an older backend bundle pushes every report).
    const runChanged = typeof createRunChangeFilter === "function" ? createRunChangeFilter() : () => true;
    const stopAoWatch = agentOrchestratorUpstream.harness.watch((change) => aoPulse.session(change.sessionId));
    aoChangeWatch = () => { stopAoWatch(); aoPulse.stop(); };
    // Chats whose agents outlived the last app run reattach now, not when the AO panel first
    // opens: until AO is back, a permission request they raised meanwhile waits unanswered.
    const upstreamAtLaunch = agentOrchestratorUpstream;
    void upstreamAtLaunch.survivingChatHosts().then((count) => {
      if (count === 0 || agentOrchestratorUpstream !== upstreamAtLaunch) return undefined;
      logger.info("ao.surviving_chats", { count });
      return upstreamAtLaunch.start();
    }).catch((error) => logger.warn("ao.surviving_chats_failed", { detail: String(error?.message ?? error).slice(0, 300) }));
    missionWorkflowRuntime?.dispose();
    const agentOrchestratorWorkflow = createAgentOrchestratorWorkflow({
      // Stop agents that sat idle for a while; their chats resume them on the next message.
      releaseIdleAgents: true,
      // Files the person attached (saved by launcher:save-attachment): reading one needs no review.
      chatAttachmentsDir: path.join(app.getPath("userData"), "chat-attachments"),
      // One run read serves the activity poll, the run loop and their checks for 300 ms.
      runReadFreshMs: 300,
      // Each launch logs where its time went (ao.launch_timing).
      logger,
      // A pre-warmed session is reused only by a launch that attaches the same app tools.
      agentToolsIdentity: (workspaceId) => chatAgentTools?.identity(workspaceId) ?? null,
      // Runtime > Subagents: its settings, saved subagents and running ones.
      subagents: subagentsService,
      // Chat goals (/goal) survive an app restart.
      goalsFile: path.join(app.getPath("userData"), "integrations", "chat-goals.json"),
      // So do the wake-ups chat agents asked for (schedule_wakeup).
      wakeupsFile: path.join(app.getPath("userData"), "integrations", "chat-wakeups.json"),
      // So do the chats' loops (/loop).
      loopsFile: path.join(app.getPath("userData"), "integrations", "chat-loops.json"),
      // So do deleted chat messages (their hidden runs and fresh-session flags).
      chatEditsFile: path.join(app.getPath("userData"), "integrations", "chat-edits.json"),
      archiveFile: path.join(app.getPath("userData"), "integrations", "chat-archive.json"),
      // The chat's own preferences ("Retry automatically").
      chatPreferencesFile: path.join(app.getPath("userData"), "integrations", "chat-preferences.json"),
      knownModelsFile: path.join(app.getPath("userData"), "integrations", "cpa-known-models.json"),
      requestHeadless: (endpoint, body, options) => {
        if (!headlessHost) throw new Error("Local Coding Tools runtime is unavailable");
        return headlessHost.request(endpoint, body, options);
      },
      cpaConnection: () => externalServicesController.cpaConnection(),
      webBridgeConnection: () => {
        const snapshot = runtimeHost.runtimeConfigSnapshot();
        const config = snapshot.config;
        if (!snapshot.configured || config?.host !== "127.0.0.1"
          || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
          throw new Error("Managed WebGPT bridge is not configured on loopback");
        }
        return { baseUrl: `http://127.0.0.1:${config.port}/v1` };
      },
      webBridgeReadiness: async () => {
        if (!browserHost || !fs.existsSync(browserHost.descriptorPath)) return { authenticated: null, ready: false };
        const session = await browserHost.authenticationReadiness();
        if (session.authenticated !== true || session.ready !== true) return session;
        const snapshot = runtimeHost.runtimeConfigSnapshot();
        const config = snapshot.config;
        if (!snapshot.configured || config?.host !== "127.0.0.1"
          || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
          return { authenticated: true, ready: false };
        }
        return { authenticated: true, ready: await runtimeSupervisor.proxyHealth(config, 2_000, undefined, true) };
      },
      // The runtime returns Codex's WebGPT High entry (Luna on a Luna-only account); other tiers
      // reuse it under their own slug (the bridge picks the effort from the slug, not this entry).
      webModelCatalog: async ({ executable, model = "chatgpt-web/high" }) => {
        const result = await runtimeHost.run("ao-web-model-catalog", ["catalog", "ao-web", "--codex", executable], {
          embedded: true, timeoutMs: 20_000, message: "Checking the WebGPT model…",
          successMessage: "WebGPT model checked",
        });
        if (typeof aoWebCatalogForModel !== "function") throw new Error("Update the Coding Tools backend to use WebGPT models");
        return aoWebCatalogForModel(JSON.parse(result.stdout), model);
      },
      resolveHarness: (selection) => resolveAoNativeConnection({ ...selection, userData: app.getPath("userData") }),
      aoHarness: agentOrchestratorUpstream.harness,
      confirm: confirmAoAction,
      confirmToolRequest,
      confirmRecoverable,
      onRunState: (update) => {
        mcpEventMonitor.runState(update);
        if (runChanged(update)) aoPulse.run(update.workspaceId, update.runId);
        noticeAoApproval(update);
      },
    });
    try {
      appsHost = createCodingToolsAppsHost({
      services: {
        inspect: (id) => externalServicesController.inspect(id),
        agentOrchestrator: (operation, args) => agentOrchestratorWorkflow.call(operation, args),
        agentOrchestratorUpstream: (operation, args) => agentOrchestratorUpstream.call(operation, args),
        antigravityCli: antigravityCall,
        start: (id) => externalServicesController.start(id),
        stop: (id) => externalServicesController.stop(id),
        restart: (id) => externalServicesController.restart(id),
        repair: (id) => externalServicesController.repairManagedComponent(id),
        loopbackRequest: (id) => externalServicesController.loopbackRequest?.(id) || null,
        listProviders: (input) => providerServices.listProviders(input),
        linkProvider: (input) => providerServices.linkProvider(input),
        unlinkProvider: (input) => providerServices.unlinkProvider(input),
        providerStatus: (input) => providerServices.providerStatus(input),
        providerCatalog: (id) => providerServices.providerCatalog(id),
        explainEmptyModels: (id, details) => providerServices.explainEmptyModels(id, details),
      },
      actUpstream,
      getFiveStack: () => getFiveStack(),
    });
    } catch (error) {
      logger.warn("apps.host_prefer_local_failed", {
        message: error instanceof Error ? error.message : String(error),
        softFail: true,
      });
      appsHost = null;
    }
    headlessHost = new HeadlessHost({
      app,
      logger,
      sourceRoot: SOURCE_ROOT,
      binaryRoot: backend.source === "bundle" ? backend.resourcesRoot : null,
      aoWorktreesRoot,
    });
    activeBackend = backend;
    missionWorkflowRuntime = agentOrchestratorWorkflow;
    void listHeadlessWorkspaces().then(items => agentOrchestratorWorkflow.restoreSchedules(items))
      .catch(() => logger.warn("ao.schedule_restore_failed", { detail: "Saved delayed starts need inspection; none were replayed." }));
    logger.info("backend.started", { source: backend.source, id: backend.id });
  };
  const startBackend = () => {
    const backend = backendBundles.current();
    try {
      startBackendFrom(backend);
    } catch (error) {
      if (backend.source !== "bundle") throw error;
      // A broken deployed backend never takes the app down: fall back to the installer's backend.
      logger.error("backend.bundle_start_failed", { id: backend.id, message: error instanceof Error ? error.message : String(error) });
      antigravityReauth?.stop();
      antigravityAuthBrowser?.closeAll();
      backendBundles.useBuiltin();
      startBackendFrom(backendBundles.current());
      publishOperation({ name: "backend-update", status: "failed", message: `Backend ${backend.id} didn't start. Using the installed backend.` });
    }
  };
  const stopBackend = async (reason) => {
    antigravityReauth?.stop();
    antigravityAuthBrowser?.closeAll();
    await agentOrchestratorUpstream?.stop().catch((error) => {
      logger.warn("backend.ao_stop_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    await headlessHost?.shutdown(reason).catch((error) => {
      logger.warn("backend.headless_stop_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    appsHost = null;
  };
  startBackend();
  let backendRestart = null;
  backendControl = {
    current: () => activeBackend,
    // Serialized: a second request waits for the running restart instead of racing it.
    restart: (reason) => {
      backendRestart = Promise.resolve(backendRestart).catch(() => undefined).then(async () => {
        await stopBackend(reason);
        startBackend();
        return { status: "restarted", source: activeBackend.source, id: activeBackend.id };
      });
      return backendRestart;
    },
  };
  backendBundles.watchIncoming(async (manifest) => {
    publishOperation({ name: "backend-update", status: "running", message: `Installing backend ${manifest.id}` });
    await backendControl.restart("backend-update");
    publishOperation({ name: "backend-update", status: "completed", message: `Backend ${manifest.id} is live. The app, Codex bridge, MCP and CPA kept running.` });
  });
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  registerIpc({ logger, stateStore });
  await ensureRendererLoaded(mainWindow, logger);
  scheduleFullIpcAfterPaint(() => {
    registerIpc({ logger, stateStore });
    if (LAUNCHER_SMOKE_TEST) return;
    originalUiController?.resume?.();
    const services = safeRead(
      "external-service.autostart_snapshot",
      () => externalServicesController?.snapshot().services ?? [],
      [],
      logger,
    );
    for (const service of services) {
      const startManagedCpa = service.id === "cpa" && service.managedInstall?.state === "installed";
      if (!service.enabled || (!service.autoStart && !startManagedCpa)) continue;
      void externalServicesController.start(service.id).catch((error) => {
        logger.warn("external-service.autostart-failed", {
          serviceId: service.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }, { logger });
  browserControl = await new BrowserControlServer({
    logger,
    // Last good Codex model catalog per account, served when the live startup request is slow.
    modelsCacheDir: path.join(app.getPath("userData"), "native-models-cache"),
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
    resolveProxy: url => session.fromPartition(LAUNCHER_PROFILE.browserPartition).resolveProxy(url),
    fetchNative: fetchThroughLauncherNetwork,
    getCodingToolsWorkspaces: () => headlessHost.request("/api/v1/workspaces", null, { method: "GET" }),
    callReadOnlyAppTool: (tool) => appsMcp.callTool(tool, {}),
    callNativeCodexTool: (body) => headlessHost.request("/api/v1/tools/call", body, { timeout: 80_000 }),
    callAgentOrchestrator: (operation, args) => appsHost.call("agent-orchestrator", operation, args),
    // Installers and patch scripts ask for this instead of killing the app, so the Codex bridge,
    // MCP tunnel and CPA stay up and the next launcher adopts them (same path as the tray item).
    requestKeepBridgeQuit: async ({ relaunch }) => {
      if (shutdownInProgress || exitCommitted) return { ok: false, message: "Launcher shutdown is already in progress" };
      logger.info("launcher.keep_bridge_quit_requested", { relaunch });
      setTimeout(() => { void requestQuit({ keepBridge: true, relaunch }); }, 100);
      return { ok: true, status: relaunch ? "restarting" : "quitting" };
    },
    onTurnEvent: (event) => {
      if (event.type === "native_fetch_failed") mcpEventMonitor.nativeFetchFailed(event);
      else if (event.type === "native_fetch_ok") mcpEventMonitor.nativeFetchSucceeded();
      else mcpEventMonitor.turnEvent(event);
    },
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: RUNTIME_SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    getRuntimeEnvironment: () => externalServicesController.runtimeEnvironment(),
    // The Codex bridge and MCP tunnel outlive launcher restarts and updates; the next launcher adopts them.
    persistentBridge: !IS_DEV_PROFILE,
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: RUNTIME_SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
    // Settings → "Use Coding Tools in Codex": absent is on (as every install before it was).
    codexRouteEnabled: () => stateStore.read().codexRoute !== false,
    refreshBrowserDescriptor: () => browserHost?.writeDescriptor(),
  });
  // Only a preference sync: an unreadable or invalid setup config (seen: a byte order mark) keeps
  // the saved mode and the app starts, as the same read a few lines on already does.
  try {
    const configuredInteractionMode = runtimeHost.runtimeConfigSnapshot().config?.browserInteractionMode;
    if ((configuredInteractionMode === "automatic" || configuredInteractionMode === "manual")
      && stateStore.read().browserInteractionMode !== configuredInteractionMode) {
      stateStore.update({ browserInteractionMode: configuredInteractionMode });
    }
  } catch (error) {
    logger.warn("runtime.config_unreadable", { message: error instanceof Error ? error.message : String(error) });
  }
  let lastPublishedBrowserAuth = false;
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    cancelTurn: IS_DEV_PROFILE ? undefined : traceId => runtimeSupervisor.cancelBrowserTurn(traceId),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    loginWithPasskey: () => runtimeHost.capturePasskeyLogin(),
    partition: LAUNCHER_PROFILE.browserPartition,
    profile: LAUNCHER_PROFILE.kind,
    publishState: (state) => {
      send("launcher:browser-state", state);
      const authenticated = state.authenticated === true;
      if (authenticated && !lastPublishedBrowserAuth && stateStore.read().codexRestartRequired === true) {
        queueMicrotask(() => scheduleCodexBridgeAutoConnect({
          logger, stateStore, reason: "browser-authenticated",
        }));
      }
      lastPublishedBrowserAuth = authenticated;
    },
    showWindow: showMainWindow,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
    // The runtime config decides the chat kind its turns open; the host must agree with it. An
    // unreadable config falls back to the synced launcher state rather than failing the turn.
    getUseSavedChats: () => {
      try {
        return runtimeHost.runtimeConfigSnapshot().config?.useSavedChats !== false;
      } catch {
        return stateStore.read().useSavedChats !== false;
      }
    },
  });
  setProviderBrowserHost(() => browserHost);
  registerIpc({ logger, stateStore });
  const trayAvailable = createTray(logger, stateStore.read().language);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = LAUNCHER_SMOKE_TEST;
  let startupAuthenticationRefresh = Promise.resolve(browserHost.snapshot());
  await ensureRendererLoaded(mainWindow, logger);
  try {
    await browserHost.ready();
  } catch (error) {
    logger.warn("browser.ready_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    scheduleFullIpcAfterPaint(() => {
      registerIpc({ logger, stateStore });
    }, {
      logger,
      skipReason: KEEP_UI_RESPONSIVE_SKIP_REASON,
    });
  }
  if (!launcherSmokeTest && stateStore.read().browserInteractionMode === "automatic") {
    // The local proxy (ProxyBridge) can still be starting when the app opens: loading chatgpt.com
    // through it then fails at once and the saved sign-in reads as signed out until the 30 s retry.
    startupAuthenticationRefresh = waitForProxyRoute(PROXY_STARTUP_WAIT_MS).then(() => browserHost.refreshAuthentication()).catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        ...navigationErrorForLog(error),
      });
      // A slow proxy or network at launch must not leave a saved sign-in looking signed out.
      scheduleAuthenticationRetry(logger);
      return browserHost.snapshot();
    });
  }
  if (!launcherSmokeTest) {
    void updateController.checkNow({ force: true }).catch((error) => {
      logger.warn("launcher.update_check_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (stateStore.read().automaticUpdates) updateController.startPeriodicChecks();
    autoInstaller.start();
  }
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    assertLauncherRuntimeVersion({
      runtimeRoot: smokeRuntimeRoot,
      result: versionResult,
    });
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
    })}\n`);
    await terminateLauncherSmoke({ app, browserHost, browserControl, mainWindow });
    return;
  }
  if (IS_DEV_PROFILE) {
    let config = null;
    try {
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("dev_profile.config_invalid", { message });
      publishOperation({ name: "dev-profile", status: "failed", message });
    }
    const state = stateStore.update({
      coreSetupComplete: Boolean(config),
      codexCatalogVerified: Boolean(config),
      mcpRuntimeInstalled: config?.mode === "full",
      ...(config?.mode !== "full" ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
      codexRestartRequired: false,
      autoStart: false,
      experimentalBiggerContext: config?.experimentalBiggerContext === true,
      useSavedChats: config?.useSavedChats !== false,
      zeroRiskProEnabled: config?.zeroRiskProEnabled === true,
    });
    send("launcher:state-changed", state);
    logger.info("dev_profile.ready", {
      configured: Boolean(config),
      mode: config?.mode || null,
      coreHome: CORE_HOME,
      userData: launcherUserData,
    });
    if (config?.mode === "full") {
      void startupAuthenticationRefresh.then(() => runtimeSupervisor.startIfConfigured()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("dev_profile.runtime_start_failed", { message });
        const failed = stateStore.update({ mcpSetupComplete: false });
        send("launcher:state-changed", failed);
      });
    }
  } else runtimeStartupInFlight = (async () => {
    // A runtime upgrade probes the ChatGPT browser, so it waits for the saved-session refresh to settle.
    // Otherwise a slow sign-in or proxy must not hold the Codex bridge down: start it after a bounded wait.
    if (runtimeHost.managedRuntimeUpgradeRequired()) await startupAuthenticationRefresh;
    else await Promise.race([startupAuthenticationRefresh, delay(STARTUP_AUTH_WAIT_MS)]);
    // The upgrade refuses to run while any operation is active, even when none is needed (seen
    // live: a sign-in's route check made every such launch fail until the watchdog restarted it).
    const upgrade = await whenRuntimeHostIdle(logger, "upgrade", () => runtimeHost.upgradeManagedRuntime());
    if (upgrade.updated) {
      const state = stateStore.update({
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        experimentalBiggerContext: runtimeHost.runtimeConfigSnapshot().config?.experimentalBiggerContext === true,
        zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
        ...(upgrade.mode === "full" ? {
          mcpRuntimeInstalled: true,
          mcpSetupComplete: false,
          mcpGuideStep: 2,
        } : {
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        }),
      });
      send("launcher:state-changed", state);
      logger.info("runtime.release_upgraded", {
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        mode: upgrade.mode,
        connectorMigrated: upgrade.connectorMigrated,
      });
    }
    const configuredRuntime = runtimeHost.runtimeConfigSnapshot();
    if (configuredRuntime.configured) {
      const enabled = configuredRuntime.config?.experimentalBiggerContext === true;
      const useSavedChats = configuredRuntime.config?.useSavedChats !== false;
      const zeroRiskProEnabled = configuredRuntime.config?.zeroRiskProEnabled === true;
      const saved = stateStore.read();
      if (saved.experimentalBiggerContext !== enabled
        || saved.useSavedChats !== useSavedChats
        || saved.zeroRiskProEnabled !== zeroRiskProEnabled) {
        const state = stateStore.update({ experimentalBiggerContext: enabled, useSavedChats, zeroRiskProEnabled });
        send("launcher:state-changed", state);
      }
    }
    // "Use Coding Tools in Codex" off: take a leftover route off at every start. This needs neither
    // the bridge nor ChatGPT, and the connect below waits for both (seen live: deferred until
    // ChatGPT was ready, so a route an older build had left stayed in Codex's config).
    if (stateStore.read().codexRoute === false) {
      await connectCodexBridgeAfterAuthentication({ logger, stateStore, reason: "startup" });
    }
    // That route check (or a sign-in's) may still be finishing; see whenRuntimeHostIdle.
    const runtime = await whenRuntimeHostIdle(logger, "start", () => runtimeSupervisor.startIfConfigured());
    // "degraded" means the bridge is up and only the MCP tunnel is still being retried.
    if (runtime.status !== "ready" && runtime.status !== "degraded") return runtime;
    const browser = await startupAuthenticationRefresh;
    if (stateStore.read().browserInteractionMode === "automatic" && browser?.authenticated !== true) {
      logger.warn("bridge.connect_deferred_until_chatgpt_ready");
      return { ...runtime, bridgeDeferred: true };
    }
    const connected = await connectCodexBridgeAfterAuthentication({ logger, stateStore, reason: "startup" });
    return { ...runtime, bridgeRouteChanged: connected.changed === true, bridgeConnected: connected.connected === true };
  })().then(async (runtime) => {
    if (runtime.bridgeDeferred) {
      const config = runtimeSupervisor.readConfig();
      const current = stateStore.read();
      const patch = {
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        mcpRuntimeInstalled: config.mode === "full",
        experimentalBiggerContext: config.experimentalBiggerContext === true,
        useSavedChats: config.useSavedChats !== false,
        zeroRiskProEnabled: config.zeroRiskProEnabled === true,
        ...(config.mode === "browser-only" ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
      };
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        const state = stateStore.update(patch);
        send("launcher:state-changed", state);
      }
      return;
    }
    if (runtime.status === "ready" || runtime.status === "degraded") {
      if (!runtime.bridgeConnected) {
        applyReadyRuntimeAfterBridge({ logger, stateStore, bridgeRouteChanged: runtime.bridgeRouteChanged === true });
      }
      return;
    }
    if (runtime.status === "not-configured") {
      const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
      const current = stateStore.read();
      if (current.coreSetupComplete || current.mcpRuntimeInstalled || current.mcpSetupComplete) {
        const state = stateStore.update({
          coreSetupComplete: false,
          codexCatalogVerified: false,
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        });
        send("launcher:state-changed", state);
      }
      if (routeRecovery.error) {
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: `Local runtime is not configured; restoring the previous Codex route also failed: ${routeRecovery.error}`,
        });
      }
      return;
    }
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    if (runtime.status === "external" || runtime.status === "needs-setup") {
      const detail = runtime.detail || (
        runtime.status === "external"
          ? "Another process owns the configured Codex Web GPT runtime"
          : "The installed runtime configuration must be repaired from Setup"
      );
      publishOperation({
        name: "runtime-start",
        status: "failed",
        message: routeRecovery.error
          ? `${detail}; restoring the previous Codex route also failed: ${routeRecovery.error}`
          : routeRecovery.restored
            ? `${detail}; the previous Codex route was restored, restart Codex once`
            : detail,
      });
    }
  }).catch(async (error) => {
    const primary = error instanceof Error ? error.message : String(error);
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const message = routeRecovery.error
      ? `${primary}; restoring the previous Codex route also failed: ${routeRecovery.error}`
      : routeRecovery.restored
        ? `${primary}; the previous Codex route was restored, restart Codex once`
        : primary;
    logger.error("runtime.startup_failed", { message });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    publishOperation({ name: "runtime-start", status: "failed", message });
  });
  // From launch on, keep the bridge and MCP tunnel alive while the app is open; the supervisor
  // coalesces a watchdog start with any launch-time start that is still in flight.
  startBridgeWatchdog(logger, stateStore);
  // A blocked main loop freezes every window; this is the only thing that can tell afterwards.
  createMainStallMonitor({ logger }).start();

  app.on("activate", () => showMainWindow());
  app.on("will-quit", () => missionWorkflowRuntime?.dispose());
  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    if (!LAUNCHER_SMOKE_TEST) {
      dialog.showErrorBox("Codex Web GPT could not start", message);
    }
  } catch {}
  app.exit(1);
});
