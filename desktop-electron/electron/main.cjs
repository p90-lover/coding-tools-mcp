const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  safeStorage,
  shell,
  Tray,
  powerSaveBlocker,
} = require("electron");
const { BrowserHost, navigationErrorForLog } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { HeadlessHost } = require("./headless-host.cjs");
const { createCodingToolsShellBridge } = require("./coding-tools-shell-bridge.cjs");
const { ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { assertLauncherRuntimeVersion, terminateLauncherSmoke } = require("./smoke-exit.cjs");
const { DEVELOPMENT_PROFILE, resolveLauncherProfile } = require("./profile.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createUpdateController } = require("./update.cjs");
const {
  providerNetworkReady,
  setProviderBrowserHost,
  setProviderCpaConnection,
} = require("./provider-bootstrap.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { createFiveStackControlPlane } = require("./five-stack-control-plane.cjs");
const { createManagedExternalServicesController } = require("./managed-external-services.cjs");
const { createManagedBootstrap } = require("./managed-bootstrap.cjs");
const { createUpstreamToolController } = require("./upstream-tools.cjs");
const { createOriginalUiController } = require("./original-ui.cjs");
const { requireAppHandler } = require("./app-handler-paths.cjs");
function loadCreateCodingToolsAppsHost() {
  try {
    return requireAppHandler("host.cjs").createCodingToolsAppsHost;
  } catch (error) {
    const failed = error;
    return function createCodingToolsAppsHostUnavailable() {
      throw failed;
    };
  }
}
const createCodingToolsAppsHost = loadCreateCodingToolsAppsHost();
const { createAppsProviderServices } = require("./apps-provider-services.cjs");
const { createCodingToolsAppsMcp, mergeAppsCatalog } = require("./coding-tools-apps-mcp.cjs");
const {
  KEEP_UI_RESPONSIVE_SKIP_REASON,
  createIpcRegistrar,
  createLazyFactory,
  createRendererLoader,
  deferUiWork,
  safeRead,
  scheduleFullIpcAfterPaint,
} = require("./launcher-ready-path.cjs");
const {
  applyCommandCodeProxyPlan,
  commandCodeProxyRegistrationPlan,
  renderCommandCodeProxyPlan,
} = require("./commandcode-proxy-plan.cjs");
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
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.codexwebgpt.launcher.dev" : "dev.codexwebgpt.launcher");
}
const launcherUserData = LAUNCHER_PROFILE.userData;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let mainWindowReadyToShow = false;
let mainWindowShowRequested = false;
let browserHost = null;
let runtimeHost = null;
let headlessHost = null;
let browserControl = null;
let runtimeSupervisor = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let updateController = null;
let externalServicesController = null;
let managedBootstrapController = null;
let upstreamToolController = null;
let originalUiController = null;
let appsHost = null;
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

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  const check = async () => {
    const current = stateStore.read();
    if (current.coreSetupComplete !== true || current.codexCatalogVerified === true) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) return;
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
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
    removeDetail: "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
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
  }),
});

function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

const UPDATE_PROMPT_COPY = Object.freeze({
  en: Object.freeze({
    title: "Coding Tools beta update",
    message: "A newer Coding Tools beta is ready.",
    detail: "Install it into the current application folder and restart Coding Tools now?",
    installNow: "Install and restart",
    later: "Later",
  }),
  "zh-CN": Object.freeze({
    title: "Coding Tools 测试版更新",
    message: "检测到较新的 Coding Tools 测试版。",
    detail: "是否安装到当前应用目录并立即重新启动 Coding Tools？",
    installNow: "安装并重新启动",
    later: "稍后",
  }),
  "zh-TW": Object.freeze({
    title: "Coding Tools 測試版更新",
    message: "偵測到較新嘅 Coding Tools 測試版。",
    detail: "要唔要安裝到目前應用程式目錄，並立即重新啟動 Coding Tools？",
    installNow: "安裝並重新啟動",
    later: "稍後",
  }),
  ja: Object.freeze({
    title: "Coding Tools ベータ更新",
    message: "新しい Coding Tools ベータ版を検出しました。",
    detail: "現在のアプリケーションフォルダーにインストールして再起動しますか？",
    installNow: "インストールして再起動",
    later: "後で",
  }),
});

function updatePromptCopyFor(language) {
  return UPDATE_PROMPT_COPY[language] || UPDATE_PROMPT_COPY.en;
}

let updatePromptVersion = null;
let updatePromptInFlight = false;

