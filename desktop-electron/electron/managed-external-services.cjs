"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");

const SERVICE_ENDPOINTS = Object.freeze({
  "codex-router": Object.freeze({ endpoint: "http://127.0.0.1:4202/" }),
  "commandcode-proxy": Object.freeze({ endpoint: "http://127.0.0.1:9090/" }),
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
  ...options
} = {}) {
  let baseController = null;
  let managedController = null;

  const publishCombined = () => {
    if (!baseController || !managedController) return;
    try { publish?.(combinedSnapshot()); } catch {}
  };

  baseController = createExternalServicesController({
    ...options,
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
      executable: installed.executable,
      arguments: installed.arguments,
      endpoint: endpoints.endpoint,
      ...(endpoints.executionEndpoint ? { executionEndpoint: endpoints.executionEndpoint } : {}),
      enabled: true,
      autoStart: true,
      ...(serviceId === "codex-router" ? {
        routerCli: installed.routerCli,
        curateCli: installed.curateCli,
      } : {}),
    };
  }

  function mergeService(service) {
    const managed = managedController.project(service.id);
    const running = managed.processes.find((entry) => entry.running) || null;
    const configuration = managed.installState === "installed"
      ? managedConfiguration(service.id)
      : null;
    return {
      ...service,
      ...(configuration ? {
        home: configuration.home,
        executable: configuration.executable,
        arguments: [...configuration.arguments],
        endpoint: configuration.endpoint,
        ...(configuration.executionEndpoint
          ? { executionEndpoint: configuration.executionEndpoint }
          : {}),
        sourceConfigured: true,
      } : {}),
      ...(running ? {
        status: service.status === "error" ? "error" : "starting",
        pid: running.pid,
        owned: true,
      } : {}),
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
      },
    };
  }

  function combinedSnapshot() {
    const snapshot = baseController.snapshot();
    return {
      ...snapshot,
      services: snapshot.services.map(mergeService),
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
    const current = baseController.snapshot().services.find((service) => service.id === serviceId);
    const patch = { ...configuration };
    if (serviceId === "codex-router" && !current?.secretConfigured) {
      patch.callerKey = crypto.randomBytes(32).toString("base64url");
    }
    baseController.configure(serviceId, patch);
    return configuration;
  }

  async function installManagedComponent(serviceId) {
    await managedController.installComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function repairManagedComponent(serviceId) {
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function start(serviceId) {
    const managed = managedController.project(serviceId);
    if (managed.installState === "installed") {
      applyManagedConfiguration(serviceId);
      await managedController.startComponent(serviceId);
      await baseController.inspect(serviceId);
      publishCombined();
      return serviceFromSnapshot(serviceId);
    }
    return mergeService(await baseController.start(serviceId));
  }

  async function stop(serviceId) {
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
    const managed = managedController.project(serviceId);
    if (managed.installState === "installed") {
      applyManagedConfiguration(serviceId);
      await managedController.restartComponent(serviceId);
      await baseController.inspect(serviceId);
      publishCombined();
      return serviceFromSnapshot(serviceId);
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

  function dispose() {
    managedController.dispose();
    baseController.dispose();
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
    installManagedComponent,
    repairManagedComponent,
    managedComponentsSnapshot: () => managedController.snapshot(),
    dispose,
  });
}

module.exports = {
  createManagedExternalServicesController,
};
