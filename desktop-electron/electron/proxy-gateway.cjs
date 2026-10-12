const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { DEFAULT_BYPASS } = require("./provider-network.cjs");
const { processRunning, terminateOwnedProcessTree } = require("./process-tree.cjs");
const relay = require("./proxy-gateway-relay.cjs");

// App side of the built-in proxy gateway (the relay itself is proxy-gateway-relay.cjs).
//
// The gateway runs as a detached helper process so the Codex bridge, CPA and the MCP tunnel,
// which outlive app restarts and installs and read their proxy route from their environment,
// keep their network while the app is away. Like the bridge, the next app instance adopts a
// helper it can verify: its pid is alive, its control port answers with the token from the
// state file, it holds the data ports, and it serves the upstream the settings name.
//
// The data port requires a per-helper proxy token; it is saved as the builtin-gateway profile's
// secret in the encrypted provider store, so Chromium's proxy login, CPA and the env routes pick
// it up. The token-free port serves ChatGPT Desktop only and is an unauthenticated loopback
// proxy (the same exposure as ProxyBridge's 17891). Upstream credentials go to the helper on
// stdin and are never written to the settings, state or log files.
const {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_TOKENLESS_PORT,
  DEFAULT_TRACE_URL,
  GATEWAY_HOST,
  HELPER_SERVICE,
  PROXYBRIDGE_PORTS,
  PROXY_USERNAME,
} = relay;
const GATEWAY_PROFILE_ID = "builtin-gateway";
const GATEWAY_PROFILE_NAME = "Built-in proxy gateway";
const GATEWAY_PROFILE_SCOPES = Object.freeze([
  "all", "browser", "provider", "oauth", "subagent", "mcp", "websocket", "http", "update",
]);
const TOKENLESS_PROXY_ENV = "CODING_TOOLS_TOKENLESS_PROXY_URL";
const SETTINGS_VERSION = 1;
const STATE_VERSION = 1;
const LOG_ROTATE_BYTES = 1024 * 1024;
const BOOT_STARTED_AT_MS = Date.now() - (os.uptime() * 1_000);
const BOOT_TIME_TOLERANCE_MS = 5_000;
const PROXY_ENV_KEYS = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|electron_run_as_node|coding_tools_tokenless_proxy_url)$/i;

function noop() {}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

// A package runs the relay from app.asar.unpacked: the bundled Bun cannot read inside app.asar.
function relayScriptPath(directory = __dirname) {
  const packed = `${path.sep}app.asar${path.sep}`;
  const root = directory.includes(packed)
    ? directory.replace(packed, `${path.sep}app.asar.unpacked${path.sep}`)
    : directory;
  return path.join(root, "proxy-gateway-relay.cjs");
}

// The helper runs on the bundled Bun from the durable runtime under coreHome (as the bridge does),
// never on Coding Tools.exe: an installer replaces and stops programs in the install folder. A
// development checkout uses Electron as Node.
function resolveHelperRuntime({
  isPackaged,
  version,
  coreHome,
  execPath = process.execPath,
  platform = process.platform,
  arch = process.arch,
}) {
  if (!isPackaged) return { executable: execPath, args: [], env: { ELECTRON_RUN_AS_NODE: "1" }, kind: "electron" };
  const binary = platform === "win32" ? "bun.exe" : "bun";
  const versionsRoot = path.join(coreHome, "versions");
  const current = `${version}-${platform}-${arch}`;
  let names = [];
  try {
    names = fs.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !/\.(tmp|previous)-/.test(entry.name))
      .map((entry) => entry.name);
  } catch {}
  const ordered = [
    current,
    ...names.filter((name) => name.startsWith(`${current}-`)),
    ...names.filter((name) => name !== current && !name.startsWith(`${current}-`)).sort().reverse(),
  ];
  for (const name of ordered) {
    const executable = path.join(versionsRoot, name, "runtime", binary);
    if (fs.existsSync(executable)) return { executable, args: [], env: {}, kind: "bun" };
  }
  throw new Error("The bundled runtime is not installed yet; start the gateway again once Coding Tools has finished starting");
}

function helperEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_ENV_KEYS.test(key)));
  return { ...env, ...extra };
}

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    enabled: false,
    port: DEFAULT_GATEWAY_PORT,
    tokenlessPort: DEFAULT_TOKENLESS_PORT,
    upstreamProfileId: null,
    useForApp: false,
    previousGlobal: null,
  };
}

