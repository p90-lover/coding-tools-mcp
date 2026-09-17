const {
  createProviderNetworkController,
  createProviderNetworkStore,
} = require("./provider-network.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { resolveLauncherProfile } = require("./profile.cjs");

let providerNetworkControllerPromise = null;
let providerBrowserHostResolver = () => null;

function setProviderBrowserHostResolver(resolver) {
  providerBrowserHostResolver = typeof resolver === "function" ? resolver : () => null;
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
      getBrowserHost: () => providerBrowserHostResolver(),
      logger,
      safeStorage,
      session,
      shell,
      userData: app.getPath("userData"),
    });

    const snapshot = controller.store.snapshot();
    if (snapshot.routing.globalEnabled && snapshot.routing.globalProfileId) {
      await controller.applyGlobalRouting();
    }
    return controller;
  });
  const controllerPromise = providerNetworkControllerPromise;

  app.on("login", (event, _webContents, _authenticationDetails, authInfo, callback) => {
    controller?.handleProxyLogin(event, authInfo, callback);
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

  function browserProviderAccount(active, accountId) {
    const account = active.store.snapshot().accounts.find((candidate) => (
      candidate.id === accountId && !candidate.archivedAt
    ));
    return account && (account.providerId === "codex-oauth" || account.providerId === "chatgpt-web")
      ? account
      : null;
  }

  async function syncBrowserProviderAccount(active, accountId, { openLogin = false } = {}) {
    const account = browserProviderAccount(active, accountId);
    if (!account) throw new Error("Browser provider account was not found");
    const browserHost = providerBrowserHostResolver();
    if (!browserHost) throw new Error("Browser provider login is unavailable");

    let browser;
    try {
      browser = openLogin
        ? await browserHost.openLogin()
        : await browserHost.probeAuthentication();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const snapshot = active.store.updateAccountConnection(account.id, {
        status: openLogin ? "pending" : "expired",
        error: message,
      });
      const error = cause instanceof Error ? cause : new Error(message);
      error.snapshot = snapshot;
      throw error;
    }

    if (browser?.authenticated !== true) {
      const message = "ChatGPT browser session is not authenticated";
      const snapshot = active.store.updateAccountConnection(account.id, {
        status: openLogin ? "pending" : "expired",
        error: message,
      });
      const error = new Error(message);
      error.snapshot = snapshot;
      throw error;
    }

    const snapshot = active.store.updateAccountConnection(account.id, {
      status: "connected",
      error: undefined,
    });
    return { browser, snapshot };
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
  handle("launcher:provider-login", async (active, _event, accountId) => {
    if (browserProviderAccount(active, accountId)) {
      try {
        const result = await syncBrowserProviderAccount(active, accountId, { openLogin: true });
        publish(result.snapshot);
        return { opened: true, mode: "embedded", ...result };
      } catch (error) {
        if (error?.snapshot) publish(error.snapshot);
        throw error;
      }
    }
    const result = await active.openProviderLogin(accountId);
    if (result?.snapshot) publish(result.snapshot);
    return result;
  });
  handle("launcher:provider-account-probe", async (active, _event, accountId) => {
    if (browserProviderAccount(active, accountId)) {
      try {
        return publish((await syncBrowserProviderAccount(active, accountId)).snapshot);
      } catch (error) {
        if (error?.snapshot) publish(error.snapshot);
        throw error;
      }
    }
    return publish(await active.probeProviderAccount(accountId));
  });
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
  setProviderBrowserHostResolver,
};
