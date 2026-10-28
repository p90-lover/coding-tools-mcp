"use strict";

// ProxyBridge Nova is the proxy manager behind the Proxy page. Coding Tools runs it headless
// (`--managed`, no tray) and drives it over its loopback API (docs/managed-api.md in Nova's repo).
// Nova's proxies, plus its CONNECT gateway, are the proxy profiles every Coding Tools route picks
// from; they are mirrored into the Provider Network store so the routes' consumers (browser
// sessions, the environment, CPA, provider and account routes) keep reading one place.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_API_PORT = 17894;
const GATEWAY_PROFILE_ID = "nova:gateway";
const STATUS_POLL_MS = 5_000;
const START_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Routing actions answer 202 at once; a proxy check and a Decodo sync take up to a few seconds.
const SLOW_REQUEST_TIMEOUT_MS = 45_000;
const EXIT_REASONS = {
  // A build without managed mode hands the launch to its running tray and exits at once.
  0: "This ProxyBridge Nova has no managed mode (it opened its own window instead). Update ProxyBridge Nova",
  2:"ProxyBridge Nova refused its start arguments or API token",
  3: "Another ProxyBridge Nova is running and did not hand over; close it, then start it here",
  4: "The ProxyBridge Nova API port is in use by another program",
};

function profileIdFor(key) {
  return `nova:${key}`;
}

function proxyName(proxy) {
  const where = `${proxy.host}:${proxy.port}`;
  const kind = String(proxy.protocol || "").toUpperCase();
  return proxy.provider ? `${proxy.provider} · ${kind} ${where}` : `${kind} ${where}`;
}

/** The Provider Network profiles for Nova's proxies and gateway. */
function profileEntries(profile, status) {
  const entries = (profile?.proxies ?? [])
    .filter((proxy) => ["http", "https", "socks5"].includes(proxy.protocol) && proxy.host && proxy.port)
    .map((proxy) => ({
      id: profileIdFor(proxy.key), sourceKey: proxy.key, name: proxyName(proxy),
      endpoint: { protocol: proxy.protocol, host: proxy.host, port: proxy.port },
      username: proxy.username || "", password: proxy.password || "",
    }));
  const gateway = status?.gateway;
  if (gateway?.port) {
    entries.unshift({
      id: GATEWAY_PROFILE_ID, sourceKey: "gateway", name: `Nova gateway (${gateway.port})`,
      endpoint: { protocol: "http", host: gateway.host || "127.0.0.1", port: gateway.port },
      username: "", password: "",
    });
  }
  return entries;
}

function sameEndpoint(a, b) {
  const host = (value) => String(value ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/^localhost$/, "127.0.0.1");
  return a.protocol === b.protocol && host(a.host) === host(b.host) && Number(a.port) === Number(b.port);
}

function defaultExecutable(env = process.env) {
  const candidates = [
    env.CODING_TOOLS_NOVA_EXE,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "ProxyBridge Nova", "ProxyBridgeRewrite.exe"),
    "F:\\ProxyBridgeRewrite\\ProxyBridgeRewrite.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) ?? "";
}