async function promptForAvailableUpdate(next, { logger, stateStore }) {
  if (next?.status !== "available" || typeof next.version !== "string") return;
  if (stateStore.read().automaticUpdates !== true) return;
  if (updatePromptInFlight || updatePromptVersion === next.version) return;

  updatePromptInFlight = true;
  updatePromptVersion = next.version;
  const copy = updatePromptCopyFor(stateStore.read().language);
  try {
    showMainWindow();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: copy.title,
      message: `${copy.message} v${next.version}`,
      detail: copy.detail,
      buttons: [copy.installNow, copy.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) {
      logger.info("launcher.update_prompt_deferred", { version: next.version });
      return;
    }
    const launch = await updateController.beginInstall();
    const quitResult = await requestQuit();
    if (!quitResult.ok) {
      updateController.cancelInstall(launch);
      throw new Error(quitResult.message);
    }
  } catch (error) {
    updatePromptVersion = null;
    logger.warn("launcher.update_prompt_failed", {
      version: next.version,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    updatePromptInFlight = false;
  }
}

function updateTrayMenu(language) {
  if (!tray) return;
  const copy = nativeCopyFor(language);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.openLauncher, click: () => showMainWindow() },
    { type: "separator" },
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
  return target.href === PACKAGED_RENDERER_URL;
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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
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
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

async function ensureRendererLoaded(window, logger) {
  const packagedRendererUrl = isDev ? process.env.VITE_DEV_SERVER_URL : PACKAGED_RENDERER_URL;
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


function assertFocusedMainWindow(event, write = false) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const valid = window
    && window === mainWindow
    && !window.isDestroyed()
    && window.isVisible()
    && !window.isMinimized()
    && (!write || (window.isFocused() && event.sender.isFocused()));
  if (!valid) {
    throw new Error("Use the visible, focused main-window controller for provider consent");
  }
}

function executionSettingsPayload(settings) {
  if (!settings) return null;
  return {
    id: settings.id ?? null,
    engine: settings.engine,
    endpoint: settings.endpoint,
    provider: settings.provider,
    model: settings.model,
    mode: settings.mode,
    project_id: settings.projectId ?? null,
    repo_id: settings.repoId ?? null,
    assignee_id: settings.assigneeId ?? null,
    max_duration_min: settings.maxDurationMin,
    allow_codex: settings.allowCodex,
    confirm_external_execution: settings.confirmExternalExecution,
  };
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
  const fiveStackControlPlane = createLazyFactory(() => createFiveStackControlPlane({
    planProvider: createProviderExecutionPlan,
    getProviderSnapshot: async () => {
      const providerNetwork = await providerNetworkReady();
      return providerNetwork.store.snapshot();
    },
    getServicesSnapshot: () => safeRead(
      "five-stack.services_snapshot",
      () => {
        if (!externalServicesController) return { version: 1, services: [] };
        return externalServicesController.snapshot();
      },
      { version: 1, services: [] },
      logger,
    ),
    inspectService: (stack) => {
      if (!externalServicesController) throw new Error("External services controller is unavailable");
      return externalServicesController.inspect(stack);
    },
    manageService: async (stack, action) => {
      if (!externalServicesController) throw new Error("External services controller is unavailable");
      if (action === "start") return externalServicesController.start(stack);
      if (action === "stop") return externalServicesController.stop(stack);
      if (action === "restart") return externalServicesController.restart(stack);
      if (action === "repair") return externalServicesController.repairManagedComponent(stack);
      throw new Error(`Unsupported manage action ${action}`);
    },
    handoffAnnealTask: async ({ projectId, body }) => {
      const config = externalServicesController?.upstreamConfiguration?.("anneal") || {};
      const result = await actUpstream({
        toolId: "anneal",
        op: "create",
        projectId,
        endpoint: config.executionEndpoint || "http://127.0.0.1:3000/",
        name: body?.name,
        description: body?.description,
        cwd: body?.workingDirectory,
      });
      return result.body && typeof result.body === "object" ? result.body : { id: null };
    },
    fetchAnnealTask: async ({ taskId }) => {
      const config = externalServicesController?.upstreamConfiguration?.("anneal") || {};
      const result = await actUpstream({
        toolId: "anneal",
        op: "preview",
        taskId,
        endpoint: config.executionEndpoint || "http://127.0.0.1:3000/",
      });
      return result.body;
    },
  }));
  getFiveStack = () => fiveStackControlPlane.tryGet();
  handle("coding-tools:runtime:status", (event) => codingTools.runtimeStatus(event));
  handle("coding-tools:workspaces:list", (event, input) => codingTools.listWorkspaces(event, input));
  handle("coding-tools:permissions:snapshot", (event, input) => codingTools.permissionsSnapshot(event, input));
  handle("coding-tools:computer:status", (event) => codingTools.computerStatus(event));
  handle("coding-tools:tasks:list", (event, input) => codingTools.listTasks(event, input));
  handle("coding-tools:history:search", (event, input) => codingTools.searchHistory(event, input));
  handle("coding-tools:native-codex:status", (event) => codingTools.nativeCodexStatus(event));
  handle("coding-tools:integrations:snapshot", async (event) => {
    const snapshot = await codingTools.integrationsSnapshot(event);
    const plane = fiveStackControlPlane.tryGet();
    return {
      ...snapshot,
      available: true,
      five_stack: plane.ok ? plane.value.apiMap() : null,
    };
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
    const plane = fiveStackControlPlane.tryGet();
    const merged = plane.ok ? plane.value.mergeCatalog(headless) : headless;
    return mergeAppsCatalog(merged);
  });
  handle("coding-tools:tools:call", async (event, input) => {
    if (appsMcp.hasTool(input.tool)) {
      assertFocusedMainWindow(event, !appsMcp.isReadOnly(input.tool, input.arguments ?? {}));
      return appsMcp.callTool(input.tool, input.arguments ?? {}, {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
      });
    }
    const plane = fiveStackControlPlane.tryGet();
    if (plane.ok && plane.value.hasTool(input.tool)) {
      assertFocusedMainWindow(event, !plane.value.isReadOnly(input.tool));
      return plane.value.callTool(input.tool, input.arguments ?? {}, {
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
      refresh_source: input.refreshSource === true,
    });
  });
  handle("coding-tools:execution:provider", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost) throw new Error("Local execution service is unavailable");

    let settings = input.settings;
    const controlCredential = typeof input.controlCredential === "string"
      ? input.controlCredential.trim()
      : "";
    const plannedWorkload = input.operation === "configure"
      && settings
      && (settings.engine === "paseo" || settings.engine === "anneal");
    if (plannedWorkload) {
      const providerNetwork = await providerNetworkReady();
      const plan = createProviderExecutionPlan(providerNetwork.store.snapshot(), {
        workload: settings.engine,
        providerId: settings.provider,
        accountId: input.providerAccountId ?? undefined,
        model: settings.model,
        allowFallback: input.allowProviderFallback !== false,
      });
      settings = {
        ...settings,
        provider: plan.provider.id,
        model: plan.model ?? settings.model,
      };
      logger.info("execution.provider_planned", {
        workload: plan.workload,
        providerId: plan.provider.id,
        accountId: plan.account.id,
        model: plan.model,
        fallbackUsed: plan.fallbackUsed,
        proxyMode: plan.proxy.mode,
        proxySource: plan.proxy.source,
        proxyProfileId: plan.proxy.profile?.id ?? null,
      });
    }

    return headlessHost.request("/api/v1/execution/provider", {
      workspace_id: input.workspaceId,
      operation: input.operation,
      expected_revision: input.expectedRevision ?? null,
      binding_id: input.bindingId ?? null,
      settings: executionSettingsPayload(settings),
      credential: controlCredential,
      confirm: input.confirm === true,
    });
  });
  handle("coding-tools:execution:update", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost) throw new Error("Local execution service is unavailable");
    return headlessHost.request("/api/v1/execution/update", {
      workspace_id: input.workspaceId,
      expected_revision: input.expectedRevision,
      change: input.change,
      confirm: input.confirm === true,
    });
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
  handle("launcher:codex-router-sync", (event) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.syncCodexRouter();
  });
  handle("launcher:commandcode-proxy-plan", (event, input = {}) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    const snapshot = externalServicesController.snapshot();
    const commandCode = snapshot.services.find((service) => service.id === "commandcode-proxy");
    const router = snapshot.services.find((service) => service.id === "codex-router");
    const baseUrl = input.baseUrl || commandCode?.endpoint || "http://127.0.0.1:9090/";
    const plan = commandCodeProxyRegistrationPlan({
      baseUrl,
      routerCli: input.routerCli || router?.routerCli || "model-router",
      curateCli: input.curateCli || router?.curateCli || "curate-models",
    });
    return {
      text: renderCommandCodeProxyPlan(plan),
      credentialPromptRequired: true,
      provider: plan.provider,
    };
  });
  handle("launcher:commandcode-proxy-apply", (event, input = {}) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    const snapshot = externalServicesController.snapshot();
    const commandCode = snapshot.services.find((service) => service.id === "commandcode-proxy");
    const router = snapshot.services.find((service) => service.id === "codex-router");
    return applyCommandCodeProxyPlan({
      baseUrl: input.baseUrl || commandCode?.endpoint || "http://127.0.0.1:9090/",
      routerCli: input.routerCli || router?.routerCli || "model-router",
      curateCli: input.curateCli || router?.curateCli || "curate-models",
    });
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
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    const toolId = String(input.toolId || "").trim();
    const config = externalServicesController.upstreamConfiguration(toolId);
    return actUpstream({
      ...input,
      toolId,
      endpoint: input.endpoint || config.executionEndpoint,
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
    assertFocusedMainWindow(event, !appsHost.isReadOnly(input.moduleId, input.operation));
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
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:manual-prompt-copy", (_event, tabId) => browserHost.copyManualPrompt(tabId));
  handle("launcher:manual-prompt-sent", (_event, tabId) => browserHost.confirmManualSent(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login", async () => {
    const browser = await browserHost.openPasskeyLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
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
  handle("launcher:mcp-verify", async (event) => {
    const operationName = "mcp-verification";
    const activeTraceId = browserHost.activeTraceId;
    logger.info("mcp.verification_requested", {
      activeTraceId,
      launcherFocused: mainWindow?.isFocused() === true,
      rendererFocused: event.sender.isFocused(),
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
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
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
  handle("launcher:set-preference", (_event, key, value) => {
    const ordinary = key === "keepRunningOnClose" || key === "showBrowserDuringTurns";
    if (!ordinary) throw new Error("Unknown preference");
    return stateStore.update({ [key]: value === true });
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
    if (state.automaticUpdates && updateController) {
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
    const launch = await updateController.beginInstall();
    const result = await requestQuit();
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
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

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting Codex Web GPT`);
    }
    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    await headlessHost?.shutdown("launcher-quit");
    stopCatalogVerificationMonitor();
    updateController?.stopPeriodicChecks?.();
    externalServicesController?.dispose();
    upstreamToolController?.dispose();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
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
  app.on("second-instance", () => showMainWindow());

  await waitForPackagedRuntimeSource({ app, resourcesPath: process.resourcesPath });
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

  cdpPort = await findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  await app.whenReady();

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
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  registerMinimalPreRendererIpc({ logger, stateStore });
  externalServicesController = createManagedExternalServicesController({
    dataRoot: path.join(app.getPath("userData"), "integrations"),
    resolveRuntimeExecutable: () => {
      const runtimeRoot = runtimeRootProvider();
      if (!runtimeRoot) throw new Error("Packaged runtime is unavailable for managed components");
      return runtimeBundlePaths(runtimeRoot, process.platform).executable;
    },
    filePath: path.join(app.getPath("userData"), "external-services.json"),
    keyPath: path.join(app.getPath("userData"), "external-services.key"),
    safeStorage,
    env: process.env,
    logger,
    publish: (value) => send("launcher:external-services-changed", value),
    runRuntimeCommand: async (args) => {
      if (!runtimeSupervisor) throw new Error("Packaged runtime is not ready");
      const invocation = runtimeSupervisor.runtimeCommand(args);
      const result = spawnSync(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env },
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || "").trim();
        throw new Error(`Codex Router integration failed (${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
      }
      return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
    },
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
  try {
    appsHost = createCodingToolsAppsHost({
    services: {
      inspect: (id) => externalServicesController.inspect(id),
      start: (id) => externalServicesController.start(id),
      stop: (id) => externalServicesController.stop(id),
      restart: (id) => externalServicesController.restart(id),
      repair: (id) => externalServicesController.repairManagedComponent(id),
      syncCodexRouter: () => externalServicesController.syncCodexRouter(),
      loopbackRequest: (id) => externalServicesController.loopbackRequest?.(id) || null,
      listProviders: (input) => providerServices.listProviders(input),
      linkProvider: (input) => providerServices.linkProvider(input),
      unlinkProvider: (input) => providerServices.unlinkProvider(input),
      providerStatus: (input) => providerServices.providerStatus(input),
      providerCatalog: (id) => providerServices.providerCatalog(id),
      explainEmptyModels: (id, details) => providerServices.explainEmptyModels(id, details),
      commandCodeProxyPlan: (input = {}) => {
        const snapshot = externalServicesController.snapshot();
        const commandCode = snapshot.services.find((service) => service.id === "commandcode-proxy");
        const router = snapshot.services.find((service) => service.id === "codex-router");
        const plan = commandCodeProxyRegistrationPlan({
          baseUrl: input.baseUrl || commandCode?.endpoint || "http://127.0.0.1:9090/",
          routerCli: input.routerCli || router?.routerCli || "model-router",
          curateCli: input.curateCli || router?.curateCli || "curate-models",
        });
        return {
          text: renderCommandCodeProxyPlan(plan),
          credentialPromptRequired: true,
          provider: plan.provider,
        };
      },
      applyCommandCodeProxyPlan: (input = {}) => {
        const snapshot = externalServicesController.snapshot();
        const commandCode = snapshot.services.find((service) => service.id === "commandcode-proxy");
        const router = snapshot.services.find((service) => service.id === "codex-router");
        return applyCommandCodeProxyPlan({
          baseUrl: input.baseUrl || commandCode?.endpoint || "http://127.0.0.1:9090/",
          routerCli: input.routerCli || router?.routerCli || "model-router",
          curateCli: input.curateCli || router?.curateCli || "curate-models",
        });
      },
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
  app.once("before-quit", () => {
    managedBootstrapController?.dispose();
    originalUiController?.dispose();
    externalServicesController?.dispose();
    upstreamToolController?.dispose();
  });
  headlessHost = new HeadlessHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
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
    const services = safeRead(
      "external-service.autostart_snapshot",
      () => externalServicesController?.snapshot().services ?? [],
      [],
      logger,
    );
    for (const service of services) {
      if (!service.enabled || !service.autoStart) continue;
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
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    getRuntimeEnvironment: () => externalServicesController.runtimeEnvironment(),
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  const configuredInteractionMode = runtimeHost.runtimeConfigSnapshot().config?.browserInteractionMode;
  if ((configuredInteractionMode === "automatic" || configuredInteractionMode === "manual")
    && stateStore.read().browserInteractionMode !== configuredInteractionMode) {
    stateStore.update({ browserInteractionMode: configuredInteractionMode });
  }
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
    publishState: (state) => send("launcher:browser-state", state),
    showWindow: showMainWindow,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  setProviderBrowserHost(() => browserHost);
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && !IS_DEV_PROFILE,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => {
      send("launcher:update-state", state);
      if (state.status === "available") {
        void promptForAvailableUpdate(state, { logger, stateStore });
      }
    },
    logger,
  });
  registerIpc({ logger, stateStore });
  const trayAvailable = createTray(logger, stateStore.read().language);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = LAUNCHER_SMOKE_TEST;
  let startupAuthenticationRefresh = Promise.resolve();
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
    startupAuthenticationRefresh = browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        ...navigationErrorForLog(error),
      });
    });
  }
  if (!launcherSmokeTest) {
    void updateController.checkNow({ force: true }).catch((error) => {
      logger.warn("launcher.update_check_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    updateController.startPeriodicChecks();
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
  } else void (async () => {
    await startupAuthenticationRefresh;
    const upgrade = await runtimeHost.upgradeManagedRuntime();
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
      const zeroRiskProEnabled = configuredRuntime.config?.zeroRiskProEnabled === true;
      const saved = stateStore.read();
      if (saved.experimentalBiggerContext !== enabled
        || saved.zeroRiskProEnabled !== zeroRiskProEnabled) {
        const state = stateStore.update({ experimentalBiggerContext: enabled, zeroRiskProEnabled });
        send("launcher:state-changed", state);
      }
    }
    const runtime = await runtimeSupervisor.startIfConfigured();
    if (runtime.status !== "ready") return runtime;
    const route = await runtimeHost.connectBridgeRoute();
    return { ...runtime, bridgeRouteChanged: route.changed === true };
  })().then(async (runtime) => {
    if (runtime.status === "ready") {
      const config = runtimeSupervisor.readConfig();
      const current = stateStore.read();
      const patch = {
        coreSetupComplete: true,
        mcpRuntimeInstalled: config.mode === "full",
        experimentalBiggerContext: config.experimentalBiggerContext === true,
        zeroRiskProEnabled: config.zeroRiskProEnabled === true,
        ...(runtime.bridgeRouteChanged ? {
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

  app.on("activate", () => showMainWindow());
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
