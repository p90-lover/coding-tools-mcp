const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { DEFAULT_BYPASS } = require("./provider-network.cjs");
const { processRunning, terminateOwnedProcessTreeAsync } = require("./process-tree.cjs");
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
// key", and on evidence of a squat on the data port: the port could not be bound, or it answers
// the control-token probe with a 200 JSON naming another process or service (whether our helper
// died or is alive). Anything less definite (our busy helper's 503, an older helper's 407, a
// timeout, a socket left by a dead helper) is not evidence. One incident rotates once per port
// within a minute. After a rotation the route is re-applied at once and CPA restarts once a
// helper serves the new key; the Codex bridge and the MCP tunnel are never restarted (they carry
// in-flight work), so the status lists them in needsRestart until the runtime supervisor's state
// shows them running as new processes (or the app restarts, when their pids are unknown).
// A helper that died while the port stayed free is replaced with the same key. That leaves one
// window: something that bound the port after the helper died and released it before we looked
// could have collected the key children sent meanwhile, and the key is not rotated for it.
//
// The token-free port is an unauthenticated loopback proxy for ChatGPT Desktop, which receives its
// route as `--proxy-server` and cannot carry credentials. It is closed by default and opened over
// the control channel only while a ChatGPT Desktop instance runs (or is being launched); the app
// renews a lease with a heartbeat and the helper closes the port by itself once the lease lapses,
// so a quit or crashed app does not leave it open. A ChatGPT Desktop instance still running after
// the app quits loses its proxy then.
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

// The process holding a local port (listening on it, or only bound to it) and its command line, or
// null (unknown, or not Windows). Asynchronous: it is asked only after a bind failed, and must not
// block the main process.
function windowsPortOwner(port) {
  if (process.platform !== "win32" || !Number.isInteger(port) || port < 1) return Promise.resolve(null);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Not only listeners: the 0.7.0-rc.26 relay seen live held 17894 bound but not listening (state 0,
  // missing from netstat), which a `-State Listen` lookup never found. Its own local socket has no
  // remote end, unlike a client's connection to the port.
  const script = `$c = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | Select-Object -First 1; `
    + "if ($c) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\"; "
    + "[pscustomobject]@{ pid = [int]$c.OwningProcess; commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress }";
  return new Promise((resolve) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        if (error || !String(stdout).trim()) return resolve(null);
        try {
          const owner = JSON.parse(String(stdout).trim());
          resolve(Number.isInteger(owner.pid) && owner.pid > 0 ? { pid: owner.pid, commandLine: String(owner.commandLine || "") } : null);
        } catch {
          resolve(null);
        }
      });
  });
}

// The Codex bridge (daemon) and MCP tunnel pids from the runtime supervisor's ownership state, so
// a "needs restart" note clears once they run as new processes.
function readSupervisorPids(coreHome) {
  const state = JSON.parse(fs.readFileSync(path.join(coreHome, "runtime", "launcher-supervisor.json"), "utf8"));
  const pid = (value) => (Number.isInteger(value) && value > 0 ? value : null);
  return { bridge: pid(state?.daemonPid), mcp: pid(state?.tunnelPid) };
}

