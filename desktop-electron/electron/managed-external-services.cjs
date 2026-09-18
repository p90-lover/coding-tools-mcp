"use strict";

const path = require("node:path");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");
const {
  CPA_LOOPBACK,
  ROUTER_LOOPBACK,
  desktopCrossUseEnvironment,
  launchConsumesProviderBackends,
  providerBackendContract,
  startPeerIds,
} = require("./cpa-codex-long-run.cjs");
const { attachLane193LongRun } = require("./paseo-anneal-commandcode-long-run.cjs");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("./loopback-mesh.cjs");

const SERVICE_ENDPOINTS = Object.freeze({
  "codex-router": Object.freeze({ endpoint: ROUTER_LOOPBACK.endpoint }),
  "commandcode-proxy": Object.freeze({ endpoint: "http://127.0.0.1:9090/" }),
  cpa: Object.freeze({ endpoint: CPA_LOOPBACK.endpoint }),
  paseo: Object.freeze({
    endpoint: "http://127.0.0.1:6768/",
    executionEndpoint: "ws://127.0.0.1:6768/ws",
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

  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new Error("Managed component data root must be absolute");
  }
  const meshPath = path.join(dataRoot, "loopback-mesh.json");

  function persistMeshFromServices(services, targetId = null, commandCodeApiKey = "") {
    const mesh = buildLoopbackMesh(services);
    persistLoopbackMesh(meshPath, mesh);
    return loopbackMeshEnvironment(mesh, { targetId, commandCodeApiKey, meshPath });
  }

  baseController = createExternalServicesController({
    ...options,
    loopbackMeshPath: meshPath,
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
    bundleRoot: options.bundleRoot,
    resourcesPath: options.resourcesPath,
    desktopRoot: options.desktopRoot,
    launchEnvironmentFor: (id) => {
      if (!launchConsumesProviderBackends(id)) return {};
      try {
        const secrets = managedController?.runtimeSecrets("cpa") || {};
        const router = managedController?.runtimeConfiguration?.("codex-router") || {};
        return desktopCrossUseEnvironment({
          cpaProxyApiKey: secrets.proxyApiKey,
          routerCallerKey: router.callerKey,
        });
      } catch {
        return desktopCrossUseEnvironment();
      }
    },
    peerEnvironment: (manifest) => {
      let commandCodeApiKey = "";
      try {
        commandCodeApiKey = String(managedController.runtimeSecrets("commandcode-proxy").proxyApiKey || "");
      } catch {}
      return persistMeshFromServices(combinedSnapshot().services, manifest.id, commandCodeApiKey);
    },
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
        missingCredentials: managed.missingCredentials,
        bundledRuntime: managed.bundledRuntime === true,
      },
    };
  }

  function combinedSnapshot() {
    const snapshot = baseController.snapshot();
    return {
      ...snapshot,
      services: snapshot.services.map(mergeService),
      providerBackends: providerBackendContract(),
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
    return serviceFromSnapshot(serviceId);
  }

  async function installManagedComponent(serviceId) {
    await ensureStartPeers(serviceId);
    await managedController.installComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function repairManagedComponent(serviceId) {
    await ensureStartPeers(serviceId);
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function start(serviceId) {
    await ensureStartPeers(serviceId);
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
    await ensureStartPeers(serviceId);
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
      baseUrl: CPA_LOOPBACK.origin,
      managementKey,
      proxyApiKey,
    };
  }

  async function ensureStartPeers(serviceId) {
    for (const peerId of startPeerIds(serviceId)) {
      if (peerId === serviceId) continue;
      const peer = managedController.project(peerId);
      if (peer.installState === "not-installed") {
        await managedController.installComponent(peerId);
      } else if (peer.installState === "repair-required" || peer.installState === "error") {
        await managedController.repairComponent(peerId);
      }
      if (managedController.project(peerId).installState === "installed") {
        applyManagedConfiguration(peerId);
        await managedController.startComponent(peerId);
        try { await baseController.inspect(peerId); } catch {}
      }
    }
  }

  function runtimeEnvironment() {
    const mesh = buildLoopbackMesh(combinedSnapshot().services);
    persistLoopbackMesh(meshPath, mesh);
    const base = baseController.runtimeEnvironment();
    let cpaProxyApiKey = "";
    try {
      cpaProxyApiKey = String(cpaConnection()?.proxyApiKey || "").trim();
    } catch {}
    const callerKey = String(base.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY || "").trim();
    const meshEnv = loopbackMeshEnvironment(mesh, { meshPath });
    return Object.freeze({
      ...base,
      ...desktopCrossUseEnvironment({
        cpaProxyApiKey: cpaProxyApiKey || undefined,
        routerCallerKey: callerKey || undefined,
      }),
      ...meshEnv,
      ...(callerKey ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey } : {}),
    });
  }

  function dispose() {
    managedController.dispose();
    baseController.dispose();
  }

  const controller = {
    snapshot: combinedSnapshot,
    configure,
    inspect,
    start,
    stop,
    restart,
    syncCodexRouter,
    runtimeEnvironment,
    providerBackendContract,
    upstreamConfiguration,
    cpaConnection,
    installManagedComponent,
    repairManagedComponent,
    setManagedComponentCredential,
    managedComponentsSnapshot: () => managedController.snapshot(),
    loopbackMesh: () => buildLoopbackMesh(combinedSnapshot().services),
    dispose,
  };
  return attachLane193LongRun(controller, {
    statePath: path.join(dataRoot, "paseo-anneal-commandcode-long-run.json"),
    logger: options.logger,
    powerSaveBlocker: options.powerSaveBlocker,
  });
}

module.exports = {
  createManagedExternalServicesController,
};