function createNovaManager({
  userData,
  safeStorage,
  store,
  applyGlobalRouting,
  publish = () => {},
  logger,
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const settingsPath = path.join(userData, "providers", "proxybridge-nova.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) ?? {}; } catch {}
  let token = null;
  let status = null;
  let lastError = null;
  let etag = null;
  let starting = null;
  let timer = null;
  let syncing = Promise.resolve();

  function saveSettings() {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writePrivateFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  // The token outlives the app (Nova does too), so a restarted app adopts the Nova it started.
  // Kept only encrypted; with no OS encryption it lives for this run and Nova is restarted next time.
  function apiToken() {
    if (token) return token;
    if (settings.token && safeStorage?.isEncryptionAvailable?.()) {
      try { token = safeStorage.decryptString(Buffer.from(settings.token, "base64")); } catch {}
    }
    if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) {
      token = crypto.randomBytes(36).toString("base64url");
      if (safeStorage?.isEncryptionAvailable?.()) {
        settings.token = safeStorage.encryptString(token).toString("base64");
        saveSettings();
      }
    }
    return token;
  }

  const apiPort = () => (Number.isInteger(settings.apiPort) ? settings.apiPort : DEFAULT_API_PORT);
  const executable = () => settings.exePath || defaultExecutable(env);

  async function api(method, endpoint, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${apiPort()}${endpoint}`, {
        method,
        headers: { authorization: `Bearer ${apiToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const error = new Error("ProxyBridge Nova is not running");
      error.code = "NOVA_UNREACHABLE";
      error.cause = cause;
      throw error;
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error(response.status === 401
        ? "ProxyBridge Nova on this port was started by something else (its API token does not match)"
        : data?.error || `ProxyBridge Nova answered HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function state() {
    return {
      running: Boolean(status),
      executable: executable(),
      apiPort: apiPort(),
      status,
      error: lastError,
      migratedAt: settings.migratedAt ?? null,
    };
  }

  function announce() {
    publish(state());
  }

  async function refreshStatus() {
    try {
      status = await api("GET", "/v1/status");
      lastError = null;
    } catch (error) {
      status = null;
      lastError = error.message;
    }
    return status;
  }

  async function launch() {
    const exe = executable();
    if (!exe) throw new Error("ProxyBridge Nova was not found. Choose ProxyBridgeRewrite.exe on the Proxy page");
    const child = spawnImpl(exe, ["--managed", "--takeover", "--api-port", String(apiPort())], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, PROXYBRIDGE_NOVA_API_TOKEN: apiToken() },
    });
    let exited = null;
    child.once?.("exit", (code) => { exited = code ?? -1; });
    child.once?.("error", (error) => { exited = error; });
    child.unref?.();
    logger?.info?.("nova.launched", { pid: child.pid ?? null, apiPort: apiPort() });
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      if (await refreshStatus()) return status;
      if (exited !== null) {
        throw new Error(exited instanceof Error ? `ProxyBridge Nova could not start: ${exited.message}`
          : EXIT_REASONS[exited] ?? `ProxyBridge Nova stopped while starting (exit code ${exited})`);
      }
    }
    throw new Error("ProxyBridge Nova did not answer within 20 s of starting");
  }

  /**
   * Adopts the Nova this app started earlier, else starts one (taking over a running tray). At app
   * start (`launchAllowed` false) it only adopts until one managed start has worked: a Nova build
   * without managed mode would treat the launch as a second tray, opening its dashboard and
   * starting routing on every app start.
   */
  function ensureRunning({ launchAllowed = true } = {}) {
    if (!starting) {
      starting = (async () => {
        if (await refreshStatus()) return status;
        if (!launchAllowed && !settings.managedStarted) {
          lastError = "ProxyBridge Nova is not running here yet";
          return null;
        }
        try {
          const started = await launch();
          if (!settings.managedStarted) {
            settings.managedStarted = true;
            saveSettings();
          }
          return started;
        } catch (error) { lastError = error.message; throw error; }
      })().finally(() => { starting = null; announce(); });
    }
    return starting;
  }

  /** Mirrors Nova's proxies into the store; re-applies the app-wide route when it uses one that changed. */
  function sync() {
    syncing = syncing.catch(() => {}).then(async () => {
      const profile = await api("GET", "/v1/profile");
      const routing = store.snapshot().routing;
      const before = routing.globalEnabled ? store.activeProxy(routing.globalProfileId) : null;
      const result = store.syncSourceProfiles("nova", profileEntries(profile, status), { fallbackId: GATEWAY_PROFILE_ID });
      etag = profile.etag;
      const after = store.snapshot().routing;
      const now = after.globalEnabled ? store.activeProxy(after.globalProfileId) : null;
      if (result.changed && JSON.stringify(before) !== JSON.stringify(now)) await applyGlobalRouting();
      if (result.changed) publish(null, result.snapshot);
      if (!settings.migratedAt) await migrate(profile);
      return profile;
    });
    return syncing;
  }

  /**
   * Once: every Coding Tools proxy profile becomes a Nova proxy (or the Nova one with the same
   * endpoint, or the gateway), its routes move there, and the old profile is archived. A SOCKS4
   * profile has no Nova equivalent and is left as it is.
   */
  async function migrate(profile) {
    const own = store.snapshot().proxyProfiles.filter((item) => !item.source && !item.archivedAt);
    let current = profile;
    const moved = [];
    const kept = [];
    for (const old of own) {
      let target = null;
      if (status?.gateway?.port && sameEndpoint(old.endpoint, { protocol: "http", host: "127.0.0.1", port: status.gateway.port })) {
        target = GATEWAY_PROFILE_ID;
      } else {
        const match = current.proxies.find((proxy) => sameEndpoint(old.endpoint, proxy));
        if (match) target = profileIdFor(match.key);
        else if (["http", "https", "socks5"].includes(old.endpoint.protocol)) {
          const secret = store.proxySecret(old.id) || {};
          const proxies = [...current.proxies.filter((proxy) => !proxy.linked).map((proxy) => ({ ...proxy, password: null })), {
            key: "", protocol: old.endpoint.protocol, host: old.endpoint.host, port: old.endpoint.port,
            username: secret.username || "", password: secret.password || "", linked: false, upstreamEligible: true, provider: null,
          }];
          current = await api("PUT", "/v1/profile/proxies", { etag: current.etag, proxies });
          const added = current.proxies.find((proxy) => !proxy.linked && sameEndpoint(old.endpoint, proxy));
          if (added) target = profileIdFor(added.key);
        }
      }
      if (!target) { kept.push(old.id); continue; }
      moved.push([old.id, target]);
    }
    if (moved.length) {
      store.syncSourceProfiles("nova", profileEntries(current, status), { fallbackId: GATEWAY_PROFILE_ID });
      etag = current.etag;
      for (const [from, to] of moved) {
        store.retargetProxyReferences(from, to);
        store.archiveProxyProfile(from);
      }
      await applyGlobalRouting();
    }
    settings.migratedAt = new Date().toISOString();
    saveSettings();
    logger?.info?.("nova.profiles_migrated", { moved: moved.length, kept: kept.length });
    publish(null, store.snapshot());
  }

  async function tick() {
    const previous = status;
    await refreshStatus();
    if (status && status.profile?.etag !== etag) await sync().catch((error) => { lastError = error.message; });
    if (Boolean(previous) !== Boolean(status) || JSON.stringify(previous) !== JSON.stringify(status)) announce();
  }

  async function start() {
    try {
      if (await ensureRunning({ launchAllowed: false })) await sync();
    } catch (error) {
      logger?.warn?.("nova.start_failed", { error: error.message });
    }
    timer = setInterval(() => { void tick(); }, STATUS_POLL_MS);
    timer.unref?.();
    return state();
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Each write answers with Nova's new profile; the store follows at once rather than at the next poll.
  async function afterProfileWrite(profile) {
    etag = null;
    await sync();
    return profile;
  }

  return {
    state,
    start,
    stopPolling,
    ensureRunning,
    sync,
    async setExecutable(exePath) {
      const value = String(exePath ?? "").trim();
      if (value && (!/\.exe$/i.test(value) || !fs.existsSync(value))) throw new Error("Choose ProxyBridgeRewrite.exe");
      settings.exePath = value || undefined;
      saveSettings();
      announce();
      return state();
    },
    async shutdown() {
      await api("POST", "/v1/shutdown");
      status = null;
      announce();
      return state();
    },
    profile: () => api("GET", "/v1/profile"),
    async saveProxies(input) {
      return afterProfileWrite(await api("PUT", "/v1/profile/proxies", input));
    },
    async saveRules(input) {
      return afterProfileWrite(await api("PUT", "/v1/profile/rules", input));
    },
    checkProxy: (key) => api("POST", "/v1/proxies/check", { key }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }),
    apps: () => api("GET", "/v1/apps"),
    connections: () => api("GET", "/v1/connections"),
    log: (after = 0) => api("GET", `/v1/log?after=${Math.max(0, Number(after) || 0)}`),
    async routing(action) {
      if (!["start", "stop", "reload", "install"].includes(action)) throw new Error("Unknown routing action");
      const result = await api("POST", `/v1/routing/${action}`, {}, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      void tick();
      return result;
    },
    decodo: () => api("GET", "/v1/decodo"),
    saveDecodo: (input) => api("PUT", "/v1/decodo", input),
    async syncDecodo() {
      const result = await api("POST", "/v1/decodo/sync", {}, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      await afterProfileWrite(result.profile);
      return result;
    },
  };
}

module.exports = { createNovaManager, profileEntries, GATEWAY_PROFILE_ID, DEFAULT_API_PORT };
