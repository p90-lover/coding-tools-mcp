"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");
const { peerEnvironmentFor } = require("./five-stack-cross-use.cjs");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("./loopback-mesh.cjs");
const { probeStack } = require("./five-stack-loopbacks.cjs");

const SERVICE_ENDPOINTS = Object.freeze({
  "codex-router": Object.freeze({ endpoint: "http://127.0.0.1:4202/" }),
  "commandcode-proxy": Object.freeze({ endpoint: "http://127.0.0.1:9090/" }),
  cpa: Object.freeze({ endpoint: "http://127.0.0.1:8317/" }),
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
    bundleRoot: options.bundleRoot,
    safeStorage: options.safeStorage,
    env: options.env,
    logger: options.logger,
    resolveRuntimeExecutable,
    resolveCrossUseEnvironment: (componentId, context) => {
      const extra = peerEnvironmentFor(componentId, crossUseSecrets());
      if (componentId === "codex-router" && context?.state) {
        extra.CODING_TOOLS_INAPP_PROVIDERS_FILE = path.join(context.state, "router", "in-app-providers.json");
      }
      return extra;
    },
    publish: publishCombined,
    peerEnvironment: (manifest) => {
      let commandCodeApiKey = "";
      try {
        commandCodeApiKey = String(managedController.runtimeSecrets("commandcode-proxy").proxyApiKey || "");
      } catch {}
      return persistMeshFromServices(combinedSnapshot().services, manifest.id, commandCodeApiKey);
    },
  });

  function crossUseSecrets() {
    let cpa = {};
    let commandCode = {};
    let callerKey = "";
    try { cpa = managedController.runtimeSecrets("cpa") || {}; } catch {}
    try { commandCode = managedController.runtimeSecrets("commandcode-proxy") || {}; } catch {}
    try {
      callerKey = String(managedController.runtimeConfiguration("codex-router")?.callerKey || "").trim();
    } catch {}
    return {
      cpaProxyApiKey: cpa.proxyApiKey,
      commandCodeProxyApiKey: commandCode.proxyApiKey,
      routerCallerKey: callerKey,
      urls: {
        cpaOrigin: SERVICE_ENDPOINTS.cpa.endpoint,
        routerOrigin: SERVICE_ENDPOINTS["codex-router"].endpoint,
        commandCodeOrigin: SERVICE_ENDPOINTS["commandcode-proxy"].endpoint,
        paseoOrigin: SERVICE_ENDPOINTS.paseo.endpoint,
        paseoExecution: SERVICE_ENDPOINTS.paseo.executionEndpoint,
        annealWeb: SERVICE_ENDPOINTS.anneal.endpoint,
        annealApi: SERVICE_ENDPOINTS.anneal.executionEndpoint,
      },
    };
  }

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
        status: service.status === "error"
          ? "error"
          : service.status === "ready"
            ? "ready"
            : "starting",
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
    const probed = await probeStack(serviceId, {
      fetchImpl: options.fetchImpl,
      headers: managedController.healthHeaders(serviceId),
    });
    if (probed.listening) {
      await inspect(serviceId);
      publishCombined();
      return serviceFromSnapshot(serviceId);
    }
    const inspected = await inspect(serviceId);
    if (inspected.status === "ready") return inspected;
    const managed = managedController.project(serviceId);
    if (managed.installState === "repair-required" || (managed.installState === "error" && managed.installedAt)) {
      return repairManagedComponent(serviceId);
    }
    if (managed.installState !== "installed" && managed.installState !== "external") {
      return installManagedComponent(serviceId);
    }
    if (managed.installState === "installed") {
      try {
        applyManagedConfiguration(serviceId);
        await managedController.startComponent(serviceId);
      } catch {
        // Loopback Start must not become a download/install gate.
      }
      await baseController.inspect(serviceId);
      publishCombined();
      return serviceFromSnapshot(serviceId);
    }
    try {
      return mergeService(await baseController.start(serviceId));
    } catch {
      await baseController.inspect(serviceId);
      publishCombined();
      return serviceFromSnapshot(serviceId);
    }
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
    runtimeEnvironment: () => {
      const mesh = buildLoopbackMesh(combinedSnapshot().services);
      persistLoopbackMesh(meshPath, mesh);
      const base = baseController.runtimeEnvironment();
      const peers = peerEnvironmentFor("runtime-supervisor", crossUseSecrets());
      const {
        OPENAI_BASE_URL: _openaiBaseUrl,
        OPENAI_API_BASE: _openaiApiBase,
        OPENAI_API_KEY: _openaiApiKey,
        ...peerUrls
      } = peers;
      return Object.freeze({
        ...base,
        ...peerUrls,
        ...loopbackMeshEnvironment(mesh, { meshPath }),
        ...(base.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY
          ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: base.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY }
          : {}),
      });
    },
    loopbackMesh: () => buildLoopbackMesh(combinedSnapshot().services),
    upstreamConfiguration,
    cpaConnection,
    installManagedComponent,
    repairManagedComponent,
    setManagedComponentCredential,
    managedComponentsSnapshot: () => managedController.snapshot(),
    dispose,
  });
}

module.exports = {
  createManagedExternalServicesController,
};
