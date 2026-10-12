const {
  createProviderNetworkController,
  createProviderNetworkStore,
} = require("./provider-network.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { resolveLauncherProfile } = require("./profile.cjs");
const {
  GATEWAY_PROFILE_ID,
  createProxyGatewayController,
  resolveHelperRuntime,
} = require("./proxy-gateway.cjs");

let providerNetworkControllerPromise = null;
let providerBrowserHostGetter = () => null;
let providerCpaConnectionGetter = () => null;
// Proxy Gateway writes are refused until main.cjs installs its focused-main-window check.
let providerWriteGuard = () => {
  throw new Error("Use the visible, focused main-window controller for provider consent");
};

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

function setProviderWriteGuard(guard) {
  if (typeof guard !== "function") {
    throw new Error("Provider write guard must be a function");
  }
  providerWriteGuard = guard;
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
  let gateway = null;

  const logger = Object.freeze({
    info(event, detail = {}) {
      console.info(`[provider-network] ${event}`, detail);
    },
    warn(event, detail = {}) {
      console.warn(`[provider-network] ${event}`, detail);
    },
  });

  function publish(snapshot) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("launcher:provider-network-changed", snapshot);
      }
    }
    return snapshot;
  }

  function publishGateway(status) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("launcher:proxy-gateway-changed", status);
      }
    }
    return status;
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

    // The gateway helper is adopted or started (and verified on its ports) before the saved global
    // route is applied, so a route that points at it never starts against a closed or foreign
    // port; if it cannot start, it puts the previous route back.
    try {
      gateway = createProxyGatewayController({
        userData: app.getPath("userData"),
        network: controller,
        logger,
        resolveRuntime: () => resolveHelperRuntime({
          isPackaged: app.isPackaged,
          version: app.getVersion(),
          coreHome: launcherProfile.coreHome,
        }),
      });
      await gateway.startup();
    } catch (error) {
      logger.warn("proxy_gateway.unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const snapshot = controller.store.snapshot();
    if (snapshot.routing.globalEnabled && snapshot.routing.globalProfileId) {
      void controller.applyGlobalRouting().catch((error) => {
        logger.warn("proxy.global_routing_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
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

  // An edited upstream restarts the gateway helper with the new credentials; a lost one takes the
  // app off the gateway. Either way the route may change, so both snapshots are published.
  async function refreshGatewayUpstream(active, profileId, options) {
    if (!gateway || !profileId || gateway.upstreamProfileId() !== profileId) return;
    try {
      publishGateway(await gateway.refreshUpstream(options));
      publish(active.store.snapshot());
    } catch (error) {
      logger.warn("proxy_gateway.refresh_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  handle("launcher:proxy-profile-save", async (active, _event, input) => {
    if (input?.id === GATEWAY_PROFILE_ID) {
      throw new Error("The built-in gateway profile is managed in Proxy Gateway and cannot be edited here");
    }
    const current = active.store.snapshot();
    const refreshGlobal = current.routing.globalEnabled
      && current.routing.globalProfileId === input?.id;
    const snapshot = await publishMutation(active, () => active.store.saveProxyProfile(input), { refreshGlobal });
    await refreshGatewayUpstream(active, input?.id, {
      credentialsChanged: typeof input?.username === "string" || typeof input?.password === "string",
    });
    return snapshot;
  }, "network");
  handle("launcher:proxy-profile-archive", async (active, _event, profileId) => {
    if (profileId === GATEWAY_PROFILE_ID) {
      throw new Error("The built-in gateway profile is managed in Proxy Gateway; turn off \"Use for this app\" there instead");
    }
    const snapshot = await publishMutation(
      active,
      () => active.store.archiveProxyProfile(profileId),
      { refreshGlobal: true },
    );
    await refreshGatewayUpstream(active, profileId);
    return snapshot;
  }, "network");
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

  // Proxy Gateway: the status read is open; every change is a user action from the focused main
  // window, checked before anything else runs.
  function handleGateway(channel, callback, { write = true } = {}) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (write) providerWriteGuard(event);
      const active = await controllerPromise;
      if (!gateway) throw new Error("Proxy Gateway is unavailable; check the launcher log");
      return callback(active, gateway, ...args);
    });
  }

  async function gatewayMutation(active, mutate) {
    const status = await mutate();
    publish(active.store.snapshot());
    return publishGateway(status);
  }

  handleGateway("launcher:proxy-gateway-status", (_active, current) => current.status(), { write: false });
  handleGateway("launcher:proxy-gateway-configure", (active, current, input) => gatewayMutation(
    active,
    () => current.configure(input),
  ));
  handleGateway("launcher:proxy-gateway-running", (active, current, running) => gatewayMutation(
    active,
    () => current.setRunning(running === true),
  ));
  handleGateway("launcher:proxy-gateway-use-for-app", (active, current, enabled) => gatewayMutation(
    active,
    () => current.setUseForApp(enabled === true),
  ));
  handleGateway("launcher:proxy-gateway-test", async (_active, current) => publishGateway(await current.test()));

  // A normal quit leaves the gateway helper running, like the bridge; the next app adopts it.
  app.on("will-quit", () => {
    void gateway?.close().catch(() => {});
  });

  return Object.freeze({
    ready: providerNetworkReady,
    createProviderNetworkStore,
    createProviderExecutionPlan,
  });
}

module.exports = {
  installProviderNetwork,
  providerNetworkReady,
  setProviderBrowserHost,
  setProviderCpaConnection,
  setProviderWriteGuard,
};
