const {
  createProviderNetworkController,
  createProviderNetworkStore,
} = require("./provider-network.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { resolveLauncherProfile } = require("./profile.cjs");

let providerNetworkControllerPromise = null;
let providerBrowserHostGetter = () => null;
let providerCpaConnectionGetter = () => null;

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

    const snapshot = controller.store.snapshot();
    if (snapshot.routing.globalEnabled && snapshot.routing.globalProfileId) {
      await controller.applyGlobalRouting().catch((error) => {
        logger.warn("proxy.global_routing_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        publish(controller.store.snapshot());
        if (error?.code === "proxy_configuration_rejected" || error?.code === "proxy_rollback_failed") {
          throw error;
        }
      });
    }
    try {
      await controller.reviveCommandCodeSessions();
    } catch (error) {
      logger.warn("commandcode.session_revive_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return controller;
  });
  const controllerPromise = providerNetworkControllerPromise;

  app.on("login", (event, webContents, _authenticationDetails, authInfo, callback) => {
    controller?.handleProxyLogin(event, webContents, authInfo, callback);
  });

  function handle(channel, callback) {
    ipcMain.handle(channel, async (event, ...args) => {
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
  handle("launcher:provider-session-import", async (active, _event, accountId) => (
    publish(await active.importProviderSession(accountId))
  ));

  handle("launcher:proxy-profile-save", (active, _event, input) => {
    const current = active.store.snapshot();
    const refreshGlobal = current.routing.globalEnabled
      && current.routing.globalProfileId === input?.id;
    return publishMutation(active, () => active.store.saveProxyProfile(input), { refreshGlobal });
  });
  handle("launcher:proxy-profile-archive", (active, _event, profileId) => publishMutation(
    active,
    () => active.store.archiveProxyProfile(profileId),
    { refreshGlobal: true },
  ));
  handle("launcher:proxy-profile-test", async (active, _event, profileId) => {
    const result = await active.testProxyProfile(profileId);
    publish(result.snapshot);
    return result;
  });
  handle("launcher:proxy-global-routing", (active, _event, input) => publishMutation(
    active,
    () => active.store.setGlobalRouting(input),
    { refreshGlobal: true },
  ));
  handle("launcher:proxy-provider-policy", (active, _event, input) => publishMutation(
    active,
    () => active.store.setProviderPolicy(input),
  ));
  handle("launcher:proxy-account-policy", (active, _event, input) => publishMutation(
    active,
    () => active.store.setAccountPolicy(input),
  ));

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
};
