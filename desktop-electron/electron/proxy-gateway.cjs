const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
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
// helper it can verify: its pid is alive, its control port answers with the control token from
// the state file, it holds the data port, and it runs this app's relay code and version with the
// upstream and access key the settings name. A helper whose pid is alive and which still holds the
// port but does not verify keeps its state (it is never signalled) and verification is retried.
//
// Access key: the data port requires `Proxy-Authorization: Basic ct:<key>`. The key's only stored
// copy is the builtin-gateway profile's secret in the encrypted provider store (never the state
// file), so Chromium's proxy login, CPA and the env routes pick it up (Bun 1.4 sends
// `http://ct:<key>@…` env credentials on plain requests and on CONNECT, verified). CPA's generated
// proxy-url YAML (cpa-managed.cjs) necessarily holds a plaintext copy. The key survives helper
// replacements so a kept bridge or CPA never meets a 407. It rotates on the user's "New access
// key", and also after the helper exits unexpectedly or its port could not be bound: something
// else may have held the port and collected the key that children send. Between such an exit and
// the restart (the watchdog interval plus backoff) children keep sending the old key to whatever
// answers on the port; after the rotation CPA is restarted with the new key and the Codex bridge
// picks it up on its next start.
//
// The token-free port is an unauthenticated loopback proxy for ChatGPT Desktop, which receives its
// route as `--proxy-server` and cannot carry credentials. It is closed by default and opened over
// the control channel only while a ChatGPT Desktop instance runs (or is being launched).
// Upstream credentials go to the helper on stdin and are never written to a file.
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
const SETTINGS_VERSION = 1;
const STATE_VERSION = 2;
const LOG_ROTATE_BYTES = 1024 * 1024;
const BOOT_STARTED_AT_MS = Date.now() - (os.uptime() * 1_000);
const BOOT_TIME_TOLERANCE_MS = 5_000;
const PROXY_ENV_KEYS = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|electron_run_as_node|coding_tools_tokenless_proxy_url)$/i;

function noop() {}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// A package runs the relay from app.asar.unpacked: the bundled Bun cannot read inside app.asar.
function relayScriptPath(directory = __dirname) {
  const packed = `${path.sep}app.asar${path.sep}`;
  const root = directory.includes(packed)
    ? directory.replace(packed, `${path.sep}app.asar.unpacked${path.sep}`)
    : directory;
  return path.join(root, "proxy-gateway-relay.cjs");
}

// "0.10.2-rc.3-win32-x64[-bundle]" -> comparable parts; numeric fields compare as numbers and a
// release sorts above its prereleases.
function versionParts(name) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-((?:[0-9A-Za-z]+\.?)*?))?-(?:win32|darwin|linux)-/.exec(name);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
  };
}

function compareVersionNames(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return a ? 1 : b ? -1 : left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (order) return order;
  }
  return 0;
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
    ...names.filter((name) => name !== current && !name.startsWith(`${current}-`))
      .sort((left, right) => compareVersionNames(right, left)),
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
  if (!value || value.version !== STATE_VERSION
    || !Number.isInteger(value.pid) || value.pid < 1
    || !port(value.dataPort) || !port(value.tokenlessPort) || !port(value.controlPort)
    || typeof value.controlToken !== "string" || !/^[0-9a-f]{64}$/.test(value.controlToken)
    || typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
    return null;
  }
  return {
    pid: value.pid,
    dataPort: value.dataPort,
    tokenlessPort: value.tokenlessPort,
    controlPort: value.controlPort,
    controlToken: value.controlToken,
    upstreamProfileId: typeof value.upstreamProfileId === "string" ? value.upstreamProfileId : null,
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
        let value = null;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        if (response.statusCode !== 200) {
          reject(new Error(value?.error || `Gateway control answered ${response.statusCode}`));
        } else if (!value) {
          reject(new Error("Gateway control answer is unreadable"));
        } else {
          resolve(value);
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Gateway control timed out")));
    request.on("error", reject);
    request.end();
  });
}

