const {
  createProviderNetworkController,
  createProviderNetworkStore,
} = require("./provider-network.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { resolveLauncherProfile } = require("./profile.cjs");
const { retireProxyGateway } = require("./proxy-gateway-retire.cjs");
const { createNovaManager } = require("./proxybridge-nova.cjs");

// Nova's profile carries proxy passwords; the page gets whether one is saved, never the value.
function redactNovaProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  return {
    ...profile,
    proxies: (profile.proxies ?? []).map(({ password, ...proxy }) => ({ ...proxy, hasPassword: Boolean(password) })),
  };
}

let providerNetworkControllerPromise = null;
let novaManager = null;
let providerBrowserHostGetter = () => null;
let providerCpaConnectionGetter = () => null;
// The launcher's own log (launcher.jsonl, which redacts proxy credentials and bearer tokens) once
// main has created it. Provider Network starts first: its events until then are kept and written
// when the log arrives.
const EARLY_LOG_LIMIT = 200;
let launcherLogger = null;
const earlyLog = [];

function setProviderLogger(logger) {
  if (!logger || typeof logger.info !== "function" || typeof logger.warn !== "function") {
    throw new Error("Provider logger must have info and warn");
  }
  launcherLogger = logger;
  for (const [level, event, detail] of earlyLog.splice(0)) {
    try { logger[level](event, detail); } catch {}
  }
}

function providerLog(level, event, detail) {
  console[level](`[provider-network] ${event}`, detail);
  if (launcherLogger) {
    try { launcherLogger[level](event, detail); } catch {}
  } else if (earlyLog.length < EARLY_LOG_LIMIT) {
    earlyLog.push([level, event, detail]);
  }
}

function setProviderBrowserHost(getter) {
  if (typeof getter !== "function") {
    throw new Error("Provider BrowserHost getter must be a function");
  }
  providerBrowserHostGetter = getter;
}

function setProviderCpaConnection(getter) {
  if (typeof getter !== "function") {
    throw new Error("Provider CPA connection getter must be a function");
  }
  providerCpaConnectionGetter = getter;
}

function providerNetworkReady() {
  if (!providerNetworkControllerPromise) {
    throw new Error("Provider Network has not been installed");
  }
  return providerNetworkControllerPromise;
}

