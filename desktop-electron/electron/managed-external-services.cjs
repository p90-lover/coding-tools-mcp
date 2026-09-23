"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");
const { peerEnvironmentFor } = require("./five-stack-cross-use.cjs");
const { createProviderNetworkStore, proxyUrl } = require("./provider-network.cjs");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("./loopback-mesh.cjs");

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

function resolveCpaProxyRoute(dataRoot, safeStorage) {
  const directory = path.join(path.dirname(dataRoot), "providers");
  const filePath = path.join(directory, "provider-network.json");
  let saved;
  try { saved = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { profileId: null, url: "" };
    throw new Error("Saved proxy settings are unavailable; CPA was not started");
  }
  if (!saved || saved.version !== 1 || !saved.routing || typeof saved.routing !== "object") {
    throw new Error("Saved proxy settings are invalid; CPA was not started");
  }
  const store = createProviderNetworkStore({
    filePath, keyPath: path.join(directory, "provider-network.key"), safeStorage,
  });
  const routing = store.snapshot().routing;
  if (!routing.globalEnabled) return { profileId: null, url: "" };
  const profile = store.activeProxy(routing.globalProfileId);
  if (!profile) throw new Error("Selected global proxy is unavailable; CPA was not started");
  if (profile.endpoint.protocol === "socks4") {
    throw new Error("CPA needs an HTTP, HTTPS or SOCKS5 proxy profile");
  }
  const credentials = store.proxySecret(profile.id);
  if (profile.hasAuthentication && !credentials?.username && !credentials?.password) {
    throw new Error("Saved proxy authentication is unavailable; CPA was not started");
  }
  const url = proxyUrl(profile, credentials);
  const parsed = new URL(url);
  if (parsed.hostname.replace(/^\[|\]$/g, "") !== profile.endpoint.host.replace(/^\[|\]$/g, "")) {
    throw new Error("Invalid proxy host; CPA was not started");
  }
  return { profileId: profile.id, url };
}

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
    spawnProcess: options.spawnProcess,
    terminateProcessTree: options.terminateProcessTree,
    resolveRuntimeExecutable,
    resolveCrossUseEnvironment: (componentId, context) => {
      const extra = peerEnvironmentFor(componentId, crossUseSecrets());
      if (componentId === "cpa") {
        const route = resolveCpaProxyRoute(dataRoot, options.safeStorage);
        extra.HTTP_PROXY = "";
        extra.HTTPS_PROXY = "";
        extra.ALL_PROXY = "";
        if (route.url) extra.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL = route.url;
      }
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
      // Mesh URLs come from the base service snapshot. combinedSnapshot() overlays
      // runtimeConfiguration → commandSpec → peerEnv and would recurse forever.
      return persistMeshFromServices(baseController.snapshot().services, manifest.id, commandCodeApiKey);
    },
  });

  function readRouterCallerKey() {
    // Do NOT call runtimeConfiguration here: it builds commandSpec → resolveCrossUseEnvironment →
    // crossUseSecrets → runtimeConfiguration (infinite recursion / regex stack overflow).
    try {
      const secretFile = path.join(dataRoot, "state", "codex-router", "router", "caller-secret");
      if (!fs.existsSync(secretFile)) return "";
      let raw = fs.readFileSync(secretFile, "utf8");
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return String(raw).trim();
    } catch {
      return "";
    }
  }

  function crossUseSecrets() {
    let cpa = {};
    let commandCode = {};
    let callerKey = "";
    try { cpa = managedController.runtimeSecrets("cpa") || {}; } catch {}
    try { commandCode = managedController.runtimeSecrets("commandcode-proxy") || {}; } catch {}
    try {
      callerKey = readRouterCallerKey();
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

  function cpaProxyStatus(service) {
    try {
      const route = resolveCpaProxyRoute(dataRoot, options.safeStorage);
      let configured = false;
      try {
        const config = fs.readFileSync(path.join(dataRoot, "state", "cpa", "config.yaml"), "utf8");
        const line = config.match(/^proxy-url:\s*(.+)$/m);
        const written = line ? JSON.parse(line[1]) : "";
        configured = service.status === "ready" && written === route.url;
      } catch {}
      return { profileId: route.profileId, configMatches: configured, error: null };
    } catch (error) {
      return { profileId: null, configMatches: false, error: error instanceof Error ? error.message : "CPA proxy settings unavailable" };
    }
  }

  function mergeService(service) {
    const managed = managedController.project(service.id);
    const running = managed.processes.find((entry) => entry.running) || null;
    let configuration = null;
    let proxyError = null;
    if (managed.installState === "installed") {
      try { configuration = managedConfiguration(service.id); }
      catch (error) {
        if (service.id !== "cpa") throw error;
        proxyError = error instanceof Error ? error.message : "CPA proxy settings unavailable";
      }
    }
    return {
      ...service,
      ...(service.id === "cpa" ? { outboundProxy: cpaProxyStatus(service) } : {}),
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
      ...(managed.error ? { status: "error", error: managed.error } : {}),
      ...(proxyError ? { status: "error", error: proxyError } : {}),
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

  let snapshotBusy = false;
  function combinedSnapshot() {
    const snapshot = baseController.snapshot();
    if (snapshotBusy) return snapshot;
    snapshotBusy = true;
    try {
      return {
        ...snapshot,
        services: snapshot.services.map(mergeService),
      };
    } finally {
      snapshotBusy = false;
    }
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
    const managed = managedController.project(serviceId);
    if (managed.installState === "repair-required" || (managed.installState === "error" && managed.installedAt)) {
      return repairManagedComponent(serviceId);
    }
    if (managed.installState !== "installed" && managed.installState !== "external") {
      return installManagedComponent(serviceId);
    }
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

  function routerCallerKey() {
    try {
      const managed = managedController.runtimeConfiguration("codex-router");
      const fromManaged = String(managed?.callerKey || "").trim();
      if (fromManaged) return fromManaged;
    } catch {}
    try {
      return String(baseController.runtimeEnvironment()?.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY || "").trim();
    } catch {
      return "";
    }
  }

  function loopbackRequest(serviceId) {
    if (serviceId === "anneal") {
      // Anneal's local web proxy supplies its operator token; never expose it to the renderer.
      return { origin: `${SERVICE_ENDPOINTS.anneal.endpoint}api/`, headers: {} };
    }
    if (serviceId === "commandcode-proxy") {
      let headers = {};
      let credentialReason = null;
      try {
        const managed = managedController.project(serviceId);
        if (managed.installState !== "installed") {
          credentialReason = `Managed CommandCode Proxy is ${managed.installState}`;
        } else if (!managed.secretConfigured) {
          credentialReason = "CommandCode proxy API key is unavailable";
        } else {
          const proxyApiKey = String(managedController.runtimeSecrets("commandcode-proxy").proxyApiKey || "").trim();
          if (proxyApiKey) headers = { Authorization: `Bearer ${proxyApiKey}` };
          else credentialReason = "CommandCode proxy API key is unavailable";
        }
      } catch (error) {
        credentialReason = error instanceof Error ? error.message : String(error);
      }
      return {
        origin: SERVICE_ENDPOINTS[serviceId].endpoint,
        headers,
        modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions",
        // Preserve the banner contract; root/health success is not end-to-end model proof.
        healthPath: "/",
        credentialReason,
      };
    }
    if (serviceId === "cpa") {
      const origin = SERVICE_ENDPOINTS.cpa.endpoint;
      let headers = {};
      let managementHeaders = {};
      let credentialReason = null;
      try {
        const connection = cpaConnection();
        if (!connection) {
          credentialReason = "Managed CPA is not installed";
        } else {
          if (connection.proxyApiKey) {
            headers = { Authorization: `Bearer ${connection.proxyApiKey}` };
          } else {
            credentialReason = "CPA proxy API key is unavailable";
          }
          if (connection.managementKey) {
            managementHeaders = {
              Authorization: `Bearer ${connection.managementKey}`,
              "X-Management-Key": connection.managementKey,
            };
          }
        }
      } catch (error) {
        credentialReason = error instanceof Error ? error.message : String(error);
      }
      return {
        origin,
        headers,
        managementHeaders,
        modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions",
        healthPath: "/v1/models",
        credentialReason,
      };
    }
    if (serviceId === "codex-router") {
      const origin = SERVICE_ENDPOINTS["codex-router"].endpoint;
      const callerKey = routerCallerKey();
      if (!callerKey) {
        return {
          origin,
          headers: {},
          modelsPath: "/v1/models",
          chatPath: "/v1/chat/completions",
          healthPath: "/",
          credentialReason: "Codex Router caller secret is not configured",
        };
      }
      const prefix = `/_codex-router/${encodeURIComponent(callerKey)}`;
      return {
        origin,
        headers: {},
        modelsPath: `${prefix}/v1/models`,
        chatPath: `${prefix}/v1/chat/completions`,
        healthPath: `${prefix}/v1/models`,
      };
    }
    return null;
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
    loopbackRequest,
    installManagedComponent,
    repairManagedComponent,
    setManagedComponentCredential,
    managedComponentsSnapshot: () => managedController.snapshot(),
    dispose,
  });
}

module.exports = {
  createManagedExternalServicesController,
  resolveCpaProxyRoute,
};
