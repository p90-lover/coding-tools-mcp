"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");
const { peerEnvironmentFor } = require("./five-stack-cross-use.cjs");
const { createProviderNetworkStore, proxyUrl } = require("./provider-network.cjs");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("./loopback-mesh.cjs");

const MANAGED_PROXY_COMPONENTS = new Set(["cpa", "antigravity-cli"]);
const RETIRED_SERVICE_IDS = new Set(["paseo", "codex-router", "commandcode-proxy", "anneal"]);
const LOCAL_PROXY_BYPASS = [
  "localhost", "*.localhost", "127.0.0.1", "::1",
  "10.0.0.0/8", "10.0.0.0-10.255.255.255",
  "172.16.0.0/12", "172.16.0.0-172.31.255.255",
  "192.168.0.0/16", "192.168.0.0-192.168.255.255",
  "169.254.0.0/16", "169.254.0.0-169.254.255.255",
].join(",");

const SERVICE_ENDPOINTS = Object.freeze({
  cpa: Object.freeze({ endpoint: "http://127.0.0.1:8317/" }),
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

function resolveManagedProxyEnvironment(componentId, dataRoot, safeStorage) {
  if (!MANAGED_PROXY_COMPONENTS.has(componentId)) return {};
  const route = resolveCpaProxyRoute(dataRoot, safeStorage);
  if (!route.url) throw new Error(`Select a global network proxy before starting ${componentId}`);
  const protocol = new URL(route.url).protocol;
  if (componentId !== "cpa" && protocol !== "http:" && protocol !== "https:") {
    throw new Error(`${componentId} needs an HTTP or HTTPS global proxy`);
  }
  const standardProxy = componentId === "cpa" && protocol === "socks5:" ? "" : route.url;
  const environment = {
    HTTP_PROXY: standardProxy, HTTPS_PROXY: standardProxy, ALL_PROXY: standardProxy,
    http_proxy: standardProxy, https_proxy: standardProxy, all_proxy: standardProxy,
    NO_PROXY: LOCAL_PROXY_BYPASS, no_proxy: LOCAL_PROXY_BYPASS,
    NODE_USE_ENV_PROXY: "1",
  };
  if (componentId === "cpa") environment.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL = route.url;
  return environment;
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

  function persistMeshFromServices(services, targetId = null) {
    const mesh = buildLoopbackMesh(services);
    persistLoopbackMesh(meshPath, mesh);
    return loopbackMeshEnvironment(mesh, { targetId, meshPath });
  }

  baseController = createExternalServicesController({
    ...options,
    archiveDataRoot: dataRoot,
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
    persistentComponents: options.persistentComponents,
    resolveRuntimeExecutable,
    resolveCrossUseEnvironment: (componentId) => {
      const extra = peerEnvironmentFor(componentId, crossUseSecrets());
      Object.assign(extra, resolveManagedProxyEnvironment(componentId, dataRoot, options.safeStorage));
      return extra;
    },
    publish: publishCombined,
    peerEnvironment: (manifest) => persistMeshFromServices(baseController.snapshot().services, manifest.id),
  });

  function crossUseSecrets() {
    let cpa = {};
    try { cpa = managedController.runtimeSecrets("cpa") || {}; } catch {}
    return {
      cpaProxyApiKey: cpa.proxyApiKey,
      urls: {
        cpaOrigin: SERVICE_ENDPOINTS.cpa.endpoint,
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

  function redactManagedError(serviceId, value) {
    if (serviceId !== "cpa" || typeof value !== "string") return value;
    let secrets = {};
    try { secrets = managedController.runtimeSecrets("cpa") || {}; } catch {}
    const secretValues = [secrets.proxyApiKey, secrets.managementKey]
      .filter((secret) => typeof secret === "string" && secret)
      .flatMap((secret) => [secret, encodeURIComponent(secret)])
      .sort((a, b) => b.length - a.length);
    for (const secret of secretValues) value = value.split(secret).join("[REDACTED]");
    return value;
  }

  function mergeService(service) {
    const managed = managedController.project(service.id);
    const running = managed.processes.find((entry) => entry.running) || null;
    const redactError = (value) => redactManagedError(service.id, value);
    let configuration = null;
    let proxyError = null;
    if (managed.installState === "installed") {
      try { configuration = managedConfiguration(service.id); }
      catch (error) {
        proxyError = error instanceof Error ? error.message : "Managed proxy settings unavailable";
      }
    }
    const outboundProxy = service.id === "cpa" ? cpaProxyStatus(service) : null;
    return {
      ...service,
      error: redactError(service.error),
      ...(outboundProxy ? { outboundProxy: { ...outboundProxy, error: redactError(outboundProxy.error) } } : {}),
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
      ...(managed.error ? { status: "error", error: redactError(managed.error) } : {}),
      ...(proxyError ? { status: "error", error: redactError(proxyError) } : {}),
      managedInstall: {
        state: managed.installState,
        version: managed.version,
        commit: managed.commit,
        strategy: managed.strategy,
        home: managed.managedHome,
        installedAt: managed.installedAt,
        currentStep: managed.currentStep,
        error: redactError(managed.error),
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
    baseController.configure(serviceId, patch);
    return configuration;
  }

  function setManagedComponentCredential(serviceId, key, value) {
    managedController.setComponentCredential(serviceId, key, value);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function installManagedComponent(serviceId) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
    await managedController.installComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function repairManagedComponent(serviceId) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    publishCombined();
    return serviceFromSnapshot(serviceId);
  }

  async function start(serviceId) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
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
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
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

  function loopbackRequest(serviceId) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
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
    return null;
  }

  function dispose({ keepPersistent = false } = {}) {
    managedController.dispose({ keepPersistent });
    baseController.dispose();
  }

  return Object.freeze({
    snapshot: combinedSnapshot,
    configure,
    inspect,
    start,
    stop,
    restart,
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
      });
    },
    loopbackMesh: () => buildLoopbackMesh(combinedSnapshot().services),
    upstreamConfiguration,
    cpaConnection,
    loopbackRequest,
    installManagedComponent,
    repairManagedComponent,
    setManagedComponentCredential,
    managedComponentsSnapshot: () => {
      const snapshot = managedController.snapshot();
      return {
        ...snapshot,
        components: snapshot.components.map((component) => ({
          ...component,
          error: redactManagedError(component.id, component.error),
        })),
      };
    },
    dispose,
  });
}

module.exports = {
  createManagedExternalServicesController,
  resolveCpaProxyRoute,
  resolveManagedProxyEnvironment,
};