function installProviderNetwork({
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
  shell,
}) {
  let controller = null;
  let nova = null;

  const logger = Object.freeze({
    info(event, detail = {}) {
      providerLog("info", event, detail);
    },
    warn(event, detail = {}) {
      providerLog("warn", event, detail);
    },
  });

  function sendAll(channel, payload) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }

  function publish(snapshot) {
    sendAll("launcher:provider-network-changed", snapshot);
    return snapshot;
  }

  providerNetworkControllerPromise = app.whenReady().then(async () => {
    const launcherProfile = resolveLauncherProfile({ appData: app.getPath("appData") });
    controller = createProviderNetworkController({
      app,
      browserPartition: launcherProfile.browserPartition,
      getBrowserHost: () => providerBrowserHostGetter?.() ?? null,
      getCpaConnection: () => {
        try {
          return providerCpaConnectionGetter?.() ?? null;
        } catch {
          return null;
        }
      },
      logger,
      safeStorage,
      session,
      shell,
      userData: app.getPath("userData"),
    });
    // Before anything awaits: this runs ahead of main's own whenReady code, so every program main
    // starts (AO, the Codex bridge, the MCP tunnel, chat agents) inherits the saved route.
    try {
      controller.applyGlobalEnvironment();
    } catch (error) {
      logger.warn("proxy.global_environment_failed", { error: error instanceof Error ? error.message : String(error) });
    }

    // Before the saved route is applied: a route left on the removed gateway goes back to the
    // route it replaced, and an older version's gateway helper is stopped.
    try {
      await retireProxyGateway({ userData: app.getPath("userData"), store: controller.store, logger });
    } catch (error) {
      logger.warn("proxy_gateway.retire_failed", { error: error instanceof Error ? error.message : String(error) });
    }

    // Proxies work inside the app on their own: ProxyBridge Nova is no longer started, and the
    // proxies it supplied become the app's own (credentials and routes kept) before the route applies.
    try {
      if (controller.store.adoptSourceProfiles("nova").changed) logger.info("proxy.nova_profiles_adopted", {});
    } catch (error) {
      logger.warn("proxy.nova_adopt_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    const snapshot = controller.store.snapshot();
    if (snapshot.routing.globalEnabled && snapshot.routing.globalProfileId) {
      void controller.applyGlobalRouting().catch((error) => {
        logger.warn("proxy.global_routing_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // Kept for its IPC (Nova's state reads as not running); app start no longer starts it. A quit
    // shuts down only a Nova this manager started, never one the user runs for other programs.
    nova = createNovaManager({
      userData: app.getPath("userData"),
      safeStorage,
      store: controller.store,
      applyGlobalRouting: () => controller.applyGlobalRouting(),
      publish: (state, providerSnapshot) => {
        if (state) sendAll("launcher:nova-changed", state);
        if (providerSnapshot) publish(providerSnapshot);
      },
      logger,
    });
    novaManager = nova;
    app.once("will-quit", () => nova?.stopPolling());
    return controller;
  });
  const controllerPromise = providerNetworkControllerPromise;

  app.on("login", (event, _webContents, _authenticationDetails, authInfo, callback) => {
    if (_webContents?.__codingToolsAntigravityAuth === true) return;
    controller?.handleProxyLogin(event, authInfo, callback);
  });

  // Who may call: every channel answers only a Coding Tools window's own page, never web content
  // embedded in it (a browser view, a webview or an iframe). Changing the network route or a proxy
  // also needs that window visible and focused, as only the user's click there does; account writes
  // can follow a login that holds the focus, so they need only the window's own page.
  function assertSender(event, access) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const own = Boolean(window) && !window.isDestroyed() && window.webContents === event.sender
      && (!event.senderFrame || event.senderFrame === event.sender.mainFrame);
    const focused = own && window.isVisible() && !window.isMinimized() && window.isFocused() && event.sender.isFocused();
    if (!own || (access === "network" && !focused)) {
      throw new Error("Use the visible, focused Coding Tools window to change network settings");
    }
  }

  function handle(channel, callback, access = "app") {
    ipcMain.handle(channel, async (event, ...args) => {
      assertSender(event, access);
      const active = await controllerPromise;
      return callback(active, event, ...args);
    });
  }

  async function publishMutation(active, mutate, { refreshGlobal = false } = {}) {
    let snapshot = await mutate();
    if (refreshGlobal) snapshot = await active.applyGlobalRouting();
    return publish(snapshot);
  }

  handle("launcher:provider-snapshot", (active) => active.store.snapshot());
  handle("launcher:provider-execution-plan", (active, _event, input) => (
    createProviderExecutionPlan(active.store.snapshot(), input)
  ));
  handle("launcher:provider-account-save", (active, _event, input) => publishMutation(
    active,
    () => active.store.saveAccount(input),
  ));
  handle("launcher:provider-account-default", (active, _event, providerId, accountId) => publishMutation(
    active,
    () => active.store.setDefaultAccount(providerId, accountId),
  ));
  handle("launcher:provider-account-enabled", (active, _event, accountId, enabled) => publishMutation(
    active,
    () => active.store.setAccountEnabled(accountId, enabled),
  ));
  handle("launcher:provider-account-archive", (active, _event, accountId) => publishMutation(
    active,
    () => active.store.archiveAccount(accountId),
  ));
  handle("launcher:provider-login", async (active, _event, accountId, adapterId) => {
    const result = adapterId === undefined
      ? await active.openProviderLogin(accountId)
      : await active.openProviderLogin(accountId, adapterId);
    if (result?.snapshot) publish(result.snapshot);
    return result;
  });
  handle("launcher:provider-account-probe", async (active, _event, accountId) => (
    publish(await active.probeProviderAccount(accountId))
  ));

  handle("launcher:proxy-profile-save", (active, _event, input) => {
    const current = active.store.snapshot();
    const refreshGlobal = current.routing.globalEnabled
      && current.routing.globalProfileId === input?.id;
    return publishMutation(active, () => active.store.saveProxyProfile(input), { refreshGlobal });
  }, "network");
  handle("launcher:proxy-profile-archive", (active, _event, profileId) => publishMutation(
    active,
    () => active.store.archiveProxyProfile(profileId),
    { refreshGlobal: true },
  ), "network");
  handle("launcher:proxy-profile-test", async (active, _event, profileId) => {
    const result = await active.testProxyProfile(profileId);
    publish(result.snapshot);
    return result;
  }, "network");
  handle("launcher:proxy-global-routing", (active, _event, input) => publishMutation(
    active,
    () => active.store.setGlobalRouting(input),
    { refreshGlobal: true },
  ), "network");
  handle("launcher:proxy-provider-policy", (active, _event, input) => publishMutation(
    active,
    () => active.store.setProviderPolicy(input),
  ), "network");
  handle("launcher:proxy-account-policy", (active, _event, input) => publishMutation(
    active,
    () => active.store.setAccountPolicy(input),
  ), "network");

  // ProxyBridge Nova (the Proxy page). Reads need the app's own page; changes also need it focused.
  const novaRead = (channel, read) => handle(channel, (_active, _event, ...args) => read(...args));
  const novaWrite = (channel, write) => handle(channel, (_active, _event, ...args) => write(...args), "network");
  novaRead("launcher:nova-state", () => nova.state());
  novaRead("launcher:nova-profile", async () => redactNovaProfile(await nova.profile()));
  novaRead("launcher:nova-apps", () => nova.apps());
  novaRead("launcher:nova-connections", () => nova.connections());
  novaRead("launcher:nova-log", (after) => nova.log(after));
  novaRead("launcher:nova-decodo", () => nova.decodo());
  novaWrite("launcher:nova-start", async () => { await nova.ensureRunning(); await nova.sync(); return nova.state(); });
  novaWrite("launcher:nova-shutdown", () => nova.shutdown());
  novaWrite("launcher:nova-set-exe", (exePath) => nova.setExecutable(exePath));
  // Linked proxies come from Nova's linked profile and can't be sent back; a password left out
  // (null) keeps the saved one.
  novaWrite("launcher:nova-save-proxies", async (input) => redactNovaProfile(await nova.saveProxies({
    etag: String(input?.etag ?? ""),
    proxies: (Array.isArray(input?.proxies) ? input.proxies : []).filter((proxy) => !proxy?.linked).map((proxy) => ({
      key: String(proxy.key ?? ""), protocol: proxy.protocol, host: String(proxy.host ?? "").trim(), port: Number(proxy.port),
      username: String(proxy.username ?? ""), password: typeof proxy.password === "string" ? proxy.password : null,
      linked: false, upstreamEligible: proxy.upstreamEligible !== false, provider: proxy.provider ?? null,
    })),
  })));
  novaWrite("launcher:nova-save-rules", async (input) => redactNovaProfile(await nova.saveRules(input)));
  novaWrite("launcher:nova-check", (key) => nova.checkProxy(key));
  novaWrite("launcher:nova-routing", (action) => nova.routing(action));
  novaWrite("launcher:nova-save-decodo", (input) => nova.saveDecodo(input));
  novaWrite("launcher:nova-sync-decodo", async () => {
    const result = await nova.syncDecodo();
    return { ...result, profile: redactNovaProfile(result.profile) };
  });

  return Object.freeze({
    ready: providerNetworkReady,
    createProviderNetworkStore,
    createProviderExecutionPlan,
  });
}

/** A full quit ends ProxyBridge Nova with the app; a relaunch leaves it for the next app to adopt. */
function stopProxyBridgeNova() {
  return novaManager?.stop() ?? Promise.resolve();
}

module.exports = {
  installProviderNetwork,
  providerNetworkReady,
  stopProxyBridgeNova,
  setProviderLogger,
  setProviderBrowserHost,
  setProviderCpaConnection,
};
