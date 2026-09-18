"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const STORE_VERSION = 1;
const SERVICE_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "cpa",
  "paseo",
  "anneal",
]);
const SERVICE_ID_SET = new Set(SERVICE_IDS);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CALLER_KEY = /^[A-Za-z0-9_-]{32,}$/;
const DEFAULT_INSPECT_TIMEOUT_MS = 4_000;
const STOP_TIMEOUT_MS = 5_000;

const DEFAULTS = Object.freeze({
  "codex-router": Object.freeze({
    name: "Codex Router",
    endpoint: "http://127.0.0.1:4202/",
    home: "",
    executable: "",
    arguments: [],
    routerCli: "model-router",
    curateCli: "curate-models",
    webBaseUrl: "http://127.0.0.1:17841/router/v1",
    enabled: true,
    autoStart: false,
  }),
  "commandcode-proxy": Object.freeze({
    name: "CommandCode Proxy",
    endpoint: "http://127.0.0.1:9090/",
    home: "",
    executable: "",
    arguments: [],
    enabled: true,
    autoStart: false,
  }),
  cpa: Object.freeze({
    name: "CPA / CLIProxyAPI",
    endpoint: "http://127.0.0.1:8317/",
    home: "",
    executable: "",
    arguments: [],
    enabled: true,
    autoStart: false,
  }),
  paseo: Object.freeze({
    name: "Paseo",
    endpoint: "http://127.0.0.1:6768/",
    executionEndpoint: "ws://127.0.0.1:6767/ws",
    home: "",
    executable: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    arguments: process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "dev:server"]
      : ["run", "dev:server"],
    enabled: true,
    autoStart: false,
  }),
  anneal: Object.freeze({
    name: "Anneal",
    endpoint: "http://127.0.0.1:3000/",
    executionEndpoint: "http://127.0.0.1:3000/",
    home: "",
    executable: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    arguments: process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "dev:web"]
      : ["run", "dev:web"],
    enabled: true,
    autoStart: false,
  }),
});

function requiredServiceId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SERVICE_ID_SET.has(id)) throw new Error(`Unknown external service: ${id || "missing"}`);
  return id;
}

function optionalText(value, maximum = 2_048) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Text value is invalid");
  const normalized = value.trim();
  if (!normalized) return "";
  if (normalized.length > maximum) throw new Error("Text value is too long");
  return normalized;
}

function normalizeArguments(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Service arguments must be an array");
  if (value.length > 64) throw new Error("Service argument limit exceeded");
  return value.map((argument) => {
    if (typeof argument !== "string") throw new Error("Service arguments must be strings");
    if (argument.includes("\0")) throw new Error("Service arguments must not contain null bytes");
    if (argument.length > 2_048) throw new Error("Service argument is too long");
    return argument;
  });
}

function normalizeLoopbackServiceEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("External service endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("External service endpoints must use HTTP or HTTPS");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("External services are restricted to loopback hosts");
  }
  if (parsed.username || parsed.password) {
    throw new Error("External service endpoints must not contain credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function normalizeLoopbackExecutionEndpoint(value, serviceId) {
  const id = requiredServiceId(serviceId);
  if (id !== "paseo" && id !== "anneal") {
    throw new Error(`Service ${id} does not expose an execution endpoint`);
  }
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${DEFAULTS[id].name} execution endpoint must be a valid URL`);
  }
  const allowed = id === "paseo"
    ? new Set(["ws:", "wss:"])
    : new Set(["http:", "https:"]);
  if (!allowed.has(parsed.protocol)) {
    throw new Error(
      id === "paseo"
        ? "Paseo execution endpoint must use WebSocket (WS or WSS)"
        : "Anneal execution endpoint must use HTTP or HTTPS",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Execution endpoints are restricted to loopback hosts");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Execution endpoints must not contain credentials, query parameters, or fragments");
  }
  if (id === "anneal" && !parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function createSecretCodec({ safeStorage, keyPath }) {
  let fallbackKey = null;

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  function loadFallbackKey() {
    if (fallbackKey) return fallbackKey;
    try {
      const bytes = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
      if (bytes.length === 32) {
        fallbackKey = bytes;
        return fallbackKey;
      }
    } catch {}
    fallbackKey = crypto.randomBytes(32);
    writePrivateFileAtomic(keyPath, `${fallbackKey.toString("base64")}\n`);
    return fallbackKey;
  }

  function encrypt(value) {
    const plain = JSON.stringify(value);
    if (encryptionAvailable()) {
      return {
        scheme: "electron-safe-storage-v1",
        data: safeStorage.encryptString(plain).toString("base64"),
      };
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", loadFallbackKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return {
      scheme: "aes-256-gcm-v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    };
  }

  function decrypt(envelope) {
    if (!envelope || typeof envelope !== "object") return null;
    try {
      if (envelope.scheme === "electron-safe-storage-v1" && encryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64")));
      }
      if (envelope.scheme !== "aes-256-gcm-v1") return null;
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        loadFallbackKey(),
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plain);
    } catch {
      return null;
    }
  }

  return Object.freeze({ encrypt, decrypt });
}

function initialState(env) {
  return {
    version: STORE_VERSION,
    services: Object.fromEntries(SERVICE_IDS.map((id) => {
      const defaults = DEFAULTS[id];
      const environmentHome = id === "paseo"
        ? env.CODING_TOOLS_PASEO_HOME
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_HOME
          : "";
      const environmentEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_URL
          : id === "codex-router"
            ? env.CODING_TOOLS_CODEX_ROUTER_URL
            : id === "commandcode-proxy"
              ? env.CODING_TOOLS_COMMANDCODE_URL
              : env.CODING_TOOLS_CPA_URL;
      const environmentExecutionEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_EXECUTION_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_EXECUTION_URL
          : undefined;
      return [id, {
        ...defaults,
        endpoint: normalizeLoopbackServiceEndpoint(environmentEndpoint || defaults.endpoint),
        ...(defaults.executionEndpoint ? {
          executionEndpoint: normalizeLoopbackExecutionEndpoint(
            environmentExecutionEndpoint || defaults.executionEndpoint,
            id,
          ),
        } : {}),
        home: optionalText(environmentHome) || defaults.home,
      }];
    })),
    secrets: {},
  };
}

function normalizeState(value, env) {
  const fallback = initialState(env);
  if (!value || value.version !== STORE_VERSION || typeof value.services !== "object") return fallback;
  const services = {};
  for (const id of SERVICE_IDS) {
    const defaults = fallback.services[id];
    const input = value.services[id] && typeof value.services[id] === "object"
      ? value.services[id]
      : {};
    let endpoint = defaults.endpoint;
    try { endpoint = normalizeLoopbackServiceEndpoint(input.endpoint || defaults.endpoint); } catch {}
    let executionEndpoint = defaults.executionEndpoint;
    if (executionEndpoint) {
      try {
        executionEndpoint = normalizeLoopbackExecutionEndpoint(
          input.executionEndpoint || defaults.executionEndpoint,
          id,
        );
      } catch {}
    }
    services[id] = {
      ...defaults,
      endpoint,
      ...(executionEndpoint ? { executionEndpoint } : {}),
      home: typeof input.home === "string" ? input.home : defaults.home,
      executable: typeof input.executable === "string" ? input.executable : defaults.executable,
      arguments: Array.isArray(input.arguments)
        ? input.arguments.filter((entry) => typeof entry === "string").slice(0, 64)
        : [...defaults.arguments],
      enabled: input.enabled !== false,
      autoStart: input.autoStart === true,
      ...(id === "codex-router" ? {
        routerCli: typeof input.routerCli === "string" && input.routerCli.trim()
          ? input.routerCli.trim()
          : defaults.routerCli,
        curateCli: typeof input.curateCli === "string" && input.curateCli.trim()
          ? input.curateCli.trim()
          : defaults.curateCli,
        webBaseUrl: (() => {
          try { return normalizeLoopbackServiceEndpoint(input.webBaseUrl || defaults.webBaseUrl).replace(/\/$/, ""); }
          catch { return defaults.webBaseUrl; }
        })(),
      } : {}),
    };
  }
  return {
    version: STORE_VERSION,
    services,
    secrets: value.secrets && typeof value.secrets === "object" ? value.secrets : {},
  };
}

function countModels(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.data)) return payload.data.length;
  if (Array.isArray(payload.models)) return payload.models.length;
  return null;
}

function boundedText(value, maximum) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function projectCommandCodeHealth(payload) {
  if (!payload || typeof payload !== "object") return null;
  const endpoints = payload.endpoints && typeof payload.endpoints === "object"
    ? Object.fromEntries(
      Object.entries(payload.endpoints)
        .filter(([, value]) => typeof value === "string")
        .slice(0, 8)
        .map(([key, value]) => [String(key).slice(0, 40), String(value).slice(0, 120)]),
    )
    : undefined;
  const models = Array.isArray(payload.models)
    ? payload.models.map((item) => String(item).slice(0, 80)).filter(Boolean).slice(0, 64)
    : undefined;
  const user = payload.user && typeof payload.user === "object"
    ? {
      id: boundedText(payload.user.id, 80),
      email: boundedText(payload.user.email, 120),
    }
    : undefined;
  return {
    status: boundedText(payload.status, 32),
    proxy: boundedText(payload.proxy, 64),
    version: boundedText(payload.version, 32),
    ...(endpoints ? { endpoints } : {}),
    ...(user && (user.id || user.email) ? { user } : {}),
    ...(typeof payload.credits === "number" ? { credits: payload.credits } : {}),
    ...(models && models.length ? { models } : {}),
  };
}

function createExternalServicesController({
  filePath,
  keyPath,
  safeStorage = null,
  logger = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnProcess = spawn,
  runRuntimeCommand = null,
  getProviderSnapshot = null,
  getHealthHeaders = null,
  publish = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!filePath || !keyPath) throw new Error("External service state paths are required");
  const codec = createSecretCodec({ safeStorage, keyPath });
  let state;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")), env);
  } catch {
    state = initialState(env);
  }
  const processes = new Map();
  const runtime = new Map(SERVICE_IDS.map((id) => [id, {
    status: state.services[id].enabled ? "unknown" : "disabled",
    pid: null,
    owned: false,
    startedAt: null,
    checkedAt: null,
    latencyMs: null,
    statusCode: null,
    modelCount: null,
    health: null,
    error: null,
  }]));

  function write() {
    writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function secretFor(id) {
    const stored = codec.decrypt(state.secrets[id]) || {};
    if (id !== "codex-router" || stored.callerKey) return stored;
    const environmentCallerKey = typeof env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY === "string"
      ? env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY.trim()
      : "";
    return CALLER_KEY.test(environmentCallerKey)
      ? { callerKey: environmentCallerKey }
      : stored;
  }

  function redactServiceSecrets(value) {
    let result = String(value || "");
    const callerKey = secretFor("codex-router").callerKey;
    if (callerKey) {
      result = result
        .split(callerKey).join("[REDACTED]")
        .split(encodeURIComponent(callerKey)).join("[REDACTED]");
    }
    return result;
  }

  function providerMetrics(id) {
    const snapshot = typeof getProviderSnapshot === "function" ? getProviderSnapshot() : null;
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const selected = id === "commandcode-proxy"
      ? accounts.filter((account) => account.providerId === "commandcode-proxy" && !account.archivedAt)
      : id === "cpa"
        ? accounts.filter((account) => (
            !account.archivedAt
              && (
                account.credentialSource === "cpa"
                || String(account.loginAdapterId || "").startsWith("cpa-")
                || account.providerId === "cliproxyapi-antigravity"
              )
          ))
        : id === "codex-router"
          ? accounts.filter((account) => account.enabled !== false && !account.archivedAt)
          : [];
    return {
      accountCount: selected.length,
      connectedAccountCount: selected.filter((account) => account.status === "connected").length,
      providerModelCount: new Set(selected.flatMap((account) => Array.isArray(account.models) ? account.models : [])).size,
    };
  }

  function project(id) {
    requiredServiceId(id);
    const config = state.services[id];
    const activity = runtime.get(id);
    return {
      id,
      name: DEFAULTS[id].name,
      endpoint: config.endpoint,
      ...(config.executionEndpoint ? { executionEndpoint: config.executionEndpoint } : {}),
      home: config.home,
      executable: config.executable,
      arguments: [...config.arguments],
      enabled: config.enabled,
      autoStart: config.autoStart,
      status: config.enabled ? activity.status : "disabled",
      pid: activity.pid,
      owned: activity.owned,
      startedAt: activity.startedAt,
      checkedAt: activity.checkedAt,
      latencyMs: activity.latencyMs,
      statusCode: activity.statusCode,
      modelCount: activity.modelCount,
      error: activity.error,
      ...(id === "commandcode-proxy" && activity.health ? { health: activity.health } : {}),
      secretConfigured: id === "codex-router" && Boolean(secretFor(id).callerKey),
      sourceConfigured: Boolean(config.home || config.executable),
      ...(id === "codex-router" ? {
        routerCli: config.routerCli,
        curateCli: config.curateCli,
        webBaseUrl: config.webBaseUrl,
      } : {}),
      ...providerMetrics(id),
    };
  }

  function snapshot() {
    return { version: STORE_VERSION, services: SERVICE_IDS.map(project) };
  }

  function emit() {
    const value = snapshot();
    try { publish?.(value); } catch {}
    return value;
  }

  function configure(idValue, input = {}) {
    const id = requiredServiceId(idValue);
    if (!input || typeof input !== "object") throw new Error("External service configuration is required");
    const current = state.services[id];
    const next = {
      ...current,
      ...(input.endpoint !== undefined
        ? { endpoint: normalizeLoopbackServiceEndpoint(input.endpoint) }
        : {}),
      ...((id === "paseo" || id === "anneal") && input.executionEndpoint !== undefined
        ? { executionEndpoint: normalizeLoopbackExecutionEndpoint(input.executionEndpoint, id) }
        : {}),
      ...(input.home !== undefined ? { home: optionalText(input.home) || "" } : {}),
      ...(input.executable !== undefined ? { executable: optionalText(input.executable) || "" } : {}),
      ...(input.arguments !== undefined ? { arguments: normalizeArguments(input.arguments) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(input.autoStart !== undefined ? { autoStart: input.autoStart === true } : {}),
    };
    if (id === "codex-router") {
      next.routerCli = input.routerCli !== undefined
        ? optionalText(input.routerCli, 1_024) || "model-router"
        : current.routerCli;
      next.curateCli = input.curateCli !== undefined
        ? optionalText(input.curateCli, 1_024) || "curate-models"
        : current.curateCli;
      next.webBaseUrl = input.webBaseUrl !== undefined
        ? normalizeLoopbackServiceEndpoint(input.webBaseUrl).replace(/\/$/, "")
        : current.webBaseUrl;
      if (input.callerKey !== undefined) {
        const callerKey = optionalText(input.callerKey, 1_024) || "";
        if (callerKey && !CALLER_KEY.test(callerKey)) {
          throw new Error("Codex Router caller key must be at least 32 URL-safe characters");
        }
        if (callerKey) state.secrets[id] = codec.encrypt({ callerKey });
      }
    }
    state.services[id] = next;
    const activity = runtime.get(id);
    runtime.set(id, {
      ...activity,
      status: next.enabled ? "unknown" : "disabled",
      error: null,
      checkedAt: null,
    });
    write();
    emit();
    return project(id);
  }

  function healthUrl(id) {
    const config = state.services[id];
    if (id === "codex-router") {
      const callerKey = secretFor(id).callerKey;
      if (!callerKey) throw new Error("Codex Router caller key is not configured");
      return new URL(`/_codex-router/${encodeURIComponent(callerKey)}/v1/models`, config.endpoint).toString();
    }
    if (id === "commandcode-proxy" || id === "cpa") {
      return new URL("/v1/models", config.endpoint).toString();
    }
    return config.endpoint;
  }

  async function inspect(idValue) {
    const id = requiredServiceId(idValue);
    const config = state.services[id];
    if (!config.enabled) return project(id);
    if (typeof fetchImpl !== "function") throw new Error("External service HTTP inspection is unavailable");
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_INSPECT_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(healthUrl(id), {
        method: "GET",
        headers: {
          accept: "application/json,text/html;q=0.8,*/*;q=0.1",
          ...(typeof getHealthHeaders === "function" ? getHealthHeaders(id) : {}),
        },
        signal: controller.signal,
      });
      let modelCount = null;
      let health = null;
      try {
        const contentType = response.headers?.get?.("content-type") || "";
        if (contentType.includes("json")) modelCount = countModels(await response.clone().json());
      } catch {}
      const reachable = response.ok;
      if (reachable && id === "commandcode-proxy") {
        try {
          const banner = await fetchImpl(new URL("/", config.endpoint).toString(), {
            method: "GET",
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          if (banner.ok) health = projectCommandCodeHealth(await banner.json());
        } catch {}
      }
      runtime.set(id, {
        ...runtime.get(id),
        status: reachable ? "ready" : "error",
        pid: processes.get(id)?.pid || null,
        owned: processes.has(id),
        checkedAt: now(),
        latencyMs: Date.now() - started,
        statusCode: response.status,
        modelCount,
        health,
        error: reachable ? null : `HTTP ${response.status}`,
      });
    } catch (error) {
      runtime.set(id, {
        ...runtime.get(id),
        status: processes.has(id) ? "starting" : "offline",
        pid: processes.get(id)?.pid || null,
        owned: processes.has(id),
        checkedAt: now(),
        health: null,
        latencyMs: Date.now() - started,
        statusCode: null,
        modelCount: null,
        error: redactServiceSecrets(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      clearTimeout(timer);
    }
    emit();
    return project(id);
  }

  async function start(idValue) {
    const id = requiredServiceId(idValue);
    const current = await inspect(id);
    if (current.status === "ready") return current;
    if (processes.has(id)) return project(id);
    const config = state.services[id];
    if (!config.enabled) throw new Error(`${DEFAULTS[id].name} is disabled`);
    if (!config.executable) throw new Error(`${DEFAULTS[id].name} executable is not configured`);
    if (config.home && !fs.existsSync(config.home)) {
      throw new Error(`${DEFAULTS[id].name} home directory does not exist`);
    }
    const child = spawnProcess(config.executable, [...config.arguments], {
      cwd: config.home || undefined,
      env: { ...env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.set(id, child);
    runtime.set(id, {
      ...runtime.get(id),
      status: "starting",
      pid: child.pid || null,
      owned: true,
      startedAt: now(),
      checkedAt: now(),
      error: null,
    });
    const log = (stream, chunk) => {
      const message = String(chunk || "").trim().slice(-2_000);
      if (message) logger?.debug?.(`external-service.${id}.${stream}`, { message });
    };
    child.stdout?.on?.("data", (chunk) => log("stdout", chunk));
    child.stderr?.on?.("data", (chunk) => log("stderr", chunk));
    child.once?.("error", (error) => {
      processes.delete(id);
      runtime.set(id, {
        ...runtime.get(id),
        status: "error",
        pid: null,
        owned: false,
        checkedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      });
      emit();
    });
    child.once?.("exit", (code, signal) => {
      processes.delete(id);
      runtime.set(id, {
        ...runtime.get(id),
        status: "offline",
        pid: null,
        owned: false,
        checkedAt: now(),
        error: code === 0 ? null : `${DEFAULTS[id].name} exited (${code ?? signal ?? "unknown"})`,
      });
      emit();
    });
    emit();
    return project(id);
  }

  async function stop(idValue) {
    const id = requiredServiceId(idValue);
    const child = processes.get(id);
    if (!child) {
      const current = await inspect(id);
      if (current.status === "ready") {
        throw new Error(`${DEFAULTS[id].name} is externally managed and cannot be stopped by Coding Tools`);
      }
      return current;
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = await new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.removeListener?.("exit", onExit);
          child.removeListener?.("error", onError);
          resolve(value);
        };
        const onExit = () => finish(true);
        const onError = () => finish(true);
        child.once?.("exit", onExit);
        child.once?.("error", onError);
        timer = setTimeout(() => finish(false), STOP_TIMEOUT_MS);
        timer.unref?.();
        try {
          if (child.kill("SIGTERM") === false) finish(false);
        } catch {
          finish(false);
        }
      });
      if (!exited && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    processes.delete(id);
    runtime.set(id, {
      ...runtime.get(id),
      status: "offline",
      pid: null,
      owned: false,
      checkedAt: now(),
      error: null,
    });
    emit();
    return project(id);
  }

  async function restart(idValue) {
    const id = requiredServiceId(idValue);
    if (!processes.has(id)) {
      const current = await inspect(id);
      if (current.status === "ready") {
        throw new Error(`${DEFAULTS[id].name} is externally managed and cannot be restarted by Coding Tools`);
      }
    } else {
      await stop(id);
    }
    return start(id);
  }

  async function syncCodexRouter() {
    if (typeof runRuntimeCommand !== "function") {
      throw new Error("Codex Router integration command is unavailable");
    }
    const router = state.services["codex-router"];
    const commandCode = state.services["commandcode-proxy"];
    const commandCodeBaseUrl = new URL("/v1", commandCode.endpoint).toString().replace(/\/$/, "");
    const args = [
      "router", "integrate", "--apply", "--with-commandcode-proxy",
      "--router-cli", router.routerCli,
      "--curate-cli", router.curateCli,
      "--web-base-url", router.webBaseUrl,
      "--commandcode-base-url", commandCodeBaseUrl,
    ];
    const result = await runRuntimeCommand(args);
    const callerKey = secretFor("codex-router").callerKey;
    const redact = (value) => String(value || "").split(callerKey || "\0").join("[REDACTED]");
    logger?.info?.("external-service.codex-router-synced", {
      routerCli: router.routerCli,
      commandCodeBaseUrl,
    });
    return {
      ok: true,
      args,
      stdout: redact(result?.stdout),
      stderr: redact(result?.stderr),
    };
  }

  function runtimeEnvironment() {
    const router = state.services["codex-router"];
    const commandCode = state.services["commandcode-proxy"];
    const cpa = state.services.cpa;
    const callerKey = secretFor("codex-router").callerKey;
    return Object.freeze({
      CODING_TOOLS_CODEX_ROUTER_URL: router.endpoint.replace(/\/$/, ""),
      ...(callerKey ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey } : {}),
      CODING_TOOLS_COMMANDCODE_URL: commandCode.endpoint.replace(/\/$/, ""),
      CODING_TOOLS_CPA_URL: cpa.endpoint.replace(/\/$/, ""),
      CODING_TOOLS_PASEO_EXECUTION_URL: state.services.paseo.executionEndpoint,
      CODING_TOOLS_ANNEAL_EXECUTION_URL: state.services.anneal.executionEndpoint,
    });
  }

  function upstreamConfiguration(idValue) {
    const id = requiredServiceId(idValue);
    if (id !== "paseo" && id !== "anneal") {
      throw new Error(`Service ${id} is not an upstream UI tool`);
    }
    const config = state.services[id];
    return {
      endpoint: config.endpoint,
      executionEndpoint: config.executionEndpoint,
      home: config.home,
      executable: config.executable,
      arguments: [...config.arguments],
    };
  }

  function dispose() {
    for (const [id, child] of processes) {
      try {
        if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      } catch {}
      runtime.set(id, {
        ...runtime.get(id),
        status: "offline",
        pid: null,
        owned: false,
        checkedAt: now(),
      });
    }
    processes.clear();
  }

  return Object.freeze({
    snapshot,
    configure,
    inspect,
    start,
    stop,
    restart,
    syncCodexRouter,
    runtimeEnvironment,
    upstreamConfiguration,
    dispose,
  });
}

module.exports = {
  SERVICE_IDS,
  createExternalServicesController,
  normalizeLoopbackExecutionEndpoint,
  normalizeLoopbackServiceEndpoint,
  projectCommandCodeHealth,
};
