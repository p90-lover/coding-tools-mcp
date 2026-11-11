"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { watchOffThread } = require("./off-thread-run.cjs");
const { createExternalServicesController } = require("./external-services.cjs");
const { createManagedComponentController } = require("./managed-components.cjs");
const { peerEnvironmentFor } = require("./five-stack-cross-use.cjs");
const { createProviderNetworkStore, proxyUrl } = require("./provider-network.cjs");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("./loopback-mesh.cjs");
const { BACKUP_SUFFIX } = require("./durable-state.cjs");

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

/**
 * The proxy route `componentId` starts on. `readText(file)` answers its file reads instead of the
 * disk (readCpaProxyRoutes); without it the files are read synchronously, as a start always has.
 */
function resolveCpaProxyRoute(dataRoot, safeStorage, componentId = "cpa", { readText = null } = {}) {
  const directory = path.join(path.dirname(dataRoot), "providers");
  const filePath = path.join(directory, "provider-network.json");
  let saved;
  try { saved = JSON.parse(readText ? readText(filePath) : fs.readFileSync(filePath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { profileId: null, url: "" };
    throw new Error("Couldn't read the saved proxy settings, so CPA didn't start");
  }
  if (!saved || saved.version !== 1 || !saved.routing || typeof saved.routing !== "object") {
    throw new Error("The saved proxy settings are invalid, so CPA didn't start");
  }
  const store = createProviderNetworkStore({
    filePath, keyPath: path.join(directory, "provider-network.key"), safeStorage, readText,
  });
  const routing = store.snapshot().routing;
  const policy = componentId === "cpa"
    ? routing.providers.find((entry) => entry.providerId === "cpa")
    : null;
  if (policy?.inheritGlobal === false) return { profileId: null, url: "" };
  const profileId = policy?.profileId || (routing.globalEnabled ? routing.globalProfileId : null);
  if (!profileId) return { profileId: null, url: "" };
  const profile = store.activeProxy(profileId);
  if (!profile) throw new Error("The selected network proxy is unavailable, so CPA didn't start");
  if (profile.endpoint.protocol === "socks4") {
    throw new Error("CPA needs an HTTP, HTTPS or SOCKS5 proxy profile");
  }
  const credentials = store.proxySecret(profile.id);
  if (profile.hasAuthentication && !credentials?.username && !credentials?.password) {
    throw new Error("Couldn't read the proxy's saved sign-in, so CPA didn't start");
  }
  const url = proxyUrl(profile, credentials);
  const parsed = new URL(url);
  if (parsed.hostname.replace(/^\[|\]$/g, "") !== profile.endpoint.host.replace(/^\[|\]$/g, "")) {
    throw new Error("The proxy host is invalid, so CPA didn't start");
  }
  return { profileId: profile.id, url };
}

/**
 * resolveCpaProxyRoute for each of `componentIds`, with the saved settings, their key and both
 * copies read by fs.promises first, so the main thread only parses and decrypts. Each entry is
 * { value } or { error }: what resolveCpaProxyRoute returns or throws for that component.
 */
async function readCpaProxyRoutes(dataRoot, safeStorage, componentIds) {
  const directory = path.join(path.dirname(dataRoot), "providers");
  const files = ["provider-network.json", "provider-network.key"]
    .flatMap((name) => [path.join(directory, name), path.join(directory, `${name}${BACKUP_SUFFIX}`)]);
  const read = new Map(await Promise.all(files.map(async (file) => {
    try { return [file, { text: await fs.promises.readFile(file, "utf8") }]; }
    catch (error) { return [file, { error }]; }
  })));
  const readText = (file) => {
    const entry = read.get(file);
    if (!entry) throw Object.assign(new Error(`${path.basename(file)} wasn't read ahead`), { code: "EIO" });
    if (entry.error) throw entry.error;
    return entry.text;
  };
  return new Map(componentIds.map((componentId) => {
    try { return [componentId, { value: resolveCpaProxyRoute(dataRoot, safeStorage, componentId, { readText }) }]; }
    catch (error) { return [componentId, { error }]; }
  }));
}

/** The route CPA's config.yaml holds, "" for none, or null when it can't be read. */
async function readCpaConfigProxyUrl(configPath) {
  try {
    const config = await fs.promises.readFile(configPath, "utf8");
    // CPA 8 saves the route grouped (requests.proxy-url); a config it hasn't rewritten yet has it at
    // the top level. Matching only the top level read every running CPA as unrouted.
    const yaml = require("js-yaml");
    const parsed = yaml.load(config) ?? {};
    return parsed.requests?.["proxy-url"] ?? parsed["proxy-url"] ?? "";
  } catch { return null; }
}

function resolveManagedProxyEnvironment(componentId, dataRoot, safeStorage, resolveRoute = resolveCpaProxyRoute) {
  if (!MANAGED_PROXY_COMPONENTS.has(componentId)) return {};
  const route = resolveRoute(dataRoot, safeStorage, componentId);
  if (!route.url) throw new Error(`Select a network proxy before starting ${componentId}`);
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

  // Every services snapshot read files synchronously on main: the saved proxy settings and their
  // key for CPA (twice) and agy, and CPA's config.yaml. On the busy hard disk that held main up to
  // 12.8 s (0.8.48, 2026-11-01). Caching them until fs.watch reported a change still read them
  // synchronously in the first snapshot and in the first one after every change, and building the
  // snapshot's command lines saved loopback-mesh.json and read the proxy settings again for every
  // installed component. Snapshots are built while project() and cpaConnection() answer, which
  // launcher.main_blocked caught frozen 2 s and 28.8 s in a single existsSync call on 2026-10-31.
  //
  // A snapshot now only shows what was last read, and never reads. The routes (CPA's and agy's) and
  // the route CPA's config.yaml holds are read with fs.promises: when the first snapshot is taken,
  // when fs.watch reports one of those files changed, and before an install, repair, update, start,
  // stop or restart publishes. A read that changes what a snapshot shows publishes afresh. Until the
  // first read lands, a snapshot shows no route and no proxy error. Starts resolve the route
  // synchronously as before (resolveCrossUseEnvironment), so a process never starts on an old one.
  let disposed = false;
  const providersDirectory = path.join(path.dirname(dataRoot), "providers");
  const cpaConfigPath = path.join(dataRoot, "state", "cpa", "config.yaml");
  const diskState = { read: false, routes: new Map(), cpaConfigProxyUrl: null };
  const diskStateKey = () => JSON.stringify([
    [...diskState.routes].map(([id, entry]) => [id, entry.error ? String(entry.error?.message) : entry.value]),
    diskState.cpaConfigProxyUrl,
  ]);
  let diskRead = null;
  let diskReadAgain = false;
  /** Reads what a snapshot shows from disk, off the main thread. Resolves true when it changed. */
  function refreshDiskState() {
    // A change seen while a read is under way may have landed after that read's file reads: read
    // once more before the waiting callers go on.
    if (diskRead) { diskReadAgain = true; return diskRead; }
    diskRead = (async () => {
      const before = diskState.read ? diskStateKey() : null;
      do {
        diskReadAgain = false;
        const [routes, cpaConfigProxyUrl] = await Promise.all([
          readCpaProxyRoutes(dataRoot, options.safeStorage, [...MANAGED_PROXY_COMPONENTS]),
          readCpaConfigProxyUrl(cpaConfigPath),
        ]);
        Object.assign(diskState, { read: true, routes, cpaConfigProxyUrl });
      } while (diskReadAgain && !disposed);
      return diskStateKey() !== before;
    })().finally(() => { diskRead = null; });
    return diskRead;
  }
  function refreshAndPublish() {
    return refreshDiskState().then((changed) => {
      if (changed) publishCombined();
      return changed;
    }, () => false);
  }
  // One write reports several events (truncate, then data): one read follows the burst.
  let refreshTimer = null;
  const refreshSoon = () => {
    if (refreshTimer || disposed) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; void refreshAndPublish(); }, 50);
    refreshTimer.unref?.();
  };
  function directoryWatch(directory, fileNames) {
    let watcher = null;
    let armed = false;
    const close = () => { watcher?.close(); watcher = null; };
    return {
      // Started by a snapshot, and again by the next one after it fails. Once in place it reports a
      // change without a name (watchOffThread), and that read catches up on anything it missed. A
      // folder that doesn't exist yet (no proxy saved) fails before that and has nothing to read.
      ensure() {
        if (watcher || disposed) return;
        armed = false;
        try {
          // The folders also hold busy subfolders (CPA's plugin data); only these files matter.
          watcher = watchOffThread(directory, (_event, name) => {
            armed = true;
            if (name && !fileNames.includes(String(name))) return;
            refreshSoon();
          });
          watcher.on("error", () => {
            const wasWatching = armed;
            close();
            if (wasWatching) refreshSoon();
          });
          watcher.unref?.();
        } catch { close(); }
      },
      close,
    };
  }
  const diskWatches = [
    directoryWatch(providersDirectory, ["provider-network.json", "provider-network.key"]),
    directoryWatch(path.dirname(cpaConfigPath), ["config.yaml"]),
  ];
  /** An operation's own publish waits for a fresh read, so it shows the route it left behind. */
  async function publishFresh() {
    try { await refreshDiskState(); } catch {}
    publishCombined();
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
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.releaseFetch ? { releaseFetch: options.releaseFetch } : {}),
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

  function managedConfiguration(serviceId, { spawnEnvironment = true } = {}) {
    const installed = managedController.runtimeConfiguration(serviceId, { spawnEnvironment });
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

  // From the last disk read (refreshDiskState), never the disk.
  function cpaProxyStatus(service) {
    const cached = diskState.routes.get("cpa");
    if (!cached) return { profileId: null, configMatches: false, error: null };
    if (cached.error) {
      return { profileId: null, configMatches: false, error: cached.error instanceof Error ? cached.error.message : "CPA proxy settings unavailable" };
    }
    const route = cached.value;
    const written = diskState.cpaConfigProxyUrl;
    const configured = service.status === "ready" && written !== null && written === route.url;
    return { profileId: route.profileId, configMatches: configured, error: null };
  }

  // What a start would refuse for want of a proxy route (resolveManagedProxyEnvironment), from the
  // last disk read: a snapshot shows it as the service's error, as it did when it resolved the route.
  function checkReadProxyRoute(serviceId) {
    if (!MANAGED_PROXY_COMPONENTS.has(serviceId)) return;
    const cached = diskState.routes.get(serviceId);
    if (!cached) return;
    resolveManagedProxyEnvironment(serviceId, dataRoot, options.safeStorage, () => {
      if (cached.error) throw cached.error;
      return cached.value;
    });
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
      try {
        const installed = managedConfiguration(service.id, { spawnEnvironment: false });
        if (installed) checkReadProxyRoute(service.id);
        configuration = installed;
      } catch (error) {
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
    if (!disposed) {
      for (const watch of diskWatches) watch.ensure();
      if (!diskState.read && !diskRead) void refreshAndPublish();
    }
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
    await publishFresh();
    return serviceFromSnapshot(serviceId);
  }

  async function repairManagedComponent(serviceId) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId);
    applyManagedConfiguration(serviceId);
    await managedController.startComponent(serviceId);
    await baseController.inspect(serviceId);
    await publishFresh();
    return serviceFromSnapshot(serviceId);
  }

  function checkManagedComponentUpdate(serviceId) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
    return managedController.checkComponentUpdate(serviceId);
  }

  /**
   * Switches a running component to its installed update: stop, start the new version, and wait
   * for its health check. A version that fails goes back to the earlier one and is never retried.
   */
  async function swapManagedComponent(serviceId) {
    const change = managedController.activateComponentUpdate(serviceId);
    if (!change) return { swapped: false, current: managedController.project(serviceId).version };
    const relaunch = async () => {
      try { await managedController.stopComponent(serviceId); } catch {}
      applyManagedConfiguration(serviceId);
      await managedController.startComponent(serviceId);
    };
    let result;
    try {
      await relaunch();
      if (!await managedController.waitForHealth(serviceId, { timeoutMs: options.updateHealthTimeoutMs ?? 30_000 })) {
        throw new Error(`${serviceId} ${change.to} didn't pass its health check`);
      }
      managedController.confirmComponentUpdate(serviceId);
      managedController.pruneComponentVersions(serviceId);
      result = { swapped: true, ...change };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn?.("managed-component.update_rolled_back", { componentId: serviceId, ...change, message });
      managedController.rejectComponentUpdate(serviceId, change.to);
      await relaunch();
      result = { swapped: false, rolledBack: true, ...change, error: message };
    }
    await baseController.inspect(serviceId);
    await publishFresh();
    return result;
  }

  /** Installs the newest release beside the running one; with swap (the default) switches to it now. */
  async function updateManagedComponent(serviceId, { swap = true } = {}) {
    if (RETIRED_SERVICE_IDS.has(serviceId)) throw new Error(`${serviceId} service is retired`);
    const staged = await managedController.installComponentUpdate(serviceId);
    if (!swap) return { ...staged, swapped: false };
    return { ...staged, ...await swapManagedComponent(serviceId) };
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
      // Not yet started by this launcher, with an update waiting: the start is the switch, health
      // check and rollback included. A component this launcher already runs keeps running.
      if (!managed.processes.some((entry) => entry.running) && await managedController.pendingComponentUpdateAsync(serviceId)) {
        await swapManagedComponent(serviceId);
        return serviceFromSnapshot(serviceId);
      }
      applyManagedConfiguration(serviceId);
      await managedController.startComponent(serviceId);
      await baseController.inspect(serviceId);
      await publishFresh();
      return serviceFromSnapshot(serviceId);
    }
    return mergeService(await baseController.start(serviceId));
  }

  async function stop(serviceId) {
    const managed = managedController.project(serviceId);
    if (managed.installState === "installed") {
      await managedController.stopComponent(serviceId);
      try { await baseController.inspect(serviceId); } catch {}
      await publishFresh();
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
      await publishFresh();
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

  // project("cpa") reads CPA's install state from disk (bundle markers, release assets) with
  // synchronous calls. A chat's timeline asked for the connection once per text field it redacts,
  // about 2,000 times for a long chat, which held the main process for 3.8 s on the hard disk
  // whenever a project was opened (every IPC, the window's included, waited). The answer changes
  // only when CPA is installed or repaired or its keys rotate, and each of those forgets it
  // (forgettingCpaConnection below), so the timeout is only a backstop. At 2 s it still re-read
  // CPA's install state (8-10 synchronous calls) every other second while the CPA panel or a chat
  // was busy, on a disk answering reads in 0.6 s on average (seen live 2026-10-24).
  const CPA_CONNECTION_TTL_MS = 60_000;
  let cpaConnectionCache = null;
  function cpaConnection() {
    const now = Date.now();
    if (cpaConnectionCache && now - cpaConnectionCache.at < CPA_CONNECTION_TTL_MS) {
      return cpaConnectionCache.value && { ...cpaConnectionCache.value };
    }
    const managed = managedController.project("cpa");
    let value = null;
    if (managed.installState === "installed") {
      const secrets = managedController.runtimeSecrets("cpa");
      const managementKey = String(secrets.managementKey || "").trim();
      const proxyApiKey = String(secrets.proxyApiKey || "").trim();
      if (!managementKey || !proxyApiKey) {
        throw new Error("Managed CPA credentials are unavailable");
      }
      value = { baseUrl: SERVICE_ENDPOINTS.cpa.endpoint.replace(/\/$/, ""), managementKey, proxyApiKey };
    }
    cpaConnectionCache = { at: now, value };
    return value && { ...value };
  }
  // Whatever can install, repair, start, stop, reconfigure or re-key a component forgets the
  // remembered connection before it starts and again when it ends (failed or not), so nobody is
  // handed CPA's old state or old key once it has changed.
  function forgettingCpaConnection(change) {
    return (...args) => {
      cpaConnectionCache = null;
      let result;
      try {
        result = change(...args);
      } finally {
        if (!result || typeof result.then !== "function") cpaConnectionCache = null;
      }
      return result && typeof result.then === "function"
        ? result.finally(() => { cpaConnectionCache = null; })
        : result;
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
    disposed = true;
    for (const watch of diskWatches) watch.close();
    clearTimeout(refreshTimer); refreshTimer = null;
    managedController.dispose({ keepPersistent });
    baseController.dispose();
  }

  return Object.freeze({
    snapshot: combinedSnapshot,
    /** Reads the proxy routes and CPA's config again (off the main thread); publishes a change. */
    refreshDiskState: refreshAndPublish,
    configure: forgettingCpaConnection(configure),
    /** Resolves once every settings change so far is on disk (saved off the main thread). */
    saved: () => baseController.saved(),
    inspect,
    start: forgettingCpaConnection(start),
    stop: forgettingCpaConnection(stop),
    restart: forgettingCpaConnection(restart),
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
    installManagedComponent: forgettingCpaConnection(installManagedComponent),
    repairManagedComponent: forgettingCpaConnection(repairManagedComponent),
    checkManagedComponentUpdate,
    updateManagedComponent: forgettingCpaConnection(updateManagedComponent),
    swapManagedComponent: forgettingCpaConnection(swapManagedComponent),
    setManagedComponentCredential: forgettingCpaConnection(setManagedComponentCredential),
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