function normalizeSettings(value) {
  const fallback = defaultSettings();
  if (!value || typeof value !== "object" || value.version !== SETTINGS_VERSION) return fallback;
  let port = fallback.port;
  let tokenlessPort = fallback.tokenlessPort;
  try {
    port = relay.validateGatewayPort(value.port);
  } catch {}
  try {
    tokenlessPort = relay.validateGatewayPort(value.tokenlessPort ?? fallback.tokenlessPort);
  } catch {}
  if (tokenlessPort === port) tokenlessPort = port === DEFAULT_TOKENLESS_PORT ? DEFAULT_GATEWAY_PORT : DEFAULT_TOKENLESS_PORT;
  const previous = value.previousGlobal && typeof value.previousGlobal === "object"
    ? {
        enabled: value.previousGlobal.enabled === true,
        profileId: typeof value.previousGlobal.profileId === "string" ? value.previousGlobal.profileId : null,
      }
    : null;
  return {
    version: SETTINGS_VERSION,
    enabled: value.enabled === true,
    port,
    tokenlessPort,
    upstreamProfileId: typeof value.upstreamProfileId === "string" && value.upstreamProfileId
      ? value.upstreamProfileId
      : null,
    useForApp: value.useForApp === true,
    previousGlobal: previous,
  };
}

function normalizeState(value) {
  const port = (item) => Number.isInteger(item) && item > 0 && item < 65_536;
  const token = (item) => typeof item === "string" && /^[0-9a-f]{32,128}$/.test(item);
  if (!value || value.version !== STATE_VERSION
    || !Number.isInteger(value.pid) || value.pid < 1
    || !port(value.dataPort) || !(value.tokenlessPort === null || port(value.tokenlessPort))
    || !port(value.controlPort)
    || !token(value.controlToken) || !token(value.proxyToken)
    || typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)
    || typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
    return null;
  }
  return {
    pid: value.pid,
    dataPort: value.dataPort,
    tokenlessPort: value.tokenlessPort,
    controlPort: value.controlPort,
    controlToken: value.controlToken,
    proxyToken: value.proxyToken,
    upstreamProfileId: typeof value.upstreamProfileId === "string" ? value.upstreamProfileId : null,
    fingerprint: value.fingerprint,
    runtime: typeof value.runtime === "string" ? value.runtime : "unknown",
    startedAt: value.startedAt,
  };
}

function waitForExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (!processRunning(pid)) resolve(true);
      else if (Date.now() - started >= timeoutMs) resolve(false);
      else setTimeout(check, 50);
    };
    check();
  });
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("The gateway helper did not start in time")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let value;
      try {
        value = JSON.parse(buffered.slice(0, newline));
      } catch {
        finish(new Error("The gateway helper answered with an unreadable ready line"));
        return;
      }
      if (value?.event === "ready") finish(null, value);
      else finish(new Error(value?.error || "The gateway helper failed to start"));
    });
    child.once("error", (error) => finish(new Error(`The gateway helper could not start: ${error.message}`)));
    child.once("exit", (code, signal) => finish(new Error(`The gateway helper exited (${signal || code}) before it was ready`)));
  });
}

function controlRequest(target, method, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: GATEWAY_HOST,
      port: target.controlPort,
      method,
      path: pathname,
      headers: { Authorization: `Bearer ${target.controlToken}` },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Gateway control answered ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("Gateway control answer is unreadable"));
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Gateway control timed out")));
    request.on("error", reject);
    request.end();
  });
}