// True when something holds the loopback port (we cannot bind it ourselves).
function portHeld(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen({ host: GATEWAY_HOST, port, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

// Owns the gateway's settings, its helper process and the "Use for this app" switch. Settings and
// the state file hold no upstream secrets and no access key.
function createProxyGatewayController({
  userData,
  settingsPath = path.join(userData, "providers", "proxy-gateway.json"),
  statePath = path.join(userData, "providers", "proxy-gateway.state.json"),
  logPath = path.join(userData, "providers", "proxy-gateway.log"),
  network,
  logger = { info: noop, warn: noop },
  appVersion = null,
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
  verifyRetryDelaysMs = [250, 750, 1_500],
  watchdogMs = 15_000,
  restartBackoffBaseMs = 15_000,
  restartBackoffCapMs = 10 * 60_000,
  tokenlessHoldMs = 2 * 60_000,
  // Called after the key rotated because of an incident, so kept services can be restarted.
  onAccessKeyRotated = noop,
}) {
  if (!network?.store || typeof network.applyGlobalRouting !== "function") {
    throw new Error("Proxy gateway needs the provider network controller");
  }
  const store = network.store;
  const scriptHash = relay.relayScriptHash(helperScript);
  let settings;
  try {
    settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    settings = defaultSettings();
  }
  let helper = null;
  let unverified = null;
  let ensurePromise = null;
  let ensureKey = null;
  let watchdog = null;
  let restartFailures = 0;
  let nextRestartAt = 0;
  let incidentPending = false;
  let lastError = null;
  let lastTest = null;
  let tokenlessDemand = false;
  let tokenlessHoldUntil = 0;
  let tokenlessTimer = null;

  // Child processes take the route from HTTP(S)_PROXY, which must carry the gateway's access key.
  network.setEnvironmentRoute?.((profile) => {
    if (profile?.id !== GATEWAY_PROFILE_ID) return null;
    const secret = store.proxySecret(GATEWAY_PROFILE_ID);
    const host = `${GATEWAY_HOST}:${profile.endpoint.port}`;
    return {
      url: secret?.password
        ? `http://${encodeURIComponent(secret.username || PROXY_USERNAME)}:${encodeURIComponent(secret.password)}@${host}`
        : `http://${host}`,
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
      upstreamProfileId: target.upstreamProfileId,
      fingerprint: target.fingerprint,
      scriptHash: target.scriptHash,
      appVersion: target.appVersion,
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

  function validKey(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
  }

  // The access key children already hold: the encrypted profile secret is the source of truth;
  // a helper started in this session also has it in memory.
  function currentAccessKey() {
    return validKey(store.proxySecret(GATEWAY_PROFILE_ID)?.password) ?? validKey(helper?.proxyToken);
  }

  function gatewayProfile() {
    return store.snapshot().proxyProfiles.find((profile) => profile.id === GATEWAY_PROFILE_ID && !profile.archivedAt) ?? null;
  }

  function saveGatewayProfile(port, key) {
    const existing = gatewayProfile();
    store.saveProxyProfile({
      id: GATEWAY_PROFILE_ID,
      name: GATEWAY_PROFILE_NAME,
      enabled: true,
      endpoint: { protocol: "http", host: GATEWAY_HOST, port },
      scopes: existing?.scopes ?? [...GATEWAY_PROFILE_SCOPES],
      bypass: existing?.bypass ?? [...DEFAULT_BYPASS],
      username: PROXY_USERNAME,
      password: key,
    });
  }

  // One verification: our control token and pid answer, and that pid holds the data port (and the
  // token-free port while it is open).
  async function verifyOnce(target) {
    if (!target || !processRunning(target.pid)) return null;
    try {
      const live = await controlRequest(target, "GET", "/status", controlTimeoutMs);
      if (live?.service !== HELPER_SERVICE || live.pid !== target.pid) return null;
      const data = await probe({ port: target.dataPort, probeToken: target.controlToken, timeoutMs: controlTimeoutMs });
      if (data.pid !== target.pid) return null;
      if (live.tokenlessPort) {
        const tokenless = await probe({ port: live.tokenlessPort, timeoutMs: controlTimeoutMs });
        if (tokenless.pid !== target.pid) return null;
      }
      return live;
    } catch {
      return null;
    }
  }

  // A live helper can miss one check (a busy machine); retry with backoff before giving up.
  async function verify(target) {
    for (const delay of [0, ...verifyRetryDelaysMs]) {
      if (delay) await sleep(delay);
      const live = await verifyOnce(target);
      if (live) return live;
      if (!processRunning(target.pid)) return null;
    }
    return null;
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

  async function spawnHelper(upstream, fingerprint, proxyToken) {
    const runtime = resolveRuntime();
    const controlToken = randomToken();
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
      appVersion,
      upstream,
      ...(helperLimits ? { limits: helperLimits } : {}),
    })}\n`);
    let started;
    try {
      const line = await ready;
      started = {
        pid: line.pid,
        dataPort: line.dataPort,
        tokenlessPort: settings.tokenlessPort,
        controlPort: line.controlPort,
        controlToken,
        proxyToken,
        upstreamProfileId: settings.upstreamProfileId,
        fingerprint,
        scriptHash,
        appVersion,
        runtime: runtime.kind || "unknown",
        startedAt: new Date().toISOString(),
        child,
      };
      if (started.pid !== child.pid || !(await verifyOnce(started))) {
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
      runtime: started.runtime,
      upstreamProfileId: started.upstreamProfileId,
    });
    return started;
  }

  async function ensureHelperOnce({ restart = false, rotateKey = false } = {}) {
    const upstream = resolveUpstream();
    const fingerprint = relay.upstreamFingerprint(upstream);
    const accessKey = rotateKey ? randomToken() : currentAccessKey() ?? randomToken();
    const keyHash = relay.accessKeyHash(accessKey);
    const keeps = (target, live) => !restart
      && live.fingerprint === fingerprint
      && live.keyHash === keyHash
      && live.scriptHash === scriptHash
      && (live.appVersion ?? null) === appVersion
      && target.upstreamProfileId === settings.upstreamProfileId
      && target.dataPort === settings.port
      && target.tokenlessPort === settings.tokenlessPort;
    let target = helper;
    if (!target) {
      target = readState();
      if (target && (Date.parse(target.startedAt) < BOOT_STARTED_AT_MS - BOOT_TIME_TOLERANCE_MS || !processRunning(target.pid))) {
        logger.warn("proxy_gateway.stale_state_discarded", { pid: target.pid });
        clearState(target.pid);
        target = null;
      }
    }
    if (target) {
      const live = await verify(target);
      if (live && keeps(target, live)) {
        if (!helper) logger.info("proxy_gateway.helper_adopted", { pid: target.pid, dataPort: target.dataPort });
        helper = helper ?? { ...target, fingerprint, scriptHash, appVersion, proxyToken: accessKey, adopted: true };
        unverified = null;
        return helper;
      }
      if (live) {
        if (live.scriptHash !== scriptHash || (live.appVersion ?? null) !== appVersion) {
          logger.info("proxy_gateway.helper_outdated", { pid: target.pid, appVersion: live.appVersion ?? null });
        }
        await stopHelper(target);
      } else if (processRunning(target.pid) && await portHeld(target.dataPort)) {
        // Never signal it and keep its state (the control token): it may be our helper, busy.
        helper = null;
        unverified = { pid: target.pid, port: target.dataPort, since: unverified?.since ?? new Date().toISOString() };
        throw new Error(`An unverified helper (pid ${target.pid}) holds the gateway port ${target.dataPort}; verification is retried`);
      } else {
        // Dead, or alive without the port (a reused pid): discard without signalling it.
        logger.warn("proxy_gateway.stale_state_discarded", { pid: target.pid, alive: processRunning(target.pid) });
        clearState(target.pid);
        helper = null;
      }
    }
    unverified = null;
    try {
      helper = await spawnHelper(upstream, fingerprint, accessKey);
    } catch (error) {
      if (/already in use/.test(error?.message || "")) await rotateAfterIncident("bind_failed");
      throw error;
    }
    return helper;
  }

  // Concurrent callers with the same request share one attempt; a call asking for more (a restart
  // or a new key) queues its own pass after the one in flight.
  function ensureHelper(options = {}) {
    const key = `${options.restart === true}:${options.rotateKey === true}`;
    if (ensurePromise && ensureKey === key) return ensurePromise;
    const previous = ensurePromise ? ensurePromise.catch(noop) : Promise.resolve();
    const run = previous.then(() => ensureHelperOnce(options));
    ensurePromise = run;
    ensureKey = key;
    run.catch(noop).finally(() => {
      if (ensurePromise === run) {
        ensurePromise = null;
        ensureKey = null;
      }
    });
    return run;
  }

  // The port may have been held by something else that collected the key children send: store a
  // new key so the next helper (and every child restarted after it) uses it.
  async function rotateAfterIncident(reason) {
    if (gatewayProfile()) saveGatewayProfile(gatewayProfile().endpoint.port, randomToken());
    logger.warn("proxy_gateway.access_key_rotated", { reason });
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
    saveGatewayProfile(helper.dataPort, helper.proxyToken);
    return true;
  }

  // A new or adopted helper is listening and verified; only now may the route point at it.
  async function routeToHelper() {
    if (!gatewayProfile()) return;
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

  // Restarts an exited helper (with a new key) or retries an unverified one, backing off
  // exponentially so a helper that crashes right after ready is not respawned forever.
  async function watchdogTick() {
    if (!settings.enabled || ensurePromise) return;
    if (helper && processRunning(helper.pid)) {
      if (Date.now() - Date.parse(helper.startedAt) > restartBackoffCapMs) restartFailures = 0;
      return;
    }
    if (helper) {
      logger.warn("proxy_gateway.helper_exited", { pid: helper.pid });
      clearState(helper.pid);
      helper = null;
      incidentPending = true;
    } else if (!unverified && !incidentPending) {
      return;
    }
    if (Date.now() < nextRestartAt) return;
    nextRestartAt = Date.now() + Math.min(restartBackoffBaseMs * (2 ** restartFailures), restartBackoffCapMs);
    restartFailures += 1;
    const rotate = incidentPending;
    try {
      await ensureHelper({ rotateKey: rotate });
      incidentPending = false;
      await routeToHelper();
      if (rotate) {
        logger.warn("proxy_gateway.access_key_rotated", { reason: "helper_exited" });
        await Promise.resolve(onAccessKeyRotated({ reason: "helper_exited" })).catch(noop);
      }
    } catch (error) {
      fail(error);
      if (!unverified && routeUsesGateway()) await leaveGatewayRoute("helper_restart_failed").catch(noop);
    }
  }

  function startWatchdog() {
    if (watchdog || !(watchdogMs > 0)) return;
    watchdog = setInterval(() => void watchdogTick(), watchdogMs);
    watchdog.unref?.();
  }

  // ---- token-free listener for ChatGPT Desktop ---------------------------------------------

  async function closeTokenlessIfIdle() {
    if (tokenlessDemand || Date.now() < tokenlessHoldUntil || !helper) return;
    try {
      await controlRequest(helper, "POST", "/tokenless/close", controlTimeoutMs);
    } catch {}
  }

  // The ChatGPT Desktop launch route: opens the token-free port (held for a launch window even
  // before the instance is tracked) when the app routes through the gateway.
  async function desktopRoute() {
    const profile = gatewayProfile();
    if (!profile || !routeUsesGateway() || !helper) return null;
    tokenlessHoldUntil = Date.now() + tokenlessHoldMs;
    clearTimeout(tokenlessTimer);
    tokenlessTimer = setTimeout(() => void closeTokenlessIfIdle(), tokenlessHoldMs + 50);
    tokenlessTimer.unref?.();
    const opened = await controlRequest(helper, "POST", "/tokenless/open", controlTimeoutMs);
    if (!opened?.tokenlessPort) throw new Error("The token-free gateway port did not open");
    return { url: `http://${GATEWAY_HOST}:${opened.tokenlessPort}`, bypass: [...profile.bypass] };
  }

  // ChatGPT Desktop reports whether any instance is running; the port closes after the last one.
  async function setDesktopRunning(running) {
    const next = running === true;
    if (next === tokenlessDemand) return;
    tokenlessDemand = next;
    if (next) {
      if (helper && routeUsesGateway()) {
        await controlRequest(helper, "POST", "/tokenless/open", controlTimeoutMs).catch((error) => {
          logger.warn("proxy_gateway.tokenless_open_failed", { message: error.message });
        });
      }
    } else {
      await closeTokenlessIfIdle();
    }
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
    const helperState = live
      ? "running"
      : unverified
        ? "unverified"
        : settings.enabled && (incidentPending || restartFailures > 0) && Date.now() < nextRestartAt
          ? "restarting"
          : "stopped";
    return {
      enabled: settings.enabled,
      running: Boolean(live),
      helperState,
      listen: { host: GATEWAY_HOST, port: helper?.dataPort ?? settings.port },
      port: settings.port,
      tokenlessPort: settings.tokenlessPort,
      tokenlessOpen: Boolean(live?.tokenlessPort),
      reservedPorts: [...PROXYBRIDGE_PORTS],
      gatewayProfileId: GATEWAY_PROFILE_ID,
      helper: helper
        ? { pid: helper.pid, runtime: helper.runtime, adopted: helper.adopted === true, startedAt: helper.startedAt }
        : null,
      unverifiedHelper: unverified ? { ...unverified } : null,
      watchdog: {
        restarts: restartFailures,
        nextRestartAt: nextRestartAt > Date.now() ? new Date(nextRestartAt).toISOString() : null,
      },
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
      // No ChatGPT Desktop instance is tracked yet in this app: a token-free port left open by the
      // previous app closes until one asks for it.
      await closeTokenlessIfIdle();
    } catch (error) {
      fail(error);
      logger.warn("proxy_gateway.startup_failed", { message: lastError.message });
      if (routed) await leaveGatewayRoute("startup_failed", { apply: false });
    }
    startWatchdog();
    return status();
  }

  async function retireUnwantedHelper() {
    const state = readState();
    if (!state) return;
    const live = processRunning(state.pid) ? await verify(state) : null;
    if (live) await stopHelper(state);
    else if (!processRunning(state.pid)) clearState(state.pid);
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
    incidentPending = false;
    restartFailures = 0;
    nextRestartAt = 0;
    await ensurePromise?.catch(noop);
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
      await ensurePromise?.catch(noop);
      if (helper) {
        if (await verify(helper)) await stopHelper(helper);
        helper = null;
      }
      return status();
    }
    if (!helper && !ensurePromise) return status();
    const restart = credentialsChanged || helper?.fingerprint !== relay.upstreamFingerprint(upstream);
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

  // The user's "New access key": replaces a running helper with the new key and updates the route;
  // kept background services pick it up when they restart.
  async function rotateAccessKey() {
    await ensurePromise?.catch(noop);
    if (helper && processRunning(helper.pid)) {
      try {
        await ensureHelper({ rotateKey: true });
        await routeToHelper();
      } catch (error) {
        throw fail(error);
      }
    } else if (gatewayProfile()) {
      saveGatewayProfile(gatewayProfile().endpoint.port, randomToken());
      if (routeUsesGateway()) await network.applyGlobalRouting();
    }
    logger.info("proxy_gateway.access_key_rotated", { reason: "user", running: Boolean(helper) });
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

  // App quit: the helper keeps running for the bridge and CPA, and the next app adopts it. The
  // token-free port is closed (best effort; the next adoption closes it otherwise).
  async function close() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    clearTimeout(tokenlessTimer);
    const target = helper;
    helper = null;
    target?.child?.unref?.();
    if (target) await controlRequest(target, "POST", "/tokenless/close", controlTimeoutMs).catch(noop);
  }

  return {
    status,
    startup,
    configure,
    setRunning,
    setUseForApp,
    refreshUpstream,
    rotateAccessKey,
    desktopRoute,
    setDesktopRunning,
    test,
    close,
    upstreamProfileId: () => settings.upstreamProfileId,
    // For tests: run one watchdog pass now.
    watchdogTick,
  };
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_TOKENLESS_PORT,
  DEFAULT_TRACE_URL,
  GATEWAY_PROFILE_ID,
  PROXYBRIDGE_PORTS,
  compareVersionNames,
  createProxyGatewayController,
  relayScriptPath,
  resolveHelperRuntime,
};
