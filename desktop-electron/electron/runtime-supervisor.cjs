const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { redactText } = require("./logging.cjs");
const {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTreeAsync,
} = require("./process-tree.cjs");
const { runtimeInvocation, runtimeReleaseVersion } = require("./runtime-command.cjs");
const { runOffThread } = require("./off-thread-run.cjs");
const { ExtraTunnels } = require("./extra-tunnels.cjs");

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const DRAIN_IDLE_TIMEOUT_MS = 15_000;
const DRAIN_POLL_INTERVAL_MS = 100;
// What a setup that waits for running turns is about to apply (RuntimeHost operation names).
const SETUP_WAIT_LABELS = {
  "bigger-context": "applying Bigger Context",
  "use-saved-chats": "changing saved chats",
  "browser-interaction-mode": "changing browser interaction",
};
const TUNNEL_START_TIMEOUT_MS = 120_000;
const TUNNEL_HEALTH_POLL_INTERVAL_MS = 1_000;
const TUNNEL_MONITOR_INTERVAL_MS = 10_000;
const TUNNEL_MONITOR_FAILURE_THRESHOLD = 3;
const TUNNEL_MCP_FAILURE_RECENCY_MS = 2 * 60_000;
const BOOT_TIME_CLOCK_TOLERANCE_MS = 5_000;
const CURRENT_BOOT_STARTED_AT_MS = Date.now() - (os.uptime() * 1_000);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function collectLines(stream, onLine, onError) {
  if (!stream) return;
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_RUNTIME_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_RUNTIME_LOG_LINE_CHARS)}…[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
  stream.on("error", (error) => onError?.(error));
}

function loopbackHealthBaseURL(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:"
      || !["127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
      || !parsed.port) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function readJson(pathname) {
  // A file saved by Windows PowerShell (Set-Content -Encoding utf8) starts with a byte order mark,
  // which JSON.parse refuses: the setup config read that way stopped the app at startup.
  return JSON.parse(fs.readFileSync(pathname, "utf8").replace(/^﻿/, ""));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function appendFailure(primary, label, failure) {
  return `${primary}; ${label}: ${errorMessage(failure)}`;
}

function absolutePath(value, platform = process.platform) {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.isAbsolute(value);
}

function pathIdentity(value, platform = process.platform) {
  const normalized = platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function windowsPipeEndpoint(value) {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}

function tunnelRuntimeAbsent(value) {
  return /not found|not running|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(
    String(value || ""),
  );
}

function tunnelRuntimeStopped(health) {
  return health?.absent === true
    || (health?.state === "stopped" && health?.processRunning === false);
}

function runtimeOwnershipPredatesCurrentBoot(state) {
  return Boolean(
    state
    && Date.parse(state.updatedAt) < CURRENT_BOOT_STARTED_AT_MS - BOOT_TIME_CLOCK_TOLERANCE_MS
  );
}

/**
 * Stand-in for a ChildProcess when the launcher adopts a bridge daemon that a
 * previous launcher left running. It reports exit by polling the pid, which is
 * all the supervisor's readiness, shutdown and recovery paths need.
 */
class AdoptedProcess extends EventEmitter {
  constructor(pid, pollMs = 1_000) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.adopted = true;
    this.timer = setInterval(() => {
      if (processRunning(this.pid)) return;
      clearInterval(this.timer);
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    }, pollMs);
    this.timer.unref?.();
  }

  kill(signal = "SIGTERM") {
    try { process.kill(this.pid, signal); return true; } catch { return false; }
  }

  release() {
    clearInterval(this.timer);
  }
}

function runtimeOwnershipMayBeLive(state) {
  if (!state || runtimeOwnershipPredatesCurrentBoot(state)) return false;
  if (processRunning(state.daemonPid) || processRunning(state.tunnelPid)) return true;
  return ["starting", "ready", "degraded", "stopping", "detached"].includes(state.status);
}

/** True only when both runtime folders are known and name different bundles. */
function runtimeRootChanged(recorded, current) {
  if (typeof recorded !== "string" || typeof current !== "string") return false;
  const normal = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normal(recorded) !== normal(current);
}

function bridgeIdle(health) {
  return ["active_http_turns", "active_generations", "active_browser_turns"]
    .every((field) => !(Number(health?.[field]) > 0));
}

function conciseTunnelLog(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const tail = value.trim().split(/\r?\n/).slice(-3).join(" | ");
  const redacted = redactText(tail);
  return redacted.length > 800 ? `…${redacted.slice(-800)}` : redacted;
}

/** A finished tunnel CLI command as runTunnelCommand returns it; output leads with stderr on failure. */
function controlResult(code, stdout, stderr) {
  const stdoutText = stdout.trim();
  const stderrText = stderr.trim();
  return {
    code,
    stdout: stdoutText,
    stderr: stderrText,
    output: code === 0 ? (stdoutText || stderrText) : [stderrText, stdoutText].filter(Boolean).join("\n"),
  };
}

/**
 * A connect that gave up while its tunnel process still runs (still starting, or even ready by the
 * time it reported): the tunnel client's own wait is shorter than a loaded machine needs. Seen live
 * 2026-10-28 and -29: connect exited non-zero with state=starting (once state=ready, healthy=true),
 * the app tore the tunnel down, and the watchdog started it again two minutes later, for 20 minutes.
 */
function tunnelStillStarting(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (!stdout) return false;
  try {
    const parsed = JSON.parse(stdout);
    const state = String(parsed.runtime_state ?? parsed.state ?? parsed.status ?? "");
    return parsed.process_running === true && ["starting", "ready"].includes(state);
  } catch {
    return false;
  }
}

function tunnelControlDiagnostic(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      const logTail = conciseTunnelLog(
        typeof parsed.launch_diagnostics?.log_tail === "string"
          ? parsed.launch_diagnostics.log_tail
          : typeof parsed.local?.log?.tail === "string"
            ? parsed.local.log.tail
            : undefined,
      );
      const error = [parsed.error, parsed.remote_error, parsed.stop_error]
        .find(value => typeof value === "string" && value.trim());
      const state = parsed.runtime_state ?? parsed.state ?? parsed.status;
      const parts = [
        ...(state !== undefined ? [`state=${String(state)}`] : []),
        ...(parsed.process_running !== undefined ? [`process_running=${String(parsed.process_running)}`] : []),
        ...(parsed.healthy !== undefined ? [`healthy=${String(parsed.healthy)}`] : []),
        ...(parsed.ready !== undefined ? [`ready=${String(parsed.ready)}`] : []),
        ...(typeof error === "string" ? [error.trim()] : []),
        ...(logTail ? [`runtime_log=${logTail}`] : []),
      ];
      if (parts.length > 0) return redactText(parts.join("; ")).slice(0, 1_200);
    } catch {
      // Fall through to bounded plain-text diagnostics.
    }
  }
  return redactText([stderr, stdout].filter(Boolean).join("\n") || result?.output || "[no tunnel diagnostic]")
    .slice(0, 1_200);
}

function tunnelCommandQuoted(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) {
    throw new Error("Tunnel MCP command values must be non-empty single-line strings");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function managedTunnelMcpCommand(invocation) {
  if (!invocation
    || typeof invocation.executable !== "string"
    || !Array.isArray(invocation.args)) {
    throw new Error("Launcher tunnel MCP command requires an explicit runtime invocation");
  }
  return [invocation.executable, ...invocation.args]
    .map(tunnelCommandQuoted)
    .join(" ");
}

function managedTunnelConnectArgs(config, invocation) {
  const tunnel = config.tunnel;
  if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
  return [
    "runtimes", "connect",
    "--alias", tunnel.alias,
    "--profile", tunnel.profileName,
    "--profile-dir", tunnel.profileDir,
    "--tunnel-client-bin", tunnel.binaryPath,
    "--tunnel-id", tunnel.tunnelId,
    "--runtime-api-key", `file:${tunnel.runtimeKeyFile}`,
    "--mcp-command", managedTunnelMcpCommand(invocation),
    "--json",
  ];
}

function validateConfig(config, descriptorPath, platform = process.platform, launcherProfile = "production") {
  if (!config || config.version !== 3) throw new Error("Runtime configuration is missing or unsupported");
  if (launcherProfile === "development") {
    if (config.purpose !== "dev-harness") {
      throw new Error("DEV launcher refuses a configuration that is not marked dev-harness");
    }
  } else if (config.purpose !== undefined) {
    throw new Error("Production launcher refuses a DEV harness configuration");
  }
  if (config.solAvailable === undefined) config = { ...config, solAvailable: true };
  if (config.browserInteractionMode === undefined) {
    config.browserInteractionMode = "automatic";
  }
  if (config.mode !== "browser-only" && config.mode !== "full") {
    throw new Error("Runtime configuration has an invalid mode");
  }
  if (config.browserInteractionMode !== "automatic" && config.browserInteractionMode !== "manual") {
    throw new Error("Runtime configuration has an invalid browser interaction mode");
  }
  if (config.subagentProtocol !== undefined
    && config.subagentProtocol !== "compatibility-v1"
    && config.subagentProtocol !== "native") {
    throw new Error("Runtime configuration has an invalid subagent protocol");
  }
  if (typeof config.releaseVersion !== "string" || !config.releaseVersion.trim()) {
    throw new Error("Runtime configuration has no release version");
  }
  if (config.browserHost !== "launcher") throw new Error("Runtime configuration is not owned by the launcher");
  if (!absolutePath(config.browserHostDescriptorPath || "", platform)
    || pathIdentity(config.browserHostDescriptorPath || "", platform) !== pathIdentity(descriptorPath, platform)) {
    throw new Error("Runtime configuration points to a different launcher browser host");
  }
  if (config.host !== "127.0.0.1"
    || !Number.isInteger(config.port)
    || config.port < 1
    || config.port > 65_535) {
    throw new Error("Runtime configuration has an invalid loopback endpoint");
  }
  if (typeof config.controlToken !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(config.controlToken)) {
    throw new Error("Runtime configuration has an invalid lifecycle control token");
  }
  if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow <= 0) {
    throw new Error("Runtime configuration has an invalid context window");
  }
  if (typeof config.appName !== "string" || !config.appName.trim() || config.appName.length > 80) {
    throw new Error("Runtime configuration has an invalid connector name");
  }
  for (const key of ["chromeExecutablePath", "storageStatePath", "brokerSocketPath"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`Runtime configuration is missing ${key}`);
    }
  }
  if (platform === "win32") {
    if (!windowsPipeEndpoint(config.brokerSocketPath)) {
      throw new Error("Runtime configuration has an invalid Windows broker pipe");
    }
  } else if (!absolutePath(config.brokerSocketPath, platform) || windowsPipeEndpoint(config.brokerSocketPath)) {
    throw new Error("Runtime configuration has an invalid Unix broker socket");
  }
  for (const key of ["headed", "solAvailable", "proAvailable", "autoApproveToolCalls"]) {
    if (typeof config[key] !== "boolean") {
      throw new Error(`Runtime configuration has an invalid ${key}`);
    }
  }
  if (config.experimentalBiggerContext !== undefined
    && typeof config.experimentalBiggerContext !== "boolean") {
    throw new Error("Runtime configuration has an invalid experimentalBiggerContext");
  }
  // Absent means saved chats (configs written before the setting); only a boolean is valid.
  if (config.useSavedChats !== undefined && typeof config.useSavedChats !== "boolean") {
    throw new Error("Runtime configuration has an invalid useSavedChats");
  }
  if (config.stallTimeoutSec !== undefined
    && (!Number.isFinite(config.stallTimeoutSec) || config.stallTimeoutSec <= 0)) {
    throw new Error("Runtime configuration has an invalid stallTimeoutSec");
  }
  if (config.proAvailable && !config.solAvailable) {
    throw new Error("Runtime configuration cannot enable Pro without Sol");
  }
  if (!Array.isArray(config.runtimeCommand)
    || config.runtimeCommand.length === 0
    || config.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error("Runtime configuration has an invalid runtime command");
  }
  const validateTunnel = (tunnel, label) => {
    if (!tunnel || typeof tunnel !== "object") {
      throw new Error(`Full mode is missing ${label}`);
    }
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"]) {
      if (typeof tunnel[key] !== "string" || !tunnel[key].trim()) {
        throw new Error(`Full mode is missing ${label}.${key}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)) {
      throw new Error(`Full mode has an invalid ${label} id`);
    }
    for (const key of ["profileName", "alias"]) {
      if (!/^[A-Za-z0-9._-]+$/.test(tunnel[key])) {
        throw new Error(`Full mode has an invalid ${label}.${key}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"]) {
      if (!absolutePath(tunnel[key], platform)) {
        throw new Error(`Full mode requires an absolute ${label}.${key}`);
      }
    }
  };
  if (config.mode === "full") {
    validateTunnel(config.tunnel, "tunnel");
    if (config.automaticTunnel !== undefined) validateTunnel(config.automaticTunnel, "automaticTunnel");
    if (config.manualTunnel !== undefined) validateTunnel(config.manualTunnel, "manualTunnel");
    if (config.automaticTunnel && config.manualTunnel
      && config.automaticTunnel.tunnelId === config.manualTunnel.tunnelId) {
      throw new Error("Automatic and Zero Risk tunnel IDs must differ");
    }
    const activeTunnel = config.browserInteractionMode === "manual"
      ? config.manualTunnel
      : config.automaticTunnel;
    if ((config.automaticTunnel || config.manualTunnel) && !activeTunnel) {
      throw new Error("Active browser interaction mode has no tunnel configuration");
    }
    if (activeTunnel && JSON.stringify(activeTunnel) !== JSON.stringify(config.tunnel)) {
      throw new Error("Active browser interaction mode does not match the active tunnel");
    }
  }
  return config;
}