// Owns the gateway's settings, its helper process and the "Use for this app" switch. Settings and
// the state file hold no upstream secrets.
function createProxyGatewayController({
  userData,
  settingsPath = path.join(userData, "providers", "proxy-gateway.json"),
  statePath = path.join(userData, "providers", "proxy-gateway.state.json"),
  logPath = path.join(userData, "providers", "proxy-gateway.log"),
  network,
  logger = { info: noop, warn: noop },
  resolveRuntime = () => {
    throw new Error("No runtime is configured for the gateway helper");
  },
  helperScript = relayScriptPath(),
  spawnProcess = spawn,
  fetchTrace = relay.fetchGatewayTrace,
  probe = relay.probeGateway,
  traceUrl = DEFAULT_TRACE_URL,
  helperLimits = null,
  readyTimeoutMs = 15_000,
  controlTimeoutMs = 2_000,
  watchdogMs = 15_000,
}) {
  if (!network?.store || typeof network.applyGlobalRouting !== "function") {
    throw new Error("Proxy gateway needs the provider network controller");
  }
  const store = network.store;
  let settings;
  try {
    settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    settings = defaultSettings();
  }
  let helper = null;
  let ensurePromise = null;
  let watchdog = null;
  let lastError = null;
  let lastTest = null;

  // Child processes take the route from HTTP(S)_PROXY, which must carry the gateway's local token;
  // ChatGPT Desktop cannot send credentials and reads the token-free URL first.
  network.setEnvironmentRoute?.((profile) => {
    if (profile?.id !== GATEWAY_PROFILE_ID) return null;
    const secret = store.proxySecret(GATEWAY_PROFILE_ID);
    const host = `${GATEWAY_HOST}:${profile.endpoint.port}`;
    return {
      url: secret?.password
        ? `http://${encodeURIComponent(secret.username || PROXY_USERNAME)}:${encodeURIComponent(secret.password)}@${host}`
        : `http://${host}`,
      extra: { [TOKENLESS_PROXY_ENV]: `http://${GATEWAY_HOST}:${settings.tokenlessPort}` },
    };
  });

  function persist() {
    writePrivateFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  function readState() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(statePath, "utf8")));
    } catch {
      return null;
    }
  }

  function writeState(target) {
    writePrivateFileAtomic(statePath, `${JSON.stringify({
      version: STATE_VERSION,
      pid: target.pid,
      ownerPid: process.pid,
      dataPort: target.dataPort,
      tokenlessPort: target.tokenlessPort,
      controlPort: target.controlPort,
      controlToken: target.controlToken,
      proxyToken: target.proxyToken,
      upstreamProfileId: target.upstreamProfileId,
      fingerprint: target.fingerprint,
      runtime: target.runtime,
      startedAt: target.startedAt,
    }, null, 2)}\n`);
  }

  function clearState(pid = null) {
    const current = readState();
    if (pid !== null && current && current.pid !== pid) return;
    fs.rmSync(statePath, { force: true });
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = { message: message.slice(0, 500), at: new Date().toISOString() };
    return new Error(lastError.message);
  }

  function routeUsesGateway(routing = store.snapshot().routing) {
    return routing.globalEnabled === true && routing.globalProfileId === GATEWAY_PROFILE_ID;
  }

  function resolveUpstream(profileId = settings.upstreamProfileId) {
    if (!profileId) throw new Error("Choose an upstream proxy profile first");
    if (profileId === GATEWAY_PROFILE_ID) {
      throw new Error("The gateway cannot use its own profile as the upstream");
    }
    const profile = store.activeProxy(profileId);
    if (!profile) throw new Error("The upstream proxy profile was not found or is disabled");
    const credentials = profile.hasAuthentication ? store.proxySecret(profile.id) : null;
    if (profile.hasAuthentication && !credentials?.username && !credentials?.password) {
      throw new Error("Saved upstream proxy credentials are unavailable");
    }
    return relay.validateUpstream({
      protocol: profile.endpoint.protocol,
      host: profile.endpoint.host,
      port: profile.endpoint.port,
      username: credentials?.username || "",
      password: credentials?.password || "",
    }, { gatewayPorts: [settings.port, settings.tokenlessPort] });
  }

  // A helper is ours and usable only if its control port answers with our token and the same pid,
  // and both data ports are held by that pid.
  async function verify(target) {
    if (!target || !processRunning(target.pid)) return null;
    try {
      const live = await controlRequest(target, "GET", "/status", controlTimeoutMs);
      if (live?.service !== HELPER_SERVICE || live.pid !== target.pid) return null;
      const data = await probe({ port: target.dataPort, proxyToken: target.proxyToken, timeoutMs: controlTimeoutMs });
      if (data.pid !== target.pid) return null;
      if (target.tokenlessPort !== null) {
        const tokenless = await probe({ port: target.tokenlessPort, timeoutMs: controlTimeoutMs });
        if (tokenless.pid !== target.pid) return null;
      }
      return live;
    } catch {
      return null;
    }
  }

  function wanted(target, fingerprint) {
    return target.fingerprint === fingerprint
      && target.upstreamProfileId === settings.upstreamProfileId
      && target.dataPort === settings.port
      && target.tokenlessPort === settings.tokenlessPort;
  }

  // Only a helper verified as ours moments earlier is ever signalled.
  async function stopHelper(target) {
    try {
      await controlRequest(target, "POST", "/stop", controlTimeoutMs);
    } catch {}
    if (!(await waitForExit(target.pid, 3_000))) {
      try {
        if (target.child) terminateOwnedProcessTree(target.child);
        else process.kill(target.pid);
      } catch {}
      await waitForExit(target.pid, 2_000);
    }
    if (helper?.pid === target.pid) helper = null;
    clearState(target.pid);
    logger.info("proxy_gateway.helper_stopped", { pid: target.pid });
  }

  function rotateLog() {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(logPath).size > LOG_ROTATE_BYTES) fs.renameSync(logPath, `${logPath}.1`);
    } catch {}
  }

  async function spawnHelper(upstream, fingerprint) {
    const runtime = resolveRuntime();
    const controlToken = randomToken();
    const proxyToken = randomToken();
    rotateLog();
    const logFd = fs.openSync(logPath, "a", 0o600);
    let child;
    try {
      child = spawnProcess(runtime.executable, [...(runtime.args || []), helperScript], {
        // The working directory stays out of the install folder so an installer can replace it.
        cwd: path.dirname(statePath),
        detached: true,
        env: helperEnvironment(runtime.env),
        stdio: ["pipe", "pipe", logFd],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd);
    }
    child.on("error", noop);
    child.stdin.on("error", noop);
    child.stdout.on("error", noop);
    const ready = waitForReady(child, readyTimeoutMs);
    child.stdin.end(`${JSON.stringify({
      version: 1,
      dataPort: settings.port,
      tokenlessPort: settings.tokenlessPort,
      controlToken,
      proxyToken,
      upstreamProfileId: settings.upstreamProfileId,
      upstream,
      ...(helperLimits ? { limits: helperLimits } : {}),
    })}\n`);
    let started;
    try {
      const line = await ready;
      started = {
        pid: line.pid,
        dataPort: line.dataPort,
        tokenlessPort: line.tokenlessPort ?? null,
        controlPort: line.controlPort,
        controlToken,
        proxyToken,
        upstreamProfileId: settings.upstreamProfileId,
        fingerprint,
        runtime: runtime.kind || "unknown",
        startedAt: new Date().toISOString(),
        child,
      };
      if (started.pid !== child.pid || !(await verify(started))) {
        throw new Error("The gateway helper started but does not answer on its ports");
      }
    } catch (error) {
      try {
        if (child.exitCode === null && child.signalCode === null) terminateOwnedProcessTree(child);
      } catch {}
      throw error;
    }
    child.stdout.destroy();
    child.unref();
    writeState(started);
    logger.info("proxy_gateway.helper_started", {
      pid: started.pid,
      dataPort: started.dataPort,
      tokenlessPort: started.tokenlessPort,
      runtime: started.runtime,
      upstreamProfileId: started.upstreamProfileId,
    });
    return started;
  }

  async function ensureHelperOnce({ restart = false } = {}) {
    const upstream = resolveUpstream();
    const fingerprint = relay.upstreamFingerprint(upstream);
    if (!helper) {
      const state = readState();
      if (state) {
        const stale = Date.parse(state.startedAt) < BOOT_STARTED_AT_MS - BOOT_TIME_TOLERANCE_MS
          || !processRunning(state.pid);
        const live = stale ? null : await verify(state);
        if (live && wanted(state, fingerprint) && !restart) {
          helper = { ...state, adopted: true };
          logger.info("proxy_gateway.helper_adopted", { pid: state.pid, dataPort: state.dataPort });
          return helper;
        }
        if (live) {
          await stopHelper(state);
        } else {
          // A dead or unverifiable pid is never signalled: it may belong to someone else now.
          logger.warn("proxy_gateway.stale_state_discarded", { pid: state.pid, alive: !stale });
          clearState(state.pid);
        }
      }
    } else {
      const live = await verify(helper);
      if (live && wanted(helper, fingerprint) && !restart) return helper;
      if (live) await stopHelper(helper);
      else helper = null;
    }
    helper = await spawnHelper(upstream, fingerprint);
    return helper;
  }

  // Concurrent callers share one attempt instead of racing for the ports.
  function ensureHelper(options) {
    ensurePromise ??= ensureHelperOnce(options).finally(() => {
      ensurePromise = null;
    });
    return ensurePromise;
  }

  function ensureGatewayProfile() {
    if (!helper) throw new Error("The gateway is not running");
    const existing = store.snapshot().proxyProfiles.find((profile) => profile.id === GATEWAY_PROFILE_ID);
    if (existing?.archivedAt) {
      throw new Error("The built-in gateway profile was archived and cannot be reused");
    }
    const secret = existing?.hasAuthentication ? store.proxySecret(GATEWAY_PROFILE_ID) : null;
    const matches = existing
      && existing.enabled
      && existing.endpoint.protocol === "http"
      && existing.endpoint.host === GATEWAY_HOST
      && existing.endpoint.port === helper.dataPort
      && secret?.username === PROXY_USERNAME
      && secret?.password === helper.proxyToken;
    if (matches) return false;
    store.saveProxyProfile({
      id: GATEWAY_PROFILE_ID,
      name: GATEWAY_PROFILE_NAME,
      enabled: true,
      endpoint: { protocol: "http", host: GATEWAY_HOST, port: helper.dataPort },
      scopes: [...GATEWAY_PROFILE_SCOPES],
      bypass: existing?.bypass ?? [...DEFAULT_BYPASS],
      username: PROXY_USERNAME,
      password: helper.proxyToken,
    });
    return true;
  }

  function gatewayProfileExists() {
    return store.snapshot().proxyProfiles.some((profile) => profile.id === GATEWAY_PROFILE_ID && !profile.archivedAt);
  }

  // A new or adopted helper is listening and verified; only now may the route point at it.
  async function routeToHelper() {
    if (!gatewayProfileExists()) return;
    const changed = ensureGatewayProfile();
    if (changed && routeUsesGateway()) await network.applyGlobalRouting();
  }

  // Puts back the global route that was active before "Use for this app" was switched on.
  function restorePreviousRoute() {
    if (!routeUsesGateway()) {
      settings.previousGlobal = null;
      return false;
    }
    const previous = settings.previousGlobal;
    const usable = previous?.profileId
      && previous.profileId !== GATEWAY_PROFILE_ID
      && store.activeProxy(previous.profileId);
    store.setGlobalRouting(usable && previous.enabled
      ? { enabled: true, profileId: previous.profileId }
      : { enabled: false, profileId: usable ? previous.profileId : null });
    settings.previousGlobal = null;
    return true;
  }

  // Takes the app off the gateway without ever leaving the route on a dead or upstream-less port:
  // the previous route if it can be restored, direct otherwise.
  async function leaveGatewayRoute(reason, { apply = true } = {}) {
    let restored = false;
    try {
      restored = restorePreviousRoute();
    } catch (error) {
      logger.warn("proxy_gateway.route_restore_failed", { message: error instanceof Error ? error.message : String(error) });
      try {
        store.setGlobalRouting({ enabled: false, profileId: null });
        restored = true;
      } catch {}
    }
    settings.useForApp = false;
    settings.previousGlobal = null;
    try {
      persist();
    } catch (error) {
      logger.warn("proxy_gateway.settings_write_failed", { message: error instanceof Error ? error.message : String(error) });
    }
    if (restored) {
      logger.warn("proxy_gateway.route_restored", { reason, profileId: store.snapshot().routing.globalProfileId });
      if (apply) await network.applyGlobalRouting();
    }
    return restored;
  }

  function startWatchdog() {
    if (watchdog || !(watchdogMs > 0)) return;
    watchdog = setInterval(() => {
      if (!settings.enabled || !helper || processRunning(helper.pid) || ensurePromise) return;
      logger.warn("proxy_gateway.helper_exited", { pid: helper.pid });
      helper = null;
      void ensureHelper()
        .then(() => routeToHelper())
        .catch(async (error) => {
          fail(error);
          if (routeUsesGateway()) await leaveGatewayRoute("helper_restart_failed").catch(noop);
        });
    }, watchdogMs);
    watchdog.unref?.();
  }

  async function status() {
    const snapshot = store.snapshot();
    const findProfile = (id) => snapshot.proxyProfiles.find((profile) => profile.id === id) ?? null;
    const globalProfile = snapshot.routing.globalProfileId ? findProfile(snapshot.routing.globalProfileId) : null;
    let live = null;
    if (helper && processRunning(helper.pid)) {
      try {
        live = await controlRequest(helper, "GET", "/status", controlTimeoutMs);
      } catch {}
    }
    const errors = [lastError, live?.lastError].filter(Boolean).sort((left, right) => right.at.localeCompare(left.at));
    const publicProfile = (profile) => (profile
      ? {
          profileId: profile.id,
          name: profile.name,
          protocol: profile.endpoint.protocol,
          host: profile.endpoint.host,
          port: profile.endpoint.port,
          hasAuthentication: profile.hasAuthentication,
        }
      : null);
    return {
      enabled: settings.enabled,
      running: Boolean(live),
      listen: { host: GATEWAY_HOST, port: helper?.dataPort ?? settings.port },
      port: settings.port,
      tokenlessPort: settings.tokenlessPort,
      reservedPorts: [...PROXYBRIDGE_PORTS],
      gatewayProfileId: GATEWAY_PROFILE_ID,
      helper: helper
        ? { pid: helper.pid, runtime: helper.runtime, adopted: helper.adopted === true, startedAt: helper.startedAt }
        : null,
      upstreamProfileId: settings.upstreamProfileId,
      upstream: publicProfile(settings.upstreamProfileId ? findProfile(settings.upstreamProfileId) : null),
      useForApp: routeUsesGateway(snapshot.routing),
      globalRoute: {
        enabled: snapshot.routing.globalEnabled,
        profileId: snapshot.routing.globalProfileId,
        profile: publicProfile(globalProfile),
      },
      previousGlobal: settings.previousGlobal ? { ...settings.previousGlobal } : null,
      stats: live?.stats ?? null,
      lastError: errors[0] ?? null,
      lastTest: lastTest ? { ...lastTest } : null,
    };
  }

  // Called before the saved global route is applied at launch. An adopted helper keeps the
  // bridge's and CPA's traffic flowing across the restart; a helper that cannot be adopted or
  // started hands the app back to the route it used before.
  async function startup() {
    const routed = routeUsesGateway();
    if (!settings.enabled && !routed) {
      await retireUnwantedHelper();
      return status();
    }
    try {
      await ensureHelper();
      if (routed) ensureGatewayProfile();
      else await routeToHelper();
      startWatchdog();
    } catch (error) {
      fail(error);
      logger.warn("proxy_gateway.startup_failed", { message: lastError.message });
      if (routed) await leaveGatewayRoute("startup_failed", { apply: false });
    }
    return status();
  }

  async function retireUnwantedHelper() {
    const state = readState();
    if (!state) return;
    const live = await verify(state);
    if (live) await stopHelper(state);
    else clearState(state.pid);
  }

  async function configure(input = {}) {
    if (!input || typeof input !== "object") throw new Error("Gateway settings are required");
    const next = { ...settings };
    if (Object.hasOwn(input, "port")) next.port = relay.validateGatewayPort(input.port);
    if (Object.hasOwn(input, "tokenlessPort")) next.tokenlessPort = relay.validateGatewayPort(input.tokenlessPort, "Token-free port");
    if (next.port === next.tokenlessPort) throw fail(new Error("The gateway and token-free ports must differ"));
    if (Object.hasOwn(input, "upstreamProfileId")) {
      next.upstreamProfileId = typeof input.upstreamProfileId === "string" && input.upstreamProfileId.trim()
        ? input.upstreamProfileId.trim()
        : null;
    }
    const previous = settings;
    settings = next;
    try {
      if (settings.upstreamProfileId) resolveUpstream();
      else if (helper) throw new Error("Stop the gateway before clearing its upstream");
    } catch (error) {
      settings = previous;
      throw fail(error);
    }
    persist();
    if (helper) {
      try {
        await ensureHelper();
      } catch (error) {
        // Keep the app's route alive: go back to the settings that were working.
        settings = previous;
        persist();
        await ensureHelper().catch(noop);
        throw fail(error);
      }
      await routeToHelper();
    }
    lastError = null;
    return status();
  }

  async function setRunning(running) {
    if (running === true) {
      try {
        await ensureHelper();
        await routeToHelper();
      } catch (error) {
        throw fail(error);
      }
      settings.enabled = true;
      persist();
      startWatchdog();
      return status();
    }
    // The app leaves the gateway first, so nothing is routed to a port that is about to close.
    if (routeUsesGateway()) await leaveGatewayRoute("gateway_stopped");
    settings.enabled = false;
    settings.useForApp = false;
    persist();
    if (helper) {
      if (await verify(helper)) await stopHelper(helper);
      helper = null;
    } else {
      await retireUnwantedHelper();
    }
    return status();
  }

  async function setUseForApp(enabled) {
    if (enabled === true) {
      try {
        await ensureHelper();
        ensureGatewayProfile();
      } catch (error) {
        throw fail(error);
      }
      const routing = store.snapshot().routing;
      if (!routeUsesGateway(routing)) {
        settings.previousGlobal = { enabled: routing.globalEnabled, profileId: routing.globalProfileId };
      }
      store.setGlobalRouting({ enabled: true, profileId: GATEWAY_PROFILE_ID });
      settings.enabled = true;
      settings.useForApp = true;
      persist();
      startWatchdog();
      await network.applyGlobalRouting();
      logger.info("proxy_gateway.app_route_enabled", { previousProfileId: settings.previousGlobal?.profileId ?? null });
      return status();
    }
    await leaveGatewayRoute("switched_off");
    logger.info("proxy_gateway.app_route_disabled", { profileId: store.snapshot().routing.globalProfileId });
    return status();
  }

  // The upstream profile was edited or archived in Network Proxy. New credentials need a new
  // helper; a lost upstream takes the app off the gateway instead of leaving every request 502.
  async function refreshUpstream({ credentialsChanged = false } = {}) {
    if (!settings.upstreamProfileId) return status();
    let upstream;
    try {
      upstream = resolveUpstream();
    } catch (error) {
      fail(error);
      logger.warn("proxy_gateway.upstream_lost", { message: lastError.message });
      if (routeUsesGateway()) await leaveGatewayRoute("upstream_lost");
      settings.enabled = false;
      persist();
      if (helper) {
        if (await verify(helper)) await stopHelper(helper);
        helper = null;
      }
      return status();
    }
    if (!helper) return status();
    const restart = credentialsChanged || helper.fingerprint !== relay.upstreamFingerprint(upstream);
    if (!restart) return status();
    try {
      await ensureHelper({ restart: true });
      await routeToHelper();
    } catch (error) {
      fail(error);
      if (routeUsesGateway()) await leaveGatewayRoute("helper_restart_failed");
    }
    return status();
  }

  async function test() {
    if (!helper || !processRunning(helper.pid)) throw fail(new Error("Start the gateway before testing it"));
    const at = new Date().toISOString();
    try {
      const result = await fetchTrace({ host: GATEWAY_HOST, port: helper.dataPort, proxyToken: helper.proxyToken, url: traceUrl });
      lastTest = { ...result, at };
    } catch (error) {
      lastTest = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500), at };
    }
    logger[lastTest.ok ? "info" : "warn"]("proxy_gateway.tested", {
      ok: lastTest.ok,
      loc: lastTest.loc,
      latencyMs: lastTest.latencyMs,
      error: lastTest.error,
    });
    return status();
  }

  // App quit: the helper keeps running for the bridge and CPA, and the next app adopts it.
  function close() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    helper?.child?.unref?.();
    helper = null;
    return Promise.resolve();
  }

  return {
    status,
    startup,
    configure,
    setRunning,
    setUseForApp,
    refreshUpstream,
    test,
    close,
    upstreamProfileId: () => settings.upstreamProfileId,
  };
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_TOKENLESS_PORT,
  DEFAULT_TRACE_URL,
  GATEWAY_PROFILE_ID,
  PROXYBRIDGE_PORTS,
  TOKENLESS_PROXY_ENV,
  createProxyGatewayController,
  relayScriptPath,
  resolveHelperRuntime,
};
