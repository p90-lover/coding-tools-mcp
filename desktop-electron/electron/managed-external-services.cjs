"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");
const { createManagedBootstrap } = require("./managed-bootstrap.cjs");
const { createFiveStackLongRun, FIVE_STACK_IDS, HEARTBEAT_MS } = require("./five-stack-long-run.cjs");
const { waitUntilHealthy } = require("./loopback-health.cjs");

const SERVICE_ENDPOINTS = Object.freeze({
  "codex-router": Object.freeze({ endpoint: "http://127.0.0.1:4202/" }),
  "commandcode-proxy": Object.freeze({ endpoint: "http://127.0.0.1:9090/" }),
  cpa: Object.freeze({ endpoint: "http://127.0.0.1:8317/" }),
  paseo: Object.freeze({
    endpoint: "http://127.0.0.1:6768/",
    executionEndpoint: "ws://127.0.0.1:6767/ws",
  }),
  anneal: Object.freeze({
    endpoint: "http://127.0.0.1:5173/",
    executionEndpoint: "http://127.0.0.1:3000/",
  }),
});

function createManagedExternalServicesController({
  dataRoot,
  manifestRoot = path.join(__dirname, "..", "vendor", "managed-components"),
  resolveRuntimeExecutable,
  publish = null,
  longRun: injectedLongRun = null,
  now = null,
  enableHeartbeat = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...options
} = {}) {
  let baseController = null;
  let managedController = null;
  let bootstrap = null;
  let ticking = false;
  let heartbeatTimer = null;
  const longRun = injectedLongRun || createFiveStackLongRun({
    persistPath: dataRoot ? path.join(dataRoot, "long-run.json") : null,
    logger: options.logger,
    now: now || (() => Date.now()),
  });

  const publishCombined = () => {
    if (!baseController || !managedController) return;
    try { publish?.(combinedSnapshot()); } catch {}
  };

  baseController = createExternalServicesController({
    ...options,
    getHealthHeaders: (serviceId) => managedController?.healthHeaders(serviceId) || {},
    publish: publishCombined,
  });
  managedController = createManagedComponentController({
    manifestRoot,
    dataRoot,
    safeStorage: options.safeStorage,
    env: options.env,
    logger: options.logger,
    resolveRuntimeExecutable,
    publish: publishCombined,
  });

  function managedConfiguration(serviceId) {
    const installed = managedController.runtimeConfiguration(serviceId);
    if (!installed) return null;
    const endpoints = SERVICE_ENDPOINTS[serviceId];
    return {
      home: installed.home,
      stateDir: installed.state,
      executable: installed.executable,
      arguments: installed.arguments,
      endpoint: endpoints.endpoint,
      ...(endpoints.executionEndpoint ? { executionEndpoint: endpoints.executionEndpoint } : {}),
      enabled: true,
      autoStart: true,
      ...(serviceId === "codex-router" ? {
        routerCli: installed.routerCli,
        curateCli: installed.curateCli,
        callerKey: installed.callerKey,
      } : {}),
    };
  }

  function ownsProcessKeepAlive(serviceId) {
    return FIVE_STACK_IDS.includes(serviceId);
  }

  function setDesiredIfOwned(serviceId, desired) {
    if (ownsProcessKeepAlive(serviceId)) longRun.setDesired(serviceId, desired);
  }

  function noteHealthyIfOwned(serviceId) {
    if (ownsProcessKeepAlive(serviceId)) longRun.noteHealthy(serviceId);
  }

  function mergeService(service) {
    const managed = managedController.project(service.id);
    const running = managed.processes.find((entry) => entry.running) || null;
    const configuration = managed.installState === "installed"
      ? managedConfiguration(service.id)
      : null;
    // A live pid is "starting", never "ready". Ready is only HTTP health
    // (CPA / Codex Router / CommandCode models probes, Paseo/Anneal GET /).
    const mergedStatus = running
      ? (service.status === "error" ? "error" : service.status === "ready" ? "ready" : "starting")
      : service.status;
    return {
      ...service,
      ...(configuration ? {
        home: configuration.home,
        stateDir: configuration.stateDir,
        executable: configuration.executable,
        arguments: [...configuration.arguments],
        endpoint: configuration.endpoint,
        ...(configuration.executionEndpoint
          ? { executionEndpoint: configuration.executionEndpoint }
          : {}),
        sourceConfigured: true,
      } : {}),
      ...(running ? {
        status: mergedStatus,
        pid: running.pid,
        owned: true,
      } : {}),
      longRun: ownsProcessKeepAlive(service.id) ? longRun.summary(service.id, mergedStatus) : null,
      managedInstall: {
        state: managed.installState,
        version: managed.version,
        commit: managed.commit,
        strategy: managed.strategy,
        home: managed.managedHome,
        installedAt: managed.installedAt,
        currentStep: managed.currentStep,
        error: managed.error,
        platformMode: managed.platformMode,
        processes: managed.processes,
        missingCredentials: managed.missingCredentials,
      },
    };
  }

  function combinedSnapshot() {
    const snapshot = baseController.snapshot();
    return {
      ...snapshot,
      services: snapshot.services.map(mergeService),
      managedBootstrap: bootstrap ? bootstrap.getSnapshot() : {
        status: "idle",
        reason: null,
        startedAt: null,
        completedAt: null,
        components: [],
      },
    };
  }

  function serviceFromSnapshot(serviceId) {
    const service = combinedSnapshot().services.find((candidate) => candidate.id === serviceId);
    if (!service) throw new Error(`Unknown external service: ${serviceId}`);
    return service;
  }

  function applyManagedConfiguration(serviceId) {
    const configuration = managedConfiguration(serviceId);
    if (!configuration) throw new Error(`${serviceId} is not installed`);
    const patch = { ...configuration };
    if (serviceId === "codex-router" && !configuration.callerKey) {
      throw new Error("Managed Codex Router caller key is unavailable");
    }
    baseController.configure(serviceId, patch);
    return configuration;
  }

  function setManagedComponentCredential(serviceId, key, value) {
    managedController.setComponentCredential(serviceId, key, value);
    publishCombined();
    void bootstrap?.reconcile({
      reason: "credential-saved",
      componentIds: [serviceId],
    });
    return serviceFromSnapshot(serviceId);
  }

  async function inspectProjected(serviceId) {
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function waitUntilListen(serviceId) {
    const snapshot = await waitUntilHealthy({
      inspect: inspectProjected,
      id: serviceId,
      sleep,
      now: now || (() => Date.now()),
    });
    if (snapshot.status === "ready") noteHealthyIfOwned(serviceId);
    return snapshot;
  }

  async function startManagedProcess(serviceId, { waitForHealth = true } = {}) {
    applyManagedConfiguration(serviceId);
    const before = managedController.project(serviceId);
    const alreadyRunning = before.processes.some((entry) => entry.running);
    await managedController.startComponent(serviceId);
    if (!waitForHealth) {
      await baseController.inspect(serviceId);
      publishCombined();
      const snapshot = serviceFromSnapshot(serviceId);
      if (snapshot.status === "ready") noteHealthyIfOwned(serviceId);
      return snapshot;
    }
    let snapshot = await waitUntilListen(serviceId);
    if (snapshot.status !== "ready" && alreadyRunning) {
      await managedController.restartComponent(serviceId);
      snapshot = await waitUntilListen(serviceId);
    }
    return snapshot;
  }

  async function installManagedComponent(serviceId) {
    setDesiredIfOwned(serviceId, "running");
    await managedController.installComponent(serviceId);
    return startManagedProcess(serviceId, { waitForHealth: true });
  }

  async function repairManagedComponent(serviceId) {
    setDesiredIfOwned(serviceId, "running");
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId);
    return startManagedProcess(serviceId, { waitForHealth: true });
  }

  async function start(serviceId, { supervised = false } = {}) {
    if (!supervised) setDesiredIfOwned(serviceId, "running");
    const managed = managedController.project(serviceId);
    if (managed.installState === "installed") {
      return startManagedProcess(serviceId, { waitForHealth: !supervised });
    }
    const started = mergeService(await baseController.start(serviceId));
    if (!supervised) return waitUntilListen(serviceId);
    if (started.status === "ready") noteHealthyIfOwned(serviceId);
    return started;
  }

  async function stop(serviceId) {
    setDesiredIfOwned(serviceId, "stopped");
    const managed = managedController.project(serviceId);
    if (managed.installState === "installed") {
      await managedController.stopComponent(serviceId);
      try { await baseController.inspect(serviceId); } catch {}
      publishCombined();
      return serviceFromSnapshot(serviceId);
    }
    return mergeService(await baseController.stop(serviceId));
  }

  async function restart(serviceId) {
    setDesiredIfOwned(serviceId, "running");
    const managed = managedController.project(serviceId);
    if (managed.installState === "installed") {
      applyManagedConfiguration(serviceId);
      await managedController.restartComponent(serviceId);
      return waitUntilListen(serviceId);
    }
    return mergeService(await baseController.restart(serviceId));
  }

  async function inspect(serviceId) {
    await baseController.inspect(serviceId);
    return serviceFromSnapshot(serviceId);
  }

  function configure(serviceId, input) {
    return mergeService(baseController.configure(serviceId, input));
  }

  async function syncCodexRouter() {
    const managed = managedController.project("codex-router");
    if (managed.installState === "installed") applyManagedConfiguration("codex-router");
    return baseController.syncCodexRouter();
  }

  function upstreamConfiguration(serviceId) {
    const configuration = managedConfiguration(serviceId);
    return configuration || baseController.upstreamConfiguration(serviceId);
  }

  function cpaConnection() {
    const managed = managedController.project("cpa");
    if (managed.installState !== "installed") return null;
    const secrets = managedController.runtimeSecrets("cpa");
    const managementKey = String(secrets.managementKey || "").trim();
    const proxyApiKey = String(secrets.proxyApiKey || "").trim();
    if (!managementKey || !proxyApiKey) {
      throw new Error("Managed CPA credentials are unavailable");
    }
    return {
      baseUrl: SERVICE_ENDPOINTS.cpa.endpoint.replace(/\/$/, ""),
      managementKey,
      proxyApiKey,
    };
  }

  function reconcileManagedComponents(options = {}) {
    if (!bootstrap) throw new Error("Managed bootstrap is unavailable");
    return bootstrap.reconcile(options);
  }

  function managedBootstrapSnapshot() {
    if (!bootstrap) throw new Error("Managed bootstrap is unavailable");
    return bootstrap.getSnapshot();
  }

  function rememberSection(serviceId, section) {
    return longRun.setSelectedSection(serviceId, section);
  }

  function liveMap() {
    const live = {};
    for (const service of combinedSnapshot().services) {
      live[service.id] = {
        status: service.status,
        installState: service.managedInstall?.state,
      };
    }
    return live;
  }

  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const actions = longRun.planTick(liveMap());
      for (const action of actions) {
        if (action.action !== "reconnect") continue;
        try {
          await start(action.id, { supervised: true });
        } catch (error) {
          options.logger?.warn?.("five-stack-long-run.reconnect-failed", {
            componentId: action.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      publishCombined();
      return actions;
    } finally {
      ticking = false;
    }
  }

  function markSuspended() {
    longRun.markSuspended();
  }

  function dispose() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    bootstrap?.dispose();
    managedController.dispose();
    baseController.dispose();
  }

  bootstrap = createManagedBootstrap({
    snapshot: combinedSnapshot,
    install: installManagedComponent,
    repair: repairManagedComponent,
    start,
    inspect,
    publish: publishCombined,
    logger: options.logger,
  });

  if (enableHeartbeat) {
    heartbeatTimer = setInterval(() => {
      void tick();
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    // Resume desired=running stacks after Desktop restart without waiting a full heartbeat.
    void tick();
  }

  return Object.freeze({
    snapshot: combinedSnapshot,
    configure,
    inspect,
    start,
    stop,
    restart,
    syncCodexRouter,
    runtimeEnvironment: () => baseController.runtimeEnvironment(),
    upstreamConfiguration,
    cpaConnection,
    installManagedComponent,
    repairManagedComponent,
    setManagedComponentCredential,
    reconcileManagedComponents,
    managedBootstrapSnapshot,
    managedComponentsSnapshot: () => managedController.snapshot(),
    rememberSection,
    markSuspended,
    tick,
    longRun,
    dispose,
  });
}

module.exports = {
  createManagedExternalServicesController,
};