// Executable, command line and parent of a process, or null when unknown (resolves). Windows only:
// elsewhere an unrecognised bridge stays an external owner, as before. PowerShell runs as a child
// process the main thread does not wait on: through spawnSync (10 s timeout) its start on a busy
// machine froze the app while the bridge was started or recovered.
function windowsProcessInfo(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid < 1) return Promise.resolve(null);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; `
    + "if ($p) { [pscustomobject]@{ executablePath = $p.ExecutablePath; commandLine = $p.CommandLine; parentPid = [int]$p.ParentProcessId } | ConvertTo-Json -Compress }";
  return new Promise((resolve) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 }, (error, stdout) => {
        if (error || !String(stdout).trim()) { resolve(null); return; }
        try {
          const info = JSON.parse(String(stdout).trim());
          resolve({ executablePath: String(info.executablePath || ""), commandLine: String(info.commandLine || ""), parentPid: Number(info.parentPid) });
        } catch {
          resolve(null);
        }
      });
  });
}

function samePath(left, right) {
  const real = (value) => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const key = (value) => (process.platform === "win32" ? real(value).toLowerCase() : real(value));
  return key(left) === key(right);
}

class RuntimeSupervisor {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome,
    browserDescriptorPath,
    launcherProfile = "production",
    publishOperation,
    runtimeInvocationFactory = runtimeInvocation,
    getRuntimeEnvironment = () => ({}),
    persistentBridge = false,
    processInfo = windowsProcessInfo,
    onExtraTunnelsChange,
    // Settings → Updates: a running MCP tunnel is adopted only when this app started it with the
    // same tunnel program it ships now (tunnelOwnerMatches). Off (the default here) adopts any ready
    // tunnel, as before; main.cjs passes the setting.
    reuseTunnelOnlyWhenMatching = () => false,
  }) {
    this.reuseTunnelOnlyWhenMatching = reuseTunnelOnlyWhenMatching;
    this.tunnelOwnerPath = path.join(coreHome, "runtime", "tunnel-owner.json");
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.coreHome = coreHome;
    this.browserDescriptorPath = browserDescriptorPath;
    if (launcherProfile !== "production" && launcherProfile !== "development") {
      throw new Error("Runtime supervisor launcher profile is invalid");
    }
    this.launcherProfile = launcherProfile;
    this.publishOperation = publishOperation;
    this.runtimeInvocationFactory = runtimeInvocationFactory;
    this.processInfo = typeof processInfo === "function" ? processInfo : () => null;
    this.getRuntimeEnvironment = typeof getRuntimeEnvironment === "function"
      ? getRuntimeEnvironment
      : () => ({});
    this.configPath = path.join(coreHome, "config.json");
    this.configCache = null; // { size, mtimeMs, value }: see readConfigJson
    this.statePath = path.join(coreHome, "runtime", "launcher-supervisor.json");
    this.daemon = null;
    this.tunnel = null;
    this.stopping = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.restartHistory = { daemon: [], tunnel: [] };
    this.restartTimers = { daemon: null, tunnel: null };
    this.tunnelMonitorTimer = null;
    this.tunnelMonitorInFlight = false;
    this.tunnelMonitorFailures = 0;
    this.tunnelMonitorObservationUnavailable = false;
    this.tunnelMonitorGeneration = 0;
    this.tunnelHealthBaseUrl = null;
    this.recoveryTasks = new Set();
    this.expectedExits = new WeakSet();
    this.restartableChildren = new WeakSet();
    this.lastChildFailure = { daemon: null, tunnel: null };
    this.lastChildOutput = { daemon: null, tunnel: null };
    // A persistent bridge daemon runs detached with its output discarded, so it survives a
    // launcher restart, crash or installer update and the next launcher adopts it.
    this.persistentBridge = persistentBridge === true && launcherProfile === "production";
    // Where an older build kept that output; removed when a persistent daemon starts.
    this.daemonLogPath = path.join(coreHome, "runtime", "daemon.log");
    // Tunnels for further ChatGPT accounts; each runs beside the main tunnel and stops with it.
    const extraStateDir = path.join(coreHome, "tunnel", "extra-runtime");
    const extraTempDir = path.join(extraStateDir, "temp");
    this.extraTunnels = new ExtraTunnels({
      coreHome,
      logger,
      runTunnel: (tunnel, args, timeoutMs, label) => {
        // A new state root cannot see legacy runtimes; starting them again would create duplicates.
        if (savedExtraTunnels && !fs.existsSync(path.join(extraStateDir, "aliases.yaml"))) {
          throw new Error("Existing extra tunnels require migration to the dedicated runtime state directory before they can be started.");
        }
        fs.mkdirSync(extraTempDir, { recursive: true, mode: 0o700 });
        return this.runTunnelCommand({ tunnel }, args, timeoutMs, label, {
          ...this.getRuntimeEnvironment(),
          TUNNEL_CLIENT_STATE_DIR: extraStateDir,
          TEMP: extraTempDir,
          TMP: extraTempDir,
        });
      },
      connectArgs: (config, tunnel) => managedTunnelConnectArgs({ ...config, tunnel }, this.tunnelMcpInvocation(config)),
      diagnostic: tunnelControlDiagnostic,
      absent: tunnelRuntimeAbsent,
      onChange: onExtraTunnelsChange,
    });
    const savedExtraTunnels = this.extraTunnels.entries().length > 0;
  }

  /** Starts the extra tunnels in the background; a failing one never holds up the bridge. */
  startExtraTunnels(config) {
    if (config?.mode !== "full" || this.launcherProfile !== "production") return;
    void this.extraTunnels.start(config);
  }

  async stopExtraTunnels(config) {
    const failures = await this.extraTunnels.stopAll(config);
    if (failures.length) this.logger.warn("runtime.extra_tunnels_stop_failed", { failures });
    return failures;
  }

  /**
   * config.json as parsed JSON (a fresh copy each call), or undefined when it does not exist.
   * Monitors read it every 2-60 s, each through readSetupConfig and readConfig; on a busy hard disk
   * those four synchronous calls stalled the whole app. It is parsed again only when its size or
   * time changes, whoever wrote it.
   */
  readConfigJson() {
    let stat;
    try { stat = fs.statSync(this.configPath); } catch { this.configCache = null; return undefined; }
    const cached = this.configCache;
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      this.configCache = null;
      this.configCache = { size: stat.size, mtimeMs: stat.mtimeMs, value: readJson(this.configPath) };
    }
    return structuredClone(this.configCache.value);
  }

  /**
   * readConfigJson for timers: the same cache, checked and (when it changed) read without blocking.
   * Even the one statSync left above froze every window for 3 s from the catalog monitor's 15 s
   * check (a main-process profile, 2026-10-24): the file's metadata had left the cache, and the hard
   * disk holding it answered a read in 0.6 s on average and up to 7 s.
   */
  async readConfigJsonAsync() {
    let stat;
    try { stat = await fs.promises.stat(this.configPath); } catch { this.configCache = null; return undefined; }
    const cached = this.configCache;
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      const value = JSON.parse((await fs.promises.readFile(this.configPath, "utf8")).replace(/^﻿/, ""));
      this.configCache = { size: stat.size, mtimeMs: stat.mtimeMs, value };
    }
    return structuredClone(this.configCache.value);
  }

  readConfig() {
    const config = this.readConfigJson();
    if (config === undefined) return null;
    return validateConfig(
      config,
      this.browserDescriptorPath,
      this.platform,
      this.launcherProfile,
    );
  }

  /** readConfig for timers, which must not block the main process (readConfigJsonAsync). */
  async readConfigAsync() {
    const config = await this.readConfigJsonAsync();
    if (config === undefined) return null;
    return validateConfig(
      config,
      this.browserDescriptorPath,
      this.platform,
      this.launcherProfile,
    );
  }

  readSetupConfig() {
    const config = this.readConfigJson();
    if (config === undefined) return null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Runtime configuration is not an object");
    }
    if (this.launcherProfile === "development") {
      if (config.purpose !== "dev-harness") {
        throw new Error("DEV launcher refuses a configuration that is not marked dev-harness");
      }
    } else if (config.purpose !== undefined) {
      throw new Error("Production launcher refuses a DEV harness configuration");
    }
    const mode = config.mode === "pro-only" ? "browser-only" : config.mode;
    if (mode !== "browser-only" && mode !== "full") {
      throw new Error("Runtime configuration has an invalid setup mode");
    }
    return { ...config, mode };
  }

  readState() {
    if (!fs.existsSync(this.statePath)) return null;
    // A marker a power cut tore (empty, or its size in NUL bytes) holds no ownership to protect: the
    // processes it named died with the machine. Failing on it stopped every watchdog restart until
    // something rewrote the file; it is set aside as if it were missing, its bytes kept in Trash first.
    let bytes = null;
    try { bytes = fs.readFileSync(this.statePath); } catch { /* the parse below reports it */ }
    if (bytes && bytes.every((byte) => byte === 0 || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)) {
      let backup = null;
      try {
        const trash = path.join(this.coreHome, "Trash");
        fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
        backup = path.join(fs.mkdtempSync(path.join(trash, "runtime-ownership-")), path.basename(this.statePath));
        fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
      } catch { backup = null; /* a full disk must not keep the watchdog failing on the marker */ }
      this.logger?.warn?.("runtime.state_torn", { bytes: bytes.length, backup });
      this.clearState();
      return null;
    }
    try {
      const state = JSON.parse((bytes ?? fs.readFileSync(this.statePath)).toString("utf8"));
      const validPid = (value) => value === null || (Number.isInteger(value) && value > 0);
      if (!state
        || state.version !== 1
        || !Number.isInteger(state.ownerPid)
        || state.ownerPid < 1
        || !validPid(state.daemonPid)
        || !validPid(state.tunnelPid)
        || typeof state.status !== "string"
        || typeof state.updatedAt !== "string"
        || Number.isNaN(Date.parse(state.updatedAt))) {
        throw new Error("state shape is invalid");
      }
      return state;
    } catch (error) {
      if (bytes && this.setAsideUnreadableStateFromBeforeBoot(bytes, error)) return null;
      throw new Error(`Launcher runtime ownership state is invalid at ${this.statePath}: ${errorMessage(error)}`);
    }
  }

  /**
   * A marker last written before this boot can name only processes the restart ended, which is
   * why a readable one is cleared (stopStaleOwnedRuntime). One a crash left unreadable in another
   * way than the torn check above (JSON cut off mid-write) is set aside the same way, its bytes
   * kept in Trash, instead of failing closed: that kept every chat from starting for over an hour
   * after an unexpected Windows restart. One written since boot still fails closed, as its
   * processes may be alive.
   */
  setAsideUnreadableStateFromBeforeBoot(bytes, error) {
    let modifiedAt;
    try {
      modifiedAt = fs.statSync(this.statePath).mtimeMs;
    } catch {
      return false;
    }
    if (!(modifiedAt < CURRENT_BOOT_STARTED_AT_MS - BOOT_TIME_CLOCK_TOLERANCE_MS)) return false;
    let backup = null;
    try {
      const trash = path.join(this.coreHome, "Trash");
      fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
      backup = path.join(fs.mkdtempSync(path.join(trash, "runtime-ownership-")), path.basename(this.statePath));
      fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
    } catch { backup = null; /* a full disk must not keep the watchdog failing on the marker */ }
    this.logger.warn("runtime.state_discarded", {
      reason: "unreadable ownership marker from before this boot",
      message: errorMessage(error),
      backup,
    });
    this.clearState();
    return true;
  }

  snapshot(status = "idle", detail) {
    return {
      version: 1,
      ownerPid: process.pid,
      daemonPid: this.daemon?.pid ?? null,
      daemonRuntimeRoot: this.daemon ? this.daemonRuntimeRoot ?? null : null,
      tunnelPid: this.tunnel?.pid ?? null,
      status,
      ...(detail ? { detail } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  writeState(status, detail) {
    const state = this.snapshot(status, detail);
    writePrivateFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { durable: true });
    return state;
  }

  tryWriteState(status, detail) {
    try {
      this.writeState(status, detail);
      return true;
    } catch (error) {
      const message = `Could not persist launcher runtime ownership: ${errorMessage(error)}`;
      this.stopping = true;
      for (const name of ["daemon", "tunnel"]) {
        if (this.restartTimers[name]) {
          clearTimeout(this.restartTimers[name]);
          this.restartTimers[name] = null;
        }
      }
      this.logger.error("runtime.state_write_failed", { status, message });
      this.publishOperation?.({ name: "runtime-supervisor", status: "failed", message });
      return false;
    }
  }

  clearState() {
    fs.rmSync(this.statePath, { force: true });
  }

  prepareExternalMigration() {
    if (this.daemon || this.tunnel) {
      throw new Error("Launcher-owned runtime children exist while an external installation is configured");
    }
    const state = this.readState();
    if (state && !runtimeOwnershipPredatesCurrentBoot(state) && (
      processRunning(state.ownerPid)
      || processRunning(state.daemonPid)
      || processRunning(state.tunnelPid)
    )) {
      throw new Error("Launcher ownership processes are still alive while an external installation is configured");
    }
    this.clearState();
  }

  writeExternalState(detail) {
    const existing = this.readState();
    const preservesLiveOwnership = existing && !runtimeOwnershipPredatesCurrentBoot(existing) && (
      processRunning(existing.ownerPid)
      || processRunning(existing.daemonPid)
      || processRunning(existing.tunnelPid)
    );
    if (!preservesLiveOwnership) this.writeState("external", detail);
  }

  spawnChild(name, invocation) {
    const suppliedRuntimeEnvironment = this.getRuntimeEnvironment() || {};
    if (typeof suppliedRuntimeEnvironment !== "object" || Array.isArray(suppliedRuntimeEnvironment)) {
      throw new Error("Runtime environment provider returned an invalid value");
    }
    const runtimeEnvironment = Object.fromEntries(
      Object.entries(suppliedRuntimeEnvironment).filter(([key, value]) => (
        /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === "string" && value.length > 0
      )),
    );
    const persistent = name === "daemon" && this.persistentBridge;
    // A persistent daemon outlives this launcher, so it cannot write to a pipe. Its output is
    // discarded rather than kept in a file: runtime/daemon.log was appended for every line and the
    // launcher re-copied each one into launcher.jsonl.
    if (persistent) this.removeOldDaemonLogs();
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: persistent ? true : DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        ...runtimeEnvironment,
        CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
      stdio: persistent ? "ignore" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this[name] = child;
    this.lastChildFailure[name] = null;
    this.lastChildOutput[name] = null;
    collectLines(child.stdout, (line) => {
      this.lastChildOutput[name] = redactText(line).slice(0, 1_000);
      this.logger.info(`runtime.${name}_stdout`, { line });
    }, (error) => {
      this.logger.warn(`runtime.${name}_stdout_unavailable`, { message: errorMessage(error) });
    });
    collectLines(child.stderr, (line) => {
      this.lastChildOutput[name] = redactText(line).slice(0, 1_000);
      this.logger.warn(`runtime.${name}_stderr`, { line });
    }, (error) => {
      this.logger.warn(`runtime.${name}_stderr_unavailable`, { message: errorMessage(error) });
    });
    let terminalHandled = false;
    const handleTerminal = ({ code = null, signal = null, error = null }) => {
      if (terminalHandled) return;
      terminalHandled = true;
      const expected = this.stopping || this.expectedExits.has(child);
      this.expectedExits.delete(child);
      const restartable = this.restartableChildren.has(child);
      this.restartableChildren.delete(child);
      if (this[name] === child) this[name] = null;
      const detail = error
        ? `${name} failed to start: ${error.message}`
        : `${name} exited (${signal || code})`
          + (this.lastChildOutput[name] ? `: ${this.lastChildOutput[name]}` : "");
      this.lastChildFailure[name] = detail;
      const statePersisted = this.tryWriteState(expected ? "stopping" : "degraded", detail);
      this.logger[expected ? "info" : "error"](
        error ? `runtime.${name}_spawn_failed` : `runtime.${name}_exited`,
        error ? { message: error.message } : { code, signal },
      );
      if (!expected && restartable && statePersisted) this.scheduleRecovery(name);
    };
    child.once("error", (error) => {
      if (!Number.isInteger(child.pid)) {
        handleTerminal({ error });
        return;
      }
      this.logger.error(`runtime.${name}_process_error`, { message: error.message, pid: child.pid });
    });
    child.once("exit", (code, signal) => handleTerminal({ code, signal }));
    this.logger.info(`runtime.${name}_started`, { pid: child.pid });
    this.writeState("starting");
    return child;
  }

  /** Removes the daemon log files an older build wrote. */
  removeOldDaemonLogs() {
    for (const file of [this.daemonLogPath, `${this.daemonLogPath}.1`]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }

  /**
   * Adopt a healthy bridge daemon left running by a previous launcher instead of
   * stopping it. Only a daemon whose live health matches the recorded pid, mode and
   * this launcher's bundled bridge version is adopted; anything else keeps the
   * existing stale-recovery path.
   */
  async adoptRunningDaemon(config) {
    if (!this.persistentBridge || this.daemon || this.tunnel) return false;
    let state;
    try { state = this.readState(); } catch { return false; }
    if (!state || runtimeOwnershipPredatesCurrentBoot(state)) return false;
    if (!Number.isInteger(state.daemonPid) || !processRunning(state.daemonPid)) return false;
    if (state.ownerPid !== process.pid && await this.launcherOwnerRunning(state.ownerPid)) return false;
    const health = await this.proxyHealthPayload(config);
    if (health?.service !== "codex-chatgpt-web"
      || health?.mode !== config.mode
      || health?.version !== config.releaseVersion
      || health?.pid !== state.daemonPid) {
      return false;
    }
    // A patch can ship a new runtime under the same release version; it installs beside the folder
    // this bridge still runs from. Replace an idle bridge so the new code takes effect. A busy one
    // keeps its turns and is replaced on a later launch.
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    if (runtimeRootChanged(state.daemonRuntimeRoot, this.installedRuntimeRoot) && bridgeIdle(health)) {
      this.logger.info("runtime.daemon_outdated", { pid: state.daemonPid });
      return false;
    }
    const handle = new AdoptedProcess(state.daemonPid);
    this.daemon = handle;
    this.daemonRuntimeRoot = typeof state.daemonRuntimeRoot === "string" ? state.daemonRuntimeRoot : null;
    this.lastChildFailure.daemon = null;
    handle.once("exit", () => {
      const expected = this.stopping || this.expectedExits.has(handle);
      this.expectedExits.delete(handle);
      const restartable = this.restartableChildren.has(handle);
      this.restartableChildren.delete(handle);
      if (this.daemon === handle) this.daemon = null;
      const detail = "adopted daemon exited";
      this.lastChildFailure.daemon = detail;
      const statePersisted = this.tryWriteState(expected ? "stopping" : "degraded", detail);
      this.logger[expected ? "info" : "error"]("runtime.daemon_exited", { adopted: true });
      if (!expected && restartable && statePersisted) this.scheduleRecovery("daemon");
    });
    this.logger.info("runtime.daemon_adopted", { pid: state.daemonPid, previousOwner: state.ownerPid });
    return true;
  }

  /**
   * Leave the bridge and MCP tunnel running for the next launcher (app restart or
   * update). Monitors stop, but no process is signalled.
   */
  async detach(reason = "launcher-restart") {
    if (!this.persistentBridge) return { status: "not-persistent" };
    const daemon = this.daemon;
    this.stopping = true;
    this.stopTunnelMonitor();
    this.extraTunnels.detach();
    for (const name of ["daemon", "tunnel"]) {
      if (this.restartTimers[name]) {
        clearTimeout(this.restartTimers[name]);
        this.restartTimers[name] = null;
      }
    }
    if (daemon) this.expectedExits.add(daemon);
    daemon?.release?.();
    daemon?.unref?.();
    const state = this.writeState("detached", reason);
    this.logger.info("runtime.detached", { daemonPid: state.daemonPid, tunnelPid: state.tunnelPid, reason });
    return { status: "detached", daemonPid: state.daemonPid, tunnelPid: state.tunnelPid };
  }

  /** Restart only the bridge daemon, after its active turns drain. */
  async restartDaemonOnly() {
    const config = this.readConfig();
    if (!config) throw new Error("Codex bridge is not configured");
    if (this.launcherProfile === "development") throw new Error("The DEV profile has no Responses bridge");
    let drained = false;
    if (this.daemon) {
      drained = await this.acquireDrain(config);
      try {
        await this.shutdownDaemon(config);
      } catch (error) {
        if (drained) await this.control(config, "resume").catch(() => undefined);
        throw error;
      }
    }
    this.stopping = false;
    await this.startDaemon(config);
    this.writeState("ready");
    return { status: "restarted", pid: this.daemon?.pid ?? null };
  }

  /** Restart only the MCP tunnel. */
  async restartTunnelOnly() {
    const config = this.readConfig();
    if (!config) throw new Error("MCP tunnel is not configured");
    if (config.mode !== "full") throw new Error("MCP tunnel is not part of the browser-only setup");
    if (this.tunnel) await this.stopTunnelGracefully(config);
    this.stopping = false;
    await this.startTunnel(config, "runtime-restart", { forceRestart: true });
    this.writeState("ready");
    return { status: "restarted", pid: this.tunnel?.pid ?? null };
  }

  runtimeCommand(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return this.runtimeInvocationFactory({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  assertTunnelClientReady(config) {
    const tunnel = config.tunnel;
    if (!tunnel || !fs.existsSync(tunnel.binaryPath)) {
      throw new Error(`Tunnel client is missing: ${tunnel?.binaryPath || "not configured"}`);
    }
    if (!fs.existsSync(tunnel.runtimeKeyFile)) {
      throw new Error(`Tunnel runtime key is missing: ${tunnel.runtimeKeyFile}`);
    }
  }

  async proxyHealthPayload(config, timeoutMs = 2_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async proxyHealth(config, timeoutMs = 2_000, expectedPid, requireAccepting = false) {
    const body = await this.proxyHealthPayload(config, timeoutMs);
    return body?.service === "codex-chatgpt-web"
      && body?.status === "ok"
      && body?.mode === config.mode
      && body?.version === config.releaseVersion
      && (expectedPid === undefined || body?.pid === expectedPid)
      && (!requireAccepting || body?.accepting_turns === true);
  }

  // A cold start on a busy machine (bridge files on an HDD, other builds running) has taken 25 s;
  // giving up sooner made the watchdog kill a bridge that was about to answer.
  async waitForProxy(config, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const daemon = this.daemon;
      if (!daemon) {
        throw new Error(this.lastChildFailure.daemon || "Responses proxy exited before becoming healthy");
      }
      if (!Number.isInteger(daemon.pid)) {
        await sleep(50);
        continue;
      }
      if (await this.proxyHealth(config, 2_000, daemon.pid, true)) return;
      await sleep(200);
    }
    throw new Error(`Responses proxy did not become healthy on 127.0.0.1:${config.port} within ${timeoutMs}ms`);
  }

  async readTunnelHealth(config) {
    const tunnel = config.tunnel;
    // `runtimes status` performs an optional control-plane lookup when the saved runtime key is
    // available. The cleanup dry run is the official local-only inventory and never removes
    // entries without `--apply`, so proxy or control-plane failures cannot block supervision.
    let result;
    try {
      result = await this.runTunnelCommand(
        config,
        ["runtimes", "cleanup", "--json"],
        5_000,
        "Local tunnel inventory probe",
      );
    } catch (error) {
      // A probe that timed out (the CLI's cold start on a loaded machine) says nothing about the
      // tunnel: the status is unknown, so the waits poll again. Thrown, one 5 s timeout made
      // startup call this app's own runtime external and stop it (seen live 2026-10-29).
      result = controlResult(null, "", errorMessage(error));
    }
    if (result.code !== 0) {
      return {
        ready: false,
        pid: null,
        state: undefined,
        processRunning: undefined,
        healthy: undefined,
        absent: false,
        statusKnown: false,
        detail: tunnelControlDiagnostic(result),
      };
    }
    try {
      const parsed = JSON.parse(result.output);
      if (!Array.isArray(parsed.entries)) throw new Error("local inventory has no entries array");
      const entry = parsed.entries.find(candidate => candidate?.alias === tunnel.alias);
      if (!entry) {
        return {
          ready: false,
          pid: null,
          state: "stopped",
          processRunning: false,
          healthy: false,
          absent: true,
          statusKnown: true,
          detail: `alias=${tunnel.alias}; local_inventory=absent`,
        };
      }
      const runtimeState = entry.runtime_state;
      if (!["stopped", "starting", "healthy", "ready"].includes(runtimeState)) {
        throw new Error(`local inventory reported unsupported runtime_state=${String(runtimeState)}`);
      }
      const liveRuntime = entry.live_runtime && typeof entry.live_runtime === "object"
        ? entry.live_runtime
        : {};
      const healthBaseUrl = loopbackHealthBaseURL(liveRuntime.base_url);
      if (healthBaseUrl) this.tunnelHealthBaseUrl = healthBaseUrl;
      const pid = Number.isInteger(liveRuntime.system?.pid) && liveRuntime.system.pid > 0
        ? liveRuntime.system.pid
        : Number.isInteger(liveRuntime.status?.pid) && liveRuntime.status.pid > 0
          ? liveRuntime.status.pid
          : null;
      const processRunning = runtimeState !== "stopped";
      const healthy = runtimeState === "healthy" || runtimeState === "ready";
      const ready = runtimeState === "ready";
      const detail = [
        ["state", runtimeState],
        ["process_running", processRunning],
        ["healthy", healthy],
        ["ready", ready],
        ["classification", entry.classification],
        ["live_admin", liveRuntime.found === true],
        ["pid", pid ?? "missing"],
      ]
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join("; ");
      return {
        ready,
        pid,
        state: runtimeState,
        processRunning,
        healthy,
        absent: false,
        statusKnown: true,
        detail: redactText(detail).slice(0, 2_000),
      };
    } catch (error) {
      return {
        ready: false,
        pid: null,
        state: undefined,
        processRunning: undefined,
        healthy: undefined,
        absent: false,
        statusKnown: false,
        detail: `local inventory returned invalid JSON: ${errorMessage(error)};`
          + ` ${redactText(result.output || "[empty]").slice(0, 500)}`,
      };
    }
  }

  async probeTunnelEndpoint(pathname, timeoutMs = 2_000) {
    if (!this.tunnelHealthBaseUrl) {
      return { observed: false, ok: false, detail: "local tunnel health URL is not known" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.tunnelHealthBaseUrl}${pathname}`, {
        method: "GET",
        signal: controller.signal,
      });
      return {
        observed: true,
        ok: response.ok,
        status: response.status,
        detail: `${pathname} returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        observed: false,
        ok: false,
        detail: `${pathname} could not be observed: ${errorMessage(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeTunnelMcpTransport(timeoutMs = 2_000) {
    if (!this.tunnelHealthBaseUrl) {
      return { observed: false, ok: false, fatal: false, detail: "local tunnel MCP diagnostics URL is not known" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.tunnelHealthBaseUrl}/api/logs?limit=100`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          observed: false,
          ok: false,
          fatal: false,
          detail: `MCP transport diagnostics returned HTTP ${response.status}`,
        };
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray(body.events)) {
        throw new Error("response has no events array");
      }
      const cutoff = Date.now() - TUNNEL_MCP_FAILURE_RECENCY_MS;
      const failure = body.events.findLast(event => {
        if (!event || typeof event !== "object") return false;
        const attrs = event.attrs && typeof event.attrs === "object" ? event.attrs : {};
        const occurredAt = Date.parse(event.time);
        return Number.isFinite(occurredAt)
          && occurredAt >= cutoff
          && event.message === "dispatcher received MCP upstream error; posted error response to control plane"
          && attrs.failure_source === "client_internal"
          && attrs.status_code === 502
          && attrs.upstream_response_received === false
          && ["initialize", "tools/call"].includes(attrs.rpc_method);
      });
      if (!failure) {
        return { observed: true, ok: true, fatal: false, detail: "MCP transport has no recent internal failures" };
      }
      return {
        observed: true,
        ok: false,
        fatal: true,
        detail: `MCP transport returned internal HTTP 502 for ${failure.attrs.rpc_method} at ${failure.time}`,
      };
    } catch (error) {
      return {
        observed: false,
        ok: false,
        fatal: false,
        detail: `MCP transport diagnostics could not be observed: ${errorMessage(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async discoverTunnelHealthBaseUrl(config) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    const result = await this.runTunnelCommand(
      config,
      ["runtimes", "status", tunnel.alias, "--json"],
      5_000,
      "Local tunnel health discovery",
    );
    if (result.code !== 0) {
      throw new Error(`Local tunnel health discovery failed: ${tunnelControlDiagnostic(result)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.output);
    } catch (error) {
      throw new Error(`Local tunnel health discovery returned invalid JSON: ${errorMessage(error)}`);
    }
    const candidates = [
      parsed?.local?.effective_health?.base_url,
      parsed?.local?.health?.base_url,
      parsed?.health_url,
      parsed?.ui_url,
    ];
    const baseUrl = candidates.map(loopbackHealthBaseURL).find(Boolean);
    if (!baseUrl) {
      throw new Error("Local tunnel health discovery returned no verified loopback endpoint");
    }
    this.tunnelHealthBaseUrl = baseUrl;
    return baseUrl;
  }

  async waitForTunnelMcpTransport(config, timeoutMs = 10_000) {
    // Discovery is a 5 s CLI call; on a loaded machine one call can time out right after the
    // tunnel reported ready. Thrown at once, that tore a healthy tunnel down and the watchdog
    // started it again two minutes later (seen live 2026-10-30 04:50). It gets its own window.
    const discoveryDeadline = Date.now() + timeoutMs;
    while (!this.tunnelHealthBaseUrl) {
      try {
        await this.discoverTunnelHealthBaseUrl(config);
      } catch (error) {
        if (Date.now() >= discoveryDeadline) throw error;
        await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
      }
    }
    const deadline = Date.now() + timeoutMs;
    let health;
    do {
      health = await this.probeTunnelMcpTransport();
      if (health.observed && health.ok) return health;
      if (health.fatal) {
        throw new Error(`Tunnel MCP transport is unhealthy: ${health.detail}`);
      }
      if (Date.now() >= deadline) break;
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);
    throw new Error(
      `Tunnel MCP transport could not be verified within ${timeoutMs}ms:`
      + ` ${health?.detail || "no diagnostics returned"}`,
    );
  }

  async readLocalTunnelHealth() {
    const [healthz, readyz, mcp] = await Promise.all([
      this.probeTunnelEndpoint("/healthz"),
      this.probeTunnelEndpoint("/readyz"),
      this.probeTunnelMcpTransport(),
    ]);
    const pid = Number.isInteger(this.tunnel?.pid) ? this.tunnel.pid : null;
    if (pid && !processRunning(pid)) {
      return {
        ready: false,
        pid,
        state: "stopped",
        processRunning: false,
        healthy: false,
        absent: false,
        statusKnown: true,
        detail: `managed tunnel process ${pid} is no longer running`,
      };
    }
    const explicitlyUnhealthy = (healthz.observed && !healthz.ok)
      || (readyz.observed && !readyz.ok)
      || (mcp.observed && !mcp.ok);
    const completelyObserved = healthz.observed && readyz.observed && mcp.observed;
    if (!explicitlyUnhealthy && !completelyObserved) {
      return {
        ready: false,
        pid,
        state: undefined,
        processRunning: pid ? true : undefined,
        healthy: undefined,
        absent: false,
        statusKnown: false,
        fatal: mcp.fatal === true,
        detail: `${healthz.detail}; ${readyz.detail}; ${mcp.detail}`,
      };
    }
    const mcpReady = mcp.observed && mcp.ok;
    return {
      ready: healthz.ok && readyz.ok && mcpReady,
      pid,
      state: healthz.ok && readyz.ok && mcpReady ? "ready" : "degraded",
      processRunning: pid ? true : undefined,
      healthy: healthz.ok && mcpReady,
      absent: false,
      statusKnown: true,
      fatal: mcp.fatal === true,
      detail: `${healthz.detail}; ${readyz.detail}; ${mcp.detail}`,
    };
  }

  async observeTunnelForMonitor(config) {
    const local = await this.readLocalTunnelHealth();
    if (local.statusKnown) return local;
    try {
      const previousEndpoint = this.tunnelHealthBaseUrl;
      const inventory = await this.readTunnelHealth(config);
      if (tunnelRuntimeStopped(inventory)) return inventory;
      if (this.tunnelHealthBaseUrl && this.tunnelHealthBaseUrl !== previousEndpoint) {
        return await this.readLocalTunnelHealth();
      }
      // Inventory can prove that the alias stopped, but its ready flag does not prove MCP health.
      // Unknown observations must not hide failures or trigger a restart without failure evidence.
      return { ...local, detail: `${local.detail}; local inventory: ${inventory.detail}` };
    } catch (error) {
      return {
        ...local,
        detail: `${local.detail}; native status unavailable: ${errorMessage(error)}`,
      };
    }
  }

  async tunnelHealth(config) {
    return (await this.observeTunnelForMonitor(config)).ready;
  }

  async waitForKnownTunnelStatus(config, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let health;
    do {
      health = await this.readTunnelHealth(config);
      if (health.statusKnown) return health;
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);
    throw new Error(
      `Tunnel runtime status could not be inspected within ${timeoutMs}ms:`
      + ` ${health?.detail || "no status returned"}`,
    );
  }

  async waitForTunnel(
    config,
    timeoutMs = TUNNEL_START_TIMEOUT_MS,
    operationName = "runtime-start",
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "tunnel status has not been observed";
    let lastPublishedDetail;
    while (Date.now() < deadline) {
      const health = await this.readTunnelHealth(config);
      if (health.pid) {
        this.tunnel = {
          pid: health.pid,
          exitCode: null,
          signalCode: null,
          managed: true,
        };
      }
      if (health.ready) {
        if (!this.tunnel) {
          this.tunnel = {
            pid: null,
            exitCode: null,
            signalCode: null,
            managed: true,
          };
        }
        return health;
      }
      if (tunnelRuntimeStopped(health)) {
        throw new Error(`Tunnel managed runtime stopped during startup: ${health.detail}`);
      }
      lastDetail = health.detail;
      if (lastDetail !== lastPublishedDetail) {
        lastPublishedDetail = lastDetail;
        this.logger.info("runtime.tunnel_waiting", { detail: lastDetail });
        this.publishOperation?.({
          name: operationName,
          status: "running",
          message: `Waiting for tunnel readiness: ${lastDetail}`,
        });
      }
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Tunnel runtime did not become healthy and ready within ${timeoutMs}ms: ${lastDetail}`,
    );
  }

  async startTunnel(config, operationName = "runtime-start", { forceRestart = false } = {}) {
    if (config.mode !== "full") return;
    this.assertTunnelClientReady(config);
    // Every acquisition binds diagnostics to this runtime, including adoption of an existing alias.
    this.tunnelHealthBaseUrl = null;
    try {
      const existing = await this.waitForKnownTunnelStatus(config);
      const matches = !existing.ready || this.reuseTunnelOnlyWhenMatching?.() !== true
        || this.tunnelOwnerMatches(config, existing.pid);
      if (existing.ready && !matches) {
        // Left running by another build (or by a version before this check): restarted, so it runs
        // the tunnel program this version ships. A 0.8.28 bridge once ran on under 0.8.29.
        this.logger.info("runtime.tunnel_replaced_mismatch", { pid: existing.pid });
      }
      if (existing.ready && matches && !forceRestart) {
        this.tunnel = {
          pid: existing.pid,
          exitCode: null,
          signalCode: null,
          managed: true,
        };
        await this.waitForTunnelMcpTransport(config);
        this.startTunnelMonitor(config);
        this.logger.info("runtime.tunnel_adopted", { pid: existing.pid });
        return;
      }
      this.tunnel = null;
      const stopped = await this.runTunnelStopCommand(config);
      if (stopped.code !== 0
        && !tunnelRuntimeAbsent(stopped.output)) {
        throw new Error(
          `tunnel runtime refused pre-start cleanup: ${tunnelControlDiagnostic(stopped)}`,
        );
      }
      if (stopped.code === 0) await this.waitForTunnelStopped(config);
      this.tunnelHealthBaseUrl = null;
      const connected = await this.runTunnelConnectCommand(config);
      if (connected.code !== 0) {
        if (!tunnelStillStarting(connected)) {
          throw new Error(
            `tunnel runtime refused managed startup: ${tunnelControlDiagnostic(connected)}`,
          );
        }
        // Its process runs: wait for it here (waitForTunnel fails at once if it stops) instead of
        // tearing down a tunnel that is about to be ready.
        this.logger.info("runtime.tunnel_connect_slow", { detail: tunnelControlDiagnostic(connected) });
      }
      await this.waitForTunnel(config, TUNNEL_START_TIMEOUT_MS, operationName);
      if (!this.tunnel) throw new Error("Tunnel runtime became ready without a managed process identity");
      await this.waitForTunnelMcpTransport(config);
      this.startTunnelMonitor(config);
      this.recordTunnelOwner(config, this.tunnel.pid);
    } catch (error) {
      let cleanupError;
      try {
        this.stopTunnelMonitor();
        const managed = this.tunnel;
        const stopped = await this.runTunnelStopCommand(config);
        if (stopped.code !== 0
          && (!tunnelRuntimeAbsent(stopped.output)
            || (managed?.pid && processRunning(managed.pid)))) {
          throw new Error(tunnelControlDiagnostic(stopped));
        }
        if (stopped.code === 0) await this.waitForTunnelStopped(config);
        this.tunnel = null;
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw new Error(appendFailure(errorMessage(error), "tunnel startup cleanup failed", cleanupError));
      }
      throw error;
    }
  }

  /** Which tunnel program a started tunnel runs: its size and change time (a release ships a new one). */
  tunnelProgramSignature(config) {
    try {
      const stat = fs.statSync(config.tunnel.binaryPath);
      return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return null;
    }
  }

  recordTunnelOwner(config, pid) {
    try {
      writePrivateFileAtomic(this.tunnelOwnerPath, `${JSON.stringify({
        pid, program: this.tunnelProgramSignature(config), appVersion: this.app?.getVersion?.() ?? null,
      })}\n`);
    } catch (error) {
      this.logger.warn("runtime.tunnel_owner_unrecorded", { message: errorMessage(error) });
    }
  }

  /** Whether the running tunnel `pid` is one this app started, with the tunnel program it ships now. */
  tunnelOwnerMatches(config, pid) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(this.tunnelOwnerPath, "utf8")); } catch { return false; }
    const program = this.tunnelProgramSignature(config);
    return Boolean(program) && owner?.pid === pid && owner.program === program;
  }

  tunnelMcpInvocation(config) {
    const contract = config.browserInteractionMode === "manual" ? "safe" : "native";
    return this.runtimeCommand([
      "mcp",
      "--contract",
      contract,
      "--broker-socket",
      config.brokerSocketPath,
    ]);
  }

  async runTunnelConnectCommand(config) {
    return await this.runTunnelCommand(
      config,
      managedTunnelConnectArgs(config, this.tunnelMcpInvocation(config)),
      TUNNEL_START_TIMEOUT_MS,
      "Tunnel managed startup",
    );
  }

  startTunnelMonitor(config) {
    this.stopTunnelMonitor();
    this.tunnelMonitorFailures = 0;
    this.tunnelMonitorObservationUnavailable = false;
    const generation = this.tunnelMonitorGeneration;
    const recordFailure = (message, immediate = false) => {
      if (this.stopping || generation !== this.tunnelMonitorGeneration) return;
      if (immediate) this.tunnelMonitorFailures = TUNNEL_MONITOR_FAILURE_THRESHOLD - 1;
      this.tunnelMonitorFailures += 1;
      this.logger.warn("runtime.tunnel_monitor_unhealthy", {
        consecutiveFailures: this.tunnelMonitorFailures,
        message,
      });
      if (this.tunnelMonitorFailures < TUNNEL_MONITOR_FAILURE_THRESHOLD) return;
      this.lastChildFailure.tunnel = message;
      this.tunnel = null;
      this.stopTunnelMonitor();
      if (!this.tryWriteState("degraded", message)) return;
      this.publishOperation?.({ name: "runtime-recovery", status: "running", message });
      this.scheduleRecovery("tunnel");
    };
    this.tunnelMonitorTimer = setInterval(() => {
      if (this.stopping
        || generation !== this.tunnelMonitorGeneration
        || this.tunnelMonitorInFlight
        || this.restartTimers.tunnel) return;
      this.tunnelMonitorInFlight = true;
      void this.observeTunnelForMonitor(config).then((health) => {
        if (this.stopping || generation !== this.tunnelMonitorGeneration) return;
        if (!health.statusKnown) {
          if (!this.tunnelMonitorObservationUnavailable) {
            this.tunnelMonitorObservationUnavailable = true;
            this.logger.warn("runtime.tunnel_monitor_observation_unavailable", {
              message: health.detail,
            });
          }
          return;
        }
        if (this.tunnelMonitorObservationUnavailable) {
          this.tunnelMonitorObservationUnavailable = false;
          this.logger.info("runtime.tunnel_monitor_observation_restored", {
            message: health.detail,
          });
        }
        if (health.ready) {
          this.tunnelMonitorFailures = 0;
          if (this.tunnel?.pid !== health.pid) {
            this.tunnel = {
              pid: health.pid,
              exitCode: null,
              signalCode: null,
              managed: true,
            };
            this.tryWriteState("ready");
          }
          return;
        }
        recordFailure(`Tunnel runtime lost readiness: ${health.detail}`, health.fatal === true);
      }).catch((error) => {
        recordFailure(`Tunnel health probe failed: ${errorMessage(error)}`);
      }).finally(() => {
        this.tunnelMonitorInFlight = false;
      });
    }, TUNNEL_MONITOR_INTERVAL_MS);
    this.tunnelMonitorTimer.unref?.();
  }

  stopTunnelMonitor() {
    if (this.tunnelMonitorTimer) clearInterval(this.tunnelMonitorTimer);
    this.tunnelMonitorTimer = null;
    this.tunnelMonitorFailures = 0;
    this.tunnelMonitorObservationUnavailable = false;
    this.tunnelMonitorGeneration += 1;
  }

  async startDaemon(config) {
    if (this.daemon) {
      const child = this.daemon;
      const identity = Number.isInteger(child.pid)
        && await this.proxyHealth(config, 2_000, child.pid);
      if (identity && !await this.proxyHealth(config, 2_000, child.pid, true)) {
        const resumed = await this.control(config, "resume");
        if (resumed.status !== "ok" || resumed.accepting_turns !== true) {
          throw new Error("Responses proxy did not acknowledge readiness after resume");
        }
      }
      await this.waitForProxy(config);
      if (this.daemon !== child) throw new Error("Responses proxy exited while readiness was being confirmed");
      this.restartableChildren.add(child);
      return;
    }
    let child;
    try {
      child = this.spawnChild("daemon", this.runtimeCommand(["serve"]));
      this.daemonRuntimeRoot = this.installedRuntimeRoot ?? null;
      await this.waitForProxy(config);
      if (this.daemon !== child) throw new Error("Responses proxy exited immediately after becoming healthy");
      this.restartableChildren.add(child);
    } catch (error) {
      let cleanupError;
      try {
        await this.stopChild("daemon");
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw new Error(appendFailure(errorMessage(error), "daemon startup cleanup failed", cleanupError));
      }
      throw error;
    }
  }

  async startIfConfigured() {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startConfigured();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startConfigured() {
    let config;
    try {
      config = this.readConfig();
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn("runtime.setup_required", { detail });
      return { status: "needs-setup", detail };
    }
    if (!config) {
      const ownershipState = this.readState();
      if (ownershipState && !runtimeOwnershipPredatesCurrentBoot(ownershipState) && (
        processRunning(ownershipState.daemonPid)
        || processRunning(ownershipState.tunnelPid)
      )) {
        const detail = "Runtime configuration is missing while launcher ownership processes are still alive";
        this.logger.warn("runtime.external_owner_detected", { detail });
        return { status: "external", detail };
      }
      this.clearState();
      return { status: "not-configured" };
    }
    const tunnelOnly = this.launcherProfile === "development";
    if (tunnelOnly && config.mode !== "full") {
      const ownershipState = this.readState();
      if (runtimeOwnershipMayBeLive(ownershipState)) {
        const detail = "A DEV MCP runtime is still owned while the profile is configured as browser-only";
        this.writeExternalState(detail);
        return { status: "external", detail };
      }
      this.clearState();
      return { status: "ready", daemonPid: null, tunnelPid: null };
    }
    const currentVersion = tunnelOnly ? this.app.getVersion() : runtimeReleaseVersion(this);
    if (!tunnelOnly && config.releaseVersion !== currentVersion) {
      const ownershipState = this.readState();
      if ((!tunnelOnly && await this.proxyHealth(config)) || runtimeOwnershipMayBeLive(ownershipState)) {
        try {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            const detail = "A runtime for another launcher version could not be safely recovered";
            this.writeExternalState(detail);
            this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
            return { status: "external", detail };
          }
        } catch (error) {
          const detail = errorMessage(error);
          this.writeExternalState(detail);
          this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
          return { status: "external", detail };
        }
      }
      const detail = `Config requires bridge ${config.releaseVersion}; bundled bridge is ${currentVersion}`;
      this.writeState("needs-setup", detail);
      this.logger.warn("runtime.setup_required", { detail });
      return { status: "needs-setup", detail };
    }
    const adopted = !tunnelOnly && await this.adoptRunningDaemon(config);
    if (!adopted && !this.daemon && !this.tunnel) {
      const healthyRuntime = tunnelOnly ? false : await this.proxyHealth(config);
      const ownershipState = this.readState();
      if (healthyRuntime || runtimeOwnershipMayBeLive(ownershipState)) {
        try {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            const detail = healthyRuntime
              ? "An external runtime already owns the configured port"
              : "Existing launcher runtime ownership could not be safely recovered";
            this.writeExternalState(detail);
            this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
            return { status: "external", detail };
          }
        } catch (error) {
          const detail = errorMessage(error);
          this.writeExternalState(detail);
          this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
          return { status: "external", detail };
        }
      }
    }

    this.stopping = false;
    this.publishOperation?.({
      name: "runtime-start",
      status: "running",
      message: tunnelOnly ? "Starting isolated DEV MCP runtime" : "Starting local runtime",
    });
    try {
      if (this.persistentBridge && !tunnelOnly) {
        // The Codex bridge comes up first and stays up on its own; a slow or failing MCP
        // tunnel leaves the runtime degraded (the launcher watchdog retries it) instead of
        // taking the bridge down with it.
        await this.startDaemon(config);
        try {
          await this.startTunnel(config, "runtime-start");
        } catch (error) {
          const detail = `MCP tunnel is not ready yet: ${errorMessage(error)}`;
          this.restartHistory.daemon = [];
          this.tryWriteState("degraded", detail);
          this.logger.warn("runtime.tunnel_deferred", { detail });
          this.publishOperation?.({ name: "runtime-start", status: "warning", message: detail });
          this.startExtraTunnels(config);
          return { status: "degraded", daemonPid: this.daemon?.pid, tunnelPid: null, detail };
        }
      } else {
        await this.startTunnel(config, "runtime-start");
        if (!tunnelOnly) await this.startDaemon(config);
      }
      this.restartHistory.daemon = [];
      this.restartHistory.tunnel = [];
      this.writeState("ready");
      this.publishOperation?.({
        name: "runtime-start",
        status: "completed",
        message: tunnelOnly ? "Isolated DEV MCP runtime is ready" : "Local runtime is ready",
      });
      this.startExtraTunnels(config);
      return { status: "ready", daemonPid: this.daemon?.pid, tunnelPid: this.tunnel?.pid };
    } catch (error) {
      this.stopping = true;
      let cleanupError;
      try {
        await this.cleanupFailedStart(config);
      } catch (caught) {
        cleanupError = caught;
      } finally {
        this.stopping = false;
      }
      const primary = errorMessage(error);
      const message = cleanupError
        ? appendFailure(primary, "runtime startup cleanup failed", cleanupError)
        : primary;
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-start", status: "failed", message });
      throw new Error(message);
    }
  }

  recordRestart(name) {
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    const recent = this.restartHistory[name].filter((at) => at >= cutoff);
    recent.push(Date.now());
    this.restartHistory[name] = recent;
    return recent.length;
  }

  scheduleRecovery(name) {
    if (this.stopping) return;
    if (this.restartTimers[name]) return;
    const attempts = this.recordRestart(name);
    if (attempts > MAX_RESTARTS_PER_WINDOW) {
      const cause = this.lastChildFailure[name];
      const message = `${name} stopped more than ${MAX_RESTARTS_PER_WINDOW} times in 60 seconds; automatic restart is disabled`
        + (cause ? `; last failure: ${cause}` : "");
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-recovery", status: "failed", message });
      return;
    }
    const delay = Math.min(attempts * 1_000, 5_000);
    this.restartTimers[name] = setTimeout(() => {
      this.restartTimers[name] = null;
      const recovery = this.recover(name).catch((error) => {
        const message = errorMessage(error);
        this.logger.error(`runtime.${name}_recovery_failed`, { message });
        if (this.tryWriteState("failed", message)) this.scheduleRecovery(name);
      });
      this.recoveryTasks.add(recovery);
      void recovery.finally(() => this.recoveryTasks.delete(recovery));
    }, delay);
  }

  async recover(name) {
    if (this.stopping) return;
    const config = this.readConfig();
    if (!config) return;
    this.publishOperation?.({ name: "runtime-recovery", status: "running", message: `Restarting ${name}` });
    const tunnelOnly = this.launcherProfile === "development";
    if (name === "tunnel") {
      await this.startTunnel(config, "runtime-recovery", { forceRestart: true });
    }
    else if (tunnelOnly) throw new Error("DEV runtime cannot recover a Responses daemon");
    else await this.startDaemon(config);
    if (!tunnelOnly && !this.daemon) throw new Error("Responses proxy is unavailable after runtime recovery");
    if (config.mode === "full" && !this.tunnel) {
      throw new Error("Tunnel runtime is unavailable after runtime recovery");
    }
    if (!tunnelOnly) await this.waitForProxy(config);
    if (config.mode === "full") {
      await this.waitForTunnel(config, TUNNEL_START_TIMEOUT_MS, "runtime-recovery");
    }
    if (!this.tryWriteState("ready")) {
      let cleanupError;
      try {
        await this.cleanupFailedStart(config);
      } catch (caught) {
        cleanupError = caught;
      }
      const message = cleanupError
        ? appendFailure(
            "Recovered runtime could not persist launcher ownership",
            "runtime recovery cleanup failed",
            cleanupError,
          )
        : "Recovered runtime could not persist launcher ownership";
      throw new Error(message);
    }
    this.publishOperation?.({ name: "runtime-recovery", status: "completed", message: `${name} recovered` });
  }

  async cleanupFailedStart(config) {
    if (this.daemon) {
      const child = this.daemon;
      const healthy = Number.isInteger(child.pid) && await this.proxyHealth(config, 2_000, child.pid);
      if (healthy) {
        let drained = false;
        try {
          drained = await this.acquireDrain(config);
          await this.shutdownDaemon(config);
        } catch (error) {
          if (drained) {
            try {
              await this.control(config, "resume");
            } catch (resumeError) {
              throw new Error(appendFailure(errorMessage(error), "daemon resume compensation failed", resumeError));
            }
          }
          throw error;
        }
      } else {
        await this.stopChild("daemon");
      }
    }
    if (this.tunnel) {
      await this.stopTunnelGracefully(config);
    }
  }

  async restoreDrainedDaemon(config) {
    const child = this.daemon;
    const childAlive = child
      && child.exitCode === null
      && child.signalCode === null
      && processRunning(child.pid);
    if (childAlive) {
      if (!Number.isInteger(child.pid) || !await this.proxyHealth(config, 2_000, child.pid)) {
        throw new Error("drained daemon is still alive but no longer provides matching health evidence");
      }
      const resumed = await this.control(config, "resume");
      if (resumed.status !== "ok" || resumed.accepting_turns !== true) {
        throw new Error("drained daemon did not acknowledge resume");
      }
      await this.waitForProxy(config);
      return { status: "resumed", pid: child.pid };
    }
    this.daemon = null;
    await this.waitForPortRelease(config);
    await this.startDaemon(config);
    return { status: "restarted", pid: this.daemon?.pid };
  }

  async ownedRuntimeReady(config) {
    return (await this.ownedRuntimeCheck(config)).ready;
  }

  // The same check, saying which part failed: the launcher watchdog logs it with each miss.
  async ownedRuntimeCheck(config) {
    const verdict = (failed) => ({ ready: !failed, ...(failed ? { failed } : {}) });
    const tunnelVerdict = async () => {
      if (!this.tunnel) return verdict("tunnel_missing");
      return verdict(await this.tunnelHealth(config) ? null : "tunnel_health");
    };
    if (this.launcherProfile === "development") {
      return config.mode !== "full" ? verdict(null) : tunnelVerdict();
    }
    const daemon = this.daemon;
    if (!daemon || !Number.isInteger(daemon.pid)) return verdict("daemon_missing");
    if (daemon.exitCode !== null || daemon.signalCode !== null) return verdict("daemon_exited");
    if (!await this.proxyHealth(config, 2_000, daemon.pid, true)) return verdict("daemon_health");
    return config.mode !== "full" ? verdict(null) : tunnelVerdict();
  }

  async control(config, action, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async waitForChildExit(name, child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        child.off("exit", finish);
        child.off("close", finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        child.off("exit", finish);
        child.off("close", finish);
        reject(new Error(`${name} did not stop within ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("exit", finish);
      child.once("close", finish);
    });
  }

  async waitForProcessExit(name, pid, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (processRunning(pid) && Date.now() < deadline) await sleep(50);
    if (processRunning(pid)) throw new Error(`${name} process ${pid} did not stop within ${timeoutMs}ms`);
  }

  async waitForTunnelStopped(config, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "tunnel stop status has not been observed";
    while (Date.now() < deadline) {
      const health = await this.readTunnelHealth(config);
      if (tunnelRuntimeStopped(health)) {
        return health;
      }
      lastDetail = health.detail;
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`Tunnel runtime did not confirm a stopped state within ${timeoutMs}ms: ${lastDetail}`);
  }

  async waitForPortRelease(config, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "port is still occupied";
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const probe = net.createServer();
          probe.unref();
          probe.once("error", reject);
          probe.listen(config.port, config.host, () => {
            probe.close((error) => error ? reject(error) : resolve());
          });
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(100);
      }
    }
    throw new Error(
      `Responses port ${config.host}:${config.port} was not released within ${timeoutMs}ms: ${lastError}`,
    );
  }

  async shutdownDaemon(config, timeoutMs = 10_000) {
    const child = this.daemon;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.daemon = null;
      return;
    }
    this.expectedExits.add(child);
    const result = await this.control(config, "shutdown");
    if (result.status !== "ok") throw new Error("daemon did not acknowledge graceful shutdown");
    await this.waitForChildExit("daemon", child, timeoutMs);
    await this.waitForPortRelease(config);
    this.daemon = null;
  }

  async stopTunnelGracefully(config, timeoutMs = 10_000) {
    const managed = this.tunnel;
    if (!managed) {
      this.stopTunnelMonitor();
      this.tunnel = null;
      return;
    }
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    this.stopTunnelMonitor();
    let result;
    try {
      result = await this.runTunnelStopCommand(config);
    } catch (error) {
      this.startTunnelMonitor(config);
      throw error;
    }
    if (result.code !== 0) {
      this.startTunnelMonitor(config);
      throw new Error(`tunnel runtime refused graceful shutdown: ${tunnelControlDiagnostic(result)}`);
    }
    try {
      await this.waitForTunnelStopped(config, timeoutMs);
    } catch (error) {
      // The native manager accepted the stop request but did not prove the terminal state.
      // Keep supervising the alias until the caller either recovers or retries the transaction.
      this.startTunnelMonitor(config);
      throw error;
    }
    this.tunnel = null;
  }

  async adoptConfiguredTunnelForStop(config) {
    if (config.mode !== "full" || this.tunnel) return;
    const health = await this.waitForKnownTunnelStatus(config);
    if (tunnelRuntimeStopped(health)) {
      return;
    }
    if (health.state === undefined
      && health.processRunning !== true
      && health.pid === null) {
      throw new Error(`Tunnel runtime state is ambiguous before shutdown: ${health.detail}`);
    }
    this.tunnel = {
      pid: health.pid,
      exitCode: null,
      signalCode: null,
      managed: true,
    };
    this.logger.info("runtime.tunnel_adopted_for_stop", {
      pid: health.pid,
      state: health.state,
    });
  }

  async runTunnelStopCommand(config) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    return await this.runTunnelCommand(
      config,
      ["runtimes", "stop", tunnel.alias, "--json"],
      // A graceful stop outlasted 10 s while restarts loaded the machine (2026-10-30 04:42).
      30_000,
      "Tunnel shutdown",
    );
  }

  /**
   * A tunnel CLI command's { code, stdout, stderr, output }. Every one starts from a worker thread:
   * started here, Windows holds the starting thread until the program is loaded (an antivirus scan
   * makes that seconds). Probes alone held every window 5.5 s of a 7 s stall (profiled 2026-10-29);
   * after the probes moved, stop and connect still blocked the main process 40 times, 20.5 s in all,
   * up to 1.4 s each, while the tunnel restarted on 0.8.35 (launcher.main_blocked, 2026-10-30).
   * A timeout ends the command's whole process tree and rejects with "<label> timed out after N ms".
   */
  async runTunnelCommand(config, args, timeoutMs, label, env) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    if (!env) {
      const stateDir = path.join(fs.realpathSync.native(this.coreHome), "tunnel", "primary-runtime");
      const tempDir = path.join(stateDir, "temp");
      if (typeof tunnel.alias === "string" && tunnel.alias) {
        const legacyRoots = [...new Set([
          process.env.TUNNEL_CLIENT_STATE_DIR?.trim(),
          process.env.XDG_STATE_HOME?.trim() && path.join(process.env.XDG_STATE_HOME.trim(), "tunnel-client"),
          path.join(os.homedir(), ".local", "state", "tunnel-client"),
          path.join(os.homedir(), ".tunnel-client"),
        ].filter(root => root && !samePath(root, stateDir)))];
        for (const root of [stateDir, ...legacyRoots]) {
          let aliases;
          try {
            aliases = readJson(path.join(root, "aliases.yaml"));
            if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) throw new Error("Invalid alias state");
          } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw new Error("Primary tunnel state could not be verified; migration is required before reconnecting.");
          }
          if (!Object.hasOwn(aliases, tunnel.alias)) continue;
          const record = aliases[tunnel.alias];
          if (root === stateDir && record?.alias === tunnel.alias
            && typeof record.tunnel_id === "string" && record.tunnel_id.trim()) break;
          throw new Error("Existing primary tunnel requires migration to the dedicated runtime state directory before it can be used.");
        }
      }
      fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      env = { TUNNEL_CLIENT_STATE_DIR: stateDir, TEMP: tempDir, TMP: tempDir };
    }
    const reply = await runOffThread({ file: tunnel.binaryPath, args, cwd: tunnel.profileDir,
      env: { ...process.env, ...env }, timeoutMs, maxBytes: MAX_CONTROL_OUTPUT_BYTES });
    if (reply.timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    if (reply.error) throw new Error(reply.error);
    return controlResult(reply.code, reply.stdout, reply.stderr);
  }

  /**
   * Whether the recorded owner is still a running launcher. Windows reuses PIDs: a quit launcher's
   * PID came back as this app's own NetworkService child, and the launcher then never started the
   * bridge ("Another launcher process still owns the runtime"). A process this launcher started, a
   * Chromium child (--type=) or a script run (the bridge's browser helper) is never a launcher.
   * A process that cannot be inspected keeps the cautious answer.
   */
  async launcherOwnerRunning(pid) {
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid || !processRunning(pid)) return false;
    const info = await this.processInfo(pid);
    if (!info) return true;
    if (info.parentPid === process.pid) return false;
    const command = String(info.commandLine || "");
    return !/--type=/.test(command) && !/\.[cm]?js\b/i.test(command);
  }

  // True only for this install's own runtime (its bun.exe serving its app/cli.js) whose launcher
  // is gone. A live parent, another executable or another entrypoint is never ours to stop.
  async isOwnOrphanedBridge(pid) {
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return false;
    let expected;
    try {
      expected = this.runtimeCommand(["serve"]);
    } catch {
      return false;
    }
    const info = await this.processInfo(pid);
    if (!info?.executablePath || !info.commandLine) return false;
    if (Number.isInteger(info.parentPid) && info.parentPid > 0 && processRunning(info.parentPid)) return false;
    if (!samePath(info.executablePath, expected.executable)) return false;
    const command = info.commandLine.trim();
    if (!/(^|\s)serve$/.test(command)) return false;
    const entry = expected.args[0];
    const forms = new Set([entry]);
    try {
      forms.add(fs.realpathSync.native(entry));
    } catch {}
    const haystack = process.platform === "win32" ? command.toLowerCase() : command;
    return [...forms].some((form) => haystack.includes(process.platform === "win32" ? form.toLowerCase() : form));
  }

  async stopStaleOwnedRuntime(config) {
    const state = this.readState();
    if (!state) return false;
    if (runtimeOwnershipPredatesCurrentBoot(state)) {
      this.clearState();
      return false;
    }
    const tunnelOnly = this.launcherProfile === "development";
    if (tunnelOnly && processRunning(state.daemonPid)) {
      throw new Error("DEV launcher ownership unexpectedly contains a Responses daemon");
    }
    const health = tunnelOnly ? null : await this.proxyHealthPayload(config);
    const daemonRunning = health?.service === "codex-chatgpt-web"
      && health?.mode === config.mode
      && health?.version === config.releaseVersion;
    let daemonPid = state.daemonPid;
    if (daemonRunning && health.pid !== state.daemonPid) {
      // A launcher stopped without its shutdown (an install, a crash) leaves its bridge running
      // under a marker a later launch overwrote. Recover it only when it is provably this
      // install's own bridge whose launcher is gone; anything else stays an external owner.
      if (!(await this.isOwnOrphanedBridge(health.pid))) {
        throw new Error("The process on the Responses port does not match the stale launcher marker");
      }
      this.logger.warn("runtime.orphaned_bridge_detected", { pid: health.pid, markerPid: state.daemonPid ?? null });
      daemonPid = health.pid;
    }
    if (!daemonRunning && processRunning(state.daemonPid)) {
      throw new Error(
        `The stale daemon PID ${state.daemonPid} is still alive but did not provide matching health evidence`,
      );
    }
    let managedTunnelRunning = false;
    if (config.mode === "full") {
      const tunnelHealth = await this.waitForKnownTunnelStatus(config);
      managedTunnelRunning = !tunnelRuntimeStopped(tunnelHealth);
      if (managedTunnelRunning
        && tunnelHealth.processRunning !== true
        && tunnelHealth.pid === null
        && typeof tunnelHealth.state !== "string") {
        throw new Error(`The stale tunnel runtime state is ambiguous: ${tunnelHealth.detail}`);
      }
      if (!managedTunnelRunning && processRunning(state.tunnelPid)) {
        throw new Error(
          `The stale tunnel PID ${state.tunnelPid} is still alive but the native runtime manager`
          + " does not recognize it; refusing to terminate an unverified process",
        );
      }
    } else if (processRunning(state.tunnelPid)) {
      throw new Error(
        `The stale tunnel PID ${state.tunnelPid} is still alive but browser-only configuration`
        + " has no tunnel identity with which to verify it",
      );
    }
    if (!daemonRunning && !managedTunnelRunning) {
      this.clearState();
      return true;
    }
    if (state.ownerPid !== process.pid && await this.launcherOwnerRunning(state.ownerPid)) {
      throw new Error(`Another launcher process still owns the runtime (pid ${state.ownerPid})`);
    }

    this.logger.warn("runtime.stale_owner_recovery_started", {
      ownerPid: state.ownerPid,
      daemonPid: daemonRunning ? daemonPid : null,
      tunnelPid: managedTunnelRunning ? state.tunnelPid : null,
    });
    if (daemonRunning) {
      let drained = false;
      try {
        drained = await this.acquireDrain(config);
        const shutdown = await this.control(config, "shutdown");
        if (shutdown.status !== "ok") throw new Error("stale daemon did not acknowledge graceful shutdown");
        await this.waitForProcessExit("stale daemon", daemonPid);
        await this.waitForPortRelease(config);
      } catch (error) {
        if (drained) {
          try {
            await this.control(config, "resume");
          } catch (resumeError) {
            throw new Error(appendFailure(errorMessage(error), "stale daemon resume compensation failed", resumeError));
          }
        }
        throw error;
      }
    }
    if (managedTunnelRunning) {
      const stopped = await this.runTunnelStopCommand(config);
      if (stopped.code !== 0) {
        throw new Error(`stale tunnel refused graceful shutdown: ${tunnelControlDiagnostic(stopped)}`);
      }
      await this.waitForTunnelStopped(config, 10_000);
    }
    this.clearState();
    this.logger.info("runtime.stale_owner_recovered");
    return true;
  }

  async waitForIdleForSetup(operationName, timeoutMs = 600_000, pollIntervalMs = 500) {
    const config = this.readConfig();
    const pid = this.daemon?.pid;
    if (!config || !Number.isInteger(pid)) return;
    const deadline = Date.now() + timeoutMs;
    let previousMessage = "";
    for (;;) {
      const health = await this.proxyHealthPayload(config);
      if (health?.service !== "codex-chatgpt-web" || health.status !== "ok"
        || health.pid !== pid || health.mode !== config.mode || health.version !== config.releaseVersion
        || !Number.isInteger(health.active_http_turns) || health.active_http_turns < 0
        || !Number.isInteger(health.active_browser_turns) || health.active_browser_turns < 0) {
        throw new Error("Cannot verify bridge activity before setup; the running bridge was left untouched");
      }
      if (health.active_http_turns === 0 && health.active_browser_turns === 0) return;
      const activity = `${health.active_http_turns} active HTTP turn(s) and ${health.active_browser_turns} active browser turn(s)`;
      if (Date.now() >= deadline) {
        throw new Error(`Still waiting for ${activity}. Finish the active Codex turns, then retry setup; the bridge is still running.`);
      }
      // Named by what is being applied: a Bigger Context or saved-chats switch waiting here said
      // "before connecting MCP", and nothing said the switch itself was waiting (2026-10-24).
      const applying = SETUP_WAIT_LABELS[operationName] || "connecting MCP";
      const message = `Waiting for ${activity} to finish before ${applying}. Existing requests can continue.`;
      if (message !== previousMessage) {
        this.publishOperation?.({ name: operationName, status: "running", message });
        previousMessage = message;
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  async acquireDrain(config, timeoutMs = DRAIN_IDLE_TIMEOUT_MS) {
    let attempted = false;
    try {
      attempted = true;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const health = await this.control(config, "drain");
        if (health.accepting_turns !== false
          || !Number.isInteger(health.active_http_turns)
          || !Number.isInteger(health.active_browser_turns)) {
          throw new Error("daemon did not acknowledge the drain contract");
        }
        if (health.active_http_turns === 0 && health.active_browser_turns === 0) return true;
        if (Date.now() >= deadline) {
          throw new Error(
            `daemon has ${health.active_http_turns} active HTTP turn(s) and ${health.active_browser_turns} active browser turn(s)`,
          );
        }
        await sleep(Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      let resumeError;
      if (attempted) {
        try {
          await this.control(config, "resume");
        } catch (caught) {
          resumeError = caught;
        }
      }
      const message = resumeError
        ? appendFailure(errorMessage(error), "compensating resume failed", resumeError)
        : errorMessage(error);
      throw new Error(`Refusing to stop launcher-owned runtime because atomic idleness could not be proven: ${message}`);
    }
  }

  async cancelActiveTurns() {
    const config = this.readConfig();
    const daemon = this.daemon;
    if (!config || !daemon || daemon.exitCode !== null || daemon.signalCode !== null) {
      return { cancelledHttpTurns: 0, cancelledBrowserTurns: 0 };
    }
    const result = await this.control(config, "cancel-turns");
    if (result.status !== "ok"
      || !Number.isInteger(result.cancelled_http_turns)
      || !Number.isInteger(result.cancelled_browser_turns)
      || result.active_http_turns !== 0
      || result.active_browser_turns !== 0) {
      throw new Error("launcher-owned daemon did not acknowledge complete active-turn cancellation");
    }
    this.logger.info("runtime.active_turns_cancelled", {
      httpTurns: result.cancelled_http_turns,
      browserTurns: result.cancelled_browser_turns,
    });
    return {
      cancelledHttpTurns: result.cancelled_http_turns,
      cancelledBrowserTurns: result.cancelled_browser_turns,
    };
  }

  async cancelBrowserTurn(traceId) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId || "")) throw new Error("Browser turn trace id is invalid");
    const config = this.readConfig();
    const daemon = this.daemon;
    if (!config || !daemon || daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error("Launcher-owned runtime is unavailable for browser-turn cancellation");
    }
    const result = await this.control(config, "cancel-turn", {
      body: { traceId },
      timeoutMs: 15_000,
    });
    if (result.status !== "ok"
      || result.trace_id !== traceId
      || !Number.isInteger(result.cancelled_browser_turns)
      || !Number.isInteger(result.cancelled_broker_turns)) {
      throw new Error("Launcher-owned runtime did not acknowledge targeted browser-turn cancellation");
    }
    this.logger.info("runtime.browser_turn_cancelled", {
      traceId,
      browserTurns: result.cancelled_browser_turns,
      brokerTurns: result.cancelled_broker_turns,
    });
    return result;
  }

  async stopChild(name, timeoutMs = 10_000) {
    const child = this[name];
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this[name] = null;
      return;
    }
    this.expectedExits.add(child);
    try {
      await terminateOwnedProcessTreeAsync(child);
    } catch (error) {
      this.expectedExits.delete(child);
      if (!processRunning(child.pid)) {
        this[name] = null;
        return;
      }
      throw new Error(`Could not request ${name} process-tree shutdown: ${errorMessage(error)}`);
    }
    try {
      await this.waitForChildExit(name, child, timeoutMs);
    } catch (gracefulError) {
      try {
        await terminateOwnedProcessTreeAsync(child, "SIGKILL");
        await this.waitForChildExit(name, child, 2_000);
      } catch (forceError) {
        throw new Error(appendFailure(
          errorMessage(gracefulError),
          `forced ${name} process-tree shutdown failed`,
          forceError,
        ));
      }
      this.logger.warn(`runtime.${name}_forced_stop`, { message: errorMessage(gracefulError) });
    }
    await terminateOwnedProcessTreeAsync(child, "SIGKILL");
    this[name] = null;
  }

  async stopForSetup() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStopForSetup();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async performStopForSetup() {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch (error) {
        this.logger.warn("runtime.start_failed_before_stop", { message: errorMessage(error) });
      }
    }
    const config = this.readConfig();
    this.stopping = true;
    this.stopTunnelMonitor();
    for (const name of ["daemon", "tunnel"]) {
      if (this.restartTimers[name]) {
        clearTimeout(this.restartTimers[name]);
        this.restartTimers[name] = null;
      }
    }
    if (this.recoveryTasks.size > 0) {
      await Promise.allSettled([...this.recoveryTasks]);
    }
    // A failure here leaves that tunnel up; the next start adopts or restarts it.
    if (config) await this.stopExtraTunnels(config);
    let drained = false;
    let tunnelStopped = false;
    try {
      const ownershipState = this.readState();
      const healthyRuntime = config && this.launcherProfile !== "development"
        ? await this.proxyHealth(config)
        : false;
      const runtimeMayBeLive = healthyRuntime || runtimeOwnershipMayBeLive(ownershipState);
      if (config?.mode === "full"
        && !this.tunnel
        && (runtimeMayBeLive || !ownershipState)) {
        await this.adoptConfiguredTunnelForStop(config);
      }
      if (!this.daemon && !this.tunnel) {
        if (!config) {
          if (ownershipState && !runtimeOwnershipPredatesCurrentBoot(ownershipState) && (
            processRunning(ownershipState.daemonPid)
            || processRunning(ownershipState.tunnelPid)
          )) {
            throw new Error("runtime configuration is missing while launcher ownership processes are still alive");
          }
        } else if (runtimeMayBeLive) {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            throw new Error("an existing runtime could not be safely recovered");
          }
        }
        this.clearState();
        return { status: "stopped" };
      }
      if (this.daemon && config) {
        const daemonPid = this.daemon.pid;
        if (!Number.isInteger(daemonPid)
          || !await this.proxyHealth(config, 2_000, daemonPid)) {
          throw new Error("launcher-owned daemon did not provide matching health evidence");
        }
        drained = await this.acquireDrain(config);
      }
      if (this.tunnel) {
        if (!config) throw new Error("launcher-owned tunnel cannot be stopped without a valid configuration");
        await this.stopTunnelGracefully(config);
        tunnelStopped = true;
      }
      if (this.daemon) {
        if (!config || !drained) {
          throw new Error("launcher-owned daemon cannot be stopped without a verified idle drain");
        }
        await this.shutdownDaemon(config);
      }
      this.clearState();
      return { status: "stopped" };
    } catch (error) {
      const compensationErrors = [];
      if (tunnelStopped && config?.mode === "full" && !this.tunnel) {
        try {
          await this.startTunnel(config);
        } catch (caught) {
          compensationErrors.push(["tunnel restart compensation failed", caught]);
        }
      }
      if (drained && config) {
        try {
          await this.restoreDrainedDaemon(config);
        } catch (caught) {
          compensationErrors.push(["daemon resume compensation failed", caught]);
        }
      }
      const message = compensationErrors.reduce(
        (current, [label, failure]) => appendFailure(current, label, failure),
        errorMessage(error),
      );
      let restoredReady = false;
      if (compensationErrors.length === 0 && config) {
        try {
          restoredReady = await this.ownedRuntimeReady(config);
        } catch {
          restoredReady = false;
        }
      }
      this.tryWriteState(restoredReady ? "ready" : "failed", message);
      if (restoredReady) this.startExtraTunnels(config);
      throw new Error(message);
    } finally {
      this.stopping = false;
    }
  }

  async restart() {
    await this.stopForSetup();
    return this.startIfConfigured();
  }

  async forceStopOwnedRuntime(reason) {
    this.logger.warn("runtime.forced_shutdown_started", { message: errorMessage(reason) });
    this.stopping = true;
    this.stopTunnelMonitor();
    for (const name of ["daemon", "tunnel"]) {
      if (this.restartTimers[name]) {
        clearTimeout(this.restartTimers[name]);
        this.restartTimers[name] = null;
      }
    }
    try {
      if (this.recoveryTasks.size > 0) await Promise.allSettled([...this.recoveryTasks]);
      const failures = [];
      try {
        const config = this.readConfig();
        if (config) failures.push(...(await this.stopExtraTunnels(config)).map(failure => `extra tunnel ${failure}`));
      } catch (error) {
        failures.push(`extra tunnels: ${errorMessage(error)}`);
      }
      if (this.tunnel) {
        try {
          const config = this.readConfig();
          if (!config) throw new Error("runtime configuration is unavailable");
          const stopped = await this.runTunnelStopCommand(config);
          if (stopped.code !== 0) throw new Error(tunnelControlDiagnostic(stopped));
          await this.waitForTunnelStopped(config, 5_000);
          this.tunnel = null;
        } catch (error) {
          failures.push(`tunnel: ${errorMessage(error)}`);
        }
      }
      try {
        await this.stopChild("daemon");
      } catch (error) {
        failures.push(`daemon: ${errorMessage(error)}`);
      }
      if (failures.length === 0) this.clearState();
      else this.tryWriteState("failed", failures.join("; "));
      this.logger.warn("runtime.forced_shutdown_completed", {
        message: errorMessage(reason),
        failures,
      });
      return {
        status: failures.length === 0 ? "forced" : "forced-partial",
        detail: errorMessage(reason),
        failures,
      };
    } finally {
      this.stopping = false;
    }
  }

  async shutdown({ cancelActiveTurns = false, force = false } = {}) {
    try {
      if (cancelActiveTurns) await this.cancelActiveTurns();
      return await this.stopForSetup();
    } catch (error) {
      if (!force) throw error;
      return this.forceStopOwnedRuntime(error);
    }
  }
}

module.exports = {
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  TUNNEL_HEALTH_POLL_INTERVAL_MS,
  TUNNEL_MONITOR_FAILURE_THRESHOLD,
  TUNNEL_MONITOR_INTERVAL_MS,
  TUNNEL_START_TIMEOUT_MS,
  RuntimeSupervisor,
  managedTunnelConnectArgs,
  validateConfig,
};