// A just-exited process's listening socket can linger for a moment; wait (bounded) for it to go.
async function waitForPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portHeld(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await portHeld(port));
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
  probeAnswer = relay.probeGatewayAnswer,
  traceUrl = DEFAULT_TRACE_URL,
  helperLimits = null,
  readyTimeoutMs = 15_000,
  controlTimeoutMs = 2_000,
  verifyRetryDelaysMs = [250, 750, 1_500],
  watchdogMs = 15_000,
  restartBackoffBaseMs = 15_000,
  restartBackoffCapMs = 10 * 60_000,
  tokenlessHoldMs = 2 * 60_000,
  tokenlessHeartbeatMs = 10_000,
  tokenlessLeaseMs = 30_000,
  // Called after the key rotated on evidence of a squat, so CPA can restart with the new key.
  onAccessKeyRotated = noop,
  // Reads the kept services' pids ({ bridge, mcp }); null when unknown.
  readServicePids = () => null,
  rotationDedupMs = 60_000,
  portReleaseWaitMs = 5_000,
  // Who listens on a port ({ pid, commandLine } or null): finds a helper an earlier app left running.
  portOwner = windowsPortOwner,
  // The clock for the restart backoff, the launch hold and the rotation dedup (tests advance it).
  now = Date.now,
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
  let restartPending = false;
  let lastError = null;
  let lastTest = null;
  let tokenlessDemand = false;
  let tokenlessHoldUntil = 0;
  let heartbeat = null;
  // Set by close(): background work (watchdog, heartbeat) never starts or restarts a helper after.
  let closed = false;
  // Evidence rotation bookkeeping: the reason waiting for the route follow-up, the reason waiting
  // for CPA's restart (once a helper runs), when each port last rotated (one incident rotates
  // once), a key for the next helper when no gateway profile exists yet, and the kept services
  // that still hold the old key with their pids at the rotation.
  let rotationPending = null;
  let rotationHookPending = null;
  const rotatedPorts = new Map();
  let pendingKey = null;
  let needsRestart = [];
  let restartBaseline = {};

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
    return validKey(store.proxySecret(GATEWAY_PROFILE_ID)?.password) ?? pendingKey ?? validKey(helper?.proxyToken);
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
        if (target.child) await terminateOwnedProcessTreeAsync(target.child);
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
      tokenlessLeaseMs,
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
        if (child.exitCode === null && child.signalCode === null) await terminateOwnedProcessTreeAsync(child);
      } catch {}
      // Even a helper that would not die must never keep the app's process alive.
      child.stdout.destroy();
      child.unref();
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

  // What answers on the data port. Only a 200 JSON probe answer naming another process or service
  // is "other" (positive evidence of a squat). Our own helper at its connection cap (503), an older
  // helper (407), a timeout or an unreadable answer is "unknown": no rotation, verification retried.
  async function dataPortHolder(target) {
    let answer;
    try {
      answer = await probeAnswer({ port: target.dataPort, probeToken: target.controlToken, timeoutMs: controlTimeoutMs });
    } catch {
      return "unknown";
    }
    const value = answer?.value;
    if (answer?.statusCode !== 200 || !value || typeof value !== "object") return "unknown";
    return value.service === HELPER_SERVICE && value.pid === target.pid ? "ours" : "other";
  }

  function servicePids() {
    try {
      const pids = readServicePids();
      return pids && typeof pids === "object" ? pids : null;
    } catch {
      return null;
    }
  }

  // The kept services that may still hold the old key: those running at the rotation. A service
  // whose pid is unknown stays listed until the app restarts.
  function recordNeedsRestart() {
    const pids = servicePids();
    restartBaseline = {};
    needsRestart = ["bridge", "mcp"].filter((service) => {
      const pid = pids?.[service];
      if (pids && !(Number.isInteger(pid) && processRunning(pid))) return false;
      restartBaseline[service] = Number.isInteger(pid) ? pid : null;
      return true;
    });
  }

  // A listed service that has restarted (another pid) or stopped no longer holds the old key.
  function refreshNeedsRestart() {
    if (!needsRestart.length) return;
    const pids = servicePids();
    if (!pids) return;
    needsRestart = needsRestart.filter((service) => {
      const before = restartBaseline[service];
      if (!Number.isInteger(before)) return true;
      const now = pids[service];
      return now === before && processRunning(before);
    });
  }

  // Evidence that something other than our helper held the data port: children may have sent it
  // the key. Store a new key for the next helper; the route and CPA follow once a helper runs.
  // One incident (a squat found after an exit, then the failed bind on the next pass) rotates once.
  function rotateOnEvidence(reason, port) {
    if (rotationPending) return;
    const last = rotatedPorts.get(port);
    if (last && now() - last < rotationDedupMs) {
      logger.info("proxy_gateway.access_key_rotation_skipped", { reason, port });
      return;
    }
    rotatedPorts.set(port, now());
    const key = randomToken();
    if (gatewayProfile()) {
      saveGatewayProfile(gatewayProfile().endpoint.port, key);
      // The Codex bridge and the MCP tunnel are kept alive across restarts and carry in-flight
      // work, so they are never restarted for this; they take the key on their next start.
      recordNeedsRestart();
    }
    pendingKey = key;
    rotationPending = reason;
    logger.warn("proxy_gateway.access_key_rotated", { reason });
    if (needsRestart.length) logger.warn("proxy_gateway.restart_needed", { services: needsRestart, reason });
  }

  // After an evidence rotation: re-apply the route with the new key right away; restart CPA only
  // once a helper serves the new key (a CPA restart while the gateway is down would gain nothing).
  async function finishRotation(running) {
    if (rotationPending) {
      const reason = rotationPending;
      rotationPending = null;
      try {
        if (running) await routeToHelper();
        if (routeUsesGateway()) await network.applyGlobalRouting();
      } catch (error) {
        logger.warn("proxy_gateway.rotation_route_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      rotationHookPending = reason;
    }
    if (running && rotationHookPending) {
      const reason = rotationHookPending;
      rotationHookPending = null;
      await Promise.resolve(onAccessKeyRotated({ reason })).catch(noop);
    }
  }

  async function ensureHelperOnce(options = {}) {
    try {
      const result = await ensureHelperPass(options);
      await finishRotation(true);
      return result;
    } catch (error) {
      await finishRotation(false);
      throw error;
    }
  }

  /**
   * Stops a gateway helper an earlier app left on the port without a state file pointing at it (seen
   * live: a 0.7.0-rc.26 relay held 17894 for hours, and every pass failed to bind and rotated the
   * key). Only a process running this gateway's relay script is stopped; true when the port is free.
   */
  async function stopOrphanHelper(port) {
    const owner = await Promise.resolve().then(() => portOwner(port)).catch(() => null);
    if (!owner || owner.pid === process.pid || owner.pid === helper?.pid) return false;
    if (!owner.commandLine.toLowerCase().includes(path.basename(helperScript).toLowerCase())) return false;
    try {
      process.kill(owner.pid);
    } catch {
      return false;
    }
    await waitForExit(owner.pid, 3_000);
    await waitForPortRelease(port, portReleaseWaitMs);
    logger.warn("proxy_gateway.orphan_helper_stopped", { pid: owner.pid, port });
    return !(await portHeld(port));
  }

  async function ensureHelperPass({ restart = false, rotateKey = false } = {}, retried = false) {
    const upstream = resolveUpstream();
    const fingerprint = relay.upstreamFingerprint(upstream);
    let target = helper;
    if (!target) {
      target = readState();
      if (target && Date.parse(target.startedAt) < BOOT_STARTED_AT_MS - BOOT_TIME_TOLERANCE_MS) {
        logger.warn("proxy_gateway.stale_state_discarded", { pid: target.pid, reason: "previous_boot" });
        clearState(target.pid);
        target = null;
      }
    }
    if (target && !processRunning(target.pid)) {
      // Our helper died. Its port answering as another process is evidence of a squat; a port that
      // is free, or held without such an answer (the dead helper's socket can linger), is not.
      if (await portHeld(target.dataPort)) {
        if (await dataPortHolder(target) === "other") rotateOnEvidence("port_held_after_exit", target.dataPort);
        else await waitForPortRelease(target.dataPort, portReleaseWaitMs);
      }
      logger.warn("proxy_gateway.stale_state_discarded", { pid: target.pid, reason: "exited" });
      clearState(target.pid);
      helper = null;
      target = null;
    }
    const accessKey = rotateKey ? randomToken() : currentAccessKey() ?? randomToken();
    const keyHash = relay.accessKeyHash(accessKey);
    const keeps = (candidate, live) => !restart
      && live.fingerprint === fingerprint
      && live.keyHash === keyHash
      && live.scriptHash === scriptHash
      && (live.appVersion ?? null) === appVersion
      && candidate.upstreamProfileId === settings.upstreamProfileId
      && candidate.dataPort === settings.port
      && candidate.tokenlessPort === settings.tokenlessPort;
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
        // Never signal it and keep its state (the control token). Only a positive answer from
        // another process is a squat; otherwise it may be our helper, busy.
        helper = null;
        if (await dataPortHolder(target) === "other") {
          rotateOnEvidence("port_held_by_other", target.dataPort);
          unverified = null;
          throw new Error(`Something other than the gateway helper holds port ${target.dataPort}`);
        }
        unverified = { pid: target.pid, port: target.dataPort, since: unverified?.since ?? new Date().toISOString() };
        throw new Error(`An unverified helper (pid ${target.pid}) holds the gateway port ${target.dataPort}; verification is retried`);
      } else {
        // Alive without the port (a reused pid): discard without signalling it.
        logger.warn("proxy_gateway.stale_state_discarded", { pid: target.pid, reason: "port_not_held" });
        clearState(target.pid);
        helper = null;
      }
    }
    unverified = null;
    // A rotation in this pass (or a pending one) replaces the key the helper starts with.
    const startKey = rotateKey ? accessKey : currentAccessKey() ?? accessKey;
    try {
      helper = await spawnHelper(upstream, fingerprint, startKey);
      pendingKey = null;
    } catch (error) {
      if (/already in use/.test(error?.message || "")) {
        // Our own helper from an earlier app is not a squat: stop it and start ours once more.
        if (!retried && await stopOrphanHelper(settings.port)) return ensureHelperPass({ restart, rotateKey }, true);
        rotateOnEvidence("bind_failed", settings.port);
      }
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

  // A new or adopted helper is listening and verified; only now may the route point at it. A
  // replaced helper starts with the token-free port closed, so a standing demand reopens it.
  async function routeToHelper() {
    if (gatewayProfile()) {
      const changed = ensureGatewayProfile();
      if (changed && routeUsesGateway()) await network.applyGlobalRouting();
    }
    await reapplyTokenless();
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

  // Restarts an exited helper or retries an unverified one, backing off exponentially so a helper
  // that crashes right after ready is not respawned forever. The key changes only on evidence of a
  // squat, which the pass itself checks.
  async function watchdogTick() {
    if (closed || !settings.enabled || ensurePromise) return;
    if (helper && processRunning(helper.pid)) {
      if (Date.now() - Date.parse(helper.startedAt) > restartBackoffCapMs) restartFailures = 0;
      await reportHelperError();
      return;
    }
    if (helper) {
      logger.warn("proxy_gateway.helper_exited", { pid: helper.pid });
      // The state stays so the restart pass can check who holds the port now.
      helper = null;
      restartPending = true;
    } else if (!unverified && !restartPending) {
      return;
    }
    if (now() < nextRestartAt) return;
    nextRestartAt = now() + Math.min(restartBackoffBaseMs * (2 ** restartFailures), restartBackoffCapMs);
    restartFailures += 1;
    try {
      await ensureHelper();
      restartPending = false;
      await routeToHelper();
    } catch (error) {
      fail(error);
      if (!unverified && routeUsesGateway()) await leaveGatewayRoute("helper_restart_failed").catch(noop);
    }
  }

  // The helper's newest relay error (an upstream that refuses tunnels, say) goes to the app's log
  // once, so a route that stops working shows there and not only in the gateway tab.
  let reportedHelperError = null;
  async function reportHelperError() {
    let live;
    try {
      live = await controlRequest(helper, "GET", "/status", controlTimeoutMs);
    } catch {
      return;
    }
    const error = live?.lastError;
    if (error?.at && error.at !== reportedHelperError) {
      reportedHelperError = error.at;
      logger.warn("proxy_gateway.relay_error", { message: String(error.message ?? "").slice(0, 300), at: error.at,
        authFailures: live.stats?.authFailures ?? null });
    }
    // A client that sent a key the gateway does not hold (a service started with an old one): its
    // port at that moment, to match against the connections of the services still running.
    const denied = live?.stats?.lastAuthFailure;
    if (denied?.at && denied.at !== reportedAuthFailure) {
      reportedAuthFailure = denied.at;
      logger.warn("proxy_gateway.auth_failed", { at: denied.at, remotePort: denied.remotePort ?? null,
        authFailures: live.stats.authFailures ?? null, authChallenges: live.stats.authChallenges ?? null });
    }
  }
  let reportedAuthFailure = null;

  function startWatchdog() {
    if (closed || watchdog || !(watchdogMs > 0)) return;
    watchdog = setInterval(() => void watchdogTick(), watchdogMs);
    watchdog.unref?.();
  }

  // ---- token-free listener for ChatGPT Desktop ---------------------------------------------

  function tokenlessWanted() {
    return tokenlessDemand || now() < tokenlessHoldUntil;
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  // While the port is wanted, each beat renews the helper's lease; when it is no longer wanted the
  // beat closes it. If the app quits or crashes the beats stop and the helper closes it itself.
  function startHeartbeat() {
    if (closed || heartbeat || !(tokenlessHeartbeatMs > 0)) return;
    heartbeat = setInterval(() => {
      if (closed) {
        stopHeartbeat();
        return;
      }
      if (!tokenlessWanted() || !routeUsesGateway()) {
        void closeTokenlessIfIdle();
        return;
      }
      if (helper) {
        controlRequest(helper, "POST", "/tokenless/open", controlTimeoutMs).catch((error) => {
          logger.warn("proxy_gateway.tokenless_heartbeat_failed", { message: error.message });
        });
      }
    }, tokenlessHeartbeatMs);
    heartbeat.unref?.();
  }

  async function openTokenless() {
    const opened = await controlRequest(helper, "POST", "/tokenless/open", controlTimeoutMs);
    if (!opened?.tokenlessPort) throw new Error("The token-free gateway port did not open");
    startHeartbeat();
    return opened.tokenlessPort;
  }

  async function closeTokenlessIfIdle() {
    if (tokenlessWanted() && routeUsesGateway()) return;
    stopHeartbeat();
    if (!helper) return;
    try {
      await controlRequest(helper, "POST", "/tokenless/close", controlTimeoutMs);
    } catch {}
  }

  async function reapplyTokenless() {
    if (!helper || !tokenlessWanted() || !routeUsesGateway()) return;
    try {
      await openTokenless();
    } catch (error) {
      logger.warn("proxy_gateway.tokenless_open_failed", { message: error.message });
    }
  }

  // The ChatGPT Desktop launch route: opens the token-free port (held for a launch window even
  // before the instance is tracked) when the app routes through the gateway.
  async function desktopRoute() {
    const profile = gatewayProfile();
    if (!profile || !routeUsesGateway() || !helper) return null;
    tokenlessHoldUntil = now() + tokenlessHoldMs;
    const port = await openTokenless();
    return { url: `http://${GATEWAY_HOST}:${port}`, bypass: [...profile.bypass] };
  }

  // ChatGPT Desktop reports whether any instance is running; the port closes after the last one.
  async function setDesktopRunning(running) {
    const next = running === true;
    if (next === tokenlessDemand) return;
    tokenlessDemand = next;
    if (next) await reapplyTokenless();
    else await closeTokenlessIfIdle();
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
        : settings.enabled && (restartPending || restartFailures > 0) && now() < nextRestartAt
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
      // Kept services still holding the previous key after an evidence rotation.
      needsRestart: (refreshNeedsRestart(), [...needsRestart]),
      watchdog: {
        restarts: restartFailures,
        nextRestartAt: nextRestartAt > now() ? new Date(nextRestartAt).toISOString() : null,
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
      // The watchdog retries it (with its backoff). Without this it saw no helper and nothing
      // pending and never tried again: a launch while the old app's relay still held the ports
      // left every CPA model failing with "proxyconnect" until the gateway was restarted by hand.
      if (settings.enabled) restartPending = true;
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
    restartPending = false;
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
      await reapplyTokenless();
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
  // token-free port is closed best effort; if that request never leaves, the stopped heartbeat
  // lets the lease lapse and the helper closes it by itself. Every timer is cleared here, so a
  // closed controller holds nothing that keeps the process alive.
  async function close() {
    closed = true;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    stopHeartbeat();
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
  readSupervisorPids,
  relayScriptPath,
  resolveHelperRuntime,
};
